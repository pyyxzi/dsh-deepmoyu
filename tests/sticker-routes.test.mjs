import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { Readable } from 'node:stream'

const root = mkdtempSync(join(tmpdir(), 'fish-sticker-routes-')), builtin = join(root, 'builtin'), home = join(root, 'bili-duty')
mkdirSync(builtin); mkdirSync(home)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64')
writeFileSync(join(builtin, '贴贴.png'), png)
const priorBuiltin = process.env.DAFEIYU_STICKER_DIR; process.env.DAFEIYU_STICKER_DIR = builtin
const { apply } = await import('../index.js')
const { McpClient } = await import('../lib/mcp.mjs')

test('gallery HTTP is safe and on demand; real reply wrapper auto-selects only eligible authorized new comments', async () => {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ reportLevel: 'off', learnAutoReview: false, autoComment: false, stickerAutoSend: true, stickerSendProbability: 100, stickerSendCooldown: 0 }))
  const cleanups = [], tools = new Map(), calls = []
  let handler
  const agent = { id: 'fish', session: { header: { agentPreset: 'dafeiyu', cwd: root } },
    ctx: { tools: { register(spec) { tools.set(spec.name, spec); return () => tools.delete(spec.name) } } } }
  const ctx = { logger: { info() {} }, get: key => key === 'dshHomePath' ? (...parts) => join(root, ...parts) : key === 'agents' ? { list: () => [agent] } : undefined,
    tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } }, settings: { describe: () => [] }, on() { return () => {} },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } },
  }
  async function request(path, body, method = 'GET', headers = {}) {
    const req = new EventEmitter(); req.url = '/api/bili-duty' + path; req.method = method; req.headers = headers; req.destroy = () => {}
    const res = { writeHead(code, headers) { this.code = code; this.headers = headers }, end(data) { this.raw = data; this.body = Buffer.isBuffer(data) || !data ? data : JSON.parse(data) } }
    const pending = handler(req, res)
    if (method === 'POST') { req.emit('data', Buffer.from(JSON.stringify(body || {}))); req.emit('end') }
    await pending; return res
  }
  const actualCall = McpClient.prototype.call
  McpClient.prototype.call = async function(name, args) {
    const record = { name, args }
    if (Array.isArray(args?.pictures)) record.pictureBytes = args.pictures.map(file => { try { return readFileSync(file) } catch { return null } })
    calls.push(record)
    if (name === 'bili_reply') return { success: false, error: 'fixture send rejected; no network' }
    if (name === 'bili_comments') return { comments: [] }
    return {}
  }
  const reply = (args, fish = true) => tools.get('bili_reply').execute({ bvid: 'BV1234567890', text: '镜头停在倒影上的那几秒，光线变化特别清楚。', ...args }, fish ? { agent } : {})
  try {
    apply(ctx, {}); await new Promise(resolve => setImmediate(resolve))
    const gallery = await request('/stickers')
    assert.equal(gallery.body.ok, true); assert.deepEqual(gallery.body.counts, { total: 1, builtin: 1, collected: 0, pending: 0, approved: 1 })
    assert.equal(gallery.body.settings.stickerCollectProbability, 35); assert.equal(gallery.body.capacity, 60)
    assert.equal(gallery.body.stickers[0].removable, false); assert.ok(!Object.hasOwn(gallery.body.stickers[0], 'file'))
    const image = await request(gallery.body.stickers[0].imageUrl.replace('/api/bili-duty', ''))
    assert.equal(image.code, 200); assert.equal(image.headers['content-type'], 'image/png'); assert.deepEqual(image.raw, png)
    assert.equal((await request('/stickers/image?name=贴贴&source=builtin', null, 'GET', { 'if-none-match': image.headers.etag })).code, 304)
    for (const query of ['name=..%2Fconfig.json', 'name=贴贴&source=../../', 'name=unknown', '']) assert.equal((await request('/stickers/image?' + query)).code, 404)
    assert.equal((await request('/stickers/collect', { name: '逃逸', path: join(root, 'private.png') }, 'POST')).body.ok, false)
    assert.equal((await request('/stickers/collect', { name: '内网', url: 'http://127.0.0.1/secrets' }, 'POST')).body.ok, false)
    assert.equal((await request('/stickers/forget', { name: '贴贴' }, 'POST')).body.ok, false)
    assert.equal((await request('/stickers/forget', { name: 'x' }, 'POST', { origin: 'https://outside.example.com' })).code, 403)
    const copied = await tools.get('bili_sticker').execute({ action: 'collect', name: '别名', path: '贴贴', description: '同一张图换个名字' }, { agent })
    assert.equal(copied.ok, true)
    assert.equal((await request('/stickers')).body.counts.collected, 1)
    assert.equal((await request('/stickers/forget', { name: '别名' }, 'POST')).body.ok, true)
    const config = (await request('/config', { stickerCollectProbability: 123, stickerCapacity: 999, stickerAutoSend: true }, 'POST')).body
    assert.equal(config.config.stickerCollectProbability, 100); assert.equal(config.config.stickerCapacity, 60)
    const blocked = await reply({})
    assert.equal(blocked.blocked, true); assert.equal(calls.filter(x => x.name === 'bili_reply').length, 0)
    assert.equal((await reply({ force: true })).code, 'FORCE_NOT_AUTHORIZATION')
    await request('/config', { autoComment: true, replyToComments: true }, 'POST')
    const sent = await reply({})
    assert.equal(sent.auto_picture, '贴贴')
    assert.notEqual(calls.at(-1).args.pictures[0], join(builtin, '贴贴.png'), 'send uses a private snapshot')
    assert.deepEqual(calls.at(-1).pictureBytes, [png])
    await reply({ picture: '' }); assert.equal(calls.at(-1).args.pictures, undefined)
    await reply({ picture: '贴贴' })
    assert.notEqual(calls.at(-1).args.pictures[0], join(builtin, '贴贴.png'))
    assert.deepEqual(calls.at(-1).pictureBytes, [png])
    await reply({ rpid: '123456789' }); assert.equal(calls.at(-1).args.pictures, undefined)
    assert.equal((await reply({}, false)).reason, 'mode_required', 'ordinary mode never executes role sends')
    const beforeUnknown = calls.length
    assert.equal((await reply({ picture: '../private' })).sticker_unknown, true); assert.equal(calls.length, beforeUnknown)
    assert.equal((await reply({ rpid: '987654321', picture: '贴贴' })).picture_floor, true)
    const status = (await request('/status')).body
    assert.ok(!Object.hasOwn(status, 'stickers')); assert.equal(status.tokensTotal, 0)
    const unchanged = (await request('/status?rev=' + encodeURIComponent(status.rev))).body
    assert.equal(unchanged.unchanged, true)
    assert.equal(JSON.parse(readFileSync(join(home, 'config.json'))).autoComment, true, 'only the explicit manual config call granted posting authority')
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup() } catch {} }
    McpClient.prototype.call = actualCall
  }
})

test.after(() => { if (priorBuiltin === undefined) delete process.env.DAFEIYU_STICKER_DIR; else process.env.DAFEIYU_STICKER_DIR = priorBuiltin; rmSync(root, { recursive: true, force: true }) })

test('session stop cancels only that session collection queue and download; resume accepts a fresh scope', async () => {
  const isolated = join(root, 'scopes'), duty = join(isolated, 'bili-duty'); mkdirSync(duty, { recursive: true })
  writeFileSync(join(duty, 'config.json'), JSON.stringify({ reportLevel: 'off', learnAutoReview: false, stickerAutoCollect: true, stickerCollectProbability: 100, stickerCollectCooldown: 0 }))
  const agents = ['a', 'b'].map(id => ({ id, session: { header: { agentPreset: 'dafeiyu', cwd: isolated } },
    ctx: { tools: { register(spec) { tools.set(spec.name, spec); return () => tools.delete(spec.name) } } } })), goals = new Map()
  for (const agent of agents) goals.set(agent.id, { id: agent.id + '-goal', objective: '🐟 鲸鱼摸鱼模式 fixture', phase: 'active', activation: 'armed', revision: 1, roundsStarted: 1, maxGoalRounds: 10 })
  const cleanups = [], tools = new Map(), require = createRequire(import.meta.url)
  const http = require('node:https'), dns = require('node:dns'), oldRequest = http.request, oldLookup = dns.promises.lookup
  const actualCall = McpClient.prototype.call
  let handler, urlCounter = 0, imageRequests = 0, pendingRequest, requestBegun
  dns.promises.lookup = async () => [{ address: '8.8.8.8', family: 4 }]
  // Native transport is intercepted after URL and DNS validation; there is no external connection.
  http.request = (_url, options, respond) => {
    const request = new EventEmitter()
    request.end = () => {
      imageRequests++
      if (imageRequests === 1) { pendingRequest = request; requestBegun?.(); return }
      const response = Readable.from([Buffer.concat([png, Buffer.from(String(imageRequests))])]); response.headers = { 'content-type': 'image/png' }; response.statusCode = 200
      queueMicrotask(() => respond(response))
    }
    const abort = () => request.emit('error', options.signal.reason)
    options.signal.addEventListener('abort', abort, { once: true })
    request.once('error', () => options.signal.removeEventListener('abort', abort))
    return request
  }
  syncBuiltinESMExports()
  McpClient.prototype.call = async function(name) { return name === 'bili_comments' ? { comments: [{ rpid: String(++urlCounter), images: [{ url: 'https://images.example.com/' + urlCounter + '.png', w: 256, h: 256 }] }] } : {} }
  const services = { dshHomePath: (...parts) => join(isolated, ...parts), agents: { list: () => agents, get: id => agents.find(a => a.id === id) }, goals: { get: agent => goals.get(agent.id), pause(agent) { const g = goals.get(agent.id); g.phase = 'paused'; g.activation = 'disarmed'; return g }, resume(agent) { const g = goals.get(agent.id); g.phase = 'active'; g.activation = 'armed'; return g } } }
  const ctx = { logger: { info() {} }, get: key => services[key], tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } }, settings: { describe: () => [] }, on() { return () => {} }, effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) }, webServer: { register(route) { handler = route.handler; return { dispose() {} } } } }
  async function post(action, agent) {
    const req = new EventEmitter(); req.url = '/api/bili-duty/feiyu'; req.method = 'POST'; req.headers = {}; req.destroy = () => {}
    const res = { writeHead() {}, end(text) { this.body = JSON.parse(text) } }, promise = handler(req, res)
    req.emit('data', Buffer.from(JSON.stringify({ action, sessionId: agent.id }))); req.emit('end'); await promise; return res.body
  }
  const comments = agent => tools.get('bili_comments').execute({ bvid: 'BV1234567890' }, { agent })
  const flush = () => new Promise(resolve => setImmediate(resolve))
  const collected = () => Object.keys(JSON.parse(readFileSync(join(duty, 'state.json'), 'utf8')).stickers || {})
  try {
    apply(ctx, {}); await flush()
    await comments(agents[0]); await post('stop', agents[0]); await flush()
    assert.equal(imageRequests, 0, 'queued download is withdrawn even though host tool signal is absent')
    assert.equal((await post('resume', agents[0])).ok, true)
    const begun = new Promise(resolve => { requestBegun = resolve })
    await comments(agents[0]); await begun
    await comments(agents[1]); await post('stop', agents[0]); await flush(); await flush()
    assert.ok(pendingRequest.listenerCount('error') > 0)
    assert.equal(imageRequests, 2, 'other session continues after one session stops')
    assert.equal(collected().length, 1, 'stopped inflight session never commits')
    assert.equal((await post('resume', agents[0])).ok, true)
    await comments(agents[0]); await flush(); await flush()
    assert.equal(imageRequests, 3); assert.equal(collected().length, 2, 'resumed session gets a fresh collection scope')
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup() } catch {} }
    http.request = oldRequest; dns.promises.lookup = oldLookup; McpClient.prototype.call = actualCall; syncBuiltinESMExports()
  }
})
