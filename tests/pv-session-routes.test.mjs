import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apply } from '../index.js'
import { productionGuide } from '../lib/pv-production.mjs'
import { appendActivityRecord } from '../lib/records.mjs'

const DATE = '2026-10-21'
const SOURCE = 'source-chat'
const tick = () => new Promise(resolve => setImmediate(resolve))

/** Real plugin routes/tools, isolated home, fake Host services and no actual subprocesses. */
async function fixture(saved = {}, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fish-video-routes-'))
  const home = join(root, 'bili-duty'), cwd = join(root, 'selected-workspace')
  mkdirSync(home); mkdirSync(cwd)
  const configFile = join(home, 'config.json')
  writeFileSync(configFile, JSON.stringify({ pythonPath: 'python', pvDir: join(root, 'films'), learnAutoReview: false,
    workspace: join(root, 'prompt-reference-only'), ...saved }))
  const agents = new Map(), permissionState = new Map(), selections = new Map(), goalState = new Map()
  const calls = [], spawned = [], cleanups = [], tools = new Map(), events = new Map()
  const workspace = { id: 'selected-workspace', path: cwd, sessionIds: [SOURCE] }
  const unrelated = { id: 'other-workspace', path: join(root, 'other-workspace'), sessionIds: [] }
  const makeAgent = (id, sandbox = 'workspace-write', approval = 'ask') => {
    const session = { header: { cwd, agentPreset: 'dafeiyu' }, append(kind, data) {
      const state = permissionState.get(id)
      if (kind === 'sandbox/mode') state.sandbox = data.mode
      if (kind === 'approval/policy') state.approval = data.policy
    } }
    const agent = { id, session, status: 'idle', cancel() { calls.push(['cancel', { sessionId: id }]) },
      ctx: { tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } } } }
    permissionState.set(id, { sandbox, approval })
    selections.set(id, { current: { provider: 'source', model: 'whole-film' } })
    agents.set(id, agent)
    return agent
  }
  makeAgent(SOURCE, 'read-only', 'never')
  let serial = 0, handler
  const goals = {
    get: agent => goalState.get(agent.id),
    create(agent, request) {
      calls.push(['goal', { sessionId: agent.id, ...request }])
      const goal = { id: 'video-goal-' + ++serial, revision: 1, phase: 'active', activation: 'armed',
        roundsStarted: 0, objective: request.objective, maxGoalRounds: request.maxGoalRounds }
      goalState.set(agent.id, goal)
      return goal
    },
    complete(agent, request) {
      calls.push(['complete', { sessionId: agent.id, ...request }])
      const goal = goalState.get(agent.id)
      if (goal) { goal.phase = 'complete'; goal.activation = 'disarmed'; goal.revision++ }
      return goal
    },
    pause(agent, request) {
      calls.push(['pause', { sessionId: agent.id, ...request }])
      const goal = goalState.get(agent.id)
      if (goal) { goal.phase = 'paused'; goal.activation = 'disarmed'; goal.revision++ }
      return goal
    },
    disarm(agent, request) {
      calls.push(['disarm', { sessionId: agent.id, ...request }])
      const goal = goalState.get(agent.id)
      if (goal) goal.activation = 'disarmed'
      return goal
    },
  }
  const controller = {
    agents: { selectionFor: agent => agent && selections.get(agent.id) },
    async resolveAgent(id) { return { agent: agents.get(id) } },
    async create(request) {
      calls.push(['create', request])
      const id = 'video-chat-' + ++serial
      makeAgent(id); workspace.sessionIds.push(id)
      return { sessionId: id }
    },
    async selectModel(request) {
      calls.push(['select', request])
      if (request.provider === 'unavailable') throw new Error('NO_ADAPTER: unavailable video model')
      const selected = { provider: request.provider, model: request.model }
      if (options.unconfirmedSelection) return { selected: { provider: 'wrong', model: 'model' } }
      selections.get(request.sessionId).current = selected
      return { selected }
    },
    async rename(request) { calls.push(['rename', request]) },
    async prompt(request) { calls.push(['prompt', request]); return { accepted: true } },
  }
  const services = {
    dshHomePath: (...parts) => join(root, ...parts), goals,
    agents: { get: id => agents.get(id), list: () => [...agents.values()] },
    sessionController: controller,
    workspaceRegistry: { list: () => [workspace, unrelated], get: id => [workspace, unrelated].find(row => row.id === id),
      resolveByPath: async path => [workspace, unrelated].find(row => row.path === path) },
    sessionProjections: { stateOf(session, key) {
      if (key === 'agentPreset') return 'dafeiyu'
      if (key === 'permissions') return permissionState.get([...agents.values()].find(agent => agent.session === session)?.id)
      if (key === 'tokenUsage') return { totals: { uncachedInputTokens: 0 } }
    } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'default', model: 'whole-film' }) },
    llm: { listProviders: () => [{ id: 'source' }, { id: 'saved' }, { id: 'explicit' }] },
  }
  const ctx = {
    get: key => services[key], logger: { info() {} }, settings: { describe: () => [] },
    tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } },
    on(name, fn) { events.set(name, fn); return () => events.delete(name) },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } },
  }
  const actualTimers = { setTimeout, clearTimeout, setInterval, clearInterval }
  const timer = () => ({ unref() {} })
  globalThis.setTimeout = timer; globalThis.clearTimeout = () => {}
  globalThis.setInterval = timer; globalThis.clearInterval = () => {}
  const cp = createRequire(import.meta.url)('node:child_process'), actualSpawn = cp.spawn
  cp.spawn = (command, args, opts) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null; child.killed = false
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true }
    spawned.push({ command, args, opts, child })
    queueMicrotask(() => {
      // No actual TTS/ffmpeg/network: produce only the coordinator's fixture artifacts.
      let code = args[0] === '-c' ? (options.missingDeps ? 1 : 0) : 23
      if (options.renderSuccess && args[0] !== '-c') {
        const value = flag => args[args.indexOf(flag) + 1]
        if (/pv_cover\.py$/.test(args[0])) {
          const out = value('--outdir')
          mkdirSync(out, { recursive: true })
          for (const [name, width, height] of [['封面_16x9.png', 1920, 1080], ['封面_4x3.png', 1440, 1080]]) {
            const png = Buffer.alloc(25)
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
            png.writeUInt32BE(width, 16); png.writeUInt32BE(height, 20)
            writeFileSync(join(out, name), png)
          }
        } else if (/pv\.py$/.test(args[0])) {
          mkdirSync(dirname(value('--out')), { recursive: true })
          writeFileSync(value('--out'), Buffer.alloc(1600))
          mkdirSync(value('--work'), { recursive: true })
          writeFileSync(join(value('--work'), 'timeline.json'), '{}')
        } else if (/pv_verify\.py$/.test(args[0])) {
          writeFileSync(join(value('--outdir'), 'verification.json'), '{"ok":true,"fixture":true}')
        }
        code = 0
      }
      child.exitCode = code; child.emit('close', code)
    })
    return child
  }
  syncBuiltinESMExports()
  const cleanup = () => {
    for (const fn of cleanups.reverse()) { try { fn() } catch {} }
    Object.assign(globalThis, actualTimers)
    cp.spawn = actualSpawn; syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
  async function request(path, body, method = 'GET', headers = {}) {
    const req = new EventEmitter(), chunks = []
    req.url = '/api/bili-duty' + path; req.method = method; req.headers = headers; req.destroy = () => {}
    const res = new Writable({ write(chunk, _encoding, next) { chunks.push(Buffer.from(chunk)); next() } })
    res.headersSent = false
    res.writeHead = (code, values = {}) => { res.code = code; res.responseHeaders = values; res.headersSent = true }
    const ended = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject) })
    const pending = handler(req, res)
    if (method === 'POST') { req.emit('data', Buffer.from(JSON.stringify(body || {}))); req.emit('end') }
    await pending; await ended
    const bytes = Buffer.concat(chunks)
    if (String(res.responseHeaders?.['content-type']).includes('video/')) return { code: res.code, headers: res.responseHeaders, bytes }
    return { code: res.code, headers: res.responseHeaders, ...(bytes.length ? JSON.parse(bytes.toString()) : {}) }
  }
  try { apply(ctx, {}); await tick() } catch (error) { cleanup(); throw error }
  const execute = (args, id = SOURCE) => tools.get('bili_pv').execute(args, { agent: agents.get(id) })
  return { root, home, workspace, configFile, calls, spawned, agents, goals, goalState, permissionState, request, execute, cleanup }
}

const startBody = (extra = {}) => ({ action: 'session', sourceSessionId: SOURCE, workspaceId: 'selected-workspace',
  date: DATE, mode: 'custom', brief: '饭桌聊一件没想明白的小事', targetDurationSec: 30, ...extra })
const count = (f, name) => f.calls.filter(call => call[0] === name).length
const assertNoLegacyRender = f => assert.ok(f.spawned.every(call => call.args[0] === '-c'), 'session creation may probe dependencies but must never launch the legacy plan/template renderer')

test('video routes migrate the saved writer model to the full-production setting and preserve explicit saves', async () => {
  const f = await fixture({ pvModelId: 'saved/whole-film', _set: ['pvModelId', 'paceFactor'], paceFactor: .73 })
  try {
    const initial = await f.request('/config')
    assert.equal(initial.code, 200)
    assert.equal(initial.config.videoModelId, 'saved/whole-film')
    assert.equal('pvModelId' in initial.config, false)
    const page = await f.request('/pv')
    assert.equal(page.code, 200); assert.equal(page.deps, true)
    assert.equal(page.modelId, 'saved/whole-film'); assert.deepEqual(page.sessions, [])
    const saved = await f.request('/config', { videoModelId: 'explicit/whole-film' }, 'POST')
    assert.equal(saved.ok, true); assert.equal(saved.config.videoModelId, 'explicit/whole-film')
    assert.equal(saved.config.paceFactor, .73)
    const disk = JSON.parse(readFileSync(f.configFile, 'utf8'))
    assert.equal(disk.videoModelId, 'explicit/whole-film')
    assert.equal('pvModelId' in disk, false)
    assert.ok(disk._set.includes('videoModelId')); assert.equal(disk._set.includes('pvModelId'), false)
    assert.equal((await f.request('/pv')).modelId, 'explicit/whole-film')
    assert.equal(count(f, 'create'), 0)
  } finally { f.cleanup() }
})

test('session/make routes inherit the current workspace and permissions, select before an owned production goal, and never run a hidden renderer', async () => {
  const f = await fixture({ videoModelId: 'saved/whole-film' })
  try {
    for (const [action, mode, model] of [['session', 'custom', 'explicit/whole-film'], ['make', 'rant', undefined],
      ['session', 'daily', undefined], ['make', 'highlights', undefined]]) {
      const before = f.calls.length
      const result = await f.request('/pv', startBody({ action, mode, ...(model ? { model } : {}), sandbox: 'danger-full-access', approval: 'ask' }), 'POST')
      assert.equal(result.code, 200); assert.equal(result.ok, true, result.error)
      assert.equal(result.model, model || 'saved/whole-film')
      assert.ok(result.goalId); assert.equal(result.accepted, true); assert.equal(result.stage, 'authoring')
      assert.equal(result.workspaceId, f.workspace.id)
      assert.equal(result.mode, mode); assert.equal(result.date, DATE); assert.equal(result.targetDurationSec, 30)
      assert.equal(result.permissions.inherited, true)
      assert.equal(result.permissions.sandbox, 'read-only'); assert.equal(result.permissions.approval, 'never')
      assert.deepEqual(f.permissionState.get(result.sessionId), { sandbox: 'read-only', approval: 'never' })
      const calls = f.calls.slice(before)
      assert.deepEqual(calls.find(call => call[0] === 'create')[1], { agentPreset: 'dafeiyu', workspaceId: f.workspace.id })
      assert.ok(calls.findIndex(call => call[0] === 'select') < calls.findIndex(call => call[0] === 'goal'))
      const selected = calls.find(call => call[0] === 'select')[1]
      assert.equal(selected.sessionId, result.sessionId)
      assert.equal(`${selected.provider}/${selected.model}`, result.model)
      const goal = f.goals.get(f.agents.get(result.sessionId))
      assert.equal(goal.phase, 'active'); assert.match(goal.objective, /整条视频/)
      assert.match(goal.objective, /action:"prepare"/); assert.match(goal.objective, /action:"render"/)
      assert.match(goal.objective, /action:"status"/); assert.match(goal.objective, /30/)
      assert.equal(count(f, 'prompt'), 0, 'the production goal schedules the first turn; no second prompt races it')
      assertNoLegacyRender(f)
      const page = await f.request('/pv')
      const row = page.sessions.find(row => row.sessionId === result.sessionId)
      assert.ok(row); assert.equal(row.model, result.model); assert.equal(row.mode, mode)
    }
    assert.equal(count(f, 'create'), 4)
    assert.equal(count(f, 'goal'), 4)
  } finally { f.cleanup() }
})

test('the client session-new endpoint accepts its exact draft contract and inherits source permissions', async () => {
  const f = await fixture({ videoModelId: 'saved/whole-film' })
  try {
    const body = { sourceSessionId: SOURCE, workspaceId: 'selected-workspace', date: DATE,
      mode: 'daily', brief: '总结这一天的公开冲浪素材', targetDurationSec: 90, model: 'explicit/whole-film' }
    const result = await f.request('/pv/session-new', body, 'POST')
    assert.equal(result.code, 200); assert.equal(result.ok, true, result.error)
    assert.equal(result.accepted, true); assert.equal(result.stage, 'authoring')
    assert.equal(result.model, body.model); assert.equal(result.mode, body.mode)
    assert.equal(result.date, body.date); assert.equal(result.targetDurationSec, body.targetDurationSec)
    assert.equal(result.workspaceId, f.workspace.id)
    assert.deepEqual(f.permissionState.get(result.sessionId), { sandbox: 'read-only', approval: 'never' })
    assert.equal(count(f, 'create'), 1); assert.equal(count(f, 'goal'), 1); assert.equal(count(f, 'prompt'), 0)
    assert.ok((await f.request('/pv')).sessions.some(row => row.sessionId === result.sessionId))
    assertNoLegacyRender(f)
    const invalid = await f.request('/pv/session-new', { ...body, date: '2026-02-29' }, 'POST')
    assert.equal(invalid.ok, false); assert.equal(count(f, 'create'), 1)
    const crossOrigin = await f.request('/pv/session-new', body, 'POST', { origin: 'https://outside.example.com' })
    assert.equal(crossOrigin.code, 403); assert.equal(count(f, 'create'), 1)
  } finally { f.cleanup() }
})

test('an unavailable or unconfirmed model leaves the new session visible but starts no goal, prompt or fallback production', async () => {
  for (const options of [{}, { unconfirmedSelection: true }]) {
    const f = await fixture({}, options)
    try {
      const model = options.unconfirmedSelection ? 'explicit/whole-film' : 'unavailable/whole-film'
      const result = await f.request('/pv', startBody({ model }), 'POST')
      assert.equal(result.ok, false); assert.ok(result.sessionId)
      assert.equal(count(f, 'create'), 1); assert.equal(count(f, 'select'), 1)
      assert.equal(count(f, 'goal'), 0); assert.equal(count(f, 'prompt'), 0)
      const page = await f.request('/pv')
      const failed = page.sessions.find(row => row.sessionId === result.sessionId)
      assert.equal(failed.stage, 'failed'); assert.ok(failed.error)
      assertNoLegacyRender(f)
    } finally { f.cleanup() }
  }
})

test('invalid inputs or missing render dependencies do not create a session or launch the legacy pipeline', async () => {
  const f = await fixture()
  try {
    for (const extra of [{ date: '2026-02-29' }, { mode: 'unknown' }, { targetDurationSec: 14 }, { model: 'not-a-route' }, { workspaceId: 'other-workspace' }]) {
      const result = await f.request('/pv', startBody(extra), 'POST')
      assert.equal(result.ok, false, JSON.stringify(extra)); assert.equal(count(f, 'create'), 0)
    }
    assertNoLegacyRender(f)
  } finally { f.cleanup() }
  const missing = await fixture({}, { missingDeps: true })
  try {
    const result = await missing.request('/pv', startBody(), 'POST')
    assert.equal(result.ok, false); assert.match(result.error, /依赖/)
    assert.equal(count(missing, 'create'), 0); assert.equal(count(missing, 'goal'), 0)
    assertNoLegacyRender(missing)
  } finally { missing.cleanup() }
})

test('video HTTP delivery rejects invalid/traversal production ids and invalid days before streaming', async () => {
  const f = await fixture()
  try {
    for (const id of ['', '../config.json', '..\\config.json', '/absolute/video.mp4', 'C:\\Windows\\file', 'a/b', 'a%2fb', 'unknown-production']) {
      const result = await f.request('/pv/video?id=' + encodeURIComponent(id))
      assert.equal(result.code, 404, id); assert.equal(result.ok, false)
    }
    for (const day of ['', '../config.json', '2026-02-29', '2026-10-32', '2026-1-1']) {
      const result = await f.request('/pv/video?day=' + encodeURIComponent(day))
      assert.equal(result.code, 400, day); assert.equal(result.ok, false)
    }
    assert.equal((await f.request('/pv/video?day=' + DATE)).code, 404)
    assert.equal(count(f, 'create'), 0); assert.equal(f.spawned.length, 0)
  } finally { f.cleanup() }
})

test('bili_pv prepare exposes only the agreed day of public source records with stable event ids', async () => {
  const f = await fixture()
  try {
    const publicRecord = appendActivityRecord(f.home, { uid: 'video-public-record', t: DATE + 'T12:00:00',
      kind: 'pick', tool: 'bili_subtitle', bvid: 'BV1Ab411c7xy', title: '手算与口算的不同', text: '读完这个公开视频的字幕，记下了比较方法。' })
    assert.equal(publicRecord.ok, true)
    appendActivityRecord(f.home, { uid: 'video-old-record', t: '2026-10-20T12:00:00',
      kind: 'pick', tool: 'bili_subtitle', bvid: 'BV1Ab411c7xy', text: '这是前一天的公开视频活动。' })
    appendActivityRecord(f.home, { uid: 'video-private-record', t: DATE + 'T12:01:00',
      kind: 'dm', tool: 'bili_dm_thread', bvid: 'BV1Ab411c7xy', text: '私信里面提到了这个视频。' })
    const made = await f.request('/pv', startBody({ mode: 'daily' }), 'POST')
    assert.equal(made.ok, true, made.error)
    appendActivityRecord(f.home, { uid: 'video-later-record', t: DATE + 'T12:02:00',
      kind: 'pick', tool: 'bili_subtitle', bvid: 'BV1Ab411c7xy', text: '开始制作之后才追加的另一条公开活动。' })
    const result = await f.execute({ action: 'prepare' }, made.sessionId)
    assert.equal(result.request.mode, 'daily'); assert.equal(result.request.date, DATE)
    assert.equal(result.sourceCount, 1)
    assert.equal(result.sources[0].eventId, publicRecord.eventId)
    assert.equal(result.sources[0].date, DATE)
    assert.equal(result.sources[0].bvid, 'BV1Ab411c7xy')
    assert.equal(result.sources[0].kind, 'public-record')
    assert.equal(result.sources[0].excerpt, '读完这个公开视频的字幕，记下了比较方法。')
    assert.equal(JSON.stringify(result.sources).includes('私信里面'), false)
    assert.equal(JSON.stringify(result.sources).includes('前一天'), false)
    assert.equal(JSON.stringify(result.sources).includes('开始制作之后'), false, 'production uses the immutable source snapshot from session creation')
    const raw = { ...productionGuide().sample, date: DATE, mode: 'daily', targetDurationSec: 30, maxDurationSec: 33,
      sources: [{ ...result.sources[0], id: 'daily-source' }] }
    raw.shots[0].source_ids = ['daily-source']; raw.shots[0].provenance = 'record-adaptation'
    for (const [key, value] of Object.entries({ eventId: 'invented', kind: 'video', bvid: 'BV1Ab411c7xz', date: '2026-10-20',
      title: '伪造标题', url: 'https://example.com/foreign', author: '伪造作者', excerpt: '伪造原话' })) {
      const changed = { ...raw, sources: [{ ...raw.sources[0], [key]: value }] }
      const invalid = await f.execute({ action: 'render', production: JSON.stringify(changed) }, made.sessionId)
      assert.equal(invalid.ok, false, `${key} must remain bound to the source snapshot`)
    }
    assertNoLegacyRender(f)
  } finally { f.cleanup() }
})

test('bili_pv reuses an existing production session and keeps prepare/render/status scoped to its agreement and output', async () => {
  const f = await fixture()
  try {
    const first = await f.execute(startBody({ action: 'make' }))
    assert.equal(first.ok, true, first.error); assert.equal(first.model, 'source/whole-film')
    const second = await f.request('/pv', startBody({ mode: 'rant', targetDurationSec: 45, brief: '另一条吐槽' }), 'POST')
    assert.equal(second.ok, true, second.error)
    const created = count(f, 'create'), goalCount = count(f, 'goal')
    const reused = await f.execute({ action: 'make' }, first.sessionId)
    assert.equal(reused.ok, true); assert.equal(reused.request.mode, 'custom'); assert.match(reused.hint, /无需重复创建/)
    assert.equal(count(f, 'create'), created); assert.equal(count(f, 'goal'), goalCount)
    const prepared = await f.execute({ action: 'prepare' }, first.sessionId)
    assert.equal(prepared.request.date, DATE); assert.equal(prepared.request.mode, 'custom')
    assert.equal(prepared.request.targetDurationSec, 30); assert.equal(prepared.request.sessionId, first.sessionId)
    assert.equal(prepared.guide.schema, 'dafeiyu-dialogue-v1')
    assert.deepEqual(prepared.sources, []); assert.equal(prepared.sourceCount, 0)
    assert.match(prepared.guide.constraints.join('\n'), /maxDurationSec 不超过 33/)
    const other = await f.execute({ action: 'prepare' }, second.sessionId)
    assert.equal(other.request.mode, 'rant'); assert.equal(other.request.targetDurationSec, 45)
    assert.equal((await f.execute({ action: 'prepare', date: '2026-10-20' }, first.sessionId)).ok, false)
    const raw = { ...productionGuide().sample, date: DATE, targetDurationSec: 30, maxDurationSec: 33 }
    for (const invalid of [{ ...raw, mode: 'rant' }, { ...raw, date: '2026-10-20' }, { ...raw, maxDurationSec: 34 }]) {
      const result = await f.execute({ action: 'render', production: JSON.stringify(invalid) }, first.sessionId)
      assert.equal(result.ok, false)
    }
    assertNoLegacyRender(f)
    const started = await f.execute({ action: 'render', production: JSON.stringify(raw) }, first.sessionId)
    assert.equal(started.ok, true, started.error); assert.equal(started.started, true); assert.ok(started.id)
    for (const key of ['file', 'plan', 'timeline', 'verification', 'log']) assert.ok(started[key], key)
    await tick(); await tick()
    const state = await f.execute({ action: 'status' }, first.sessionId)
    assert.equal(state.sessionId, first.sessionId); assert.equal(state.id, started.id)
    assert.equal(state.modelId, first.model); assert.equal(state.mode, 'custom'); assert.equal(state.stage, 'failed')
    for (const key of ['file', 'plan', 'timeline', 'verification', 'log']) assert.equal(state[key], started[key], key)
    assert.ok(state.error, 'real failed render is visible in the owning conversation')
    const failedGoal = f.goals.get(f.agents.get(first.sessionId))
    assert.equal(failedGoal.phase, 'active', 'failure must not claim that the production objective completed')
    assert.equal(failedGoal.activation, 'disarmed', 'async render must not spend automatic rounds polling')
    assert.equal(count(f, 'complete'), 0)
    const receipts = f.calls.filter(call => call[0] === 'prompt')
    assert.equal(receipts.length, 1); assert.equal(receipts[0][1].sessionId, first.sessionId)
    assert.equal(receipts[0][1].requestId, 'deepmoyu-video-terminal-' + started.id)
    assert.match(receipts[0][1].content[0].text, /"verified":false/)
    await f.request('/pv'); await f.execute({ action: 'status' }, first.sessionId)
    assert.equal(count(f, 'prompt'), 1, 'reading status must not redeliver a terminal receipt')
    const untouched = await f.execute({ action: 'status' }, second.sessionId)
    assert.equal(untouched.sessionId, second.sessionId); assert.equal(untouched.mode, 'rant')
    assert.equal(untouched.id, ''); assert.equal(untouched.running, false); assert.notEqual(untouched.stage, 'failed')
    assert.equal((await f.execute({ action: 'stop' }, second.sessionId)).stopped, true)
    assert.equal(f.goals.get(f.agents.get(second.sessionId)).phase, 'paused')
    assert.equal((await f.execute({ action: 'status' }, second.sessionId)).stage, 'stopped')
    assert.equal(count(f, 'create'), created)
    assert.ok(f.spawned.some(call => /pv_cover\.py$/.test(call.args[0])))
    assert.equal(f.spawned.some(call => /pv_plan\.py$/.test(call.args[0])), false)
  } finally { f.cleanup() }
})

test('verified production completion retires only its owned goal, delivers one receipt and streams the confined video id', async () => {
  const f = await fixture({}, { renderSuccess: true })
  try {
    const made = await f.request('/pv', startBody(), 'POST')
    assert.equal(made.ok, true, made.error)
    const raw = { ...productionGuide().sample, date: DATE, targetDurationSec: 30, maxDurationSec: 33 }
    const started = await f.execute({ action: 'render', production: JSON.stringify(raw) }, made.sessionId)
    assert.equal(started.started, true, started.error)
    for (let attempt = 0; attempt < 12 && count(f, 'prompt') === 0; attempt++) await tick()
    const state = await f.execute({ action: 'status' }, made.sessionId)
    assert.equal(state.stage, 'done'); assert.equal(state.running, false); assert.equal(state.id, started.id)
    const own = f.goals.get(f.agents.get(made.sessionId))
    assert.equal(own.id, made.goalId); assert.equal(own.phase, 'complete')
    assert.equal(count(f, 'complete'), 1); assert.equal(count(f, 'prompt'), 1)
    const receipt = f.calls.find(call => call[0] === 'prompt')[1]
    assert.equal(receipt.sessionId, made.sessionId)
    assert.equal(receipt.requestId, 'deepmoyu-video-terminal-' + started.id)
    assert.match(receipt.content[0].text, /"verified":true/)
    assert.match(receipt.content[0].text, /action:"status"/)
    const page = await f.request('/pv')
    const visible = page.productions.find(row => row.id === started.id)
    assert.ok(visible); assert.equal(visible.stage, 'done'); assert.equal(visible.verification, started.verification)
    const full = await f.request('/pv/video?id=' + encodeURIComponent(started.id))
    assert.equal(full.code, 200); assert.equal(full.headers['content-type'], 'video/mp4')
    assert.equal(full.bytes.length, 1600)
    assert.equal(full.headers['content-disposition'], undefined, 'playback must stay inline')
    const download = await f.request('/pv/video?id=' + encodeURIComponent(started.id) + '&download=1')
    assert.equal(download.code, 200)
    assert.match(download.headers['content-disposition'] || '', /^attachment; filename="DeepMoYu-[0-9A-Za-z-]+\.mp4"$/)
    const partial = await f.request('/pv/video?id=' + encodeURIComponent(started.id), undefined, 'GET', { range: 'bytes=10-19' })
    assert.equal(partial.code, 206); assert.equal(partial.bytes.length, 10)
    assert.equal(partial.headers['content-range'], 'bytes 10-19/1600')
    const invalid = await f.request('/pv/video?id=' + encodeURIComponent(started.id), undefined, 'GET', { range: 'bytes=1600-' })
    assert.equal(invalid.code, 416)
    await f.execute({ action: 'status' }, made.sessionId); await f.request('/pv')
    assert.equal(count(f, 'complete'), 1); assert.equal(count(f, 'prompt'), 1)
    assert.equal(f.spawned.filter(call => /pv_verify\.py$/.test(call.args[0])).length, 1)
    assert.equal(f.spawned.some(call => /pv_plan\.py$/.test(call.args[0])), false)
  } finally { f.cleanup() }
})
