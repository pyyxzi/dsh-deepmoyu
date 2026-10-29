import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { apply } from '../index.js'

test('pet routes isolate defaults, enforce session budgets and safely stop background', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pet-run-test-'))
  const home = join(root, 'bili-duty'); mkdirSync(home)
  const dummy = join(root, 'never-executed.js'); writeFileSync(dummy, '// never executed: spawn is mocked')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ dshBin: dummy, modelId: 'legacy/model', tokenBudget: 999999, maxRounds: 64, sessionModelId: 'saved/session', sessionTokenBudget: 9000, sessionMaxRounds: 16, sessionMinutes: 0, backgroundModelId: 'saved/background', backgroundTokenBudget: 7000, backgroundMinutes: 45 }))
  const workspace = { id: 'current-workspace', path: root, sessionIds: ['fish-b'] }, createRequests = []
  const permissionState = new Map()
  const session = id => ({ header: { agentPreset: 'dafeiyu', cwd: root }, append(type, data) {
    const state = permissionState.get(id) || {}
    if (type === 'sandbox/mode') state.sandbox = data.mode
    if (type === 'approval/policy') state.approval = data.policy
    permissionState.set(id, state)
  } })
  const scopedTools = () => ({ register() { return () => {} } })
  const a = { id: 'fish-a', status: 'running', session: session('fish-a'), ctx: { tools: scopedTools() } }
  const b = { id: 'fish-b', status: 'idle', session: session('fish-b'), ctx: { tools: scopedTools() } }
  permissionState.set(a.id, { sandbox: 'workspace-write', approval: 'ask' })
  permissionState.set(b.id, { sandbox: 'danger-full-access', approval: 'never' })
  const agents = [a, b], goalsById = new Map(), selections = new Map(agents.map(x => [x.id, { current: { provider: 'default', model: 'model' } }]))
  const usage = new Map(agents.map(x => [x.session, 0]))
  const events = new Map(), cleanup = [], timeouts = [], children = [], spawned = []
  let handler, seq = 0
  const goals = {
    get: agent => goalsById.get(agent.id),
    create(agent, { objective, maxGoalRounds }) { const goal = { id: 'g' + ++seq, objective, maxGoalRounds, roundsStarted: 1, revision: 1, phase: 'active', activation: 'armed' }; goalsById.set(agent.id, goal); return goal },
    pause(agent) { const g = goalsById.get(agent.id); g.phase = 'paused'; g.activation = 'disarmed'; return g },
    resume(agent) { const g = goalsById.get(agent.id); g.phase = 'active'; g.activation = 'armed'; return g },
    clear(agent) { const g = goalsById.get(agent.id); goalsById.delete(agent.id); return g },
  }
  const services = {
    dshHomePath: (...parts) => join(root, ...parts), goals,
    llm: { listProviders: () => ['explicit', 'saved', 'other'].map(id => ({ id })) },
    agents: { get: id => agents.find(a => a.id === id), list: () => agents },
    sessionController: { create: async request => { createRequests.push(request); workspace.sessionIds.push(a.id); return { sessionId: a.id } }, agents: { selectionFor: agent => selections.get(agent.id) } },
    workspaceRegistry: { list: () => [workspace], get: id => id === workspace.id ? workspace : undefined, resolveByPath: async path => path === root ? workspace : undefined },
    sessionProjections: { stateOf(session, key) { if (key === 'agentPreset') return 'dafeiyu'; if (key === 'tokenUsage') return { totals: { uncachedInputTokens: usage.get(session) || 0 } }; if (key === 'permissions') return permissionState.get(agents.find(a => a.session === session)?.id) } },
  }
  const ctx = { get: key => services[key], logger: { info() {} }, tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } }, settings: { describe: () => [] },
    on(name, fn) { events.set(name, fn); return () => events.delete(name) },
    effect(fn) { const c = fn(); if (typeof c === 'function') cleanup.push(c); return c },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } },
  }
  const actualTimeout = globalThis.setTimeout, actualClearTimeout = globalThis.clearTimeout, actualInterval = globalThis.setInterval, actualClearInterval = globalThis.clearInterval
  globalThis.setTimeout = (fn, ms) => { const timer = { fn, ms, cleared: false, unref() {} }; timeouts.push(timer); return timer }
  globalThis.clearTimeout = timer => { if (timer) timer.cleared = true }
  globalThis.setInterval = () => ({ unref() {} }); globalThis.clearInterval = () => {}
  const cp = createRequire(import.meta.url)('node:child_process'), actualSpawn = cp.spawn
  cp.spawn = (command, args, opts) => {
    spawned.push({ command, args, opts })
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null; child.killed = false
    child.kill = () => { child.killed = true; return true }; children.push(child); return child
  }; syncBuiltinESMExports()
  async function request(path, body, method = 'POST') {
    const req = new EventEmitter(); req.url = '/api/bili-duty' + path; req.method = method; req.headers = {}; req.destroy = () => {}
    const res = { headersSent: false, writableEnded: false, writeHead(code) { this.code = code; this.headersSent = true }, end(text) { this.body = JSON.parse(text); this.writableEnded = true } }
    const result = handler(req, res)
    if (method === 'POST') { req.emit('data', Buffer.from(JSON.stringify(body || {}))); req.emit('end') }
    await result; return { code: res.code, ...res.body }
  }
  try {
    apply(ctx, {})
    await new Promise(resolve => setImmediate(resolve))
    const created = await request('/pet/session-new', { sourceSessionId: b.id, workspaceId: workspace.id })
    assert.equal(created.ok, true); assert.equal(created.sessionId, a.id); assert.equal(created.workspaceId, workspace.id)
    assert.deepEqual(createRequests, [{ agentPreset: 'dafeiyu', workspaceId: workspace.id }])
    assert.equal(created.permissions.sandbox, 'danger-full-access'); assert.equal(created.permissions.approval, 'never')
    assert.ok(workspace.sessionIds.includes(a.id))
    const started = await request('/pet/start', { mode: 'session', sessionId: a.id, model: 'explicit/session', tokenBudget: 100, maxRounds: 23, durationMinutes: 1 })
    assert.equal(started.ok, true); assert.equal(started.maxRounds, 23); assert.equal(started.model, 'explicit/session')
    assert.equal(started.tokenBudget, 100); assert.equal(started.durationEnforcement, 'wall-clock-pause')
    const firstDeadline = timeouts.find(t => t.ms > 59000 && t.ms <= 60000)
    assert.ok(firstDeadline)
    let state = await request('/feiyu', {}, 'GET'); assert.equal(state.sessionId, a.id); assert.equal(state.tokens.budget, 100)
    const saved = await request('/config', { backgroundModelId: 'other/background', backgroundTokenBudget: 4000, backgroundMinutes: 999 })
    assert.equal(saved.config.backgroundMinutes, 180); assert.ok(saved.clamped.some(x => x.key === 'backgroundMinutes'))
    assert.equal(saved.config.sessionModelId, 'saved/session'); assert.equal(saved.config.modelId, 'legacy/model')
    state = await request('/feiyu', {}, 'GET'); assert.equal(state.tokens.budget, 100)
    usage.set(a.session, 101); events.get('agent/status')({ agent: a, status: 'idle' })
    const fuse = timeouts.findLast(t => t.ms === 1200); assert.ok(fuse); fuse.fn()
    assert.equal(goals.get(a).phase, 'paused')
    await request('/feiyu', { action: 'clear', sessionId: a.id })
    const second = await request('/pet/start', { mode: 'session', sessionId: a.id, tokenBudget: 0, maxRounds: 7, durationMinutes: 2 })
    assert.equal(second.ok, true); const secondGoal = goals.get(a).id
    firstDeadline.fn(); fuse.fn(); assert.equal(goals.get(a).id, secondGoal); assert.equal(goals.get(a).phase, 'active', 'stale deadline and token timers must not pause new run')
    await request('/pet/start', { mode: 'session', sessionId: b.id, tokenBudget: 0, durationMinutes: 0 })
    await request('/feiyu', { action: 'stop', sessionId: a.id }); assert.equal(goals.get(a).phase, 'paused'); assert.equal(goals.get(b).phase, 'active')
    const secondDeadline = timeouts.find(t => t.ms > 119000 && t.ms <= 120000)
    await request('/feiyu', { action: 'resume', sessionId: a.id }); secondDeadline.fn(); assert.equal(goals.get(a).phase, 'paused', 'wall clock timer must work while agent is running with no tool events')
    const blocked = await request('/pet/start', { mode: 'background', model: 'explicit/background', tokenBudget: 6000, durationMinutes: 3 })
    assert.equal(blocked.started, false, 'session fish still swimming ⇒ background start must refuse (double-draw guard)')
    await request('/feiyu', { action: 'stop', sessionId: b.id }); assert.equal(goals.get(b).phase, 'paused')
    const bg = await request('/pet/start', { mode: 'background', model: 'explicit/background', tokenBudget: 6000, durationMinutes: 3 })
    assert.equal(bg.started, true); assert.equal(bg.tokenBudgetEnforcement, 'advisory'); assert.equal(bg.backgroundRun.durationMinutes, 3)
    assert.equal(spawned.length, 1); assert.match(spawned[0].args.at(-1), /6000/)
    const overlay = readFileSync(join(home, 'headless-overlay.yml'), 'utf8'); assert.match(overlay, /provider: 'dafeiyu-parent'/); assert.match(overlay, /model: 'explicit\/background'/)
    assert.match(overlay, /model-relay-adapter\.mjs/)
    assert.doesNotMatch(overlay, /BILI_DUTY_RELAY_CAPABILITY/)
    assert.match(spawned[0].opts.env.BILI_DUTY_RELAY_CAPABILITY, /^[a-f0-9]{64}$/)
    const config = await request('/config', {}, 'GET'); assert.equal(config.config.modelId, 'legacy/model'); assert.equal(config.config.backgroundModelId, 'other/background')
    assert.equal((await request('/feiyu', {}, 'GET')).sessionId, b.id, 'untargeted control prefers an active fish over paused sessions')
    const stopped = await request('/pet/stop', {}); assert.equal(stopped.ok, true); assert.equal(children[0].killed, true); assert.equal(goals.get(b).phase, 'paused', 'pet/stop must not touch session fish')
    assert.equal((await request('/pet/start', { mode: 'background' })).busy, true, 'do not overlap workers until actual exit')
    const bgDeadline = timeouts.find(t => t.ms > 179000 && t.ms <= 180000); assert.ok(bgDeadline)
    children[0].emit('close', null)
    const again = await request('/pet/start', { mode: 'background', durationMinutes: 4 }); assert.ok(again.started)
    bgDeadline.fn(); assert.equal(children[1].killed, false, 'old deadline cannot kill replacement background run')
    const newDeadline = timeouts.find(t => t.ms > 239000 && t.ms <= 240000); assert.ok(newDeadline); newDeadline.fn(); assert.equal(children[1].killed, true)
    children[1].emit('close', null)
    assert.equal((await request('/status', {}, 'GET')).backgroundRun.stopReason, 'time-limit')
    const logs = await request('/pet/log?n=500', {}, 'GET'); assert.ok(logs.entries.some(e => e.type === 'bg-done' && e.code === null && e.reason === 'user'))
    assert.equal((await request('/pet/start', { mode: 'bad' })).code, 400)
    assert.equal((await request('/pet/start', { mode: 'session' })).code, 400)
    assert.equal((await request('/pet/start', { mode: 'session', sessionId: 'missing' })).ok, false)
  } finally {
    for (const fn of cleanup.reverse()) { try { fn() } catch {} }
    globalThis.setTimeout = actualTimeout; globalThis.clearTimeout = actualClearTimeout; globalThis.setInterval = actualInterval; globalThis.clearInterval = actualClearInterval
    cp.spawn = actualSpawn; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true })
  }
})
