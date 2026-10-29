import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'fish-sticker-test-')), builtin = join(root, 'builtin')
mkdirSync(builtin)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64')
const alternate = Buffer.concat([png, Buffer.from('another image')])
writeFileSync(join(builtin, '贴贴.png'), png)
const priorBuiltin = process.env.DAFEIYU_STICKER_DIR
process.env.DAFEIYU_STICKER_DIR = builtin
const { listStickers, collectSticker, forgetSticker, readStickerImage, resolveSticker, safeName } = await import('../lib/sticker.mjs')
const { downloadStickerImage, publicImageUrl, isPublicImageAddress } = await import('../lib/sticker-download.mjs')
const { createStickerAutomation, STICKER_DEFAULTS, clampStickerSettings, commentStickerCandidates } = await import('../lib/sticker-automation.mjs')
const lookupImpl = async () => [{ address: '8.8.8.8', family: 4 }]
const imageFetch = async () => new Response(alternate, { headers: { 'content-type': 'image/png' } })
const flush = () => new Promise(resolve => setImmediate(resolve))
let sequence = 0
const home = () => { const dir = join(root, 'home-' + ++sequence); mkdirSync(dir); writeFileSync(join(dir, 'state.json'), JSON.stringify({ tokensTotal: 1234, unrelated: { retained: true } })); return dir }
const comments = (suffix = 'one') => ({ comments: [{ rpid: '12345678901234567', images: [{ url: `https://images.example.com/${suffix}.png`, w: 256, h: 256 }] }] })
const collectionCfg = { ...STICKER_DEFAULTS, stickerAutoCollect: true, stickerCollectProbability: 100, stickerCollectCooldown: 0 }

test.after(() => { if (priorBuiltin === undefined) delete process.env.DAFEIYU_STICKER_DIR; else process.env.DAFEIYU_STICKER_DIR = priorBuiltin; rmSync(root, { recursive: true, force: true }) })

test('sticker settings keep separate switches, exact defaults and bounded percentages/capacity', () => {
  assert.deepEqual(STICKER_DEFAULTS, { stickerAutoCollect: false, stickerCollectProbability: 35, stickerCollectCooldown: 60, stickerAutoSend: false, stickerSendProbability: 30, stickerSendCooldown: 180, stickerCapacity: 60, stickerReview: false })
  assert.deepEqual(clampStickerSettings({ stickerAutoCollect: 'true', stickerAutoSend: true, stickerReview: 'true', stickerCollectProbability: 200, stickerSendProbability: -10, stickerCollectCooldown: -3, stickerSendCooldown: 999999, stickerCapacity: 500 }), { stickerAutoCollect: false, stickerAutoSend: true, stickerReview: false, stickerCollectProbability: 100, stickerSendProbability: 0, stickerCollectCooldown: 0, stickerSendCooldown: 86400, stickerCapacity: 60 })
  assert.equal(clampStickerSettings({ stickerReview: true }).stickerReview, true)
})

test('public-image validation rejects local addresses, credentials, ports and special address ranges', () => {
  for (const url of ['file:///C:/secrets', 'https://localhost/image', 'http://127.0.0.1/a', 'https://0x7f000001/a', 'http://169.254.169.254/a', 'http://[::1]/a', 'http://[::ffff:127.0.0.1]/a', 'https://a.internal/a', 'https://user:pass@images.example.com/a', 'https://images.example.com:8080/a']) assert.throws(() => publicImageUrl(url), url)
  for (const ip of ['0.0.0.0', '100.64.0.1', '172.31.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '2001:db8::1', '2002:7f00:1::', 'fc00::1']) assert.equal(isPublicImageAddress(ip), false, ip)
  assert.equal(isPublicImageAddress('8.8.8.8'), true)
  assert.equal(isPublicImageAddress('2606:4700:4700::1111'), true)
  assert.equal(publicImageUrl('https://images.example.com/a#fragment').href, 'https://images.example.com/a')
})

test('downloader validates DNS and every redirect before fetching and enforces byte/type limits', async () => {
  let calls = 0
  await assert.rejects(downloadStickerImage('https://images.example.com/a', { lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }], fetchImpl: async () => { calls++; return new Response(png) } }), /内网/)
  assert.equal(calls, 0)
  await assert.rejects(downloadStickerImage('https://images.example.com/a', { lookupImpl, fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) } }), /内网/)
  assert.equal(calls, 1)
  await assert.rejects(downloadStickerImage('https://images.example.com/a', { lookupImpl, fetchImpl: async () => new Response(png, { headers: { 'content-length': '9999999' } }) }), /5MB/)
  await assert.rejects(downloadStickerImage('https://images.example.com/a', { lookupImpl, maxBytes: 16, fetchImpl: imageFetch }), /5MB/)
  await assert.rejects(downloadStickerImage('https://images.example.com/a', { lookupImpl, fetchImpl: async () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }) }), /图片格式/)
  assert.deepEqual((await downloadStickerImage('https://images.example.com/a', { lookupImpl, fetchImpl: imageFetch })).bytes, alternate)
})

test('collection preserves provenance/state, deduplicates URL/content and keeps builtins read-only', async () => {
  const dir = home(), url = 'https://images.example.com/a.png'
  const added = await collectSticker(dir, { name: '惊喜', url, lookupImpl, fetchImpl: imageFetch, bvid: 'BV1234567890', rpid: '12345678901234567', from: '评论区', tags: ['开心'], description: '笑起来的表情' })
  assert.equal(added.ok, true)
  const state = JSON.parse(readFileSync(join(dir, 'state.json')))
  assert.equal(state.tokensTotal, 1234); assert.deepEqual(state.unrelated, { retained: true })
  assert.equal(state.stickers.惊喜.sourceUrl, url); assert.equal(state.stickers.惊喜.bvid, 'BV1234567890'); assert.equal(state.stickers.惊喜.rpid, '12345678901234567')
  assert.deepEqual(state.stickers.惊喜.tags, ['开心'])
  assert.equal((await collectSticker(dir, { name: '另一个名字', url, lookupImpl, fetchImpl: () => { throw new Error('must not redownload') } })).duplicate, true)
  assert.equal((await collectSticker(dir, { name: '同内容', url: 'https://images.example.com/changed-url.png', lookupImpl, fetchImpl: imageFetch })).duplicate, true)
  assert.equal((await collectSticker(dir, { name: '同内置', url: 'https://images.example.com/builtin.png', lookupImpl, fetchImpl: async () => new Response(png) })).duplicate, true)
  assert.equal((await collectSticker(dir, { name: '贴贴', url, lookupImpl, fetchImpl: imageFetch })).ok, false)
  assert.equal(forgetSticker(dir, '贴贴').ok, false)
  assert.deepEqual(readFileSync(join(builtin, '贴贴.png')), png)
  assert.equal(listStickers(dir).length, 2)
  const image = readStickerImage(dir, '惊喜', 'collected'); assert.deepEqual(image.bytes, alternate); assert.equal(image.mime, 'image/png'); assert.ok(image.etag)
  assert.equal(forgetSticker(dir, '惊喜').ok, true); assert.equal(listStickers(dir).length, 1)
  assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'))).tokensTotal, 1234)
})

test('library allows explicit builtin copies while rejecting traversal, arbitrary files and corrupt ledger deletion', async () => {
  const dir = home()
  assert.equal((await collectSticker(dir, { name: '别名', path: '贴贴' })).ok, true)
  assert.equal(resolveSticker(dir, '贴贴'), join(builtin, '贴贴.png'))
  assert.equal(resolveSticker(dir, join(root, 'state.json')), '')
  for (const name of ['../逃逸', '..\\逃逸', 'con', '__proto__']) assert.equal((await collectSticker(dir, { name, path: '贴贴' })).ok, false, name)
  assert.equal(safeName('hello world.png'), 'hello-world')
  assert.equal(readStickerImage(dir, '../state', 'collected'), null)
  const stateFile = join(dir, 'state.json')
  writeFileSync(stateFile, JSON.stringify({ tokensTotal: 88, stickers: { 假图: { file: '../state.json' } } }))
  assert.equal(forgetSticker(dir, '假图').ok, false)
  assert.equal(JSON.parse(readFileSync(stateFile)).tokensTotal, 88)
  writeFileSync(stateFile, '{broken')
  assert.equal((await collectSticker(dir, { name: '图', path: '贴贴' })).ok, false)
  assert.equal(readFileSync(stateFile, 'utf8'), '{broken')
})

test('capacity, auto naming, actual image magic and commit cancellation apply before storage', async () => {
  const dir = home()
  assert.equal((await collectSticker(dir, { name: '贴贴', path: '贴贴', autoName: true, capacity: 1 })).name, '贴贴-2')
  assert.equal((await collectSticker(dir, { name: '第二张', path: '贴贴', capacity: 1 })).ok, false)
  const other = home()
  assert.match((await collectSticker(other, { name: 'HTML', url: 'https://images.example.com/html', lookupImpl, fetchImpl: async () => new Response('<html>not image</html>') })).error, /图片格式/)
  assert.equal((await collectSticker(other, { name: '取消', url: 'https://images.example.com/canceled', lookupImpl, fetchImpl: imageFetch, shouldCommit: () => false })).ok, false)
  assert.equal(listStickers(other, { source: 'collected' }).length, 0)
})

test('comment candidates are bounded and exclude emotes, duplicate images and unreasonable aspect ratios', () => {
  const rows = comments()
  rows.comments[0].images.push({ url: 'http://127.0.0.1/a', w: 256, h: 256 }, { url: 'https://images.example.com/tiny', w: 24, h: 24 }, { url: 'https://images.example.com/wide', w: 2000, h: 50 }, rows.comments[0].images[0])
  rows.comments[0].emotes = [{ url: 'https://images.example.com/emote' }]
  assert.equal(commentStickerCandidates(rows, 'BV1234567890').length, 1)
  assert.equal(commentStickerCandidates(rows, 'BV1234567890')[0].rpid, '12345678901234567')
})

test('automatic collection executes off the comments path with switch, probability, cooldown and concurrency bounds', async () => {
  const dir = home(), calls = [], events = []
  let cfg = { ...collectionCfg, stickerAutoCollect: false }, at = 10000
  const auto = createStickerAutomation({ stateDir: dir, getConfig: () => cfg, now: () => at, random: () => 0, collect: async (_dir, opts) => { calls.push(opts); return { ok: true, name: opts.name } }, onEvent: (kind, data) => events.push({ kind, data }) })
  assert.equal(auto.offer(comments(), 'BV1234567890').queued, 0)
  cfg = { ...cfg, stickerAutoCollect: true, stickerCollectProbability: 0 }
  assert.equal(auto.offer(comments(), 'BV1234567890').queued, 0)
  cfg = { ...cfg, stickerCollectProbability: 100, stickerCollectCooldown: 60 }
  assert.equal(auto.offer(comments(), 'BV1234567890').queued, 1); assert.equal(calls.length, 0)
  await flush(); assert.equal(calls.length, 1); assert.equal(auto.snapshot().lastCollectedAt, at)
  assert.equal(auto.offer(comments('second'), 'BV1234567890').queued, 0)
  at += 60001
  assert.equal(auto.offer(comments('second'), 'BV1234567890').queued, 1)
  await flush(); assert.equal(calls.length, 2); assert.equal(events.filter(x => x.kind === 'collected').length, 2)
  auto.stop()
})

test('queued and inflight source cancellation prevent disk writes without disabling later runs', async () => {
  const dir = home(), queued = new AbortController(), inflight = new AbortController()
  let requests = 0, started
  const begun = new Promise(resolve => { started = resolve })
  const auto = createStickerAutomation({ stateDir: dir, getConfig: () => collectionCfg, random: () => 0,
    collect: (stateDir, opts) => collectSticker(stateDir, { ...opts, lookupImpl, fetchImpl: async () => { requests++; if (requests === 1) { started(); return new Promise(() => {}) }; return new Response(alternate) } }) })
  auto.offer(comments('queued'), 'BV1234567890', { signal: queued.signal }); queued.abort(new Error('round stopped'))
  await flush(); assert.equal(requests, 0)
  auto.offer(comments('inflight'), 'BV1234567890', { signal: inflight.signal })
  await begun; inflight.abort(new Error('round stopped'))
  await flush(); await flush()
  assert.equal(listStickers(dir, { source: 'collected' }).length, 0)
  assert.equal(auto.snapshot().collectPending, 0)
  auto.offer(comments('next-run'), 'BV1234567890', { signal: new AbortController().signal })
  await flush(); await flush()
  assert.equal(listStickers(dir, { source: 'collected' }).length, 1)
  assert.equal(requests, 2)
  auto.stop()
})

test('global disposal aborts active download, bounds pending work and prevents new offers', async () => {
  const dir = home(), calls = []; let release
  const auto = createStickerAutomation({ stateDir: dir, getConfig: () => collectionCfg, random: () => 0,
    collect: async (_dir, opts) => { calls.push(opts); return new Promise(resolve => { release = resolve }) } })
  for (let i = 0; i < 10; i++) auto.offer(comments(String(i)), 'BV1234567890')
  assert.equal(auto.snapshot().collectPending, 3)
  await flush(); assert.equal(calls.length, 1)
  auto.stop(); assert.equal(calls[0].signal.aborted, true); assert.equal(calls[0].shouldCommit(), false)
  release({ ok: false, error: 'canceled' }); await flush()
  assert.equal(auto.offer(comments('later'), 'BV1234567890').queued, 0)
  assert.equal(auto.snapshot().collectPending, 0)
})

test('automatic send respects independent gates, reservations, successful-only cooldown and explicit completion', () => {
  const dir = home(); let at = 10000, cfg = { ...STICKER_DEFAULTS, stickerAutoSend: true, stickerSendProbability: 0 }
  const auto = createStickerAutomation({ stateDir: dir, getConfig: () => cfg, now: () => at, random: () => 0, list: () => [{ name: '贴贴', file: '/library/one.png', tags: ['喜欢'] }, { name: '惊讶', file: '/library/two.png', tags: ['惊讶'] }] })
  assert.equal(auto.pickForSend('喜欢这一段'), null)
  cfg = { ...cfg, stickerSendProbability: 100, stickerSendCooldown: 180 }
  const first = auto.pickForSend('喜欢这一段'); assert.equal(first.name, '贴贴')
  assert.equal(auto.pickForSend('另一个'), null, 'concurrent selection cannot reserve twice')
  first.finish(false); const retry = auto.pickForSend('喜欢这一段'); assert.ok(retry); retry.finish(true)
  assert.equal(auto.snapshot().lastSentAt, at); assert.equal(auto.pickForSend('惊讶'), null)
  at += 180001; const second = auto.pickForSend('惊讶'); assert.equal(second.name, '惊讶'); second.finish(true)
  at += 180001; cfg.stickerAutoSend = false; assert.equal(auto.pickForSend('喜欢'), null)
  auto.stop()
})
