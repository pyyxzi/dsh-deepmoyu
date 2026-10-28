/** Local sticker library: read-only builtins and bounded, provenance-preserving collected images. */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, lstatSync, realpathSync, unlinkSync, writeFileSync, openSync, closeSync, readSync } from 'node:fs'
import { join, dirname, resolve, relative, isAbsolute, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { withFileLockSync, atomicWriteFileSync, readJsonFileSync } from './record-storage.mjs'
import { downloadStickerImage } from './sticker-download.mjs'
import { validateStickerImage } from './sticker-image.mjs'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const STICKER_DIR_CANDIDATES = [
  join(MODULE_DIR, '..', '..', '..', '大肥鱼形象图', '大肥鱼表情'),
  join(MODULE_DIR, '..', '..', '大肥鱼形象图', '大肥鱼表情'),
]
const findStickerDir = () => STICKER_DIR_CANDIDATES.find(dir => {
  try { return statSync(dir).isDirectory() } catch { return false }
}) || STICKER_DIR_CANDIDATES[0]
export const BUILTIN_DIR = resolve(process.env.DAFEIYU_STICKER_DIR || findStickerDir())
export const collectedDirOf = stateDir => join(stateDir, 'stickers')
export const STICKER_MAX = 60
export const NAME_MAX = 40
export const STICKER_BYTES_MAX = 5 * 1024 * 1024
export const STICKER_MIME = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }

export function sniffImageFormat(bytes) {
  if (!bytes || bytes.length < 12) return ''
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'gif'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  return ''
}

export function safeName(name) {
  const clean = String(name || '').normalize('NFC').replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '').replace(/\s+/g, '-').trim()
    .replace(/^[.\-]+|[.\-]+$/g, '').slice(0, NAME_MAX)
  if (!clean || /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|__proto__|constructor|prototype)(\.|$)/i.test(clean)) return ''
  return clean
}
const textOf = (value, max = 160) => String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max)
export const stickerTags = value => (Array.isArray(value) ? value : String(value || '').split(/[,，、\s]+/))
  .map(tag => textOf(tag, 24)).filter(Boolean).slice(0, 8)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const withinDir = (path, dir) => { const rel = relative(dir, path); return Boolean(rel) && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') }
const validFileName = name => typeof name === 'string' && name === basename(name) && !/[\\/\x00-\x1f:]/.test(name) && !/^\./.test(name)

function readState(stateDir) {
  let state
  try { state = readJsonFileSync(join(stateDir, 'state.json'), {}) } catch (error) {
    throw new Error(`state.json 读不出来（${error?.message ?? error}）——先修好它再收表情`)
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('state.json 内容不是对象——不能拿 {stickers} 把账本盖掉')
  return state
}
const bookOf = state => state.stickers && typeof state.stickers === 'object' && !Array.isArray(state.stickers) ? state.stickers : {}
export function readStickerBook(stateDir) { return bookOf(readState(stateDir)) }
export function writeStickerBook(stateDir, book) {
  const file = join(stateDir, 'state.json')
  withFileLockSync(file, () => {
    const state = readState(stateDir)
    state.stickers = book
    atomicWriteFileSync(file, JSON.stringify(state, null, 2))
  })
}

/** Reject links and ledger traversal. Only first-level, bounded, header-checked library files qualify. */
function safeLibraryFile(dir, fileName) {
  if (!validFileName(fileName)) return null
  try {
    if (lstatSync(dir).isSymbolicLink()) return null
    const file = resolve(dir, fileName), stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 12 || stat.size > STICKER_BYTES_MAX) return null
    if (!withinDir(realpathSync(file), realpathSync(dir))) return null
    let fd
    const head = Buffer.alloc(12)
    try { fd = openSync(file, 'r'); readSync(fd, head, 0, 12, 0) } finally { if (fd !== undefined) closeSync(fd) }
    const fmt = sniffImageFormat(head)
    return fmt ? { file, bytes: stat.size, fmt, mime: STICKER_MIME[fmt] } : null
  } catch { return null }
}

function listFromBook(stateDir, book, { source, shadow = true } = {}) {
  const out = [], seen = new Set()
  if (source !== 'builtin') for (const [name, meta] of Object.entries(book).slice(0, STICKER_MAX * 4)) {
    if (!meta || typeof meta !== 'object' || !safeName(name) || safeName(name) !== name) continue
    const info = safeLibraryFile(collectedDirOf(stateDir), meta.file)
    if (!info) continue
    seen.add(name)
    out.push({ name, source: 'collected', ...info, addedAt: textOf(meta.addedAt, 40), from: textOf(meta.from, 2048),
      sourceUrl: textOf(meta.sourceUrl || (/^https?:\/\//i.test(meta.from || '') ? meta.from : ''), 2048),
      bvid: textOf(meta.bvid, 32), rpid: textOf(meta.rpid, 32), description: textOf(meta.description), tags: stickerTags(meta.tags), hash: textOf(meta.hash, 64) })
  }
  if (source !== 'collected') {
    let entries = []
    try { entries = readdirSync(BUILTIN_DIR).slice(0, 500) } catch { /* no builtins */ }
    for (const entry of entries) {
      const info = safeLibraryFile(BUILTIN_DIR, entry)
      const name = entry.replace(/\.[^.]+$/, '')
      if (!info || !safeName(name) || (shadow && seen.has(name))) continue
      out.push({ name, source: 'builtin', ...info, addedAt: '', from: '使用者的表情文件夹', sourceUrl: '', bvid: '', rpid: '', description: '', tags: [], hash: '' })
    }
  }
  return out
}
export function listStickers(stateDir, options = {}) { return listFromBook(stateDir, readStickerBook(stateDir), options) }

/** Explicit paths qualify only if they are already enumerated; never resolve an arbitrary in-directory path. */
export function resolveSticker(stateDir, input, options = {}) {
  const raw = String(input || '').trim()
  if (!raw) return ''
  const all = listStickers(stateDir, options)
  const found = all.find(item => item.name === raw || item.file === raw)
    || (!/[\\/]/.test(raw) ? all.find(item => safeName(raw) === item.name) : null)
  return found?.file || ''
}

export function readStickerImage(stateDir, name, source) {
  if (source && !['builtin', 'collected'].includes(source)) return null
  const item = listStickers(stateDir, { source }).find(item => item.name === String(name || ''))
  if (!item) return null
  const bytes = readFileSync(item.file)
  if (bytes.length > STICKER_BYTES_MAX || !sniffImageFormat(bytes)) return null
  return { ...item, bytes, etag: '"' + sha256(bytes) + '"' }
}

/** Both remote collection and uploads commit under the same state transaction. */
function commitStickerBytes(stateDir, bytes, options, { clean, capacity, fmt, sourceUrl = '', from = '', allowCopy = false, autoName = false }) {
  const hash = sha256(bytes), dir = collectedDirOf(stateDir), stateFile = join(stateDir, 'state.json')
  return withFileLockSync(stateFile, () => {
    options.signal?.throwIfAborted()
    if (options.shouldCommit && !options.shouldCommit()) return { ok: false, code: 'STICKER_CANCELED', error: '自动收集已关闭或停止' }
    const state = readState(stateDir), book = { ...bookOf(state) }, all = listFromBook(stateDir, book, { shadow: false })
    const prior = all.find(item => (item.hash || sha256(readFileSync(item.file))) === hash)
    if (prior && !allowCopy) return { ok: false, code: 'STICKER_DUPLICATE', duplicate: true, name: prior.name, error: `这张图已经在库里了（${prior.name}）` }
    if (all.filter(item => item.source === 'collected').length >= capacity || Object.keys(book).length >= STICKER_MAX) {
      return { ok: false, code: 'STICKER_CAPACITY', error: `收集区满了（上限 ${capacity} 张）——先 forget 一张再收` }
    }
    if (autoName) {
      const base = clean
      for (let n = 2; all.some(item => item.name === clean) || Object.hasOwn(book, clean); n++) clean = base.slice(0, NAME_MAX - String(n).length - 1) + '-' + n
    } else if (all.some(item => item.name === clean) || Object.hasOwn(book, clean)) return { ok: false, code: 'STICKER_NAME_EXISTS', error: `「${clean}」已经在库里了，想换图先 forget（内置区只读）` }
    mkdirSync(dir, { recursive: true })
    if (lstatSync(dir).isSymbolicLink()) throw new Error('收集目录不能是符号链接')
    const fileName = `${clean}.${fmt}`, file = join(dir, fileName)
    if (existsSync(file)) return { ok: false, code: 'STICKER_NAME_EXISTS', error: `「${clean}」的文件已经存在，拒绝覆盖` }
    writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 })
    const meta = { file: fileName, from: textOf(options.from || from, 2048), sourceUrl: textOf(sourceUrl, 2048),
      addedAt: new Date().toISOString(), bytes: bytes.length, mime: STICKER_MIME[fmt], hash,
      bvid: textOf(options.bvid, 32), rpid: textOf(options.rpid, 32), description: textOf(options.description), tags: stickerTags(options.tags), automatic: Boolean(options.automatic) }
    book[clean] = meta; state.stickers = book
    try { atomicWriteFileSync(stateFile, JSON.stringify(state, null, 2)) } catch (error) { try { unlinkSync(file) } catch { /* original error */ }; throw error }
    return { ok: true, name: clean, ...meta, file, bytes: bytes.length, fmt }
  })
}

/** Download outside the state lock; recheck names, capacity and content under the shared atomic transaction. */
export async function collectSticker(stateDir, options = {}) {
  const { name, url, path, fetchImpl, lookupImpl, signal, autoName = false } = options
  let clean = safeName(name)
  if (!clean || /[\\/]/.test(String(name || ''))) return { ok: false, error: 'name 必须是普通文件名字符（别带路径、扩展名或怪符号）' }
  const capacity = Math.max(1, Math.min(STICKER_MAX, Math.trunc(Number(options.capacity) || STICKER_MAX)))
  try {
    const initial = listStickers(stateDir, { shadow: false })
    if (!autoName && initial.some(item => item.name === clean)) return { ok: false, error: `「${clean}」已经在库里了，想换图先 forget（内置区只读）` }
    if (initial.filter(item => item.source === 'collected').length >= capacity) return { ok: false, error: `收集区满了（上限 ${capacity} 张）——先 forget 一张再收` }
    let bytes, sourceUrl = '', from = ''
    if (url) {
      // URL equality avoids a repeat download; content equality below covers changed URLs.
      const prior = initial.find(item => item.sourceUrl === String(url))
      if (prior) return { ok: false, duplicate: true, name: prior.name, error: `这张来源图已经收过了（${prior.name}）` }
      const downloaded = await downloadStickerImage(url, { fetchImpl, lookupImpl, signal })
      bytes = downloaded.bytes; sourceUrl = String(url); from = sourceUrl
    } else if (path) {
      const file = resolveSticker(stateDir, path)
      if (!file) return { ok: false, error: 'path 必须是库内已有的图（内置区或收集区），不接受任意路径' }
      bytes = readFileSync(file); from = 'library copy'
    } else return { ok: false, error: 'collect 要给 url 或 path 之一' }
    signal?.throwIfAborted()
    if (bytes.length > STICKER_BYTES_MAX) return { ok: false, error: '图片超过 5MB，太大了' }
    const fmt = sniffImageFormat(bytes)
    if (!fmt) return { ok: false, error: '内容不是认识的图片格式（jpg/png/gif/webp）' }
    return commitStickerBytes(stateDir, bytes, options, { clean, capacity, fmt, sourceUrl, from, allowCopy: Boolean(path), autoName })
  } catch (error) { return { ok: false, error: String(error?.message || error) } }
}

/** Accept only uploaded bytes encoded as canonical base64; never interpret filename/path as a file to read. */
export function uploadSticker(stateDir, options = {}) {
  const failure = (code, error) => ({ ok: false, code, error })
  if (!options || typeof options !== 'object' || Array.isArray(options)) return failure('STICKER_INPUT', '上传请求必须是 JSON 对象')
  const { name, filename, dataBase64, description, tags } = options
  if (typeof name !== 'string' || !safeName(name) || /[\\/]/.test(name)) return failure('STICKER_INPUT', 'name 必须是普通文件名字符（别带路径、扩展名或怪符号）')
  if (filename !== undefined && (typeof filename !== 'string' || filename.length > 255 || /[\\/\x00-\x1f\x7f]/.test(filename))) return failure('STICKER_INPUT', 'filename 只能是原文件名，不能带路径')
  if ((description !== undefined && typeof description !== 'string') || (tags !== undefined && typeof tags !== 'string' && (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string')))) return failure('STICKER_INPUT', 'description 必须是文字，tags 必须是文字或文字数组')
  if (typeof dataBase64 !== 'string' || !dataBase64) return failure('STICKER_INPUT', 'dataBase64 必须是图片字节的标准 base64（不带 data: 前缀）')
  if (dataBase64.length > Math.ceil(STICKER_BYTES_MAX / 3) * 4) return failure('STICKER_TOO_LARGE', '图片超过 5MB，太大了')
  if (dataBase64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) return failure('STICKER_INPUT', 'dataBase64 不是合法的标准 base64')
  const bytes = Buffer.from(dataBase64, 'base64')
  if (bytes.length > STICKER_BYTES_MAX) return failure('STICKER_TOO_LARGE', '图片超过 5MB，太大了')
  if (!bytes.length || bytes.toString('base64') !== dataBase64) return failure('STICKER_INPUT', 'dataBase64 不是合法的标准 base64')
  const fmt = sniffImageFormat(bytes)
  if (!fmt) return failure('STICKER_IMAGE_INVALID', '无法识别或图片结构损坏，仅支持 PNG / JPEG / GIF / WebP')
  try { validateStickerImage(bytes, fmt) } catch (error) { return failure('STICKER_IMAGE_INVALID', `无法识别或图片结构损坏：${error.message}`) }
  const capacity = Math.max(1, Math.min(STICKER_MAX, Math.trunc(Number(options.capacity) || STICKER_MAX)))
  try {
    // Only metadata fields are forwarded. Client-supplied path/url/from/automatic cannot affect storage.
    return commitStickerBytes(stateDir, bytes, { description, tags }, { clean: safeName(name), capacity, fmt,
      from: filename ? `local upload: ${textOf(filename, 255)}` : 'local upload' })
  } catch (error) { return failure('STICKER_STORAGE', String(error?.message || error)) }
}

/** Only the collected area's validated regular file may be removed; malformed ledgers fail closed. */
export function forgetSticker(stateDir, name) {
  const clean = safeName(name)
  if (!clean) return { ok: false, error: 'name 必须是普通文件名字符' }
  try {
    return withFileLockSync(join(stateDir, 'state.json'), () => {
      const state = readState(stateDir), book = { ...bookOf(state) }, meta = book[clean]
      if (!meta) return { ok: false, error: `「${clean}」不在收集区（内置区的图归使用者管）` }
      if (!validFileName(meta.file)) return { ok: false, error: '账本里这张图的文件名不正常（指向收集区外），拒绝删除' }
      const dir = collectedDirOf(stateDir), target = resolve(dir, meta.file)
      if (!withinDir(target, resolve(dir)) || (existsSync(dir) && lstatSync(dir).isSymbolicLink())) return { ok: false, error: '收集目录不正常，拒绝删除' }
      if (existsSync(target)) {
        if (!safeLibraryFile(dir, meta.file)) return { ok: false, error: '这不是收集区的有效图片，拒绝删除' }
        unlinkSync(target)
      }
      delete book[clean]; state.stickers = book
      atomicWriteFileSync(join(stateDir, 'state.json'), JSON.stringify(state, null, 2))
      return { ok: true, forgot: clean }
    })
  } catch (error) { return { ok: false, error: String(error?.message || error) } }
}
