import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'
import { learnAdd } from '../lib/learn.mjs'
import { reviewMcpRequest } from '../lib/learn-review-mcp.mjs'

test('schedule and review routes share background exclusion, persist days and isolate review decisions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-automation-routes-')), home = join(root, 'bili-duty')
  mkdirSync(home)
  const dummy = join(root, 'mock-cli.js'); writeFileSync(dummy, '// spawn is mocked')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ dshBin: dummy, learnAutoReview: false, backgroundModelId: 'background/model', backgroundMinutes: 4, learnReviewModelId: 'reviewer/model' }))
  const stateFile = join(home, 'state.json'), pending = learnAdd({}, { text: '指出是哪一段有效，不照抄评论', from: 'BV1234567890' })
  writeFileSync(stateFile, JSON.stringify({ learn: pending.ledger, unrelated: 77 }))
  const children = [], spawned = [], cleanups = [], intervals = [], timers = []
  let handler
  const ctx = { logger: { info() {} }, get(key) { return key === 'llm' ? { listProviders: () => [{ id: 'background' }, { id: 'reviewer' }] } : key === 'dshHomePath' ? (...parts) => join(root, ...parts) : key === 'agents' ? { list: () => [] } : undefined },
    tools: { register: tool => tool }, settings: { describe: () => [] }, on() { return () => {} },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } },
  }
  const actual = { setTimeout, clearTimeout, setInterval, clearInterval }
  globalThis.setTimeout = (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t }
  globalThis.clearTimeout = () => {}
  globalThis.setInterval = (fn, ms) => { const t = { fn, ms, unref() {} }; intervals.push(t); return t }
  globalThis.clearInterval = () => {}
  const cp = createRequire(import.meta.url)('node:child_process'), actualSpawn = cp.spawn
  cp.spawn = (command, args, opts) => {
    spawned.push({ command, args, opts })
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null
    child.kill = () => { child.killed = true; return true }; children.push(child); return child
  }; syncBuiltinESMExports()
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'))
  async function request(path, body = {}, method = 'POST') {
    const req = new EventEmitter(); req.url = '/api/bili-duty' + path; req.method = method; req.headers = {}; req.destroy = () => {}
    const res = { writeHead(code) { this.code = code }, end(text) { this.body = JSON.parse(text) } }
    const promise = handler(req, res)
    if (method === 'POST') { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }
    await promise; return { statusCode: res.code, ...res.body }
  }
  try {
    apply(ctx, {})
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(intervals.some(t => t.ms === 15000)); assert.ok(timers.some(t => t.ms === 1500))
    const cfg = await request('/config', {}, 'GET')
    assert.equal(cfg.config.scheduleEnabled, false); assert.equal(cfg.config.learnAutoReview, false)
    const launch = await request('/schedule', { scheduleEnabled: true, scheduleAllDay: true })
    assert.equal(launch.started, true); assert.equal(spawned.length, 1); assert.equal(launch.schedule.ran, true)
    assert.match(spawned[0].args.at(-1), /duty\.md/)
    assert.equal((await request('/learn/review')).busy, true)
    assert.equal((await request('/schedule', { action: 'check' })).busy, true)
    children[0].exitCode = 0; children[0].emit('exit', 0)
    assert.equal((await request('/learn/review')).busy, true, 'wait for final stdio before releasing worker')
    children[0].emit('close', 0)
    assert.equal((await request('/schedule', { action: 'check' })).schedule.ran, true)
    assert.equal(spawned.length, 1)
    assert.equal(state().unrelated, 77)

    // Restarting from the same home keeps today's start consumed.
    for (const cleanup of cleanups.splice(0).reverse()) cleanup()
    apply(ctx, {})
    await new Promise(resolve => setImmediate(resolve))
    await request('/schedule', { action: 'check' }); assert.equal(spawned.length, 1)

    // The next failed spawn must release its own marker and retain a retry cooldown.
    const fresh = state(); fresh.schedule = {}; writeFileSync(stateFile, JSON.stringify(fresh))
    assert.equal((await request('/schedule', { action: 'check' })).started, true)
    children[1].emit('error', new Error('ENOENT fixture'))
    const afterFailure = await request('/schedule', { action: 'check' })
    assert.equal(afterFailure.schedule.ran, false); assert.match(afterFailure.schedule.lastError, /ENOENT/)
    assert.equal(spawned.length, 2)
    await request('/schedule', { scheduleEnabled: false })

    const review = await request('/learn/review')
    assert.equal(review.started, true); assert.equal(spawned.length, 3)
    const overlay = readFileSync(join(home, 'headless-learn-review-overlay.yml'), 'utf8')
    assert.match(overlay, /mcp-dafeiyu-learn-review/); assert.match(overlay, /learn-review-mcp\.mjs/)
    assert.match(overlay, /provider: 'dafeiyu-parent'/); assert.match(overlay, /model: 'reviewer\/model'/)
    assert.match(overlay, /model-relay-adapter\.mjs/); assert.doesNotMatch(overlay, /BILI_DUTY_RELAY_CAPABILITY|BILI_MCP_TOOLS/)
    assert.match(spawned[2].opts.env.BILI_DUTY_RELAY_CAPABILITY, /^[a-f0-9]{64}$/)
    assert.doesNotMatch(spawned[2].args.at(-1), /先看自己的作品/)
    const manifestFile = join(home, review.learnReview.id + '.json'), manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    const reply = reviewMcpRequest({ id: 5, method: 'tools/call', params: { name: 'bili_learn', arguments: { action: 'approve', id: pending.id, why: '具体、可复用且有来源' } } }, manifest, { stateFile, manifestFile })
    assert.equal(reply.result.isError, false)
    assert.equal(state().learn.items[pending.id].state, 'approved')
    await request('/config', { learnReviewModelId: 'background/next-review' })
    const liveReview = (await request('/learn/review', {}, 'GET')).learnReview
    assert.equal(liveReview.running, true); assert.equal(liveReview.approved, 1); assert.equal(liveReview.remaining, 0)
    assert.equal(liveReview.model, 'reviewer/model', 'current run keeps its actual model when next-run settings change')
    assert.equal((await request('/learn/review', { action: 'stop' })).stopped, true)
    assert.equal(existsSync(manifestFile), false)
    const revoked = reviewMcpRequest({ id: 6, method: 'tools/call', params: { name: 'bili_learn', arguments: { action: 'reject', id: pending.id, why: 'stale worker' } } }, manifest, { stateFile, manifestFile })
    assert.match(revoked.result.content[0].text, /REVIEW_RUN_REVOKED/)
    assert.equal((await request('/pet/start', { mode: 'background' })).busy, true)
    children[2].emit('close', null)
    await request('/schedule', { action: 'check' })
    const reviewDone = await request('/learn/review', {}, 'GET')
    assert.equal(reviewDone.learnReview.running, false); assert.equal(reviewDone.learnReview.approved, 1)
    assert.equal(reviewDone.learnReview.stopReason, 'user')
    assert.equal(state().unrelated, 77)
    const log = await request('/pet/log?n=500', {}, 'GET')
    for (const type of ['schedule-start', 'schedule-error', 'learn-review-start', 'learn-review-done']) assert.ok(log.entries.some(row => row.type === type), type)
    const bad = await request('/learn/review', { action: 'approve' }); assert.equal(bad.statusCode, 400)
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup() } catch {} }
    Object.assign(globalThis, actual); cp.spawn = actualSpawn; syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})

test('default automatic review starts on idle startup, respects retry and off switch, then finishes pending work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-auto-review-')), home = join(root, 'bili-duty')
  mkdirSync(home)
  const dummy = join(root, 'mock-cli.js'); writeFileSync(dummy, '// spawn is mocked')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ dshBin: dummy, backgroundModelId: 'reviewer/model' }))
  const stateFile = join(home, 'state.json'), pending = learnAdd({}, { text: '说明具体场景，再决定如何接话', from: 'BV1234567890' })
  writeFileSync(stateFile, JSON.stringify({ learn: pending.ledger, unrelated: 99 }))
  const children = [], spawned = [], cleanups = [], intervals = [], timers = []
  let handler
  const ctx = { logger: { info() {} }, get(key) { return key === 'llm' ? { listProviders: () => [{ id: 'reviewer' }] } : key === 'dshHomePath' ? (...parts) => join(root, ...parts) : key === 'agents' ? { list: () => [] } : undefined },
    tools: { register: tool => tool }, settings: { describe: () => [] }, on() { return () => {} },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } },
  }
  const actual = { setTimeout, clearTimeout, setInterval, clearInterval }
  globalThis.setTimeout = (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t }
  globalThis.clearTimeout = () => {}
  globalThis.setInterval = (fn, ms) => { const t = { fn, ms, unref() {} }; intervals.push(t); return t }
  globalThis.clearInterval = () => {}
  const cp = createRequire(import.meta.url)('node:child_process'), actualSpawn = cp.spawn
  cp.spawn = (command, args, opts) => {
    spawned.push({ command, args, opts })
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null
    child.kill = () => true; children.push(child); return child
  }; syncBuiltinESMExports()
  const flush = () => new Promise(resolve => setImmediate(resolve))
  async function request(path, body, method = 'GET') {
    const req = new EventEmitter(); req.url = '/api/bili-duty' + path; req.method = method; req.headers = {}; req.destroy = () => {}
    const res = { writeHead(code) { this.code = code }, end(text) { this.body = JSON.parse(text) } }
    const promise = handler(req, res)
    if (method === 'POST') { req.emit('data', Buffer.from(JSON.stringify(body || {}))); req.emit('end') }
    await promise; return res.body
  }
  try {
    apply(ctx, {}); await flush()
    assert.equal((await request('/config')).config.learnAutoReview, true)
    const startup = timers.find(t => t.ms === 1500), interval = intervals.find(t => t.ms === 15000)
    startup.fn(); await flush()
    assert.equal(spawned.length, 1, 'startup automatically launches pending review without a manual request')
    assert.match(spawned[0].args.at(-1), /独立的学习队列模型审核任务/)
    assert.equal((await request('/learn/review')).learnReview.model, 'reviewer/model', 'empty reviewer setting uses background model')
    interval.fn(); await flush(); assert.equal(spawned.length, 1, 'busy worker is never duplicated')
    children[0].emit('close', 0); await flush()
    const incomplete = (await request('/learn/review')).learnReview
    assert.equal(incomplete.complete, false); assert.equal(incomplete.pending, 1)
    assert.ok(incomplete.nextRetryAt > Date.now()); assert.equal(incomplete.remaining, 1)
    interval.fn(); await flush(); assert.equal(spawned.length, 1, 'zero exit with unprocessed pending work respects backoff')
    const ready = JSON.parse(readFileSync(stateFile, 'utf8'))
    ready.learnReview.lastAttemptAt = Date.now() - 180001; ready.learnReview.nextRetryAt = Date.now() - 1
    writeFileSync(stateFile, JSON.stringify(ready))
    await request('/config', { learnAutoReview: false }, 'POST')
    interval.fn(); await flush(); assert.equal(spawned.length, 1, 'explicit off is preserved')
    await request('/config', { learnAutoReview: true }, 'POST')
    interval.fn(); await flush(); assert.equal(spawned.length, 2, 'idle scheduler resumes pending review after cooldown')
    const running = (await request('/learn/review')).learnReview
    const manifestFile = join(home, running.id + '.json'), manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    const reply = reviewMcpRequest({ id: 9, method: 'tools/call', params: { name: 'bili_learn', arguments: { action: 'approve', id: pending.id, why: '具体、可复用且有来源' } } }, manifest, { stateFile, manifestFile })
    assert.equal(reply.result.isError, false)
    children[1].emit('close', 0); await flush()
    const complete = (await request('/learn/review')).learnReview
    assert.equal(complete.complete, true); assert.equal(complete.approved, 1); assert.equal(complete.pending, 0)
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).unrelated, 99)
    interval.fn(); await flush(); assert.equal(spawned.length, 2, 'empty pending queue stays idle')
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup() } catch {} }
    Object.assign(globalThis, actual); cp.spawn = actualSpawn; syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})
