import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVideoStudio, migrateVideoSettings, videoRequest } from '../lib/pv-session.mjs'
import { productionGuide } from '../lib/pv-production.mjs'

function fixture(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fish-video-session-')), calls = [], agents = new Map(), goalState = new Map(), listeners = new Set()
  const workspace = { id: 'workspace', path: root, sessionIds: ['source'] }
  const makeAgent = (id, sandbox, approval) => {
    const state = { sandbox, approval }
    const session = { header: { cwd: root }, state, append(kind, data) {
      if (kind === 'sandbox/mode') state.sandbox = data.mode
      if (kind === 'approval/policy') state.approval = data.policy
    } }
    const agent = { id, session, cancel(reason, options) { calls.push(['cancel', id, reason, options]) } }
    agents.set(id, agent); return agent
  }
  makeAgent('source', 'read-only', 'never')
  let serial = 0, depsGate
  let current = { ok: true, stage: 'idle', id: '', running: false, productions: [], failures: [] }
  const config = { videoModelId: '', pvVoice: 'host-voice', ...extra.config }
  const goals = {
    get: agent => goalState.get(agent.id),
    create(agent, request) {
      calls.push(['goal', agent.id, request])
      const goal = { id: 'goal-' + ++serial, revision: 1, phase: 'active', activation: 'armed', ...request }
      goalState.set(agent.id, goal); return goal
    },
    disarm(agent) {
      calls.push(['disarm', agent.id])
      const goal = goalState.get(agent.id); if (goal) goal.activation = 'disarmed'
    },
    complete(agent, ref) {
      calls.push(['complete', agent.id, ref])
      const goal = goalState.get(agent.id)
      assert.equal(ref.id, goal.id); assert.equal(ref.revision, goal.revision)
      goal.phase = 'complete'; goal.activation = 'disarmed'; goal.revision++
    },
    pause(agent, ref) {
      calls.push(['pause', agent.id, ref])
      const goal = goalState.get(agent.id)
      assert.equal(ref.id, goal.id); assert.equal(ref.revision, goal.revision)
      goal.phase = 'paused'; goal.activation = 'disarmed'; goal.revision++
    },
  }
  const controller = {
    agents: { selectionFor: agent => agent && ({ current: { provider: 'source', model: 'model' } }) },
    async create(request) { calls.push(['create', request]); const id = 'created-' + agents.size; makeAgent(id, 'workspace-write', 'ask'); workspace.sessionIds.push(id); return { sessionId: id } },
    async selectModel(request) { calls.push(['select', request]); if (extra.unavailable) throw new Error('model unavailable'); return { selected: { provider: request.provider, model: request.model } } },
    async rename(request) { calls.push(['rename', request]) },
    async prompt(request) { calls.push(['prompt', request]); return { accepted: !extra.receiptRejected } },
  }
  const services = { sessionController: controller, goals, agents: { get: id => agents.get(id) },
    workspaceRegistry: { list: () => [workspace], get: id => id === workspace.id ? workspace : undefined },
    sessionProjections: { stateOf: session => session.state },
    agentDefaultModel: { currentSelection: () => ({ provider: 'default', model: 'model' }) } }
  const pv = { status: () => current, checkDeps: async () => { if (depsGate) await depsGate; return !extra.missingDeps },
    onSettled(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    stop() { calls.push(['stop']); current = { ...current, stage: 'stopped', running: false }; return { ok: true, stopped: true } },
    render(raw, opt) {
      calls.push(['render', raw, opt])
      current = { ...current, stage: 'cover', id: 'production-' + ++serial, running: true }
      return { ok: true, started: true, stage: current.stage, id: current.id, file: 'video.mp4', plan: 'plan.json', timeline: 'timeline.json', verification: 'verification.json', log: 'build.log' }
    } }
  const source = { id: 'event-1', eventId: 'event-1', date: '2026-10-21', kind: 'public-record', bvid: 'BV1Ab411c7xy', title: '当日公开活动', url: 'https://www.bilibili.com/video/BV1Ab411c7xy', excerpt: '保存的公开原文。' }
  let sources = [source]
  const options = { ctx: { get: key => services[key] }, stateDir: root, pv, config: () => config, publicSources: date => sources.filter(item => item.date === date) }
  const studios = [createVideoStudio(options)]
  return { studio: studios[0], options, calls, agents, config, controller, source, goals, goalState,
    setState: state => { current = { ...current, ...state } }, setSources: value => { sources = value },
    setDepsGate: promise => { depsGate = promise },
    reopen() { studios.at(-1).dispose(); const restored = createVideoStudio(options); studios.push(restored); return restored },
    async settle(result) { for (const listener of [...listeners]) await listener(result) },
    cleanup() { for (const studio of studios) studio.dispose(); rmSync(root, { recursive: true, force: true }) } }
}
const request = { date: '2026-10-21', mode: 'custom', targetDurationSec: 30, sourceSessionId: 'source', workspaceId: 'workspace', brief: '饭桌聊想法' }
const plan = () => ({ ...productionGuide().sample, targetDurationSec: 30, maxDurationSec: 33 })
const count = (f, name) => f.calls.filter(call => call[0] === name).length
const terminal = (rendered, changes = {}) => ({ ...rendered, ok: true, running: false, stage: 'done', verificationSkipped: false, ...changes })

test('video settings migrate old explicit/default keys without overwriting a newer selection', () => {
  const old = { pvModelId: 'saved/model', _set: ['pvModelId', 'paceFactor'], paceFactor: .73 }
  assert.deepEqual(migrateVideoSettings(old), { videoModelId: 'saved/model', _set: ['videoModelId', 'paceFactor'], paceFactor: .73 })
  assert.equal(old.pvModelId, 'saved/model')
  assert.equal(migrateVideoSettings({ pvModelId: 'old/model', videoModelId: 'new/model' }).videoModelId, 'new/model')
  for (const raw of [{ date: '2026-02-29' }, { mode: 'other' }, { targetDurationSec: 0 }, { targetDurationSec: '30' }, { model: 'no-slash' }, { brief: '鱼'.repeat(2001) }]) assert.throws(() => videoRequest(raw))
})

test('new video session inherits permissions and selects the production model before a single goal-driven first turn', async () => {
  const f = fixture()
  try {
    const result = await f.studio.start(request)
    assert.equal(result.ok, true, result.error)
    assert.equal(result.model, 'source/model')
    assert.deepEqual(f.calls.map(call => call[0]), ['create', 'select', 'rename', 'goal'])
    assert.deepEqual(f.calls[0][1], { agentPreset: 'dafeiyu', workspaceId: 'workspace' })
    assert.equal(result.permissions.sandbox, 'read-only'); assert.equal(result.permissions.approval, 'never')
    const goal = f.goalState.get(result.sessionId)
    assert.equal(goal.id, result.goalId); assert.equal(goal.activation, 'armed')
    assert.match(goal.objective, /整条视频/); assert.match(goal.objective, /action:"render"/)
    assert.match(goal.objective, /也不要启动刷站循环/)
    assert.equal(count(f, 'prompt'), 0); assert.equal(count(f, 'render'), 0)
    const prepared = f.studio.prepare({}, result.sessionId)
    assert.equal(prepared.request.targetDurationSec, 30)
    assert.match(prepared.guide.constraints[0], /targetDurationSec=30/)
    assert.deepEqual(prepared.sources, [f.source])
  } finally { f.cleanup() }
})

test('preview rejects a plan that is materially shorter than the session target', async () => {
  const f = fixture()
  try {
    const made = await f.studio.start(request)
    const tooShort = plan()
    tooShort.gap = 0
    tooShort.lead = 0
    tooShort.tail = 0
    tooShort.shots = Array.from({ length: 4 }, (_, i) => ({ id: `short-${i}`, speaker: 'fish', text: '鱼' }))
    assert.throws(() => f.studio.preview({ production: tooShort }, made.sessionId), /目标 30 秒的60%/)
  } finally { f.cleanup() }
})

test('saved/explicit/inherited model precedence is exact and unavailable dependencies or models never trigger fallback', async () => {
  for (const options of [{ config: { videoModelId: 'saved/model' } }, { config: { videoModelId: 'saved/model' }, explicit: 'explicit/model' }, { config: { videoModelId: 'saved/model' }, explicit: '' }, { unavailable: true }, { missingDeps: true }]) {
    const f = fixture(options)
    try {
      const result = await f.studio.start({ ...request, ...('explicit' in options ? { model: options.explicit } : {}) })
      if (options.unavailable || options.missingDeps) {
        assert.equal(result.ok, false)
        assert.equal(count(f, 'goal') + count(f, 'prompt') + count(f, 'render'), 0)
        if (options.unavailable) { assert.ok(result.sessionId); assert.equal(f.studio.list()[0].stage, 'failed') }
        else assert.equal(f.calls.length, 0)
      } else {
        assert.equal(result.ok, true, result.error)
        assert.equal(result.model, 'explicit' in options ? options.explicit || 'source/model' : 'saved/model')
      }
    } finally { f.cleanup() }
  }
})

test('render enforces agreement, preserves raw authoring and disarms polling only for the owning session', async () => {
  const f = fixture()
  try {
    const first = await f.studio.start(request), second = await f.studio.start(request)
    for (const change of [{ mode: 'rant' }, { date: '2026-10-20' }, { maxDurationSec: 34 }, { targetDurationSec: 29 }]) {
      assert.equal((await f.studio.render({ production: { ...plan(), ...change } }, first.sessionId)).ok, false)
    }
    assert.equal(count(f, 'render'), 0)
    const result = await f.studio.render({ production: JSON.stringify(plan()) }, first.sessionId)
    assert.equal(result.started, true, result.error)
    assert.equal(f.studio.status(first.sessionId).id, result.id)
    assert.equal(f.studio.status(second.sessionId).stage, 'authoring')
    assert.equal(f.goalState.get(first.sessionId).activation, 'disarmed')
    assert.equal(f.goalState.get(second.sessionId).activation, 'armed')
    const rendered = f.calls.find(call => call[0] === 'render')
    assert.equal(typeof rendered[1], 'string')
    assert.deepEqual(rendered[2], { date: request.date, voice: 'host-voice' })
    f.setState({ id: '', running: false, stage: 'idle', productions: [{ id: result.id, stage: 'done', file: 'video.mp4' }] })
    const restored = f.reopen()
    assert.equal(restored.status(first.sessionId).stage, 'done')
    assert.equal(restored.sessionRow(first.sessionId).verification, 'verification.json')
  } finally { f.cleanup() }
})

test('verified completion completes only its owned goal and delivers one terminal receipt in the original conversation', async () => {
  const f = fixture()
  try {
    const made = await f.studio.start(request), other = await f.studio.start(request)
    const rendered = await f.studio.render({ production: plan() }, made.sessionId)
    const result = terminal(rendered)
    f.setState({ ...result, productions: [result] })
    await f.settle(result); await f.settle(result)
    assert.equal(f.goalState.get(made.sessionId).phase, 'complete')
    assert.equal(f.goalState.get(other.sessionId).phase, 'active')
    assert.equal(count(f, 'complete'), 1); assert.equal(count(f, 'prompt'), 1)
    const receipt = f.calls.find(call => call[0] === 'prompt')[1]
    assert.equal(receipt.sessionId, made.sessionId)
    assert.equal(receipt.requestId, 'deepmoyu-video-terminal-' + result.id)
    assert.match(receipt.content[0].text, /"verified":true/)
    assert.match(receipt.content[0].text, /action:"status"/)
    assert.equal(f.studio.sessionRow(made.sessionId).terminalDelivered, result.id)
  } finally { f.cleanup() }
})

test('failed or skipped verification never completes the goal and still returns an honest failure receipt', async () => {
  for (const changes of [{ ok: false, stage: 'failed', error: 'audio verification failed' }, { verificationSkipped: true }]) {
    const f = fixture()
    try {
      const made = await f.studio.start(request), rendered = await f.studio.render({ production: plan() }, made.sessionId)
      await f.settle(terminal(rendered, changes))
      assert.equal(count(f, 'complete'), 0)
      assert.equal(f.goalState.get(made.sessionId).phase, 'active')
      assert.equal(f.goalState.get(made.sessionId).activation, 'disarmed')
      assert.equal(f.studio.sessionRow(made.sessionId).stage, 'failed')
      assert.match(f.calls.find(call => call[0] === 'prompt')[1].content[0].text, /"verified":false/)
    } finally { f.cleanup() }
  }
})

test('terminal delivery cannot complete or disarm a replacement user goal', async () => {
  const f = fixture()
  try {
    const made = await f.studio.start(request), rendered = await f.studio.render({ production: plan() }, made.sessionId)
    const replacement = { id: 'new-human-goal', revision: 2, phase: 'active', activation: 'armed' }
    f.goalState.set(made.sessionId, replacement)
    const before = count(f, 'disarm')
    await f.settle(terminal(rendered))
    assert.equal(count(f, 'complete'), 0); assert.equal(count(f, 'disarm'), before)
    assert.equal(replacement.activation, 'armed'); assert.equal(replacement.phase, 'active')
  } finally { f.cleanup() }
})

test('stopping authoring cancels the running turn and fences render, without stopping another production', async () => {
  const f = fixture()
  try {
    const first = await f.studio.start(request), second = await f.studio.start(request)
    const rendered = await f.studio.render({ production: plan() }, first.sessionId)
    const result = f.studio.stop(second.sessionId)
    assert.equal(result.stopped, true)
    assert.equal(count(f, 'stop'), 0)
    assert.equal(f.goalState.get(second.sessionId).phase, 'paused')
    const cancel = f.calls.find(call => call[0] === 'cancel')
    assert.deepEqual(cancel, ['cancel', second.sessionId, { kind: 'user' }, { keepInbox: true }])
    assert.equal((await f.studio.render({ production: plan() }, second.sessionId)).ok, false)
    assert.equal(f.studio.status(first.sessionId).id, rendered.id)
    assert.equal(f.studio.stop('unknown-session').stopped, false)
    assert.equal(count(f, 'stop'), 0)
    f.studio.stop(first.sessionId)
    await f.settle(terminal(rendered))
    assert.equal(count(f, 'stop'), 1); assert.equal(count(f, 'prompt'), 0); assert.equal(count(f, 'complete'), 0)
    assert.equal(f.studio.status(first.sessionId).stage, 'stopped')
  } finally { f.cleanup() }
})

test('a stop during an asynchronous dependency probe prevents the later render submission', async () => {
  const f = fixture()
  try {
    const made = await f.studio.start(request)
    let release
    f.setDepsGate(new Promise(resolve => { release = resolve }))
    const pending = f.studio.render({ production: plan() }, made.sessionId)
    f.studio.stop(made.sessionId); release()
    const result = await pending
    assert.equal(result.ok, false); assert.match(result.error, /停止/)
    assert.equal(count(f, 'render'), 0)
  } finally { f.cleanup() }
})

test('daily evidence is frozen across restart and rejects forged ids, source kinds, metadata and quotes', async () => {
  const f = fixture()
  try {
    const started = await f.studio.start({ ...request, mode: 'daily' })
    f.setSources([])
    const restored = f.reopen()
    assert.deepEqual(restored.prepare({}, started.sessionId).sources, [f.source])
    const raw = { ...plan(), mode: 'daily', sources: [{ ...f.source, id: 'activity' }] }
    raw.shots[0].source_ids = ['activity']; raw.shots[0].provenance = 'record-adaptation'
    for (const [key, value] of Object.entries({ eventId: 'invented', bvid: 'BV1Ab411c7xz', kind: 'public-video', title: '假标题', author: '假作者', url: 'https://www.bilibili.com/video/BV1Ab411c7xz', excerpt: '编造的原话' })) {
      const result = await restored.render({ production: { ...raw, sources: [{ ...raw.sources[0], [key]: value }] } }, started.sessionId)
      assert.equal(result.ok, false, key)
    }
    const quote = structuredClone(raw)
    quote.sources[0].excerpt = '编造的原话'
    quote.shots[0].provenance = 'source-quote'; quote.shots[0].text = '编造的原话'
    assert.equal((await restored.render({ production: quote }, started.sessionId)).ok, false)
    assert.equal(count(f, 'render'), 0)
    const valid = await restored.render({ production: raw }, started.sessionId)
    assert.equal(valid.started, true, valid.error)
  } finally { f.cleanup() }
})

test('receipt errors remain visible and disposing the studio suppresses terminal followups', async () => {
  const f = fixture({ receiptRejected: true })
  try {
    const made = await f.studio.start(request), rendered = await f.studio.render({ production: plan() }, made.sessionId)
    await f.settle(terminal(rendered))
    assert.match(f.studio.sessionRow(made.sessionId).receiptError, /未确认/)
    const before = count(f, 'prompt')
    f.studio.dispose()
    await f.settle(terminal(rendered))
    assert.equal(count(f, 'prompt'), before)
  } finally { f.cleanup() }
})
