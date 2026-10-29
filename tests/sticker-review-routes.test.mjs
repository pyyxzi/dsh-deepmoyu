import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { Readable } from 'node:stream'

const root = mkdtempSync(join(tmpdir(), 'fish-sticker-review-routes-')), builtin = join(root, 'builtin')
mkdirSync(builtin)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8r+DAwMDAxAAGABFdAWPYSWFdAAAAAElFTkSuQmCC', 'base64')
const gif = Buffer.from('R0lGODdhAgACAIEAABQ8eAAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7', 'base64')
const webp = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvAUAAAAdQnlIUr/+BiOh/AAA=', 'base64')
writeFileSync(join(builtin, '内置.webp'), webp)
const priorBuiltin = process.env.DAFEIYU_STICKER_DIR
process.env.DAFEIYU_STICKER_DIR = builtin
const { apply } = await import('../index.js')
const { McpClient } = await import('../lib/mcp.mjs')
const flush = () => new Promise(resolve => setImmediate(resolve))
let sequence = 0

async function fixture(extra = {}) {
  const dir = join(root, 'fixture-' + ++sequence), home = join(dir, 'bili-duty')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ reportLevel: 'off', learnAutoReview: false,
    autoComment: true, autoDm: false, autoMoment: false, stickerReview: true,
    stickerAutoSend: true, stickerSendProbability: 100, stickerSendCooldown: 0, ...extra }))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ tokensTotal: 777, unrelated: { kept: true } }))
  const cleanups = [], tools = new Map(), calls = []
  const agent = { id: 'fish-' + sequence, session: { header: { agentPreset: 'dafeiyu', cwd: dir } },
    ctx: { tools: { register(spec) { tools.set(spec.name, spec); return () => tools.delete(spec.name) } } } }
  let handler
  const originalCall = McpClient.prototype.call
  McpClient.prototype.call = async function(name, args) {
    const record = { name, args }
    if (Array.isArray(args?.pictures)) {
      // Capture what the sender actually read while the call is in flight; the
      // private snapshot is removed as soon as the send settles.
      record.pictureBytes = args.pictures.map(file => { try { return readFileSync(file) } catch { return null } })
    }
    calls.push(record)
    return name === 'bili_reply' ? { success: false, error: 'fixture send rejected; no network' } : {}
  }
  const ctx = { logger: { info() {} }, get: key => key === 'dshHomePath' ? (...parts) => join(dir, ...parts)
    : key === 'agents' ? { list: () => [agent] } : undefined,
    tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } }, settings: { describe: () => [] }, on() { return () => {} },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } },
  }
  apply(ctx, {}); await flush()
  const request = async (path, body, method = 'GET', headers = {}) => {
    const req = new EventEmitter(); req.url = path.startsWith('/api/') ? path : '/api/bili-duty' + path
    req.method = method; req.headers = headers; req.destroy = () => {}
    const res = { writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders },
      end(data) { this.raw = data; this.body = Buffer.isBuffer(data) || !data ? data : JSON.parse(data) } }
    const pending = handler(req, res)
    if (method === 'POST') { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }
    await pending
    return res
  }
  const post = (path, body, headers) => request(path, body, 'POST', headers)
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const upload = (name, bytes = png, fields = {}) => post('/stickers/upload', { name, dataBase64: bytes.toString('base64'), ...fields })
  const pending = async () => (await request('/stickers?status=pending')).body.stickers
  const reply = args => tools.get('bili_reply').execute({ bvid: 'BV1234567890', text: '镜头停在倒影上的那几秒，光线变化特别清楚。', ...args }, { agent })
  return { dir, home, agent, tools, calls, request, post, state, upload, pending, reply,
    close() { for (const cleanup of cleanups.reverse()) { try { cleanup() } catch {} }; McpClient.prototype.call = originalCall } }
}

test.after(() => {
  if (priorBuiltin === undefined) delete process.env.DAFEIYU_STICKER_DIR
  else process.env.DAFEIYU_STICKER_DIR = priorBuiltin
  rmSync(root, { recursive: true, force: true })
})

test('manual gallery previews pending bytes explicitly and only hash-bound manual approval makes them sendable', async () => {
  const f = await fixture()
  try {
    const added = await f.upload('待审图片', png, { stickerReview: false, description: '说明', tags: ['开心'] })
    assert.equal(added.status, 200); assert.equal(added.body.status, 'pending', 'request body cannot disable the configured gate')
    assert.ok(!Object.hasOwn(added.body, 'file'))
    const gallery = (await f.request('/stickers')).body
    assert.equal(gallery.settings.stickerReview, true)
    assert.deepEqual(gallery.stickers.map(item => item.name), ['内置'])
    assert.deepEqual(gallery.counts, { total: 2, builtin: 1, collected: 1, pending: 1, approved: 1 })
    assert.equal((await f.request('/stickers?status=bad')).status, 400)
    const [pending] = await f.pending()
    assert.equal(pending.name, '待审图片'); assert.equal(pending.status, 'pending'); assert.match(pending.hash, /^[a-f0-9]{64}$/)
    assert.ok(!Object.hasOwn(pending, 'file'))
    const hidden = await f.request('/stickers/image?name=' + encodeURIComponent(pending.name) + '&source=collected')
    assert.equal(hidden.status, 404)
    const preview = await f.request(pending.imageUrl)
    assert.equal(preview.status, 200); assert.deepEqual(preview.raw, png); assert.equal(preview.headers['cache-control'], 'private, no-store')
    assert.equal((await f.request(pending.imageUrl.replace(pending.hash, '0'.repeat(64)))).status, 404)
    const toolList = await f.tools.get('bili_sticker').execute({ action: 'list', status: 'all' }, { agent: f.agent })
    assert.deepEqual(toolList.stickers.map(item => item.name), ['内置'])
    assert.equal((await f.tools.get('bili_sticker').execute({ action: 'approve', name: pending.name, expectedHash: pending.hash }, { agent: f.agent })).ok, false)
    for (const picture of [pending.name, join(f.home, 'stickers', pending.name + '.png')]) {
      const before = f.calls.length
      assert.equal((await f.reply({ picture })).sticker_unknown, true)
      assert.equal(f.calls.length, before, 'pending names and absolute paths never reach the sender')
    }
    await f.reply({})
    assert.deepEqual(f.calls.at(-1).pictureBytes, [webp])
    for (const body of [{ name: pending.name }, { name: pending.name, expectedHash: 'bad' }, []]) assert.equal((await f.post('/stickers/approve', body)).status, 400)
    assert.equal((await f.post('/stickers/approve', { name: pending.name, expectedHash: pending.hash }, { origin: 'https://outside.example.com' })).status, 403)
    assert.equal((await f.post('/stickers/approve', { name: pending.name, expectedHash: '0'.repeat(64) })).body.code, 'STICKER_REVIEW_CHANGED')
    const approved = await f.post('/stickers/approve', { name: pending.name, expectedHash: pending.hash })
    assert.equal(approved.status, 200); assert.equal(approved.body.status, 'approved')
    assert.equal((await f.pending()).length, 0)
    await f.reply({ picture: pending.name })
    const sent = f.calls.at(-1)
    assert.equal(sent.args.pictures.length, 1)
    assert.notEqual(sent.args.pictures[0], join(f.home, 'stickers', pending.name + '.png'), 'sender gets a private snapshot, not the reusable library path')
    assert.deepEqual(sent.pictureBytes[0], png)
    assert.equal(existsSync(sent.args.pictures[0]), false, 'snapshot is removed after the send')
    assert.equal((await f.request('/stickers/image?name=' + encodeURIComponent(pending.name) + '&source=collected')).status, 200)
    assert.equal((await f.post('/stickers/reject', { name: pending.name, expectedHash: pending.hash })).body.code, 'STICKER_NOT_PENDING')
    assert.equal(f.state().tokensTotal, 777); assert.deepEqual(f.state().unrelated, { kept: true })
    const config = JSON.parse(readFileSync(join(f.home, 'config.json'), 'utf8'))
    assert.equal(config.autoComment, true, 'the fixture explicitly authorized comments before testing picture gates')
    for (const key of ['autoDm', 'autoMoment']) assert.equal(config[key], false)
  } finally { f.close() }
})

test('a send is bound to approved bytes when a same-name pending image replaces the file mid-call', async () => {
  const f = await fixture({ stickerReview: false })
  const originalCall = McpClient.prototype.call
  try {
    const added = await f.upload('竞态图', png)
    assert.equal(added.body.status, 'approved')
    let release, entered
    const began = new Promise(resolve => { entered = resolve })
    McpClient.prototype.call = async function(name, args) {
      const record = { name, args }
      if (Array.isArray(args?.pictures)) record.pictureBytes = args.pictures.map(file => { try { return readFileSync(file) } catch { return null } })
      f.calls.push(record)
      if (name === 'bili_reply' && args.pictures?.length) {
        entered()
        await new Promise(resolve => { release = resolve })
      }
      return {}
    }
    const sending = f.reply({ picture: '竞态图' })
    await began
    const approvedPath = join(f.home, 'stickers', '竞态图.png')
    assert.equal(existsSync(approvedPath), true)
    assert.equal((await f.post('/config', { stickerReview: true })).body.config.stickerReview, true)
    assert.equal((await f.post('/stickers/forget', { name: '竞态图' })).body.ok, true)
    // Same-name upload is now pending; without the snapshot the old send would read these bytes.
    const swapped = await f.upload('竞态图', gif)
    assert.equal(swapped.body.status, 'pending')
    release()
    await sending
    const sent = f.calls.at(-1)
    assert.notEqual(sent.args.pictures[0], approvedPath)
    assert.deepEqual(sent.pictureBytes[0], png, 'original approved bytes were sent, never the new pending GIF')
    assert.equal((await f.pending()).length, 1)
  } finally {
    McpClient.prototype.call = originalCall
    f.close()
  }
})

test('turning review off affects new additions only, and rejection releases pending capacity without approving old entries', async () => {
  const f = await fixture({ stickerCapacity: 1 })
  try {
    assert.equal((await f.upload('仍待审核')).body.status, 'pending')
    const [pending] = await f.pending()
    assert.equal((await f.post('/config', { stickerReview: false })).body.config.stickerReview, false)
    assert.equal((await f.pending()).length, 1)
    assert.equal((await f.reply({ picture: pending.name })).sticker_unknown, true)
    const full = await f.upload('库满时的新图', gif)
    assert.equal(full.status, 409); assert.equal(full.body.code, 'STICKER_CAPACITY')
    const rejected = await f.post('/stickers/reject', { name: pending.name, expectedHash: pending.hash })
    assert.equal(rejected.status, 200); assert.equal(rejected.body.rejected, pending.name)
    assert.equal(existsSync(join(f.home, 'stickers', pending.name + '.png')), false)
    assert.equal((await f.request(pending.imageUrl)).status, 404)
    const direct = await f.upload('直接可用', png, { stickerReview: true })
    assert.equal(direct.body.status, 'approved', 'request body cannot enable the gate when config is off')
    assert.equal((await f.pending()).length, 0)
    assert.equal((await f.post('/stickers/approve', { name: '不存在', expectedHash: pending.hash })).body.code, 'STICKER_NOT_FOUND')
    assert.equal((await f.request('/status')).body.tokensTotal, 777)
  } finally { f.close() }
})

test('ordinary config tools cannot change review, including mixed patches; forget and recollect stay pending while settings can toggle', async () => {
  const f = await fixture()
  const configFile = join(f.home, 'config.json'), config = f.tools.get('bili_config')
  const sticker = args => f.tools.get('bili_sticker').execute(args, { agent: f.agent })
  try {
    const first = await sticker({ action: 'collect', name: '工具待审', path: '内置', stickerReview: false, status: 'approved' })
    assert.equal(first.ok, true); assert.equal(first.status, 'pending')
    assert.ok(!Object.hasOwn(first, 'file'))
    const beforeConfig = readFileSync(configFile, 'utf8'), beforeState = f.state(), beforePending = await f.pending()
    for (const patch of [
      { stickerReview: false },
      { stickerReview: false, stickerAutoSend: false, focus: '夹带更改' },
      { stickerReview: null, paceFactor: 0.5 },
      { stickerReview: true, stickerCapacity: 1 },
    ]) {
      for (const exec of [{}, { agent: f.agent }]) {
        const blocked = await config.execute({ patch }, exec)
        assert.equal(blocked.ok, false)
        if (exec.agent) assert.equal(blocked.code, 'STICKER_REVIEW_MANUAL_ONLY')
        else assert.equal(blocked.reason, 'mode_required', 'ordinary conversations cannot execute fish config tools at all')
        assert.equal(readFileSync(configFile, 'utf8'), beforeConfig, 'the entire patch is rejected before config persistence')
        assert.deepEqual(f.state(), beforeState)
        assert.deepEqual(await f.pending(), beforePending)
      }
    }
    assert.equal((await config.execute({}, { agent: f.agent })).config.stickerReview, true)
    assert.equal((await f.reply({ picture: first.collected })).sticker_unknown, true)
    assert.equal((await sticker({ action: 'forget', name: first.collected })).ok, true)
    const recollected = await sticker({ action: 'collect', name: '重收待审', path: '内置', stickerReview: false })
    assert.equal(recollected.ok, true); assert.equal(recollected.status, 'pending')
    assert.equal((await f.reply({ picture: recollected.collected })).sticker_unknown, true)

    assert.equal((await f.post('/config', { stickerReview: false })).body.config.stickerReview, false)
    const offConfig = readFileSync(configFile, 'utf8'), offPending = await f.pending()
    assert.equal(offPending.length, 1); assert.equal(offPending[0].name, recollected.collected)
    const blockedEnable = await config.execute({ patch: { stickerReview: true, stickerAutoSend: false } }, { agent: f.agent })
    assert.equal(blockedEnable.code, 'STICKER_REVIEW_MANUAL_ONLY')
    assert.equal(readFileSync(configFile, 'utf8'), offConfig)
    assert.deepEqual(await f.pending(), offPending)
    assert.equal((await f.upload('设置关闭后新增', png, { stickerReview: true })).body.status, 'approved')
    assert.equal((await f.reply({ picture: recollected.collected })).sticker_unknown, true, 'disabling the gate never approves old pending entries')
    assert.equal((await f.post('/config', { stickerReview: true })).body.config.stickerReview, true)
    assert.equal((await f.upload('设置重开后新增', gif, { stickerReview: false })).body.status, 'pending')
    assert.deepEqual((await f.pending()).map(item => item.name), [recollected.collected, '设置重开后新增'])
    const ordinary = await config.execute({ patch: { focus: '普通配置仍可修改' } }, { agent: f.agent })
    assert.equal(ordinary.ok, true); assert.equal(ordinary.config.focus, '普通配置仍可修改')
    assert.equal(ordinary.config.stickerReview, true)
    assert.equal(f.state().tokensTotal, 777); assert.deepEqual(f.state().unrelated, { kept: true })
  } finally { f.close() }
})

test('real collect wrapper and HTTP download use current review config when a download commits', async () => {
  const f = await fixture({ stickerReview: false })
  const require = createRequire(import.meta.url), https = require('node:https'), dns = require('node:dns')
  const originalRequest = https.request, originalLookup = dns.promises.lookup
  let release, began, downloads = 0
  const begun = new Promise(resolve => { began = resolve })
  dns.promises.lookup = async () => [{ address: '8.8.8.8', family: 4 }]
  https.request = (_url, options, respond) => {
    const request = new EventEmitter()
    request.end = () => {
      downloads++
      const deliver = () => { const response = Readable.from([png]); response.headers = { 'content-type': 'image/png' }; response.statusCode = 200; queueMicrotask(() => respond(response)) }
      if (downloads === 1) { release = deliver; began() } else deliver()
    }
    options.signal.addEventListener('abort', () => request.emit('error', options.signal.reason), { once: true })
    return request
  }
  syncBuiltinESMExports()
  try {
    const adding = f.post('/stickers/collect', { name: '下载过程中开启', url: 'https://images.example.com/live.png', stickerReview: false })
    await begun
    assert.equal((await f.post('/config', { stickerReview: true })).body.config.stickerReview, true)
    release()
    const added = await adding
    assert.equal(added.body.status, 'pending')
    assert.equal((await f.pending()).length, 1)
    const copy = await f.tools.get('bili_sticker').execute({ action: 'collect', name: '工具复制待审', path: '内置', stickerReview: false }, { agent: f.agent })
    assert.equal(copy.ok, true); assert.equal(copy.status, 'pending'); assert.ok(!Object.hasOwn(copy, 'file'))
    assert.equal((await f.tools.get('bili_sticker').execute({ action: 'collect', name: '待审绕过', path: copy.collected }, { agent: f.agent })).ok, false)
    assert.equal((await f.pending()).length, 2)
    assert.equal(downloads, 1)
    const blocked = await f.post('/stickers/collect', { name: '内网', url: 'http://127.0.0.1/private.png' })
    assert.equal(blocked.body.ok, false); assert.equal(downloads, 1)
  } finally { https.request = originalRequest; dns.promises.lookup = originalLookup; syncBuiltinESMExports(); f.close() }
})
