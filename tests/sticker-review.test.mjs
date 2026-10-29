import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'

const root = mkdtempSync(join(tmpdir(), 'fish-sticker-review-')), builtin = join(root, 'builtin')
mkdirSync(builtin)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8r+DAwMDAxAAGABFdAWPYSWFdAAAAAElFTkSuQmCC', 'base64')
const gif = Buffer.from('R0lGODdhAgACAIEAABQ8eAAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7', 'base64')
const webp = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvAUAAAAdQnlIUr/+BiOh/AAA=', 'base64')
const builtinBytes = Buffer.from('R0lGODdhAgACAIEAAP8gQAAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7', 'base64')
writeFileSync(join(builtin, '内置.gif'), builtinBytes)
const priorBuiltin = process.env.DAFEIYU_STICKER_DIR
process.env.DAFEIYU_STICKER_DIR = builtin
const { collectSticker, uploadSticker, listStickers, resolveSticker, readStickerImage, approveSticker, rejectSticker, forgetSticker } = await import('../lib/sticker.mjs')
const { createStickerAutomation, STICKER_DEFAULTS, stickerSettings } = await import('../lib/sticker-automation.mjs')
const { withFileLockSync } = await import('../lib/record-storage.mjs')
const lookupImpl = async () => [{ address: '8.8.8.8', family: 4 }]
const flush = () => new Promise(resolve => setImmediate(resolve))
let sequence = 0
const home = () => {
  const dir = join(root, 'home-' + ++sequence)
  mkdirSync(dir)
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ tokensTotal: 777, unrelated: { retained: true } }))
  return dir
}
const stateOf = dir => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
const upload = (dir, name = '待审图', bytes = png, extra = {}) => uploadSticker(dir, { name, dataBase64: bytes.toString('base64'), stickerReview: true, ...extra })
const remote = (dir, name, bytes = png, extra = {}) => collectSticker(dir, { name, url: `https://images.example.com/${encodeURIComponent(name)}.png`, lookupImpl, fetchImpl: async () => new Response(bytes), stickerReview: true, ...extra })
const comments = (suffix = 'one') => ({ comments: [{ rpid: suffix, images: [{ url: `https://images.example.com/${suffix}.png`, w: 256, h: 256 }] }] })
const collectionCfg = { ...STICKER_DEFAULTS, stickerAutoCollect: true, stickerCollectProbability: 100, stickerCollectCooldown: 0, stickerReview: true }
const sendingCfg = { ...STICKER_DEFAULTS, stickerAutoSend: true, stickerSendProbability: 100, stickerSendCooldown: 0 }
const workerSource = `
const { parentPort, workerData } = require('node:worker_threads')
void (async () => {
  const library = await import(workerData.library)
  const options = workerData.options
  if (workerData.liveReview) {
    const fs = require('node:fs'), path = require('node:path'), stage = new Int32Array(workerData.stage)
    const originalOpen = fs.openSync, lock = path.join(workerData.dir, 'state.json.lock')
    fs.openSync = (file, ...args) => {
      if (file === lock) { Atomics.store(stage, 0, 1); Atomics.notify(stage, 0) }
      return originalOpen(file, ...args)
    }
    require('node:module').syncBuiltinESMExports()
    Object.defineProperty(options, 'stickerReview', { get() {
      return JSON.parse(fs.readFileSync(path.join(workerData.dir, 'config.json'), 'utf8')).stickerReview
    } })
  }
  parentPort.postMessage({ ready: true })
  parentPort.once('message', () => {
    const result = workerData.action === 'upload'
      ? library.uploadSticker(workerData.dir, options)
      : library[workerData.action](workerData.dir, workerData.name, options)
    parentPort.postMessage({ result })
  })
})().catch(error => { throw error })
`
async function raceWriters(inputs) {
  const workers = inputs.map(input => new Worker(workerSource, { eval: true, workerData: { ...input, library: new URL('../lib/sticker.mjs', import.meta.url).href } }))
  try {
    await Promise.all(workers.map(worker => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject) })))
    const results = workers.map(worker => new Promise((resolve, reject) => {
      let result
      worker.once('message', message => { result = message.result })
      worker.once('error', reject)
      worker.once('exit', code => code === 0 && result ? resolve(result) : reject(new Error(`sticker worker exited ${code}`)))
    }))
    for (const worker of workers) worker.postMessage('start')
    return await Promise.all(results)
  } finally { await Promise.all(workers.map(worker => worker.terminate())) }
}

test.after(() => {
  if (priorBuiltin === undefined) delete process.env.DAFEIYU_STICKER_DIR
  else process.env.DAFEIYU_STICKER_DIR = priorBuiltin
  rmSync(root, { recursive: true, force: true })
})

test('review settings are opt-in strict booleans and preserve the other independent switches', () => {
  assert.equal(stickerSettings({}).stickerReview, false)
  assert.equal(stickerSettings({ stickerReview: true }).stickerReview, true)
  for (const value of ['true', 1, {}, null]) assert.equal(stickerSettings({ stickerReview: value }).stickerReview, false)
  assert.equal(stickerSettings({ stickerReview: true }).stickerAutoCollect, false)
  assert.equal(stickerSettings({ stickerReview: true }).stickerAutoSend, false)
})

test('review collection preserves provenance, lists pending explicitly and blocks every resolve/copy route', async () => {
  const dir = home()
  const added = await remote(dir, '待审远程', png, { bvid: 'BV1234567890', rpid: '12345678901234567', tags: ['开心'], description: '待使用者挑选' })
  assert.equal(added.ok, true); assert.equal(added.status, 'pending')
  assert.equal(stateOf(dir).stickers.待审远程.status, 'pending')
  assert.deepEqual(listStickers(dir).map(item => item.name), ['内置'])
  const pending = listStickers(dir, { status: 'pending' })
  assert.equal(pending.length, 1); assert.equal(pending[0].name, '待审远程'); assert.equal(pending[0].status, 'pending')
  assert.equal(pending[0].sourceUrl, added.sourceUrl); assert.equal(pending[0].bvid, 'BV1234567890')
  assert.deepEqual(pending[0].tags, ['开心'])
  assert.equal(listStickers(dir, { status: 'all' }).length, 2)
  assert.equal(listStickers(dir, { status: 'unknown' }).length, 0)
  for (const input of ['待审远程', '待审远程.png', added.file]) for (const options of [{}, { status: 'all' }, { status: 'pending', source: 'collected', shadow: false }]) assert.equal(resolveSticker(dir, input, options), '')
  assert.equal(readStickerImage(dir, '待审远程', 'collected'), null)
  const preview = readStickerImage(dir, '待审远程', 'collected', { status: 'pending' })
  assert.deepEqual(preview.bytes, png); assert.ok(preview.etag)
  assert.equal((await collectSticker(dir, { name: '绕过审核', path: added.file, stickerReview: false })).ok, false)
  assert.equal((await collectSticker(dir, { name: '绕过名字', path: '待审远程', stickerReview: false })).ok, false)
  const duplicate = await remote(dir, '不同网址同图', png, { stickerReview: false })
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.name, added.name)
  const mixedInputs = await remote(dir, '带库内路径的下载', png, { path: '内置', stickerReview: false })
  assert.equal(mixedInputs.duplicate, true); assert.equal(mixedInputs.name, added.name)
  assert.equal(stateOf(dir).stickers.待审远程.status, 'pending')
  let downloads = 0
  const sameUrl = await collectSticker(dir, { name: '重复来源', url: added.sourceUrl, lookupImpl, fetchImpl: async () => { downloads++; return new Response(png) }, stickerReview: false })
  assert.equal(sameUrl.duplicate, true); assert.equal(downloads, 0)
  assert.equal(stateOf(dir).tokensTotal, 777)
})

test('manual approval checks the displayed content then makes pending entries sendable without losing metadata', () => {
  const dir = home(), added = upload(dir, '批准图', png, { description: '保留说明', tags: ['高兴'], filename: 'picked.png' })
  assert.equal(added.status, 'pending')
  const before = stateOf(dir).stickers.批准图
  const approved = approveSticker(dir, '批准图', { expectedHash: added.hash })
  assert.equal(approved.ok, true); assert.equal(approved.approved, '批准图'); assert.equal(approved.status, 'approved')
  assert.match(approved.reviewedAt, /^\d{4}-\d\d-/)
  const after = stateOf(dir)
  assert.equal(after.tokensTotal, 777); assert.deepEqual(after.unrelated, { retained: true })
  assert.deepEqual(after.stickers.批准图, { ...before, status: 'approved', reviewedAt: approved.reviewedAt })
  assert.equal(listStickers(dir, { status: 'pending' }).length, 0)
  assert.equal(resolveSticker(dir, '批准图'), added.file); assert.equal(resolveSticker(dir, added.file), added.file)
  assert.deepEqual(readStickerImage(dir, '批准图', 'collected').bytes, png)
  assert.equal(approveSticker(dir, '批准图').code, 'STICKER_NOT_PENDING')
  assert.equal(rejectSticker(dir, '批准图').code, 'STICKER_NOT_PENDING')
  assert.equal(approveSticker(dir, '内置').code, 'STICKER_NOT_FOUND')
  assert.deepEqual(readFileSync(join(builtin, '内置.gif')), builtinBytes)
})

test('manual rejection frees capacity and content dedupe while installed and approved entries remain usable', async () => {
  const dir = home(), added = upload(dir, '拒绝图', png, { capacity: 1 })
  assert.equal(upload(dir, '重复图').duplicate, true)
  assert.equal(upload(dir, '另一张', gif, { capacity: 1 }).code, 'STICKER_CAPACITY')
  const rejected = rejectSticker(dir, added.name, { expectedHash: added.hash })
  assert.equal(rejected.ok, true); assert.equal(rejected.rejected, added.name)
  assert.equal(existsSync(added.file), false); assert.deepEqual(stateOf(dir).stickers, {})
  assert.equal(stateOf(dir).tokensTotal, 777); assert.deepEqual(stateOf(dir).unrelated, { retained: true })
  assert.equal(rejectSticker(dir, added.name).code, 'STICKER_NOT_FOUND')
  assert.equal(upload(dir, '新图', png, { capacity: 1, stickerReview: false }).status, 'approved')
  assert.equal(resolveSticker(dir, '新图'), join(dir, 'stickers', '新图.png'))
  assert.equal((await collectSticker(dir, { name: '库内别名', path: '内置', stickerReview: true })).ok, true)
  assert.equal(resolveSticker(dir, '库内别名'), '')
  assert.equal(forgetSticker(dir, '库内别名').ok, true, 'existing manual forget also works for pending entries')
})

test('missing legacy status stays approved, and disabling review only changes later additions', () => {
  const dir = home(), legacy = upload(dir, '旧图', png, { stickerReview: false })
  const state = stateOf(dir)
  delete state.stickers.旧图.status
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state))
  assert.equal(listStickers(dir, { source: 'collected' })[0].status, 'approved')
  assert.equal(resolveSticker(dir, '旧图', { stickerReview: true }), legacy.file)
  const pending = upload(dir, '仍待审', gif)
  const direct = upload(dir, '直接可用', webp, { stickerReview: false })
  assert.equal(pending.status, 'pending'); assert.equal(direct.status, 'approved')
  assert.equal(resolveSticker(dir, pending.name, { stickerReview: false }), '')
  assert.equal(resolveSticker(dir, direct.name), direct.file)
  assert.deepEqual(listStickers(dir, { source: 'collected' }).map(item => item.name), ['旧图', '直接可用'])
  assert.deepEqual(listStickers(dir, { status: 'pending' }).map(item => item.name), ['仍待审'])
})

test('stale decisions, changed image bytes, invalid names and malicious ledger paths fail closed', () => {
  const dir = home(), added = upload(dir)
  assert.equal(approveSticker(dir, added.name, { expectedHash: '0'.repeat(64) }).code, 'STICKER_REVIEW_CHANGED')
  assert.equal(rejectSticker(dir, added.name, { expectedHash: 'bad' }).code, 'STICKER_INPUT')
  for (const value of ['../待审图', '..\\待审图', 'con', '__proto__', {}]) assert.equal(approveSticker(dir, value).code, 'STICKER_INPUT')
  writeFileSync(added.file, gif)
  assert.equal(approveSticker(dir, added.name).code, 'STICKER_REVIEW_CHANGED')
  assert.equal(rejectSticker(dir, added.name).code, 'STICKER_REVIEW_CHANGED')
  assert.equal(stateOf(dir).stickers.待审图.status, 'pending')
  const state = stateOf(dir)
  state.stickers.逃逸 = { file: '../state.json', status: 'pending' }
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state))
  assert.equal(approveSticker(dir, '逃逸').code, 'STICKER_IMAGE_INVALID')
  assert.equal(rejectSticker(dir, '逃逸').code, 'STICKER_IMAGE_INVALID')
  assert.equal(stateOf(dir).tokensTotal, 777)
  writeFileSync(join(dir, 'state.json'), '{broken')
  assert.equal(approveSticker(dir, added.name).code, 'STICKER_STORAGE')
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), '{broken')
})

test('pending aliases and unknown explicit states cannot be resolved through approved names, paths or builtin fallback', () => {
  const dir = home(), added = upload(dir)
  const state = stateOf(dir)
  state.stickers.批准别名 = { ...state.stickers.待审图, status: 'approved' }
  state.stickers.内置 = { ...state.stickers.待审图, status: 'unexpected' }
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state))
  for (const input of ['批准别名', '内置', '待审图', added.file, join(builtin, '内置.gif')]) assert.equal(resolveSticker(dir, input, { status: 'all', source: undefined, shadow: false }), '')
  assert.equal(resolveSticker(dir, '内置', { source: 'builtin' }), '')
  assert.equal(listStickers(dir).length, 0)
  assert.equal(listStickers(dir, { status: 'pending' }).length, 2)
  assert.equal(rejectSticker(dir, '待审图', { expectedHash: added.hash }).ok, true)
  assert.equal(existsSync(added.file), true, 'rejecting one alias must not delete another entry’s file')
})

test('case-insensitive pending file/name aliases stay blocked on Windows', { skip: process.platform !== 'win32' }, () => {
  const dir = home(), added = upload(dir, 'CasePending')
  const state = stateOf(dir)
  state.stickers.CaseAlias = { ...state.stickers.CasePending, file: 'CASEPENDING.PNG', status: 'approved' }
  state.stickers.casepending = { ...state.stickers.CasePending, file: 'CaseOther.png', status: 'approved' }
  writeFileSync(join(dir, 'stickers', 'CaseOther.png'), gif)
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state))
  for (const value of ['CaseAlias', 'CasePending', 'casepending', added.file, join(dir, 'stickers', 'CASEPENDING.PNG')]) assert.equal(resolveSticker(dir, value), '')
  assert.equal(listStickers(dir, { source: 'collected' }).length, 0)
  assert.equal(rejectSticker(dir, 'CasePending').ok, true)
  assert.equal(existsSync(added.file), true, 'case aliases reference the same file on Windows')
})

test('cross-thread writers serialize competing approvals, content duplicates and capacity without losing state', async () => {
  const dir = home(), added = upload(dir, '并行审核')
  const approvals = await raceWriters([
    { dir, action: 'approveSticker', name: added.name, options: { expectedHash: added.hash } },
    { dir, action: 'approveSticker', name: added.name, options: { expectedHash: added.hash } },
  ])
  assert.equal(approvals.filter(item => item.ok).length, 1)
  assert.equal(approvals.filter(item => item.code === 'STICKER_NOT_PENDING').length, 1)
  assert.equal(stateOf(dir).stickers.并行审核.status, 'approved')
  const duplicates = await raceWriters(['并行图一', '并行图二'].map(name => ({ dir, action: 'upload', options: { name, dataBase64: gif.toString('base64'), stickerReview: true } })))
  assert.equal(duplicates.filter(item => item.ok).length, 1)
  assert.equal(duplicates.filter(item => item.code === 'STICKER_DUPLICATE').length, 1)
  const another = home()
  const capped = await raceWriters([png, gif].map((bytes, index) => ({ dir: another, action: 'upload', options: { name: '并行容量' + index, dataBase64: bytes.toString('base64'), stickerReview: true, capacity: 1 } })))
  assert.equal(capped.filter(item => item.ok).length, 1)
  assert.equal(capped.filter(item => item.code === 'STICKER_CAPACITY').length, 1)
  assert.equal(listStickers(another, { status: 'pending' }).length, 1)
  assert.equal(readdirSync(join(another, 'stickers')).length, 1)
  for (const target of [dir, another]) { assert.equal(stateOf(target).tokensTotal, 777); assert.deepEqual(stateOf(target).unrelated, { retained: true }) }
})

test('upload reads the review switch after acquiring a contended state lock in both directions', async () => {
  for (const [before, after] of [[false, true], [true, false]]) {
    const dir = home(), configFile = join(dir, 'config.json'), stage = new Int32Array(new SharedArrayBuffer(4))
    writeFileSync(configFile, JSON.stringify({ stickerReview: before }))
    const worker = new Worker(workerSource, { eval: true, workerData: {
      dir, library: new URL('../lib/sticker.mjs', import.meta.url).href, action: 'upload', liveReview: true, stage: stage.buffer,
      options: { name: '锁内决定', dataBase64: png.toString('base64') },
    } })
    try {
      await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject) })
      const result = new Promise((resolve, reject) => {
        let value
        worker.once('message', message => { value = message.result })
        worker.once('error', reject)
        worker.once('exit', code => code === 0 && value ? resolve(value) : reject(new Error(`upload worker exited ${code}`)))
      })
      withFileLockSync(join(dir, 'state.json'), () => {
        worker.postMessage('start')
        assert.notEqual(Atomics.wait(stage, 0, 0, 5000), 'timed-out', 'upload must attempt the held state lock')
        assert.equal(Atomics.load(stage, 0), 1)
        writeFileSync(configFile, JSON.stringify({ stickerReview: after }))
      })
      const added = await result
      assert.equal(added.ok, true, added.error)
      assert.equal(added.status, after ? 'pending' : 'approved')
      assert.equal(stateOf(dir).stickers.锁内决定.status, added.status)
      assert.equal(Boolean(resolveSticker(dir, added.name)), !after)
      assert.equal(stateOf(dir).tokensTotal, 777)
    } finally { await worker.terminate() }
  }
})

test('commit-time merge keeps reviews during concurrent downloads and pending entries consume capacity', async () => {
  const dir = home(), pending = upload(dir, '审核中')
  let release, started
  const begun = new Promise(resolve => { started = resolve })
  const downloading = remote(dir, '同时下载', gif, { fetchImpl: async () => { started(); return new Promise(resolve => { release = () => resolve(new Response(gif)) }) } })
  await begun
  assert.equal(approveSticker(dir, pending.name).ok, true)
  const state = stateOf(dir); state.anotherWriter = 42; writeFileSync(join(dir, 'state.json'), JSON.stringify(state))
  release()
  const added = await downloading
  assert.equal(added.status, 'pending'); assert.equal(stateOf(dir).anotherWriter, 42)
  assert.equal(stateOf(dir).stickers.审核中.status, 'approved')
  assert.equal(rejectSticker(dir, added.name).ok, true)
  let releaseOther, otherStarted
  const otherBegun = new Promise(resolve => { otherStarted = resolve })
  const capped = remote(dir, '抢最后位置', webp, { capacity: 2, fetchImpl: async () => { otherStarted(); return new Promise(resolve => { releaseOther = () => resolve(new Response(webp)) }) } })
  await otherBegun
  assert.equal(upload(dir, '占据位置', gif, { capacity: 2 }).ok, true)
  releaseOther()
  assert.equal((await capped).code, 'STICKER_CAPACITY')
  assert.deepEqual(readdirSync(join(dir, 'stickers')).sort(), ['占据位置.gif', '审核中.png'].sort())
  assert.equal(stateOf(dir).tokensTotal, 777)
})

test('automatic collection forwards live review config at commit and does not release older pending entries', async () => {
  const dir = home(), events = []
  let cfg = { ...collectionCfg, stickerReview: false }, release, started
  const begun = new Promise(resolve => { started = resolve })
  const auto = createStickerAutomation({ stateDir: dir, getConfig: () => cfg, random: () => 0,
    collect: (stateDir, options) => collectSticker(stateDir, Object.assign(options, { lookupImpl, fetchImpl: async () => { started(); return new Promise(resolve => { release = () => resolve(new Response(png)) }) } })),
    onEvent: (kind, value) => events.push({ kind, value }) })
  try {
    assert.equal(auto.offer(comments('first'), 'BV1234567890').queued, 1)
    await begun
    cfg = { ...cfg, stickerReview: true }
    release(); await flush(); await flush()
    const pending = listStickers(dir, { status: 'pending' })
    assert.equal(pending.length, 1); assert.equal(events[0].value.status, 'pending')
    cfg = { ...cfg, stickerReview: false }
    assert.equal(resolveSticker(dir, pending[0].name), '')
  } finally { auto.stop() }
})

test('automation uses approved-only listing and never reserves a pending image even from a broad custom list', () => {
  const dir = home(), added = upload(dir, '待审自动图')
  const auto = createStickerAutomation({ stateDir: dir, getConfig: () => sendingCfg, random: () => 0 })
  try {
    const before = auto.pickForSend('待审自动图')
    assert.equal(before.name, '内置'); before.finish(false)
    assert.equal(approveSticker(dir, added.name).ok, true)
    const after = auto.pickForSend('待审自动图')
    assert.equal(after.name, added.name); assert.equal(after.file, added.file); after.finish(true)
  } finally { auto.stop() }
  let seenOptions
  const broad = createStickerAutomation({ stateDir: home(), getConfig: () => sendingCfg, random: () => 0,
    list: (_dir, options) => { seenOptions = options; return [{ name: 'pending', file: '/pending.png', status: 'pending' }, { name: 'bad', file: '/bad.png', status: 'bad' }] } })
  try { assert.equal(broad.pickForSend('pending'), null); assert.deepEqual(seenOptions, { status: 'approved' }); assert.equal(broad.snapshot().lastSentAt, 0) }
  finally { broad.stop() }
})

test('review-enabled automation still cancels queued and inflight work and accepts a later run', async () => {
  const dir = home(), queued = new AbortController(), inflight = new AbortController()
  let requests = 0, started
  const begun = new Promise(resolve => { started = resolve })
  const auto = createStickerAutomation({ stateDir: dir, getConfig: () => collectionCfg, random: () => 0,
    collect: (stateDir, options) => collectSticker(stateDir, Object.assign(options, { lookupImpl, fetchImpl: async () => {
      requests++
      if (requests === 1) { started(); return new Promise(() => {}) }
      return new Response(png)
    } })) })
  try {
    auto.offer(comments('queued'), 'BV1234567890', { signal: queued.signal }); queued.abort(new Error('round stopped'))
    await flush(); assert.equal(requests, 0)
    auto.offer(comments('inflight'), 'BV1234567890', { signal: inflight.signal })
    await begun; inflight.abort(new Error('round stopped'))
    await flush(); await flush()
    assert.equal(listStickers(dir, { status: 'all', source: 'collected' }).length, 0)
    assert.equal(auto.snapshot().collectPending, 0)
    auto.offer(comments('next-run'), 'BV1234567890', { signal: new AbortController().signal })
    await flush(); await flush()
    assert.equal(requests, 2); assert.equal(listStickers(dir, { status: 'pending' }).length, 1)
    assert.equal(listStickers(dir, { source: 'collected' }).length, 0)
  } finally { auto.stop() }
})
