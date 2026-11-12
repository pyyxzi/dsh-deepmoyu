import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'
import { dayKey } from '../lib/state.mjs'

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
  const originals = { spawn: cp.spawn, Date, setTimeout, clearTimeout, setInterval, clearInterval }
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
    children.push({ child, args }); return child
  }
  syncBuiltinESMExports()
  const ctx = { logger: { info() {} }, settings: { describe: () => [] },
    get: key => key === 'llm' ? { listProviders: () => [{ id: 'fixture' }] } : key === 'dshHomePath' ? (...parts) => join(root, ...parts) : key === 'agents' ? { list: () => [] } : undefined,
    tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } }, on() { return () => {} },
    effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } },
  }
  const request = async (path, body = {}) => {
    const req = new EventEmitter(); Object.assign(req, { url: '/api/bili-duty' + path, method: 'POST', headers: {}, destroy() {} })
    const res = { writeHead(status) { this.status = status }, end(text) { this.body = JSON.parse(text) } }
    const pending = handler(req, res)
    req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end')
    await pending; await flush()
    assert.equal(res.status, 200, JSON.stringify(res.body)); return res.body
  }
  try {
    apply(ctx, {}); await flush()
    await run({ home, children, timers, request, now: () => now, advance: ms => { now += ms }, setTime: value => { now = value },
      state: () => JSON.parse(readFileSync(stateFile, 'utf8')),
      writeState: patch => writeFileSync(stateFile, JSON.stringify(patch)),
      tick: async () => { intervals.find(row => row.ms === 60000).fire(); await flush() },
      async close(index) { children[index].child.exitCode = 0; children[index].child.emit('close', 0); await flush() },
    })
  } finally {
    for (const row of children) row.child.exitCode = 0
    for (const off of cleanups.reverse()) { try { await off() } catch {} }
    Object.assign(globalThis, { Date: originals.Date, setTimeout: originals.setTimeout, clearTimeout: originals.clearTimeout,
      setInterval: originals.setInterval, clearInterval: originals.clearInterval })
    cp.spawn = originals.spawn; syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
}

test('an enabled daily schedule browses with digest quota full or zero and reporting off, once per day', async () => {
  for (const perDay of [0, 1]) await fixture({ perDay }, async f => {
    f.writeState({ ...f.state(), day: dayKey(), picked: perDay, count: 1 })
    const started = await f.request('/schedule', { scheduleEnabled: true, scheduleAllDay: true })
    assert.equal(started.started, true)
    assert.equal(f.children.length, 1)
    assert.match(f.children[0].args.at(-1), /不是浏览或互动总额度/)
    f.advance(60000)
    await f.close(0)
    await f.request('/schedule', { action: 'check' })
    assert.equal(f.children.length, 1, 'the consumed daily window remains consumed')
    f.advance(86400000)
    assert.equal((await f.request('/schedule', { action: 'check' })).started, true)
    assert.equal(f.children.length, 2)
    f.advance(60000)
    await f.close(1)
  })
})

test('enabled peak/valley windows keep independent starts even after an earlier off-report run', async () => fixture({ peakValley: true, noon: true, night: true }, async f => {
  f.writeState({ ...f.state(), day: dayKey(), count: 1, picked: 0 })
  await Promise.all([f.tick(), f.tick()])
  assert.equal(f.children.length, 1, 'concurrent ticks claim the current window only once')
  f.advance(60000)
  await f.close(0)
  await f.tick()
  assert.equal(f.children.length, 1)
  f.setTime(at(18, 30))
  await f.tick()
  assert.equal(f.children.length, 2, 'the evening window is not a second daily digest allowance')
  f.advance(60000)
  await f.close(1)
  await f.tick()
  assert.equal(f.children.length, 2)
}))

test('a natural window rest resets the continuous stretch while manual holds and window boundaries stay authoritative', async () => fixture({
  backgroundWindowStart: '09:00', backgroundWindowEnd: '21:00', peakValley: true, noon: true,
}, async f => {
  const endAt = at(21, 0)
  f.writeState({ ...f.state(), bgWindowSince: { at: f.now() - 3 * 3600000 - 1, endAt } })
  assert.equal((await f.request('/pet/start', { mode: 'background' })).started, true)
  await f.close(0)
  const restUntil = f.now() + 15 * 60000
  assert.equal(f.state().bgWindowHold, restUntil)
  assert.deepEqual(f.state().bgWindowSince, { at: restUntil, endAt })
  await f.request('/schedule', { scheduleEnabled: true, scheduleAllDay: true })
  assert.equal(f.children.length, 1, 'a daily schedule cannot bypass the active natural hold')
  await f.tick()
  assert.equal(f.children.length, 1)
  f.setTime(restUntil)
  assert.equal((await f.request('/schedule', { action: 'check' })).started, true)
  assert.equal(f.children.length, 2)
  f.advance(60000)
  const relaysBefore = f.timers.filter(row => row.ms === 2500).length
  await f.close(1)
  assert.equal(f.timers.filter(row => row.ms === 2500).length, relaysBefore + 1, 'a short new stretch continues instead of immediately resting again')
  assert.ok(f.state().bgWindowHold <= f.now())
  f.timers.filter(row => row.ms === 2500).at(-1).fire(); await flush()
  assert.equal(f.children.length, 3)
  await f.request('/pet/stop')
  await f.close(2)
  assert.equal(f.state().bgWindowHold, endAt, 'manual stop holds the whole current window')
  await f.request('/schedule', { action: 'check' })
  await f.tick()
  assert.equal(f.children.length, 3)
  f.setTime(at(21, 0))
  await f.request('/schedule', { scheduleEnabled: false })
  assert.equal(f.children.length, 3, 'the expired window does not restart itself')
  f.setTime(at(12, 30, 13))
  assert.equal((await f.request('/schedule', { action: 'check' })).started, true)
  assert.equal(f.children.length, 4)
  assert.deepEqual(f.state().bgWindowSince, { at: f.now(), endAt: at(21, 0, 13) })
  await f.request('/pet/stop'); await f.close(3)
}))
