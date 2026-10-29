import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'fish-sticker-upload-route-')), builtin = join(root, 'builtin'), home = join(root, 'bili-duty')
mkdirSync(builtin); mkdirSync(home)
const dataBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8r+DAwMDAxAAGABFdAWPYSWFdAAAAAElFTkSuQmCC'
const gif = Buffer.from('R0lGODdhAgACAIEAAP8gQAAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7', 'base64')
writeFileSync(join(builtin, '内置.gif'), gif)
const priorBuiltin = process.env.DAFEIYU_STICKER_DIR; process.env.DAFEIYU_STICKER_DIR = builtin
const { apply } = await import('../index.js')
const cleanups = [], tools = new Map()
let handler
const ctx = { logger: { info() {} }, get: key => key === 'dshHomePath' ? (...parts) => join(root, ...parts) : undefined,
  tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } }, settings: { describe: () => [] }, on() { return () => {} },
  effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
  webServer: { register(route) { handler = route.handler; return { dispose() {} } } },
}

async function mockRequest(path, raw, headers = {}, chunks) {
  const req = new EventEmitter(); req.url = '/api/bili-duty' + path; req.method = 'POST'; req.headers = headers
  let destroyed = false; req.destroy = () => { destroyed = true }
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers }, end(data) { this.body = JSON.parse(data) } }
  const pending = handler(req, res)
  for (const bytes of chunks || [Buffer.from(raw)]) req.emit('data', bytes)
  req.emit('end'); await pending
  return { ...res, destroyed }
}
const post = (body, headers, chunks) => mockRequest('/stickers/upload', JSON.stringify(body), headers, chunks)

writeFileSync(join(home, 'config.json'), JSON.stringify({ reportLevel: 'off', learnAutoReview: false, autoComment: false, autoDm: false, autoMoment: false }))
apply(ctx, {})

test.after(() => {
  for (const cleanup of cleanups.reverse()) { try { cleanup() } catch {} }
  if (priorBuiltin === undefined) delete process.env.DAFEIYU_STICKER_DIR; else process.env.DAFEIYU_STICKER_DIR = priorBuiltin
  rmSync(root, { recursive: true, force: true })
})

test('HTTP upload provides stable errors, preserves Origin and posting gates, and exposes safe gallery image URL', async () => {
  assert.equal((await post({ name: '跨站', dataBase64 }, { origin: 'https://outside.example.com' })).status, 403)
  for (const body of [null, [], { name: '只给路径', path: join(builtin, '内置.gif') }, { name: '../escape', dataBase64 }, { name: '坏编码', dataBase64: 'a===' }]) {
    const result = await post(body); assert.equal(result.status, 400); assert.equal(result.body.ok, false)
  }
  assert.equal((await mockRequest('/stickers/upload', '{broken')).body.code, 'INVALID_JSON')
  const bad = await post({ name: '伪图片', dataBase64: Buffer.from('hello world and not image').toString('base64') })
  assert.equal(bad.status, 415); assert.equal(bad.body.code, 'STICKER_IMAGE_INVALID')
  const oversized = await post({ name: '字节超限', dataBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') })
  assert.equal(oversized.status, 413); assert.equal(oversized.body.code, 'STICKER_TOO_LARGE'); assert.equal(oversized.destroyed, false)
  // Size of the optional description pushes this otherwise valid upload beyond the old 1MB request limit.
  const body = { name: '本地图片', filename: 'from-device.jpg', dataBase64, description: '本地备注'.repeat(150000), tags: ['开心'] }
  const raw = Buffer.from(JSON.stringify(body)), firstChinese = raw.indexOf(Buffer.from('本'))
  assert.ok(raw.length > 1_000_000)
  const added = await post(body, { origin: 'http://127.0.0.1:43129' }, [raw.subarray(0, firstChinese + 1), raw.subarray(firstChinese + 1, 500000), raw.subarray(500000)])
  assert.equal(added.status, 200); assert.deepEqual(added.body, { ok: true, name: '本地图片', bytes: Buffer.from(dataBase64, 'base64').length, mime: 'image/png', source: 'collected', status: 'approved', imageUrl: '/api/bili-duty/stickers/image?name=' + encodeURIComponent('本地图片') + '&source=collected' })
  assert.ok(!Object.hasOwn(added.body, 'file'))
  const duplicate = await post({ name: '同内容', dataBase64 }); assert.equal(duplicate.status, 409); assert.equal(duplicate.body.duplicate, true)
  const config = JSON.parse(readFileSync(join(home, 'config.json')))
  assert.equal(config.autoComment, false); assert.equal(config.autoDm, false); assert.equal(config.autoMoment, false)
  const state = JSON.parse(readFileSync(join(home, 'state.json')))
  assert.equal(state.stickers.本地图片.description.length, 160); assert.equal(state.stickers.本地图片.file, '本地图片.png')
  assert.deepEqual(readFileSync(join(builtin, '内置.gif')), gif)
})

test('HTTP body overrun returns 413 without destroying the request; default routes keep the 1MB limit', async () => {
  const overrun = await mockRequest('/stickers/upload', '', {}, [Buffer.alloc(7 * 1024 * 1024 + 1, 32), Buffer.from('ignored after limit')])
  assert.equal(overrun.status, 413); assert.equal(overrun.body.code, 'REQUEST_TOO_LARGE'); assert.equal(overrun.destroyed, false)
  const declared = await mockRequest('/stickers/upload', '', { 'content-length': String(7 * 1024 * 1024 + 1) })
  assert.equal(declared.status, 413); assert.equal(declared.body.code, 'REQUEST_TOO_LARGE'); assert.equal(declared.destroyed, false)
  const defaults = await mockRequest('/stickers/collect', JSON.stringify({ name: '超默认请求体', description: 'x'.repeat(1_000_001) }))
  assert.equal(defaults.body.ok, false); assert.equal(defaults.destroyed, false)
})

test('real loopback transport receives JSON for a chunked upload overrun and remains usable', async () => {
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const call = (path, chunks) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: address.port, path: '/api/bili-duty' + path, method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      const data = []; res.on('data', bytes => data.push(bytes)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(data)) }))
    })
    req.on('error', reject)
    req.setTimeout(10000, () => req.destroy(new Error('fixture request timed out')))
    for (const bytes of chunks) req.write(bytes)
    req.end()
  })
  try {
    const tooLarge = await call('/stickers/upload', [Buffer.alloc(7 * 1024 * 1024, 32), Buffer.from('extra')])
    assert.equal(tooLarge.status, 413); assert.equal(tooLarge.body.code, 'REQUEST_TOO_LARGE')
    const after = await call('/stickers/forget', [Buffer.from(JSON.stringify({ name: '本地图片' }))])
    assert.equal(after.status, 200); assert.equal(after.body.ok, true)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
