import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'
import { paceTake, paceNoteRisk } from '../lib/pace.mjs'

test('status exposes shared pace explanation without rewriting pinned waits or safety scopes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-pace-routes-')), home = join(root, 'bili-duty')
  mkdirSync(home)
  writeFileSync(join(home, 'config.json'), JSON.stringify({ paceFactor: 0.73, learnAutoReview: false }))
  const stateFile = join(home, 'state.json'), now = Date.now()
  const pinned = paceTake(null, 'comment', now - 5000, 0)
  writeFileSync(stateFile, JSON.stringify({ pace: pinned, unrelated: 77 }))
  const cleanups = []
  let handler
  const ctx = {
    logger: { info() {} },
    get(key) { return key === 'dshHomePath' ? (...parts) => join(root, ...parts) : key === 'agents' ? { list: () => [] } : undefined },
    tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } }, settings: { describe: () => [] }, on() { return () => {} },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } },
  }
  const actual = { setTimeout, clearTimeout, setInterval, clearInterval }
  const timer = () => ({ unref() {} })
  globalThis.setTimeout = timer; globalThis.clearTimeout = () => {}
  globalThis.setInterval = timer; globalThis.clearInterval = () => {}
  const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'))
  async function request(path, body, method = 'GET') {
    const req = new EventEmitter(); req.url = '/api/bili-duty' + path; req.method = method; req.headers = {}; req.destroy = () => {}
    const res = { writeHead(code) { this.code = code }, end(text) { this.body = JSON.parse(text) } }
    const promise = handler(req, res)
    if (method === 'POST') { req.emit('data', Buffer.from(JSON.stringify(body || {}))); req.emit('end') }
    await promise
    assert.equal(res.code, 200, JSON.stringify(res.body))
    return res.body
  }
  try {
    apply(ctx, {})
    await new Promise(resolve => setImmediate(resolve))
    const cfg = await request('/config')
    assert.equal(cfg.config.paceFactor, 0.73, 'reading status never chooses a preset for the user')
    const before = (await request('/status')).pace
    assert.equal(before.ok, true)
    assert.equal(before.factor, 0.73)
    assert.equal(before.explanation.factor, 0.73)
    assert.deepEqual(before.explanation.presets, { normal: 1, responsive: 0.5, cautious: 1.5 })
    assert.equal(before.explanation.factorAffects, 'next-success-gap-only')
    assert.equal(before.explanation.pinnedIntervalsPreserved, true)
    assert.equal(before.explanation.kinds.comment.baseMinSec, 120)
    assert.equal(before.explanation.kinds.comment.baseMaxSec, 180)
    assert.equal(before.explanation.kinds.dm.effectiveJitterSec, 10.95)
    assert.equal(before.explanation.kinds.comment.waitSec, before.kinds.comment.waitSec)
    assert.equal(before.explanation.kinds.comment.nextAt, new Date(pinned.last.comment.next).toISOString())
    assert.deepEqual(readState().pace, pinned)

    await request('/config', { paceFactor: 0.5 }, 'POST')
    const after = (await request('/status')).pace
    assert.equal(after.factor, 0.5)
    assert.equal(after.explanation.factor, 0.5)
    assert.equal(after.explanation.kinds.comment.effectiveMinSec, 60)
    assert.equal(after.explanation.kinds.comment.effectiveMaxSec, 90)
    assert.equal(after.explanation.kinds.comment.hourCap, 8)
    assert.equal(after.explanation.kinds.comment.nextAt, before.explanation.kinds.comment.nextAt, 'save does not shorten an existing interval')
    assert.deepEqual(readState().pace, pinned)

    const parked = paceNoteRisk(pinned, 12014, Date.now()).book
    writeFileSync(stateFile, JSON.stringify({ ...readState(), pace: parked }))
    const quota = (await request('/status')).pace
    assert.deepEqual(quota.explanation.quota.scopes.comment, ['comment', 'reply'])
    assert.deepEqual(quota.explanation.quota.parkSec, [2700, 5400, 10800])
    assert.equal(quota.explanation.quota.scalesWithFactor, false)
    assert.deepEqual(quota.explanation.quota.active.comment.kinds, ['comment', 'reply'])
    for (const kind of ['comment', 'reply']) assert.equal(quota.explanation.kinds[kind].blockedBy, 'quota')
    for (const kind of ['opusReply', 'dm', 'moment']) assert.equal(quota.explanation.kinds[kind].waitSec, 0, kind + ' is not stopped by video-comment quota')

    const cooled = paceNoteRisk(parked, -412, Date.now()).book
    writeFileSync(stateFile, JSON.stringify({ ...readState(), pace: cooled }))
    const risk = (await request('/status')).pace
    assert.equal(risk.explanation.risk.scope, 'all')
    assert.equal(risk.explanation.risk.cooldownSecByCode['-412'], 3600)
    assert.equal(risk.explanation.risk.scalesWithFactor, false)
    assert.equal(risk.explanation.risk.active.until, risk.cooldown.until)
    for (const kind of Object.keys(risk.kinds)) assert.equal(risk.explanation.kinds[kind].blockedBy, 'cooldown')
    assert.deepEqual(readState().pace, cooled, 'GET is read-only even with active risk cooldown')
    assert.equal(readState().unrelated, 77)
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup() } catch {} }
    Object.assign(globalThis, actual)
    rmSync(root, { recursive: true, force: true })
  }
})
