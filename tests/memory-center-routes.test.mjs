import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'
import { learnAdd, learnDecide } from '../lib/learn.mjs'
import { soulTemplate, soulSetSection } from '../lib/persona.mjs'
import { readRecordEvents } from '../lib/records.mjs'

test('combined memory search supports audited, stale-safe manual revocation while preserving browsing history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-memory-routes-')), home = join(root, 'bili-duty')
  mkdirSync(home)
  writeFileSync(join(home, 'config.json'), JSON.stringify({ learnAutoReview: false, idleChatter: false }))
  const addition = learnAdd({}, { kind: 'fact', text: '纸张动画的留白更舒服', from: 'BV1bKJX6mEnY' })
  const approved = learnDecide(addition.ledger, addition.id, 'approve', '人工批准')
  const stateFile = join(home, 'state.json')
  writeFileSync(stateFile, JSON.stringify({ learn: approved.ledger, taste: { '123': { text: '一条口味样本', likes: 1, at: '2026-10-29T01:00:00Z' } },
    seenVideos: { BV1bKJX6mEnY: { note: '纸张动画', at: '2026-10-29T01:01:00Z' } }, unrelated: 77 }))
  const soulFile = join(home, 'soul.md'), voiceFile = join(home, 'voice.md')
  writeFileSync(soulFile, soulSetSection(soulTemplate(), 'mood', '<!-- preserve this comment -->\n- 想再看一次纸张动画\n- 想找新鲜事'))
  writeFileSync(voiceFile, '# 语气札记\n<!-- preserve this voice comment -->\n- 先说细节再开玩笑\n- 留一点空白\n')
  const cleanups = []; let handler; let toolExecutions = 0
  const ctx = { logger: { info() {} },
    get(key) { return key === 'dshHomePath' ? (...parts) => join(root, ...parts) : key === 'agents' ? { list: () => [] } : undefined },
    tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') }, execute() { toolExecutions++; throw new Error('MUST_NOT_SEND') } },
    settings: { describe: () => [] }, on() { return () => {} },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } },
  }
  const actual = { setTimeout, clearTimeout, setInterval, clearInterval }; const timer = () => ({ unref() {} })
  globalThis.setTimeout = timer; globalThis.clearTimeout = () => {}; globalThis.setInterval = timer; globalThis.clearInterval = () => {}
  async function request(path, body, origin) {
    const req = new EventEmitter(); req.url = '/api/bili-duty' + path; req.method = body ? 'POST' : 'GET'; req.headers = origin ? { origin } : {}; req.destroy = () => {}
    const res = { writeHead(code) { this.code = code }, end(text) { this.body = JSON.parse(text) } }
    const promise = handler(req, res)
    if (body) { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }
    await promise
    return res
  }
  const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'))
  const list = async (source) => {
    const r = await request('/memory?source=' + source); assert.equal(r.code, 200); assert.equal(r.body.ok, true); return r.body.items
  }
  const act = (row, action) => request('/memory', { source: row.source, id: row.id, version: row.version, action })
  try {
    apply(ctx, {})
    await new Promise(resolve => setImmediate(resolve))
    const result = await request('/memory?source=all&filter=' + encodeURIComponent('纸张'))
    assert.equal(result.body.matched, 3)
    const learned = (await list('learning'))[0]
    assert.deepEqual(learned.actions, ['revoke', 'forget'])
    const revoked = await act(learned, 'revoke')
    assert.equal(revoked.code, 200); assert.equal(revoked.body.ok, true)
    assert.equal(readState().learn.items[addition.id].state, 'rejected')
    assert.equal((await act(learned, 'forget')).code, 409, 'stale content cannot be removed after a decision changed it')
    const audit = readRecordEvents(home, { type: 'learning', limit: 100 })
    assert.ok(audit.some((event) => event.data?.action === 'reject'), 'revocation is durable learning audit')

    const soul = (await list('soul')).find((row) => row.text.includes('纸张'))
    assert.equal((await act(soul, 'forget')).body.ok, true)
    assert.ok(!readFileSync(soulFile, 'utf8').includes('想再看一次纸张动画'))
    assert.ok(readFileSync(soulFile, 'utf8').includes('preserve this comment'))
    const voice = (await list('voice')).find((row) => row.text.includes('先说细节'))
    assert.equal((await act(voice, 'forget')).body.ok, true)
    assert.ok(readFileSync(voiceFile, 'utf8').includes('preserve this voice comment'))
    assert.ok(!readFileSync(voiceFile, 'utf8').includes('先说细节'))
    assert.ok(readRecordEvents(home, { type: 'memory', limit: 100 }).some((event) => event.data?.operation === 'manual-forget'))

    const taste = (await list('taste'))[0]
    const before = (await request('/status')).body
    writeFileSync(stateFile, JSON.stringify({ ...readState(), taste: { '123': { ...readState().taste['123'], likes: 2 } } }))
    const changed = (await request('/status?rev=' + before.rev)).body
    assert.notEqual(changed.unchanged, true, 'same-size taste changes invalidate the status revision')
    assert.equal((await act(taste, 'forget')).code, 409)
    assert.equal((await act((await list('taste'))[0], 'forget')).body.ok, true)
    assert.deepEqual(readState().taste, {})
    assert.equal(readState().unrelated, 77)
    assert.ok(readState().seenVideos.BV1bKJX6mEnY, 'forgetting experience never resets dedupe')
    assert.equal((await request('/memory', { source: 'seen', id: 'BV1bKJX6mEnY', version: 'a'.repeat(64), action: 'forget' })).code, 400)
    assert.equal((await request('/memory', { source: 'soul', id: 'mood:1', version: 'a'.repeat(64), action: 'forget' }, 'https://evil.example')).code, 403)
    assert.equal(toolExecutions, 0, 'memory UI cannot cause network sends')
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup() } catch {} }
    Object.assign(globalThis, actual)
    rmSync(root, { recursive: true, force: true })
  }
})
