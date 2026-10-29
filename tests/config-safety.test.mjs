import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'

function fixture(root) {
  const cleanups = []; let handler
  const ctx = { logger: { info() {} }, settings: { describe: () => [] }, tools: { register() { throw new Error('global registration forbidden') } },
    get: key => key === 'dshHomePath' ? (...parts) => join(root, ...parts) : key === 'agents' ? { list: () => [] } : undefined,
    on() { return () => {} }, effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } } }
  apply(ctx, {})
  const begin = (path, { method = 'POST', headers = {} } = {}) => {
    const req = new EventEmitter(); Object.assign(req, { method, headers, url: '/api/bili-duty' + path, destroy() {} })
    const res = { writeHead(status) { this.status = status }, end(text) { this.body = JSON.parse(text) } }
    const promise = handler(req, res).then(() => res)
    return { req, promise, finish(value) { req.emit('data', Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))); req.emit('end'); return promise } }
  }
  return { begin, async close() { for (const off of cleanups.reverse()) try { await off() } catch {} } }
}
async function withHome(run) {
  const root = mkdtempSync(join(tmpdir(), 'fish-config-safe-')), home = join(root, 'bili-duty')
  mkdirSync(home); writeFileSync(join(home, 'config.json'), JSON.stringify({ perDay: 5, learnAutoReview: false, autoComment: false, autoReplyDm: false, autoMoment: false }))
  const fixtures = []
  try { await run({ home, add: () => { const f = fixture(root); fixtures.push(f); return f }, config: () => JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) }) }
  finally { for (const f of fixtures.reverse()) await f.close(); rmSync(root, { recursive: true, force: true }) }
}

test('two host instances merge disjoint PATCHes inside the config lock, including defaults and explicit ownership', async () => {
  await withHome(async ({ add, config }) => {
    const a = add(), b = add()
    // Both handlers load their config before either asynchronous request body completes.
    const first = a.begin('/config'), second = b.begin('/config')
    assert.equal((await first.finish({ perDay: 19 })).status, 200)
    assert.equal((await second.finish({ idleChatter: false })).status, 200)
    assert.equal(config().perDay, 19); assert.equal(config().idleChatter, false)
    assert.ok(config()._set.includes('perDay')); assert.ok(config()._set.includes('idleChatter'))
    const third = a.begin('/config'), fourth = b.begin('/config')
    await third.finish({ autoComment: true }); await fourth.finish({ perDay: 5 })
    assert.equal(config().autoComment, true); assert.equal(config().perDay, 5)
  })
})

test('string/number/null boolean inputs and malformed JSON cannot enable sending or clear usage', async () => {
  await withHome(async ({ add, home, config }) => {
    const f = add(); const before = readFileSync(join(home, 'config.json'), 'utf8')
    for (const body of [{ autoMoment: 'false' }, { autoReplyDm: 1 }, { autoComment: null }, { sendReview: 'true' }, { resetTokensTotal: 'false' }, [] , null, '{bad-json']) {
      const response = await f.begin('/config').finish(body)
      assert.equal(response.status, 400, JSON.stringify(body)); assert.equal(response.body.ok, false)
      assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), before)
    }
    assert.equal(config().autoComment, false); assert.equal(config().autoReplyDm, false); assert.equal(config().autoMoment, false)
    const oversized = f.begin('/config', { headers: { 'content-length': '1000001' } })
    assert.equal((await oversized.promise).status, 413)
  })
})

test('corrupt config is preserved and an unsuccessful durable save never claims success', async () => {
  await withHome(async ({ add, home }) => {
    const f = add(); const request = f.begin('/config')
    writeFileSync(join(home, 'config.json'), '{corrupt-history')
    const result = await request.finish({ perDay: 19 })
    assert.equal(result.status, 500); assert.equal(result.body.ok, false)
    assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), '{corrupt-history')
  })
})

test('cross-origin browser config requests are rejected before any body writes', async () => {
  await withHome(async ({ add, home }) => {
    const f = add(), before = readFileSync(join(home, 'config.json'), 'utf8')
    for (const origin of ['https://evil.example', 'null', 'http://localhost.evil.example', 'http://127.0.0.1.evil.example']) {
      const r = await f.begin('/config', { headers: { origin } }).promise
      assert.equal(r.status, 403)
    }
    assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), before)
  })
})
