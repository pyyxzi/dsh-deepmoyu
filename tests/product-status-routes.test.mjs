import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'

const dayKey = (date = new Date()) => {
  const pad = (v) => String(v).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

test('status route exposes durable retrospective/recovery and revision invalidates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-product-status-')), home = join(root, 'bili-duty')
  mkdirSync(home); mkdirSync(join(home, 'out'))
  const today = dayKey()
  writeFileSync(join(home, 'config.json'), JSON.stringify({ learnAutoReview: false, backgroundWindowStart: '20:00', backgroundWindowEnd: '02:00' }))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ tokenDays: { [today]: 321 }, tokensTotal: 321, tokensToday: 321 }))
  writeFileSync(join(home, 'out', `${today}.md`), '### BV1abcdefghi - 路由里的真实主题\n一句理由\n')
  writeFileSync(join(home, 'token-ledger.json'), JSON.stringify({ version: 1, entries: [{ id: 'bg-failed', kind: 'background', label: '后台刷一轮', startedAt: new Date(Date.now() - 60_000).toISOString(), endedAt: new Date().toISOString(), stopReason: 'spawn-error', tokensUnknown: true }] }))
  writeFileSync(join(home, 'pv-sessions.json'), JSON.stringify([{ sessionId: 'pv-stale', productionId: 'prod-stale', date: today, mode: 'daily', stage: 'verify', createdAt: new Date().toISOString() }]))
  let handler
  const cleanups = []
  const ctx = {
    logger: { info() {} },
    get(key) { return key === 'dshHomePath' ? (...parts) => join(root, ...parts) : key === 'agents' ? { list: () => [], get: () => null } : undefined },
    tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } }, settings: { describe: () => [] }, on() { return () => {} },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } },
  }
  const actual = { setTimeout, clearTimeout, setInterval, clearInterval }
  const timer = () => ({ unref() {} })
  globalThis.setTimeout = timer; globalThis.clearTimeout = () => {}; globalThis.setInterval = timer; globalThis.clearInterval = () => {}
  async function request(path) {
    const req = new EventEmitter(); req.url = '/api/bili-duty' + path; req.method = 'GET'; req.headers = {}; req.destroy = () => {}
    const res = { writeHead(code) { this.code = code }, end(text) { this.body = JSON.parse(text) } }
    await handler(req, res); assert.equal(res.code, 200); return res.body
  }
  try {
    apply(ctx, {})
    await new Promise(resolve => setImmediate(resolve))
    const first = await request('/status')
    assert.equal(first.retrospective.days.find((row) => row.day === today).picks, 1)
    assert.equal(first.retrospective.totals.tokens, 321)
    assert.equal(first.retrospective.themes.some((row) => row.sources?.some((source) => source.day === today && source.bvid === 'BV1abcdefghi')), true)
    assert.equal(first.recovery.rows.find((row) => row.id === 'background').state, 'failed')
    assert.equal(first.recovery.rows.find((row) => row.id === 'video').state, 'interrupted')
    assert.equal(first.recovery.rows.find((row) => row.id === 'schedule').action, 'background')
    assert.equal((await request('/status?rev=' + encodeURIComponent(first.rev))).unchanged, true)

    const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    state.tokenDays[today] = 654; state.tokensToday = 654; state.tokensTotal = 654
    writeFileSync(join(home, 'state.json'), JSON.stringify(state))
    const changed = await request('/status?rev=' + encodeURIComponent(first.rev))
    assert.notEqual(changed.rev, first.rev)
    assert.equal(changed.unchanged, undefined)
    assert.equal(changed.retrospective.totals.tokens, 654)

    writeFileSync(join(home, 'out', `${today}.md`), 'x'.repeat(512 * 1024 + 1))
    const oversized = await request('/status?rev=' + encodeURIComponent(changed.rev))
    assert.notEqual(oversized.rev, changed.rev, 'report mtime/size participates in revision')
    assert.equal(oversized.retrospective.complete, false)
    assert.equal(oversized.retrospective.errors.some((row) => row.day === today), true)

    writeFileSync(join(home, 'token-ledger.json'), JSON.stringify({ version: 1, entries: [] }))
    const holdUntil = Date.now() + 300000
    let prior = oversized
    for (const reason of ['rest', 'manual', undefined, 'not-a-known-reason']) {
      const next = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
      next.bgWindowHold = holdUntil
      if (reason === undefined) delete next.bgWindowHoldReason
      else next.bgWindowHoldReason = reason
      writeFileSync(join(home, 'state.json'), JSON.stringify(next))
      const result = await request('/status?rev=' + encodeURIComponent(prior.rev))
      const expected = reason === 'rest' || reason === 'manual' ? reason : 'unknown'
      if (prior.bgWindow?.holdReason !== expected) assert.notEqual(result.unchanged, true, 'changing only the stored reason invalidates the status revision')
      const full = result.unchanged ? await request('/status') : result
      assert.equal(full.bgWindow.holdReason, expected)
      const held = full.recovery.rows.find(row => row.state === 'held')
      assert.equal(held.holdReason, expected, 'recovery receives the same persisted cause as the background controls')
      if (expected !== 'manual') assert.doesNotMatch(held.label, /手动/)
      prior = full
    }
    const expired = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    expired.bgWindowHold = Date.now() - 1; expired.bgWindowHoldReason = 'rest'
    writeFileSync(join(home, 'state.json'), JSON.stringify(expired))
    const after = await request('/status')
    assert.equal(after.bgWindow.holdReason, '')
    assert.equal(after.recovery.rows.some(row => row.state === 'held'), false)
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup() } catch {} }
    Object.assign(globalThis, actual)
    rmSync(root, { recursive: true, force: true })
  }
})
