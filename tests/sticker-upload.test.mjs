import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'

// Pillow-generated standard 2x2 RGB images. Tests need no decoder dependency or external process.
const fixtures = {
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8r+DAwMDAxAAGABFdAWPYSWFdAAAAAElFTkSuQmCC',
  jpg: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDFoooryz9hP//Z',
  gif: 'R0lGODdhAgACAIEAAP8gQAAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7',
  webp: 'UklGRjoAAABXRUJQVlA4IC4AAACQAQCdASoCAAIAAUAmJaACdLoAA5gA/u1N38bzea1rf/ybL/y0L/y0L/knAAAA',
}
const root = mkdtempSync(join(tmpdir(), 'fish-sticker-upload-')), builtin = join(root, 'builtin')
mkdirSync(builtin)
const builtinBytes = Buffer.from(fixtures.gif, 'base64')
writeFileSync(join(builtin, '内置.gif'), builtinBytes)
const priorBuiltin = process.env.DAFEIYU_STICKER_DIR
process.env.DAFEIYU_STICKER_DIR = builtin
const { uploadSticker, collectSticker, listStickers, readStickerImage, forgetSticker, STICKER_BYTES_MAX } = await import('../lib/sticker.mjs')
const { validateStickerImage } = await import('../lib/sticker-image.mjs')
let sequence = 0
const home = () => { const path = join(root, 'home-' + ++sequence); mkdirSync(path); writeFileSync(join(path, 'state.json'), JSON.stringify({ tokensTotal: 888, retained: { value: true } })); return path }
const upload = (path, name = '本地图', dataBase64 = fixtures.png, extra = {}) => uploadSticker(path, { name, dataBase64, ...extra })
const png = Buffer.from(fixtures.png, 'base64')

// Build well-formed PNG chunks for exact-boundary and decompression-limit checks.
const crc32 = bytes => {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1 }
  return (crc ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const kind = Buffer.from(type), out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length); kind.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([kind, data])), data.length + 8)
  return out
}
const paddedPng = size => Buffer.concat([png.subarray(0, -12), chunk('tEXt', Buffer.alloc(size - png.length - 12, 65)), png.subarray(-12)])

test.after(() => { if (priorBuiltin === undefined) delete process.env.DAFEIYU_STICKER_DIR; else process.env.DAFEIYU_STICKER_DIR = priorBuiltin; rmSync(root, { recursive: true, force: true }) })

test('upload accepts standard PNG/JPEG/GIF/WebP bytes and actual format wins over filename', () => {
  for (const [fmt, dataBase64] of Object.entries(fixtures)) {
    const dir = home()
    // GIF fixture belongs to the built-in area; use the same validation directly for that format.
    validateStickerImage(Buffer.from(dataBase64, 'base64'), fmt)
    const result = upload(dir, '本地 图片.png', dataBase64, { filename: 'wrong-extension.txt', description: '本地挑选', tags: ['高兴', '贴贴'] })
    if (fmt === 'gif') { assert.equal(result.duplicate, true); continue }
    assert.equal(result.ok, true, `${fmt}: ${result.error}`); assert.equal(result.name, '本地-图片'); assert.equal(result.fmt, fmt)
    assert.equal(result.mime, { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[fmt]); assert.equal(result.from, 'local upload: wrong-extension.txt')
    assert.equal(result.sourceUrl, ''); assert.equal(result.automatic, false)
    assert.deepEqual(readStickerImage(dir, result.name, 'collected').bytes, Buffer.from(dataBase64, 'base64'))
    const state = JSON.parse(readFileSync(join(dir, 'state.json')))
    assert.equal(state.tokensTotal, 888); assert.deepEqual(state.retained, { value: true }); assert.deepEqual(state.stickers[result.name].tags, ['高兴', '贴贴'])
    assert.match(state.stickers[result.name].hash, /^[a-f0-9]{64}$/)
    assert.equal(forgetSticker(dir, result.name).ok, true)
  }
})

test('upload accepts a distinct GIF, animated GIF/WebP, lossless WebP and progressive JPEG', () => {
  const variants = [
    ['gif', 'R0lGODdhAgACAIEAABQ8eAAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7'],
    ['webp', 'UklGRh4AAABXRUJQVlA4TBEAAAAvAUAAAAdQnlIUr/+BiOh/AAA='],
    ['webp', 'UklGRsAAAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAAAAAAAAABBTk1GQgAAAAAAAAAAAAEAAAEAAGQAAAJWUDggKgAAADABAJ0BKgIAAgABQCYloAADcAD++F9///xvH+u7/KLgu//rb8c/mvAwAEFOTUZKAAAAAAAAAAAAAQAAAQAAZAAAAFZQOCAyAAAANAEAnQEqAgACAAAAJiWgAANwAP7y63//+bA/9vP/BHoB///S4P/+lwf/9Lg/9KQAAAA='],
    ['gif', 'R0lGODlhAgACAIEAABQ8eAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBCgABACwAAAAAAgACAIH/AAAAAAAAAAAAAAAIBgABCAQQEAA7'],
    ['jpg', '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAVAQEBAAAAAAAAAAAAAAAAAAAEBf/aAAwDAQACEAMQAAABmhQJ/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD7/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k='],
  ]
  for (const [fmt, dataBase64] of variants) {
    const result = upload(home(), '多种编码', dataBase64)
    assert.equal(result.ok, true, `${fmt}: ${result.error}`); assert.equal(result.fmt, fmt)
  }
})

test('upload rejects invalid JSON field types, arbitrary paths and noncanonical base64 without storing anything', () => {
  const dir = home(), before = readFileSync(join(dir, 'state.json'), 'utf8')
  for (const options of [null, [], { name: {}, dataBase64: fixtures.png }, { name: '../escape', dataBase64: fixtures.png }, { name: 'con', dataBase64: fixtures.png },
    { name: '图', path: join(builtin, '内置.gif') }, { name: '图', dataBase64: fixtures.png, filename: 'C:\\private.png' },
    { name: '图', dataBase64: fixtures.png, description: {} }, { name: '图', dataBase64: fixtures.png, tags: [123] },
    { name: '图', dataBase64: '' }, { name: '图', dataBase64: 'data:image/png;base64,' + fixtures.png },
    { name: '图', dataBase64: fixtures.png + '\n' }, { name: '图', dataBase64: 'AB==' }, { name: '图', dataBase64: '!!!!' }, { name: '图', dataBase64: 'AAAA=' }]) {
    assert.equal(uploadSticker(dir, options).code, 'STICKER_INPUT', JSON.stringify(options))
  }
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), before); assert.equal(listStickers(dir, { source: 'collected' }).length, 0)
})

test('upload detects non-images, header-only files, missing terminators, malformed chunk lengths and CRC corruption', () => {
  const dir = home()
  const broken = [Buffer.from('<html>not an image</html>'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')]
  for (const [fmt, encoded] of Object.entries(fixtures)) {
    const bytes = Buffer.from(encoded, 'base64')
    broken.push(bytes.subarray(0, 12), bytes.subarray(0, -1), bytes.subarray(0, Math.floor(bytes.length / 2)))
    if (fmt === 'png') { const corrupt = Buffer.from(bytes); corrupt[45] ^= 1; broken.push(corrupt) }
    if (fmt === 'webp') { const corrupt = Buffer.from(bytes); corrupt.writeUInt32LE(0x7fffffff, 16); broken.push(corrupt) }
  }
  for (const bytes of broken) assert.equal(upload(dir, '坏图', bytes.toString('base64')).code, 'STICKER_IMAGE_INVALID')
  assert.equal(listStickers(dir, { source: 'collected' }).length, 0)
})

test('upload accepts exactly 5MiB, rejects one byte over and bounds PNG decompression', () => {
  const accepted = paddedPng(STICKER_BYTES_MAX)
  assert.equal(upload(home(), '边界', accepted.toString('base64')).ok, true)
  assert.equal(upload(home(), '超限', Buffer.concat([accepted, Buffer.from([0])]).toString('base64')).code, 'STICKER_TOO_LARGE')
  const header = Buffer.from(png.subarray(16, 29)); header.writeUInt32BE(65535, 0); header.writeUInt32BE(65535, 4)
  const bomb = Buffer.concat([png.subarray(0, 8), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0]))), chunk('IEND', Buffer.alloc(0))])
  assert.match(upload(home(), '解压超限', bomb.toString('base64')).error, /64MB/)
})

test('upload shares names, capacity, content dedupe, state merge and builtin protection with collection', async () => {
  const dir = home()
  assert.equal(upload(dir, '内置').code, 'STICKER_NAME_EXISTS')
  assert.equal(upload(dir, '同内置', fixtures.gif).duplicate, true)
  assert.equal(upload(dir, '第一张').ok, true)
  const duplicate = upload(dir, '不同名字'); assert.equal(duplicate.code, 'STICKER_DUPLICATE'); assert.equal(duplicate.name, '第一张')
  assert.equal((await collectSticker(dir, { name: '下载同图', url: 'https://images.example.com/a.png', lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }], fetchImpl: async () => new Response(png) })).duplicate, true)
  assert.equal(upload(dir, '第二张', fixtures.jpg, { capacity: 1 }).code, 'STICKER_CAPACITY')
  assert.equal(listStickers(dir, { source: 'collected' }).length, 1)
  assert.deepEqual(readFileSync(join(builtin, '内置.gif')), builtinBytes)
  const stateFile = join(dir, 'state.json'); writeFileSync(stateFile, '{broken')
  assert.equal(upload(dir, '账本坏了', fixtures.webp).code, 'STICKER_STORAGE'); assert.equal(readFileSync(stateFile, 'utf8'), '{broken')
  assert.deepEqual(readdirSync(join(dir, 'stickers')), ['第一张.png'])
})
