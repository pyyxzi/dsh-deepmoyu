import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { apply } from '../index.js'
import { McpClient } from '../lib/mcp.mjs'

const require = createRequire(import.meta.url)
const childProcess = require('node:child_process')
const immediate = () => new Promise(resolve => setImmediate(resolve))
const startingUsage = () => ({ uncachedInputTokens: 400, cacheReadTokens: 80, cacheWriteTokens: 20, outputTokens: 50 })
const noCacheUsage = (input, output) => ({ uncachedInputTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: output })

// All services, timers, subprocesses and MCP responses belong to this fixture.
// The host is applied normally; no Python process, account or HTTP server is used.
async function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'fish-manual-browsing-'))
  const home = join(root, 'bili-duty')
  mkdirSync(home)
  const dummy = join(root, 'never-executed.js')
  writeFileSync(dummy, '// subprocesses are forbidden in this fixture')
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    dshBin: dummy, pythonPath: 'fixture-python-never-executed',
    reportLevel: 'off', learnAutoReview: false, peakValley: false, pvAuto: false,
    autoComment: false, autoReplyDm: false, autoMoment: false,
    stickerAutoCollect: false, stickerAutoSend: false,
    sessionTokenBudget: 0, sessionMinutes: 0, sessionMaxRounds: 4,
  }))
  const cleanups = [], listeners = new Map(), tools = new Map(), calls = [], spawned = [], networkCalls = []
  const agents = [], usage = new Map(), presets = new Map(), goalsById = new Map(), goalChanges = []
  let handler, goalSequence = 0, turnSequence = 0
  const goals = {
    get: agent => goalsById.get(agent.id),
    create(agent, options) {
      goalChanges.push({ action: 'create', agent: agent.id, options })
      const goal = { id: `goal-${++goalSequence}`, objective: options.objective, maxGoalRounds: options.maxGoalRounds, roundsStarted: 1, revision: 1, phase: 'active', activation: 'armed' }
      goalsById.set(agent.id, goal)
      return goal
    },
    pause(agent) {
      goalChanges.push({ action: 'pause', agent: agent.id })
      const goal = goalsById.get(agent.id)
      if (goal) Object.assign(goal, { phase: 'paused', activation: 'disarmed', revision: goal.revision + 1 })
      return goal
    },
    resume(agent) {
      goalChanges.push({ action: 'resume', agent: agent.id })
      const goal = goalsById.get(agent.id)
      if (goal) Object.assign(goal, { phase: 'active', activation: 'armed', revision: goal.revision + 1 })
      return goal
    },
    clear(agent) {
      goalChanges.push({ action: 'clear', agent: agent.id })
      const goal = goalsById.get(agent.id)
      goalsById.delete(agent.id)
      return goal
    },
  }
  const services = {
    dshHomePath: (...parts) => join(root, ...parts), goals,
    agents: { get: id => agents.find(agent => agent.id === id), list: () => agents },
    sessionController: { agents: { selectionFor: () => ({ current: { provider: 'fixture', model: 'manual' } }) } },
    sessionProjections: { stateOf(session, key) {
      if (key === 'agentPreset') return presets.get(session.id)
      if (key === 'tokenUsage') return { totals: usage.get(session.id) }
    } },
  }
  const ctx = {
    get: key => services[key], logger: { info() {} }, settings: { describe: () => [] },
    tools: { register(spec) { tools.set(spec.name, spec); return spec } },
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(listener)
      return () => listeners.get(name)?.delete(listener)
    },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } },
  }
  const originals = {
    timeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    interval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
    spawn: childProcess.spawn, call: McpClient.prototype.call, fetch: globalThis.fetch,
    role: process.env.BILI_DUTY_ROLE, dutyHome: process.env.BILI_DUTY_HOME,
  }
  const timer = () => ({ unref() {}, cleared: false })
  globalThis.setTimeout = () => timer()
  globalThis.clearTimeout = value => { if (value) value.cleared = true }
  globalThis.setInterval = () => timer()
  globalThis.clearInterval = value => { if (value) value.cleared = true }
  delete process.env.BILI_DUTY_ROLE
  delete process.env.BILI_DUTY_HOME
  globalThis.fetch = async (...args) => {
    networkCalls.push(args)
    throw new Error('MANUAL_BROWSING_FIXTURE: unexpected network request')
  }
  childProcess.spawn = (...args) => {
    spawned.push(args)
    throw new Error('MANUAL_BROWSING_FIXTURE: unexpected subprocess')
  }
  syncBuiltinESMExports()
  McpClient.prototype.call = async function(name, args) {
    calls.push({ name, args })
    if (name === 'bili_search') return { videos: [] }
    if (name === 'bili_subtitle') return { text: '隔离字幕样本', segments: [{ from: 0, to: 1, content: '隔离字幕样本' }] }
    if (name === 'bili_comments') return { comments: [] }
    if (name === 'bili_rank' || name === 'bili_hot_videos') return { videos: [] }
    if (name === 'bili_buzzwords') return { keywords: ['隔离热词'] }
    return { ok: true, count: 0, items: [], comments: [], videos: [] }
  }
  async function flush() { await immediate(); await immediate() }
  async function emit(name, ...args) {
    for (const listener of [...(listeners.get(name) || [])]) await listener(...args)
    await flush()
  }
  const addAgent = (id = 'manual-fish', preset = 'dafeiyu') => {
    const cancelled = []
    const agent = {
      id, status: 'idle', session: { id, header: { ...(preset == null ? {} : { agentPreset: preset }), cwd: root } }, cancelled,
      cancel(...args) { cancelled.push(args) },
    }
    agents.push(agent)
    presets.set(id, preset)
    usage.set(id, startingUsage())
    return agent
  }
  const setUsage = (agent, input, output) => usage.set(agent.id, noCacheUsage(input, output))
  const clearUsage = agent => usage.delete(agent.id)
  async function running(agent) { agent.status = 'running'; await emit('agent/status', { agent, status: 'running' }) }
  async function idle(agent) { agent.status = 'idle'; await emit('agent/status', { agent, status: 'idle' }) }
  async function turnStart(agent, turn = ++turnSequence) {
    await emit('session/event', agent.session, { type: 'turn/start', data: { turn } })
    return turn
  }
  async function turnEnd(agent, turn, kind = 'completed') {
    await emit('session/event', agent.session, { type: 'turn/end', data: { turn, reason: { kind } } })
  }
  async function selectPreset(agent, preset) {
    presets.set(agent.id, preset)
    agent.session.header.agentPreset = preset
    await emit('agent-preset/selected', agent.id, preset)
  }
  async function execute(agent, name, args = {}) {
    assert.ok(tools.has(name), `missing registered tool: ${name}`)
    return tools.get(name).execute(args, { agent })
  }
  async function request(path, body, method = 'GET') {
    const req = new EventEmitter()
    Object.assign(req, { url: '/api/bili-duty' + path, method, headers: {}, destroy() {} })
    const res = {
      headersSent: false, writableEnded: false,
      writeHead(code) { this.code = code; this.headersSent = true },
      end(text) { this.body = JSON.parse(text); this.writableEnded = true },
    }
    const pending = handler(req, res)
    if (method === 'POST') { req.emit('data', Buffer.from(JSON.stringify(body || {}))); req.emit('end') }
    await pending
    await flush()
    assert.equal(res.code, 200, JSON.stringify(res.body))
    return res.body
  }
  try {
    apply(ctx, {})
    await flush()
    assert.equal(typeof handler, 'function')
    await run({ addAgent, setUsage, clearUsage, running, idle, turnStart, turnEnd, selectPreset, execute, request, emit, flush, calls, goalsById, goalChanges })
    assert.deepEqual(spawned, [], 'manual tool execution must not start a worker or Python process')
    assert.deepEqual(networkCalls, [], 'manual fixture must never reach an account or external endpoint')
  } finally {
    try {
      const cleanupErrors = []
      for (const cleanup of cleanups.reverse()) {
        try { await cleanup() } catch (error) { cleanupErrors.push(error) }
      }
      await flush()
      assert.deepEqual(cleanupErrors, [], 'all fixture effects dispose cleanly')
    } finally {
      globalThis.setTimeout = originals.timeout
      globalThis.clearTimeout = originals.clearTimeout
      globalThis.setInterval = originals.interval
      globalThis.clearInterval = originals.clearInterval
      childProcess.spawn = originals.spawn
      globalThis.fetch = originals.fetch
      McpClient.prototype.call = originals.call
      syncBuiltinESMExports()
      if (originals.role === undefined) delete process.env.BILI_DUTY_ROLE
      else process.env.BILI_DUTY_ROLE = originals.role
      if (originals.dutyHome === undefined) delete process.env.BILI_DUTY_HOME
      else process.env.BILI_DUTY_HOME = originals.dutyHome
      rmSync(root, { recursive: true, force: true })
    }
  }
}

function assertTotals(status, total) {
  assert.equal(status.tokensTotal, total, 'cumulative usage includes only browsing requests')
  assert.equal(status.tokensToday, total, 'today usage matches cumulative in the isolated fixture')
}

function assertSingleEntry(status, input, output, ended = true) {
  assert.equal(status.tokenRounds.entries.length, 1, 'tools in one turn share one ledger entry')
  const entry = status.tokenRounds.entries[0]
  assert.equal(entry.kind, 'session')
  assert.equal(entry.tokensUnknown, false)
  assert.deepEqual(entry.tokens, { input, output, total: input + output })
  assert.equal(Boolean(entry.endedAt), ended)
  return entry
}

test('manual content tools show running without a goal and account the whole request exactly once', async () => {
  await withFixture(async f => {
    const agent = f.addAgent()
    const before = await f.request('/status')
    assertTotals(before, 0)
    assert.equal(before.feiyu.active, false)
    await f.running(agent)
    f.setUsage(agent, 550, 60)
    const turn = await f.turnStart(agent)
    f.setUsage(agent, 600, 70)
    await f.execute(agent, 'bili_search', { keyword: '隔离搜索', days: 7 })
    const active = await f.request('/status?rev=' + encodeURIComponent(before.rev))
    assert.notEqual(active.unchanged, true, 'claiming a manual request invalidates the previous status revision')
    assert.equal(active.feiyu.active, true)
    assert.equal(active.feiyu.goal, null)
    assert.equal(active.feiyu.source, 'manual')
    assert.equal(active.feiyu.sessionId, agent.id)
    assert.equal(active.feiyu.tokens.thisRun, 120, 'baseline precedes the first tool, including input already spent to select it')
    assert.deepEqual(f.goalChanges, [], 'manual browsing never creates or modifies a goal')
    const activity = await f.request('/activity')
    assert.equal(activity.live.active, true)
    assert.equal(activity.live.thinking, true)
    await f.execute(agent, 'bili_subtitle', { bvid: 'BV1234567890' })
    await f.execute(agent, 'bili_comments', { bvid: 'BV1234567890', num: 3 })
    f.setUsage(agent, 650, 90)
    await f.turnEnd(agent, turn)
    await f.idle(agent)
    const ended = await f.request('/status?rev=' + encodeURIComponent(active.rev))
    assert.notEqual(ended.unchanged, true, 'ending the manual request invalidates the active status revision')
    assert.equal(ended.feiyu.active, false)
    assert.equal(ended.feiyu.goal, null)
    assert.equal(ended.feiyu.tokens.thisRun, 190, 'recent-run usage remains available to the pet menu')
    assertTotals(ended, 190)
    const entry = assertSingleEntry(ended, 150, 40)
    assert.equal((await f.request('/activity')).live.active, false)
    const unchanged = await f.request('/status?rev=' + encodeURIComponent(ended.rev))
    assert.equal(unchanged.unchanged, true)
    await f.idle(agent)
    await f.turnEnd(agent, turn)
    const repeated = await f.request('/status')
    assertTotals(repeated, 190)
    assert.equal(assertSingleEntry(repeated, 150, 40).id, entry.id)
    assert.equal(f.calls.filter(call => call.name === 'bili_search').length, 1)
  })
})

test('zero measured usage stays zero while manual start and end still invalidate status revisions', async () => {
  await withFixture(async f => {
    const agent = f.addAgent('manual-measured-zero', 'default')
    const before = await f.request('/status')
    await f.running(agent)
    const turn = await f.turnStart(agent)
    await f.execute(agent, 'bili_search', { keyword: '真实零增量', days: 7 })
    const active = await f.request('/status?rev=' + encodeURIComponent(before.rev))
    assert.notEqual(active.unchanged, true)
    assert.equal(active.feiyu.active, true)
    assert.equal(active.feiyu.tokens.thisRun, 0)
    await f.turnEnd(agent, turn)
    const ended = await f.request('/status?rev=' + encodeURIComponent(active.rev))
    assert.notEqual(ended.unchanged, true, 'activity ending changes rev even when no token or tool-event count changes')
    assert.equal(ended.feiyu.active, false)
    assert.equal(ended.feiyu.tokens.thisRun, 0)
    assertTotals(ended, 0)
    assertSingleEntry(ended, 0, 0)
    await f.idle(agent)
    assertTotals(await f.request('/status'), 0)
  })
})

test('session turn events capture the request baseline even without a running notification', async () => {
  await withFixture(async f => {
    const agent = f.addAgent('turn-events-only', 'default')
    agent.status = 'running'
    const turn = await f.turnStart(agent)
    f.setUsage(agent, 600, 70)
    await f.execute(agent, 'bili_rank', { category: 'knowledge', day: 3 })
    assert.equal((await f.request('/status')).feiyu.active, true)
    f.setUsage(agent, 650, 90)
    await f.turnEnd(agent, turn)
    const status = await f.request('/status')
    assert.equal(status.feiyu.active, false, 'turn/end closes manual activity before the later idle event')
    assertTotals(status, 190)
    assertSingleEntry(status, 150, 40)
    await f.idle(agent)
    assertTotals(await f.request('/status'), 190)
  })
})

test('ordinary presets count each content entry point without entering the fish goal mode', async () => {
  await withFixture(async f => {
    let count = 0
    for (const [name, args] of [
      ['bili_buzzwords', {}], ['bili_hot_videos', { ps: 3 }],
      ['bili_subtitle', { bvid: 'BV1234567890' }], ['bili_comments', { bvid: 'BV1234567890', num: 3 }],
      ['bili_my_notices', { num: 3 }], ['bili_received_replies', {}],
      ['bili_dm_inbox', { num: 3 }], ['bili_dm_thread', { uid: '12345', num: 3 }],
    ]) {
      const agent = f.addAgent(`ordinary-${name}`, count % 2 ? 'default' : null)
      await f.running(agent)
      f.setUsage(agent, 600, 70)
      await f.execute(agent, name, args)
      const active = await f.request('/status')
      assert.equal(active.feiyu.active, true, `${name} alone proves actual browsing`)
      assert.equal(active.feiyu.sessionId, agent.id)
      assert.equal(active.feiyu.source, 'manual')
      assert.equal(active.feiyu.goal, null)
      const memory = await f.execute(agent, 'bili_soul', { action: 'stats' })
      assert.equal(memory.blocked, true, 'accounting for ordinary browsing does not enable fish persona memory')
      assert.equal(memory.reason, 'mode_required')
      f.setUsage(agent, 650, 90)
      await f.idle(agent)
      const status = await f.request('/status')
      assertTotals(status, ++count * 190)
      assert.equal(status.tokenRounds.entries.length, count)
      assert.ok(status.tokenRounds.entries.every(entry => entry.kind === 'session' && entry.endedAt && entry.tokens.total === 190))
    }
    assert.deepEqual(f.goalChanges, [])
  })
})

test('a fish preset and management tools alone do not claim or charge ordinary conversation', async () => {
  await withFixture(async f => {
    const agent = f.addAgent()
    await f.running(agent)
    const turn = await f.turnStart(agent)
    f.setUsage(agent, 600, 70)
    for (const [name, args] of [
      ['bili_status', {}], ['bili_config', {}], ['bili_pace', { kind: 'comment' }],
      ['bili_seen', { action: 'stats' }], ['bili_learn', { action: 'stats' }],
      ['bili_soul', { action: 'stats' }], ['bili_sticker', { action: 'list' }],
      ['bili_taste', { action: 'digest' }], ['bili_records', { type: 'activity', num: 1 }],
      ['bili_say', { text: '隔离测试里的普通记录。' }], ['bili_pv', { action: 'status' }],
      ['bili_feiyu', { action: 'status' }],
    ]) await f.execute(agent, name, args)
    const active = await f.request('/status')
    assert.equal(active.feiyu.active, false, 'management calls are not proof of browsing')
    assert.equal((await f.request('/activity')).live.active, false)
    f.setUsage(agent, 650, 90)
    await f.turnEnd(agent, turn)
    await f.idle(agent)
    const status = await f.request('/status')
    assertTotals(status, 0)
    assert.deepEqual(status.tokenRounds.entries, [])
    assert.deepEqual(f.goalChanges, [])
  })
})

test('manual browsing and preset exit leave an unrelated goal untouched', async () => {
  await withFixture(async f => {
    const agent = f.addAgent('foreign-goal-reader', 'dafeiyu')
    const goal = { id: 'foreign-goal', objective: '修复别的项目', phase: 'active', activation: 'armed', revision: 8, roundsStarted: 2, maxGoalRounds: 10 }
    f.goalsById.set(agent.id, structuredClone(goal))
    await f.running(agent)
    const turn = await f.turnStart(agent)
    f.setUsage(agent, 600, 70)
    await f.execute(agent, 'bili_search', { keyword: '独立查询', days: 7 })
    const active = await f.request('/status')
    assert.equal(active.feiyu.active, true)
    assert.equal(active.feiyu.source, 'manual')
    assert.equal(active.feiyu.goal, null, 'an unrelated goal never becomes a fish goal')
    f.setUsage(agent, 650, 90)
    await f.selectPreset(agent, 'another-preset')
    const exited = await f.request('/status')
    assert.equal(exited.feiyu.active, false)
    assertTotals(exited, 190)
    assertSingleEntry(exited, 150, 40)
    assert.deepEqual(f.goalsById.get(agent.id), goal)
    assert.deepEqual(f.goalChanges, [])
    assert.deepEqual(agent.cancelled, [], 'leaving a preset does not abort the unrelated goal task')
    await f.turnEnd(agent, turn)
    await f.idle(agent)
    assertTotals(await f.request('/status'), 190)
    assert.deepEqual(f.goalsById.get(agent.id), goal)
  })
})

test('later ordinary chat is excluded and the next browsing turn starts a fresh ledger entry', async () => {
  await withFixture(async f => {
    const agent = f.addAgent()
    await f.running(agent)
    let turn = await f.turnStart(agent)
    f.setUsage(agent, 600, 70)
    await f.execute(agent, 'bili_search', { keyword: '第一轮', days: 7 })
    f.setUsage(agent, 650, 90)
    await f.turnEnd(agent, turn)
    await f.idle(agent)
    assertTotals(await f.request('/status'), 190)
    await f.running(agent)
    turn = await f.turnStart(agent)
    f.setUsage(agent, 900, 140)
    await f.turnEnd(agent, turn)
    await f.idle(agent)
    const afterChat = await f.request('/status')
    assertTotals(afterChat, 190)
    assertSingleEntry(afterChat, 150, 40)
    assert.equal(afterChat.feiyu.tokens.thisRun, 190, 'ordinary chat does not inflate the recent browsing run')
    await f.running(agent)
    turn = await f.turnStart(agent)
    f.setUsage(agent, 920, 145)
    await f.execute(agent, 'bili_hot_videos', { ps: 3 })
    f.setUsage(agent, 950, 160)
    await f.turnEnd(agent, turn)
    await f.idle(agent)
    const afterSecond = await f.request('/status')
    assertTotals(afterSecond, 260)
    assert.equal(afterSecond.feiyu.tokens.thisRun, 70)
    assert.equal(afterSecond.tokenRounds.entries.length, 2)
    assert.deepEqual(afterSecond.tokenRounds.entries.map(entry => entry.tokens.total).sort((a, b) => a - b), [70, 190])
    assert.equal(new Set(afterSecond.tokenRounds.entries.map(entry => entry.id)).size, 2)
    assert.ok(afterSecond.tokenRounds.entries.every(entry => entry.endedAt))
  })
})

test('starting a continuous goal closes manual usage before the new goal baseline', async () => {
  await withFixture(async f => {
    const agent = f.addAgent('manual-to-goal')
    await f.running(agent)
    const turn = await f.turnStart(agent)
    f.setUsage(agent, 600, 70)
    await f.execute(agent, 'bili_search', { keyword: '转连续模式前', days: 7 })
    f.setUsage(agent, 650, 90)
    const started = await f.execute(agent, 'bili_feiyu', { action: 'start', maxRounds: 4 })
    assert.equal(started.ok, true)
    const transitioned = await f.request('/status')
    assertTotals(transitioned, 190)
    assert.equal(transitioned.feiyu.active, true)
    assert.ok(transitioned.feiyu.goal)
    assert.equal(transitioned.feiyu.tokens.thisRun, 0, 'goal baseline starts after the manual request was settled')
    assert.equal(f.goalChanges.filter(change => change.action === 'create').length, 1)
    f.setUsage(agent, 700, 100)
    await f.turnEnd(agent, turn)
    await f.idle(agent)
    const status = await f.request('/status')
    assertTotals(status, 250)
    assert.equal(status.feiyu.tokens.thisRun, 60)
    const stopped = await f.execute(agent, 'bili_feiyu', { action: 'stop' })
    assert.equal(stopped.ok, true)
    const final = await f.request('/status')
    assertTotals(final, 250)
    assert.equal(final.tokenRounds.entries.length, 2)
    assert.deepEqual(final.tokenRounds.entries.map(entry => entry.tokens.total).sort((a, b) => a - b), [60, 190])
    assert.deepEqual(final.tokenRounds.entries.find(entry => entry.tokens.total === 60).tokens, { input: 50, output: 10, total: 60 })
    assert.ok(final.tokenRounds.entries.every(entry => entry.endedAt))
    await f.idle(agent)
    assertTotals(await f.request('/status'), 250)
  })
})

for (const resumeAction of ['resume', 'start']) {
  test(`a paused goal resumed through ${resumeAction} excludes pause-gap chat and separately charged manual browsing`, async () => {
    await withFixture(async f => {
      const agent = f.addAgent(`paused-goal-${resumeAction}`)
      await f.request('/config', { sessionTokenBudget: 5000, sessionMinutes: 30 }, 'POST')
      await f.running(agent)
      let turn = await f.turnStart(agent)
      const started = await f.execute(agent, 'bili_feiyu', { action: 'start', maxRounds: 4 })
      assert.equal(started.ok, true)
      const originalGoal = structuredClone(f.goalsById.get(agent.id))
      const original = (await f.request('/status')).feiyu
      assert.equal(original.tokens.budget, 5000)
      assert.ok(original.deadlineAt > Date.now())
      f.setUsage(agent, 550, 60)
      await f.turnEnd(agent, turn)
      await f.idle(agent)
      assertTotals(await f.request('/status'), 60)
      const stopped = await f.execute(agent, 'bili_feiyu', { action: 'stop' })
      assert.equal(stopped.ok, true)
      const paused = await f.request('/status')
      const initialEntry = assertSingleEntry(paused, 50, 10)
      assert.equal(paused.feiyu.active, false)

      await f.running(agent)
      turn = await f.turnStart(agent)
      f.setUsage(agent, 800, 110)
      await f.turnEnd(agent, turn)
      await f.idle(agent)
      assertTotals(await f.request('/status'), 60)

      await f.running(agent)
      turn = await f.turnStart(agent)
      f.setUsage(agent, 900, 130)
      await f.execute(agent, 'bili_search', { keyword: `暂停期手动-${resumeAction}`, days: 7 })
      f.setUsage(agent, 950, 150)
      await f.turnEnd(agent, turn)
      await f.idle(agent)
      const afterManual = await f.request('/status')
      assertTotals(afterManual, 250)
      assert.equal(afterManual.feiyu.tokens.thisRun, 190)
      const manualEntry = afterManual.tokenRounds.entries.find(entry => entry.id !== initialEntry.id)
      assert.deepEqual(manualEntry.tokens, { input: 150, output: 40, total: 190 })
      assert.ok(manualEntry.endedAt)
      assert.equal(f.goalsById.get(agent.id).phase, 'paused')

      await f.running(agent)
      turn = await f.turnStart(agent)
      f.setUsage(agent, 1050, 170)
      await f.turnEnd(agent, turn)
      await f.idle(agent)
      assertTotals(await f.request('/status'), 250)

      await f.running(agent)
      turn = await f.turnStart(agent)
      const resumed = await f.execute(agent, 'bili_feiyu', { action: resumeAction })
      assert.equal(resumed.ok, true)
      const ready = await f.request('/status')
      assertTotals(ready, 250)
      assert.equal(ready.feiyu.active, true)
      assert.equal(ready.feiyu.source, 'goal')
      assert.equal(ready.feiyu.goal.id, originalGoal.id)
      assert.equal(ready.feiyu.tokens.thisRun, 60, 'the same goal preserves only its prior active usage')
      assert.equal(ready.feiyu.tokens.budget, original.tokens.budget)
      assert.equal(ready.feiyu.deadlineAt, original.deadlineAt)
      assert.equal(ready.feiyu.model, original.model)
      assert.equal(f.goalChanges.filter(change => change.action === 'create').length, 1)
      assert.equal(f.goalChanges.filter(change => change.action === 'resume').length, 1)
      f.setUsage(agent, 1100, 180)
      await f.turnEnd(agent, turn)
      await f.idle(agent)
      const ended = await f.request('/status')
      assertTotals(ended, 310)
      assert.equal(ended.feiyu.tokens.thisRun, 120)
      assert.equal(ended.tokenRounds.entries.length, 3)
      assert.deepEqual(ended.tokenRounds.entries.find(entry => entry.id === initialEntry.id).tokens, { input: 50, output: 10, total: 60 })
      assert.deepEqual(ended.tokenRounds.entries.find(entry => entry.id === manualEntry.id).tokens, { input: 150, output: 40, total: 190 })
      const resumedEntry = ended.tokenRounds.entries.find(entry => ![initialEntry.id, manualEntry.id].includes(entry.id))
      assert.deepEqual(resumedEntry.tokens, { input: 50, output: 10, total: 60 })
      assert.equal(ended.tokenRounds.entries.reduce((sum, entry) => sum + entry.tokens.total, 0), 310)
      await f.execute(agent, 'bili_feiyu', { action: 'stop' })
      const final = await f.request('/status')
      assertTotals(final, 310)
      assert.ok(final.tokenRounds.entries.every(entry => entry.endedAt))
      await f.idle(agent)
      assertTotals(await f.request('/status'), 310)
    })
  })
}

test('disposing a manual browsing agent closes its ledger without relying on a final idle event', async () => {
  await withFixture(async f => {
    const agent = f.addAgent('manual-dispose', 'default')
    await f.running(agent)
    const turn = await f.turnStart(agent)
    f.setUsage(agent, 600, 70)
    await f.execute(agent, 'bili_search', { keyword: '销毁前查询', days: 7 })
    f.setUsage(agent, 650, 90)
    await f.emit('agent/disposed', { agent })
    const status = await f.request('/status')
    assert.equal(status.feiyu.active, false)
    assertTotals(status, 190)
    assertSingleEntry(status, 150, 40)
    await f.turnEnd(agent, turn)
    await f.idle(agent)
    assertTotals(await f.request('/status'), 190)
  })
})

test('resetting completed manual usage does not refill it on repeated idle or status polling', async () => {
  await withFixture(async f => {
    const agent = f.addAgent('manual-reset')
    await f.running(agent)
    const turn = await f.turnStart(agent)
    f.setUsage(agent, 600, 70)
    await f.execute(agent, 'bili_search', { keyword: '清零前查询', days: 7 })
    f.setUsage(agent, 650, 90)
    await f.turnEnd(agent, turn)
    await f.idle(agent)
    assertTotals(await f.request('/status'), 190)
    const reset = await f.request('/config', { resetTokensTotal: true }, 'POST')
    assert.equal(reset.ok, true)
    const cleared = await f.request('/status')
    assertTotals(cleared, 0)
    assert.deepEqual(cleared.tokenRounds.entries, [])
    await f.idle(agent)
    await f.turnEnd(agent, turn)
    const repeated = await f.request('/status')
    assertTotals(repeated, 0)
    assert.deepEqual(repeated.tokenRounds.entries, [])
  })
})

test('resetting an active manual request rebases usage and starts a new ledger without refilling cleared tokens', async () => {
  await withFixture(async f => {
    const agent = f.addAgent('manual-active-reset')
    await f.running(agent)
    const turn = await f.turnStart(agent)
    f.setUsage(agent, 600, 70)
    await f.execute(agent, 'bili_search', { keyword: '运行时清零前', days: 7 })
    assertTotals(await f.request('/status'), 120)
    const reset = await f.request('/config', { resetTokensTotal: true }, 'POST')
    assert.equal(reset.ok, true)
    const cleared = await f.request('/status')
    assertTotals(cleared, 0)
    assert.equal(cleared.feiyu.active, true)
    assert.equal(cleared.feiyu.tokens.thisRun, 0)
    assertSingleEntry(cleared, 0, 0, false)
    f.setUsage(agent, 650, 90)
    await f.turnEnd(agent, turn)
    await f.idle(agent)
    const ended = await f.request('/status')
    assertTotals(ended, 70)
    assert.equal(ended.feiyu.tokens.thisRun, 70)
    const entry = assertSingleEntry(ended, 50, 20)
    await f.idle(agent)
    const repeated = await f.request('/status')
    assertTotals(repeated, 70)
    assert.equal(assertSingleEntry(repeated, 50, 20).id, entry.id)
  })
})

test('missing manual token projections remain unknown instead of reporting measured zero', async () => {
  await withFixture(async f => {
    const agent = f.addAgent('manual-unmetered', 'default')
    f.clearUsage(agent)
    await f.running(agent)
    const turn = await f.turnStart(agent)
    await f.execute(agent, 'bili_search', { keyword: '未计量查询', days: 7 })
    const active = await f.request('/status')
    assert.equal(active.feiyu.active, true)
    assert.equal(active.feiyu.source, 'manual')
    assert.equal(active.feiyu.tokens.thisRun, null)
    assert.equal(active.feiyu.tokens.tokensUnknown, true)
    await f.turnEnd(agent, turn)
    await f.idle(agent)
    const ended = await f.request('/status')
    assert.equal(ended.feiyu.active, false)
    assert.equal(ended.feiyu.tokens.thisRun, null)
    assert.equal(ended.tokenRounds.entries.length, 1)
    assert.equal(ended.tokenRounds.entries[0].tokensUnknown, true)
    assert.equal(ended.tokenRounds.entries[0].tokens, null)
    assert.ok(ended.tokenRounds.entries[0].endedAt)
    assertTotals(ended, 0)
  })
})

test('stopping a goal-free manual request uses the host cancellation contract and settles once', async () => {
  await withFixture(async f => {
    const agent = f.addAgent('manual-stop', 'default')
    await f.running(agent)
    const turn = await f.turnStart(agent)
    f.setUsage(agent, 600, 70)
    await f.execute(agent, 'bili_search', { keyword: '停止前查询', days: 7 })
    f.setUsage(agent, 650, 90)
    const stopped = await f.request('/feiyu', { action: 'stop' }, 'POST')
    assert.equal(stopped.ok, true, 'the existing settings stop route finds a goal-free manual run')
    assert.deepEqual(agent.cancelled, [[{ kind: 'user' }, { keepInbox: true }]])
    assert.deepEqual(f.goalChanges, [])
    const status = await f.request('/status')
    assert.equal(status.feiyu.active, false)
    assertTotals(status, 190)
    assertSingleEntry(status, 150, 40, false)
    f.setUsage(agent, 700, 100)
    await f.turnEnd(agent, turn, 'aborted')
    await f.idle(agent)
    const ended = await f.request('/status')
    assertTotals(ended, 250)
    assertSingleEntry(ended, 200, 50)
    await f.idle(agent)
    assertTotals(await f.request('/status'), 250)
  })
})
