/** One small local interest board. No I/O, scheduling, model calls or send permissions. */
import { createHash } from 'node:crypto'
import { isBvid } from './ledger.mjs'
import { redactRecordText } from './record-privacy.mjs'

export const CURIOSITY_LIMITS = Object.freeze({ active: 3, total: 20, notes: 3, question: 120, query: 80, text: 180 })
const STATUSES = ['active', 'paused', 'resolved']
const ACTIONS = ['open', 'note', 'pause', 'resume', 'resolve', 'forget']
const ARG_KEYS = new Set(['action', 'id', 'question', 'query', 'bvid', 'text', 'seconds', 'version', 'expectedRevision'])
const ID_RE = /^cq-[a-f0-9]{16}$/
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const integer = value => Number.isSafeInteger(value) && value >= 0
const digest = text => createHash('sha256').update(text).digest('hex')
const normalized = value => value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '')
const idOf = (question, bvid) => 'cq-' + digest(JSON.stringify([normalized(question), bvid || 'user'])).slice(0, 16)
const iso = value => { const date = new Date(value); return value !== null && value !== '' && Number.isFinite(date.getTime()) ? date.toISOString() : '' }
const timestamp = value => typeof value === 'string' && iso(value) === value
const validSeconds = value => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86400)
const videoUrl = (bvid, seconds = null) => `https://www.bilibili.com/video/${bvid}` + (seconds === null ? '' : `?t=${seconds}`)
const ownKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key))
const failure = (board, code, error, item) => ({ ok: false, changed: false, board, code, error, ...(item ? { item: structuredClone(item), id: item.id } : {}) })
const invalidBoard = () => { throw Object.assign(new Error('好奇心记录损坏，已保留原记录并停止写入'), { code: 'CURIOSITY_INVALID' }) }

function clean(value, limit, field, { optional = false } = {}) {
  if (optional && (value === undefined || value === '')) return ''
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\r\n\x00-\x1f\x7f]/.test(value)) {
    throw new TypeError(`${field}需要1至${limit}字的单行文本`)
  }
  const text = redactRecordText(value.trim(), { maxLength: limit })
  if (!normalized(text)) throw new TypeError(`${field}需要具体文本，不能只有符号`)
  return text
}

/** Only an absent key is a new board. Null/malformed persisted data must never be overwritten. */
export function curiosityBoard(raw) {
  if (raw === undefined) return { schema: 1, revision: 0, items: [] }
  if (!object(raw) || !ownKeys(raw, ['schema', 'revision', 'items']) || raw.schema !== 1 || !integer(raw.revision)
    || !Array.isArray(raw.items) || raw.items.length > CURIOSITY_LIMITS.total) return invalidBoard()
  const ids = new Set()
  for (const row of raw.items) {
    if (!object(row) || !ownKeys(row, ['id', 'status', 'origin', 'question', 'query', 'bvid', 'url', 'createdAt', 'updatedAt', 'version', 'notes'])
      || !ID_RE.test(row.id) || ids.has(row.id) || !STATUSES.includes(row.status) || !['fish', 'user'].includes(row.origin)
      || !timestamp(row.createdAt) || !timestamp(row.updatedAt) || !integer(row.version) || row.version < 1
      || !Array.isArray(row.notes) || row.notes.length > CURIOSITY_LIMITS.notes
      || typeof row.bvid !== 'string' || (row.bvid !== '' && !isBvid(row.bvid)) || (row.origin === 'fish' && !row.bvid)
      || row.url !== (row.bvid ? videoUrl(row.bvid) : '')) return invalidBoard()
    try {
      if (clean(row.question, CURIOSITY_LIMITS.question, 'question') !== row.question
        || clean(row.query, CURIOSITY_LIMITS.query, 'query') !== row.query
        || idOf(row.question, row.bvid) !== row.id) return invalidBoard()
    } catch { return invalidBoard() }
    const notes = new Set()
    for (const note of row.notes) {
      if (!object(note) || !ownKeys(note, ['bvid', 'text', 'seconds', 'url', 'at'])
        || !isBvid(note.bvid) || !validSeconds(note.seconds) || !timestamp(note.at)
        || note.url !== videoUrl(note.bvid, note.seconds)) return invalidBoard()
      try { if (clean(note.text, CURIOSITY_LIMITS.text, 'text') !== note.text) return invalidBoard() } catch { return invalidBoard() }
      const key = JSON.stringify([note.bvid, normalized(note.text), note.seconds])
      if (notes.has(key)) return invalidBoard()
      notes.add(key)
    }
    ids.add(row.id)
  }
  if (raw.items.filter(row => row.status === 'active').length > CURIOSITY_LIMITS.active) return invalidBoard()
  return structuredClone(raw)
}

/** readBvids is trusted execution evidence supplied by the host, never by tool arguments. */
export function curiousChange(raw, args = {}, { readBvids = [], actor = 'fish', now = Date.now() } = {}) {
  const board = curiosityBoard(raw)
  if (!object(args) || Object.keys(args).some(key => !ARG_KEYS.has(key)) || !ACTIONS.includes(args.action)
    || !['fish', 'user'].includes(actor)) return failure(board, 'CURIOSITY_INPUT', '好奇心操作或参数无效')
  const at = iso(now)
  if (!at) return failure(board, 'CURIOSITY_INPUT', '记录时间无效')
  if (args.expectedRevision !== undefined && (!integer(args.expectedRevision) || args.expectedRevision !== board.revision)) {
    return failure(board, 'CURIOSITY_STALE', '记录已经变化，请刷新后重试')
  }
  const read = new Set((Array.isArray(readBvids) ? readBvids : []).filter(isBvid))
  const active = board.items.filter(row => row.status === 'active').length
  let row = board.items.find(item => item.id === args.id)
  if (args.action !== 'open' && !row) return failure(board, 'CURIOSITY_NOT_FOUND', '找不到这条好奇心记录')
  if (row && args.version !== undefined && (!integer(args.version) || args.version !== row.version)) {
    return failure(board, 'CURIOSITY_STALE', '这条记录已经变化，请刷新后重试', row)
  }
  if (args.action === 'open') {
    let question, query, bvid
    try {
      question = clean(args.question, CURIOSITY_LIMITS.question, 'question')
      query = clean(args.query === undefined ? question : args.query, CURIOSITY_LIMITS.query, 'query')
      bvid = args.bvid === undefined || args.bvid === '' ? '' : typeof args.bvid === 'string' ? args.bvid.trim() : null
    } catch (error) { return failure(board, 'CURIOSITY_INPUT', error.message) }
    if (bvid === null || (bvid && !isBvid(bvid))) return failure(board, 'CURIOSITY_INPUT', '来源需要有效BV号')
    if (actor === 'fish' && (!bvid || !read.has(bvid))) return failure(board, 'CURIOSITY_READ_REQUIRED', '先实际读过来源字幕，再留下具体问题；已读补记不作阅读证据')
    const id = idOf(question, bvid)
    const duplicate = board.items.find(item => item.id === id)
    if (duplicate) return { ok: true, changed: false, duplicate: true, board, item: structuredClone(duplicate), id }
    if (active >= CURIOSITY_LIMITS.active) return failure(board, 'CURIOSITY_ACTIVE_LIMIT', '最多同时追三个小问题，先暂停或收起一个')
    if (board.items.length >= CURIOSITY_LIMITS.total) return failure(board, 'CURIOSITY_TOTAL_LIMIT', '兴趣板已满，请先明确删除不再需要的一条')
    row = { id, status: 'active', origin: actor, question, query, bvid, url: bvid ? videoUrl(bvid) : '',
      createdAt: at, updatedAt: at, version: 1, notes: [] }
    board.items.push(row)
  } else if (args.action === 'forget') {
    board.items = board.items.filter(item => item.id !== row.id)
  } else if (args.action === 'note') {
    if (actor !== 'fish') return failure(board, 'CURIOSITY_READ_REQUIRED', '收获只由角色在实际阅读后记录，人工入口不能代填阅读证据', row)
    if (row.status !== 'active') return failure(board, 'CURIOSITY_NOT_ACTIVE', '这条已经暂停或收起，先明确恢复再继续记', row)
    const bvid = typeof args.bvid === 'string' ? args.bvid.trim() : ''
    if (!isBvid(bvid) || !read.has(bvid)) return failure(board, 'CURIOSITY_READ_REQUIRED', '收获需要本次实际读过的来源BV号', row)
    let text
    try { text = clean(args.text, CURIOSITY_LIMITS.text, 'text') } catch (error) { return failure(board, 'CURIOSITY_INPUT', error.message, row) }
    const seconds = args.seconds === undefined || args.seconds === null ? null : args.seconds
    if (!validSeconds(seconds)) return failure(board, 'CURIOSITY_INPUT', '时间点需要0至86400之间的秒数', row)
    if (row.notes.some(note => note.bvid === bvid && normalized(note.text) === normalized(text) && note.seconds === seconds)) {
      return { ok: true, changed: false, duplicate: true, board, item: structuredClone(row), id: row.id }
    }
    if (row.notes.length >= CURIOSITY_LIMITS.notes) return failure(board, 'CURIOSITY_NOTE_LIMIT', '这一条已经留了三点收获，可以收起它；更多原文仍在原视频里', row)
    row.notes.push({ bvid, text, seconds, url: videoUrl(bvid, seconds), at })
    row.updatedAt = at; row.version++
  } else {
    const status = { pause: 'paused', resume: 'active', resolve: 'resolved' }[args.action]
    if (row.status === status) return { ok: true, changed: false, board, item: structuredClone(row), id: row.id }
    if (status === 'active' && active >= CURIOSITY_LIMITS.active) return failure(board, 'CURIOSITY_ACTIVE_LIMIT', '最多同时追三个小问题，先暂停或收起一个', row)
    row.status = status; row.updatedAt = at; row.version++
  }
  board.revision++
  return { ok: true, changed: true, board, item: structuredClone(row), id: row.id }
}

/** Finds are views of these same notes, not a second saved collection or a claim of verified truth. */
export function curiousSnapshot(raw) {
  const board = curiosityBoard(raw)
  const items = board.items.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  const finds = items.flatMap(item => item.notes.map(note => ({ ...note,
    id: 'cf-' + digest(JSON.stringify([item.id, note.bvid, normalized(note.text), note.seconds])).slice(0, 16),
    topicId: item.id, question: item.question, status: item.status })))
    .sort((a, b) => b.at.localeCompare(a.at) || a.topicId.localeCompare(b.topicId)).slice(0, 60)
  return { ok: true, schema: 1, revision: board.revision, items, counts: {
    active: items.filter(row => row.status === 'active').length, paused: items.filter(row => row.status === 'paused').length,
    resolved: items.filter(row => row.status === 'resolved').length, total: items.length }, finds }
}

/** One optional active lead plus its latest self-written finding, never verified truth or read evidence. */
export function curiousHint(raw, { rotationKey = '' } = {}) {
  const board = curiosityBoard(raw)
  const active = board.items.filter(row => row.status === 'active').sort((a, b) => a.id.localeCompare(b.id))
  if (!active.length) return null
  const index = parseInt(digest(String(rotationKey)).slice(0, 8), 16) % active.length
  const row = active[index]
  const last = row.notes.at(-1)
  return { id: row.id, question: row.question, query: row.query, bvid: row.bvid, url: row.url, optional: true,
    noteCount: row.notes.length,
    ...(last ? { lastFind: { bvid: last.bvid, text: last.text, url: last.url, at: last.at } } : {}) }
}
