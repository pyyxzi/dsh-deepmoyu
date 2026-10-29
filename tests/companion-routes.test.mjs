import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'

test('companion settings persist and status revisions change without starting or altering any browsing mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-companion-')), home = join(root, 'bili-duty')
  mkdirSync(home)
  const runConfig = { sessionMinutes: 50, backgroundMinutes: 25, backgroundWindowStart: '19:00', backgroundWindowEnd: '02:00', scheduleEnabled: false, learnAutoReview: false }
  writeFileSync(join(home, 'config.json'), JSON.stringify(runConfig))
  const marker = { unseen: 'preserve me', petChatterAt: Date.now() + 10000 }
  writeFileSync(join(home, 'state.json'), JSON.stringify(marker))
  let handler
  const cleanups = [], timers = { setTimeout, setInterval, clearTimeout, clearInterval }
  const noopTimer = () => ({ unref() {} })
  Object.assign(globalThis, { setTimeout: noopTimer, setInterval: noopTimer, clearTimeout() {}, clearInterval() {} })
  const ctx = { logger: { info() {} },
    get: name => name === 'dshHomePath' ? (...p) => join(root, ...p) : name === 'agents' ? { list: () => [] } : undefined,
    tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } }, settings: { describe: () => [] }, on: () => () => {},
    effect(fn) { const end = fn(); if (typeof end === 'function') cleanups.push(end) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } } }
  async function request(route, body) {
    const req = new EventEmitter(); Object.assign(req, { url: '/api/bili-duty' + route, method: body ? 'POST' : 'GET', headers: {} })
    const res = { writeHead(code) { this.code = code }, end(text) { this.body = JSON.parse(text) } }
    const promise = handler(req, res)
    if (body) { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }
    await promise
    assert.equal(res.code, 200, JSON.stringify(res.body))
    return res.body
  }
  try {
    apply(ctx, {})
    await new Promise(resolve => setImmediate(resolve))
    const before = await request('/status')
    assert.equal(before.companion.focus, false)
    const start = Date.now()
    const saved = await request('/config', { chatterFrequency: 'lively', focusMode: true, quietHoursEnabled: true,
      quietHoursStart: '22:30', quietHoursEnd: '07:45', notificationLevel: 'minimal', petReducedMotion: true })
    for (const [key, value] of Object.entries(runConfig)) assert.equal(saved.config[key], value, key + ' preserved')
    assert.equal(saved.config.autoComment, false)
    const after = await request('/status?rev=' + before.rev)
    assert.notEqual(after.rev, before.rev)
    assert.equal(after.companion.focus, true)
    assert.equal(after.companion.chatterAllowed, false)
    assert.equal(after.companion.reducedMotion, true)
    assert.equal(after.companion.notificationLevel, 'minimal')
    assert.equal(after.bgBusy, false)
    assert.equal(after.feiyu.active, false)
    const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    assert.equal(state.unseen, marker.unseen)
    assert(state.petChatterAt >= start + 45 * 60_000 && state.petChatterAt <= Date.now() + 90 * 60_000)
    const reread = await request('/config')
    assert.equal(reread.config.chatterFrequency, 'lively')
    assert.equal(reread.config.quietHoursStart, '22:30')
  } finally {
    for (const end of cleanups.reverse()) { try { end() } catch {} }
    Object.assign(globalThis, timers)
    rmSync(root, { recursive: true, force: true })
  }
})
