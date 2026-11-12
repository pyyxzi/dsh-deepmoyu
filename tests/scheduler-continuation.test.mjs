import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'
import { dayKey } from '../lib/state.mjs'
import { McpClient } from '../lib/mcp.mjs'
import { createRelayClient } from '../lib/model-relay-adapter.mjs'
import { backgroundMcpRequest } from '../lib/background-mcp.mjs'

const RealDate = Date
const at = (h, m, day = 12) => new RealDate(2026, 10, day, h, m).getTime()
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)) }

/** Real scheduling/HTTP/state integration with owned synthetic children and no account transport. */
async function fixture(config, run) {
  const root = mkdtempSync(join(tmpdir(), 'fish-browsing-schedule-')), home = join(root, 'bili-duty')
  mkdirSync(home)
  const cli = join(root, 'synthetic-cli.js'); writeFileSync(cli, '// never executed')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ dshBin: cli, backgroundModelId: 'fixture/model', backgroundMinutes: 1,
    perDay: 0, reportLevel: 'off', learnAutoReview: false, idleChatter: false, pvAuto: false, updateMirror: false,
    autoComment: false, replyToComments: false, autoReplyDm: false, autoMoment: false, ...config }))
  const stateFile = join(home, 'state.json'), intervals = [], timers = [], children = [], cleanups = []
  writeFileSync(stateFile, '{}')
  const cp = createRequire(import.meta.url)('node:child_process')
  const originals = { spawn: cp.spawn, call: McpClient.prototype.call, Date, setTimeout, clearTimeout, setInterval, clearInterval }
  let now = at(12, 30), handler
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
  }
  const timer = (fn, ms) => ({ fn, ms, cancelled: false, unref() {}, fire() { if (!this.cancelled) return fn() } })
  globalThis.setTimeout = (fn, ms) => { const row = timer(fn, ms); timers.push(row); return row }
  globalThis.clearTimeout = row => { if (row) row.cancelled = true }
  globalThis.setInterval = (fn, ms) => { const row = timer(fn, ms); intervals.push(row); return row }
  globalThis.clearInterval = globalThis.clearTimeout
  cp.spawn = (command, args, options) => {
    assert.ok(options.env?.BILI_DUTY_RELAY_CAPABILITY)
    const child = new EventEmitter()
    Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, kill: () => true })
    children.push({ child, args, env: options.env }); return child
  }
  syncBuiltinESMExports()
  McpClient.prototype.call = async name => {
    if (name === 'bili_search') return { videos: [{ bvid: 'BV1234567890', title: '实际合成检索内容', duration: 120, pubdate: Math.floor(now / 1000) }] }
    if (name === 'bili_guard_status') return { seenVideos: {} }
    throw new Error('PLATFORM_IO_FORBIDDEN: ' + name)
  }
  const ctx = { logger: { info() {} }, settings: { describe: () => [] },
    get: key => key === 'llm' ? { listProviders: () => [{ id: 'fixture' }] } : key === 'dshHomePath' ? (...parts) => join(root, ...parts) : key === 'agents' ? { list: () => [] } : undefined,
    tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } }, on() { return () => {} },
    effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } },
  }
  const request = async (path, body = {}, method = 'POST') => {
    const req = new EventEmitter(); Object.assign(req, { url: '/api/bili-duty' + path, method, headers: {}, destroy() {} })
    const res = { writeHead(status) { this.status = status }, end(text) { this.body = JSON.parse(text) } }
    const pending = handler(req, res)
    if (method === 'POST') { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }
    await pending; await flush()
    assert.equal(res.status, 200, JSON.stringify(res.body)); return res.body
  }
  try {
    apply(ctx, {}); await flush()
    await run({ home, children, timers, request, now: () => now, advance: ms => { now += ms }, setTime: value => { now = value },
      state: () => JSON.parse(readFileSync(stateFile, 'utf8')),
      writeState: patch => writeFileSync(stateFile, JSON.stringify(patch)),
      status: () => request('/status', {}, 'GET'),
      async work(index, tool = 'bili_search') {
        const response = await backgroundMcpRequest({ id: index + 1, method: 'tools/call', params: { name: tool, arguments: tool === 'bili_search' ? { keyword: '合成实际检索' } : { kind: 'comment' } } }, createRelayClient(children[index].env))
        const result = JSON.parse(response.result.content[0].text)
        assert.notEqual(response.result.isError, true, JSON.stringify(result))
        assert.notEqual(result.ok, false, JSON.stringify(result)); return result
      },
      async dispose() { for (const off of cleanups.splice(0).reverse()) { try { await off() } catch {} }; await flush() },
      async spawnError(index) { children[index].child.exitCode = 1; children[index].child.emit('error', new Error('SYNTHETIC_SPAWN_FAILURE')); await flush() },
      tick: async () => { intervals.find(row => row.ms === 60000).fire(); await flush() },
      async close(index, code = 0) { children[index].child.exitCode = code; children[index].child.emit('close', code); await flush() },
    })
  } finally {
    for (const row of children) row.child.exitCode = 0
    for (const off of cleanups.reverse()) { try { await off() } catch {} }
    Object.assign(globalThis, { Date: originals.Date, setTimeout: originals.setTimeout, clearTimeout: originals.clearTimeout,
      setInterval: originals.setInterval, clearInterval: originals.clearInterval })
    cp.spawn = originals.spawn; McpClient.prototype.call = originals.call; syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
}

test('a stop in the background continuation gap cancels the pending child and keeps the window held', async () => fixture({
  backgroundMinutes: 15, backgroundWindowStart: '09:00', backgroundWindowEnd: '21:00',
}, async f => {
  assert.equal((await f.request('/pet/start', { mode: 'background' })).started, true)
  await f.close(0)
  const relay = f.timers.filter(row => row.ms === 2500).at(-1)
  assert.ok(relay, 'a clean early finish waits before continuing')
  await f.request('/config', { backgroundWindowEnd: '22:00' })
  await f.request('/pet/stop')
  relay.fire(); await flush()
  assert.equal(f.children.length, 1, 'manual stop must also stop work queued between children')
  assert.equal(f.state().bgWindowHold, at(21, 0))
  assert.equal(f.state().bgWindowHoldReason, 'manual')
}))

test('failed peak/valley launches release only their own claim and can retry in the same window', async () => fixture({
  peakValley: true, noon: true, night: false,
}, async f => {
  const key = dayKey() + ':noon'
  await f.tick()
  assert.equal(f.children.length, 1)
  await f.spawnError(0)
  assert.equal(f.state().windows?.[key], undefined)
  await f.tick()
  assert.equal(f.children.length, 2)
  const state = f.state()
  state.windows[key] = 'another-instance-newer-claim'
  f.writeState(state)
  await f.spawnError(1)
  assert.equal(f.state().windows[key], 'another-instance-newer-claim', 'a delayed failure cannot erase a newer owner')
}))

test('stale relay callbacks cannot start or cancel a newer run and disposal invalidates queued work', async () => fixture({
  backgroundMinutes: 15,
}, async f => {
  await f.request('/pet/start', { mode: 'background' })
  await f.close(0)
  const stale = f.timers.filter(row => row.ms === 2500).at(-1)
  const stopped = await f.request('/pet/stop')
  assert.equal(stopped.stopped, true)
  assert.equal(stopped.backgroundRun.continuationPending, false)
  assert.equal(stopped.backgroundRun.nextStartAt, 0)
  await f.request('/pet/start', { mode: 'background' })
  stale.fn(); await flush() // Simulate a timer callback which was already delivered when cancelled.
  assert.equal(f.children.length, 2)
  await f.close(1)
  const current = f.timers.filter(row => row.ms === 2500).at(-1)
  stale.fn(); await flush()
  current.fire(); await flush()
  assert.equal(f.children.length, 3, 'the old callback must not clear the new continuation token')
  await f.close(2)
  const disposed = f.timers.filter(row => row.ms === 2500).at(-1)
  await f.dispose()
  disposed.fn(); await flush()
  assert.equal(f.children.length, 3, 'dispose invalidates the identity even if a cancelled timer callback arrives')
}))

test('a late continuation callback cannot create work after the original deadline', async () => fixture({ backgroundMinutes: 15 }, async f => {
  const first = await f.request('/pet/start', { mode: 'background' })
  await f.close(0)
  const relay = f.timers.filter(row => row.ms === 2500).at(-1)
  f.setTime(first.backgroundRun.deadlineAt)
  relay.fire(); await flush()
  assert.equal(f.children.length, 1)
}))

test('an occupied background process does not consume a peak/valley window before it can launch', async () => fixture({
  peakValley: true, noon: true, night: false,
}, async f => {
  assert.equal((await f.request('/pet/start', { mode: 'background' })).started, true)
  await f.tick()
  assert.equal(f.children.length, 1)
  const key = dayKey() + ':noon'
  assert.equal(f.state().windows?.[key], undefined, 'a busy worker cannot consume this window')
  await f.request('/pet/stop'); await f.close(0)
  await f.tick()
  assert.equal(f.children.length, 2, 'the enabled noon window must remain eligible when the earlier process finishes')
}))

test('a scheduled relay retains the original absolute deadline and model across settings changes', async () => fixture({
  backgroundMinutes: 15, backgroundTokenBudget: 777,
}, async f => {
  const first = await f.request('/schedule', { scheduleEnabled: true, scheduleAllDay: true })
  assert.equal(first.started, true)
  const deadline = first.backgroundRun.deadlineAt
  f.advance(1000)
  await f.close(0)
  const relay = f.timers.filter(row => row.ms === 2500).at(-1)
  await f.request('/config', { backgroundModelId: 'fixture/changed', backgroundTokenBudget: 12345 })
  f.advance(2500); relay.fire(); await flush()
  assert.equal(f.children.length, 2)
  const result = await f.request('/pet/stop')
  assert.equal(result.backgroundRun.deadlineAt, deadline, 'ceil of remaining minutes must not extend the promised run')
  assert.equal(result.backgroundRun.model, first.model, 'settings edits apply to later tasks, not an existing relay')
  assert.equal(result.backgroundRun.tokenBudget, 777, 'the running task retains its chosen budget')
  await f.close(1)
}))

test('working background runs continue beyond eight relays and retain the original deadline', async () => fixture({ backgroundMinutes: 5 }, async f => {
  const started = await f.request('/pet/start', { mode: 'background' })
  const deadline = started.backgroundRun.deadlineAt
  for (let index = 0; index < 15; index++) {
    if (index >= 3) await f.work(index)
    f.advance(1000)
    await f.close(index)
    const status = await f.status(), state = status.backgroundRun
    assert.equal(state.workCalls, index >= 3 ? 1 : 0)
    assert.equal(state.noProgressStreak, index >= 3 ? 0 : index + 1, 'real work resets the preceding quick-exit streak')
    assert.equal(state.continuationPending, true, 'actual work remains eligible after relay ' + index)
    assert.equal(status.recovery.rows.find(row => row.id === 'background').state, 'waiting-retry')
    assert.equal(status.recovery.needsAction, false)
    assert.equal(state.deadlineAt, deadline)
    f.advance(2500)
    f.timers.filter(row => row.ms === 2500).at(-1).fire(); await flush()
    assert.equal(f.children.length, index + 2)
  }
  await f.request('/pet/stop'); await f.close(15)
}))

test('repeated fast exits with only status checks stop after eight attempts and cannot restart from the standing window', async () => fixture({
  backgroundMinutes: 15, backgroundWindowStart: '09:00', backgroundWindowEnd: '21:00',
}, async f => {
  await f.request('/pet/start', { mode: 'background' })
  for (let index = 0; index < 8; index++) {
    await f.work(index, 'bili_pace')
    f.advance(1000)
    await f.close(index)
    const status = await f.status(), state = status.backgroundRun
    assert.equal(state.workCalls, 0, 'checking availability is not browsing work')
    assert.equal(state.noProgressStreak, index + 1)
    if (index < 7) {
      assert.equal(state.continuationPending, true)
      f.advance(2500); f.timers.filter(row => row.ms === 2500).at(-1).fire(); await flush()
    } else {
      assert.equal(state.stopReason, 'no-progress')
      assert.equal(Boolean(state.continuationPending), false)
      assert.equal(status.recovery.rows.find(row => row.id === 'background').state, 'needs-attention')
      assert.equal(status.recovery.rows.find(row => row.id === 'background').reason, 'no-progress')
      assert.equal(status.recovery.needsAction, true)
    }
  }
  assert.equal(f.children.length, 8)
  assert.equal(f.state().bgWindowHold, at(21, 0))
  assert.equal(f.state().bgWindowHoldReason, 'unknown', 'no-progress is never mislabeled as human or natural rest')
  await f.request('/schedule', { action: 'check' })
  await f.tick()
  assert.equal(f.children.length, 8)
}))

test('one- and two-minute tasks can relay after an early clean exit, while errors never relay', async () => {
  for (const minutes of [1, 2]) await fixture({ backgroundMinutes: minutes }, async f => {
    const started = await f.request('/pet/start', { mode: 'background' })
    f.advance(1000); await f.close(0)
    assert.equal((await f.status()).backgroundRun.continuationPending, true)
    f.advance(2500); f.timers.filter(row => row.ms === 2500).at(-1).fire(); await flush()
    assert.equal(f.children.length, 2)
    assert.equal((await f.status()).backgroundRun.deadlineAt, started.backgroundRun.deadlineAt)
    const relayCount = f.timers.filter(row => row.ms === 2500).length
    await f.close(1, 1)
    assert.equal(f.timers.filter(row => row.ms === 2500).length, relayCount)
    assert.equal((await f.status()).backgroundRun.stopReason, 'error')
  })
})

test('an explicit successful start clears both the prior hold and its reason', async () => fixture({}, async f => {
  f.writeState({ ...f.state(), bgWindowHold: at(21, 0), bgWindowHoldReason: 'manual' })
  assert.equal((await f.status()).bgWindow.holdReason, 'manual')
  assert.equal((await f.request('/pet/start', { mode: 'background' })).started, true)
  assert.equal(f.state().bgWindowHold, 0)
  assert.equal(f.state().bgWindowHoldReason, '')
  assert.equal((await f.status()).bgWindow.holdReason, '')
  await f.request('/pet/stop'); await f.close(0)
}))
