import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { dayKey } from '../lib/state.mjs'

test('verify route reports exact list evidence, keeps hidden results hidden and preserves damaged history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-verify-route-')), home = join(root, 'bili-duty'), cleanups = []
  mkdirSync(home)
  writeFileSync(join(home, 'config.json'), JSON.stringify({ learnAutoReview: false, reportLevel: 'off' }))
  writeFileSync(join(home, 'bili_credential.json'), JSON.stringify({ sessdata: 'fixture-session' }))
  const bv = 'BV1234567890', big = '1234567890123456789', stateFile = join(home, 'verify-state.json')
  writeFileSync(join(home, 'seen.md'), `${bv} ${big}`)
  let handler, hidden = true, requests = 0
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    requests++; assert.ok(String(url).startsWith('https://api.bilibili.com/')); assert.ok(init.signal instanceof AbortSignal)
    return { ok: true, text: async () => String(url).includes('/view?') ? '{"code":0,"data":{"aid":42}}'
      : `{"code":0,"data":{"replies":[{"rpid":${big},"invisible":${hidden},"like":2}]}}` }
  }
  const ctx = { logger: { info() {} }, settings: { describe: () => [] }, tools: { register() { throw new Error('global forbidden') } },
    get: key => key === 'dshHomePath' ? (...parts) => join(root, ...parts) : key === 'agents' ? { list: () => [] } : undefined,
    on() { return () => {} }, effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } } }
  const request = async () => {
    const req = new EventEmitter(); Object.assign(req, { method: 'POST', url: '/api/bili-duty/verify', headers: {} })
    const res = { writeHead(status) { this.status = status }, end(value) { this.body = JSON.parse(value) } }
    await handler(req, res); return res
  }
  try {
    apply(ctx, {}); await new Promise(done => setImmediate(done))
    const report = join(home, 'out', `${dayKey()}.md`)
    writeFileSync(report, '# fixture original report\n')
    const first = await request()
    assert.equal(first.status, 200); assert.equal(first.body.ok, true); assert.equal(first.body.checked[0].rpid, big)
    assert.equal(first.body.checked[0].visible, false); assert.match(first.body.text, /接口标记不可见/)
    assert.equal(first.body.report, report); assert.match(readFileSync(report, 'utf8'), /^# fixture original report/)
    hidden = false
    const second = await request()
    assert.equal(second.body.checked[0].visible, true); assert.match(second.body.text, /列表可见/)
    const before = requests
    assert.equal((await request()).body.checked.length, 0); assert.equal(requests, before)
    writeFileSync(stateFile, '{fixture-corrupt-history')
    const failed = await request()
    assert.equal(failed.body.ok, false); assert.equal(requests, before)
    assert.equal(readFileSync(stateFile, 'utf8'), '{fixture-corrupt-history')
  } finally {
    for (const off of cleanups.reverse()) try { off() } catch {}
    globalThis.fetch = original; rmSync(root, { recursive: true, force: true })
  }
})
