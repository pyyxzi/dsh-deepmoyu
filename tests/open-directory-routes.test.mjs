import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { apply } from '../index.js'

test('open route accepts only server directory selectors and waits for a mocked launcher exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-open-route-')), home = join(root, 'bili-duty'), mirror = join(root, "中文 mirror 'quote' & folder"), pv = join(root, 'videos')
  for (const folder of [home, mirror, pv, join(home, 'out')]) mkdirSync(folder, { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ learnAutoReview: false, reportLevel: 'off', mirrorDir: mirror, pvDir: pv }))
  const cp = createRequire(import.meta.url)('node:child_process'), original = cp.spawn, calls = [], cleanups = []
  let handler, fail = false
  cp.spawn = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter(); child.unref = () => {}
    queueMicrotask(() => child.emit('exit', fail ? 2 : 0, null))
    return child
  }; syncBuiltinESMExports()
  const ctx = { logger: { info() {} }, settings: { describe: () => [] }, tools: { register() { throw new Error('global forbidden') } },
    get: key => key === 'dshHomePath' ? (...parts) => join(root, ...parts) : key === 'agents' ? { list: () => [] } : undefined,
    on() { return () => {} }, effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } } }
  const request = async body => {
    const req = new EventEmitter(); Object.assign(req, { method: 'POST', url: '/api/bili-duty/open', headers: {} })
    const res = { writeHead(status) { this.status = status }, end(value) { this.body = JSON.parse(value) } }
    const pending = handler(req, res); req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); await pending; return res
  }
  try {
    apply(ctx, {}); await new Promise(done => setImmediate(done))
    const before = calls.length
    for (const what of ['../private', 'C:\\private', 'other', '', null, false, {}, []]) {
      const result = await request({ what, path: root })
      assert.equal(result.status, 400); assert.equal(result.body.code, 'OPEN_TARGET_INVALID')
    }
    assert.equal(calls.length, before)
    for (const [what, expected] of [['home', home], ['out', join(home, 'out')], ['mirror', mirror], ['pv', pv]]) {
      const result = await request({ what, path: join(root, 'attacker-path') })
      assert.equal(result.status, 200); assert.equal(result.body.ok, true); assert.equal(result.body.acknowledged, true)
      assert.equal(result.body.opened, resolve(expected))
      const call = calls.at(-1)
      if (process.platform === 'win32') {
        const position = call.args.indexOf('-EncodedCommand')
        assert.ok(position >= 0)
        const script = Buffer.from(call.args[position + 1], 'base64').toString('utf16le')
        const encoded = /\$encodedDirectory = '([A-Za-z0-9+/=]+)'/.exec(script)
        assert.ok(encoded, 'the fixed helper carries the directory as UTF-8 base64 data')
        assert.equal(Buffer.from(encoded[1], 'base64').toString('utf8'), resolve(expected))
        assert.match(call.command, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i)
        assert.equal(call.options.windowsHide, true)
      } else assert.equal(call.args.at(-1), resolve(expected))
      assert.equal(call.options.shell, false)
    }
    fail = true
    const failed = await request({ what: 'home' })
    assert.equal(failed.body.ok, false); assert.equal(failed.body.code, 'OPEN_EXIT_FAILED')
    rmSync(pv, { recursive: true })
    const count = calls.length, missing = await request({ what: 'pv' })
    assert.equal(missing.body.ok, false); assert.equal(missing.body.code, 'OPEN_DIRECTORY_UNAVAILABLE'); assert.equal(calls.length, count)
  } finally {
    for (const off of cleanups.reverse()) try { off() } catch {}
    cp.spawn = original; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true })
  }
})
