/** Durable records: immutable event identities, resumable imports, bounded reads and lossless rotation. */
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, fsyncSync, fstatSync, lstatSync, readSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { atomicWriteFileSync, readJsonFileSync, withFileLockSync } from './record-storage.mjs'
import { sanitizeRecord, redactRecordText, isPrivateActivity } from './record-privacy.mjs'

const SHA = (s) => createHash('sha256').update(s).digest('hex')
const object = (x) => x && typeof x === 'object' && !Array.isArray(x) ? x : {}
const stable = (v) => JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x)
const iso = (value) => { const d = new Date(value); return value !== null && value !== '' && Number.isFinite(d.getTime()) ? d.toISOString() : '' }
const localDay = (stamp) => { const d = new Date(stamp); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const rootOf = (stateDir) => join(stateDir, 'records')
const lockOf = (stateDir) => join(rootOf(stateDir), 'journal')
const fileOf = (stateDir, id) => join(rootOf(stateDir), 'events', id.slice(0, 2), `${id}.json`)
const bounded = (v, lo, hi, fallback) => Number.isFinite(Number(v)) ? Math.max(lo, Math.min(Math.trunc(Number(v)), hi)) : fallback

function indexEvent(stateDir, event) {
  const stamp = event.at || event.recordedAt
  const receipt = `${fileOf(stateDir, event.eventId)}.indexed`
  if (existsSync(receipt)) return
  const file = join(rootOf(stateDir), 'days', `${localDay(stamp)}.jsonl`)
  mkdirSync(join(rootOf(stateDir), 'days'), { recursive: true })
  const fd = openSync(file, 'a', 0o600)
  try { appendFileSync(fd, JSON.stringify({ eventId: event.eventId, at: stamp }) + '\n', 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
  atomicWriteFileSync(receipt, JSON.stringify({ eventId: event.eventId }))
}

function putEvent(stateDir, event) {
  const file = fileOf(stateDir, event.eventId)
  if (existsSync(file)) {
    const prev = readJsonFileSync(file, null)
    if (prev?.fingerprint !== event.fingerprint) return { ok: false, eventId: event.eventId, conflict: true, error: 'RECORD_ID_CONFLICT' }
    indexEvent(stateDir, prev) // Repair a crash between durable event write and its date index.
    return { ok: true, eventId: event.eventId, duplicate: true, path: file, event: prev }
  }
  atomicWriteFileSync(file, JSON.stringify(event) + '\n')
  indexEvent(stateDir, event)
  return { ok: true, eventId: event.eventId, duplicate: false, path: file, event }
}

function activityEvent(row, opts = {}) {
  const raw = object(row)
  if (typeof raw.text !== 'string') throw new TypeError('ACTIVITY_TEXT_REQUIRED')
  let safe = object(sanitizeRecord(raw))
  if (isPrivateActivity(raw) || /私信/.test(raw.text)) {
    // Only retain activity identity and outcome, never arbitrary nested private payloads.
    safe = Object.fromEntries(['uid', 'seq', 'proc', 't', 'at', 'kind', 'tool', 'ok', 'code'].filter((k) => safe[k] !== undefined).map((k) => [k, safe[k]]))
    safe.text = '[私信活动：正文不进入复用记录]'
  }
  delete safe.eventId
  safe.kind = redactRecordText(safe.kind || 'info', { maxLength: 80 })
  const uid = typeof safe.uid === 'string' ? safe.uid.trim().slice(0, 160) : ''
  if (uid) safe.uid = uid
  else delete safe.uid
  const eventId = /^legacy-[a-f0-9]{64}$/.test(uid) ? uid.slice(7) : SHA(uid ? `activity:uid:${uid}` : `activity:legacy:${stable(safe)}`)
  safe.uid = uid || `legacy-${eventId}`
  const fingerprint = SHA(stable(safe))
  safe.eventId = eventId
  const at = iso(raw.t ?? raw.at)
  return { schema: 1, eventId, type: 'activity', at: at || null, recordedAt: new Date().toISOString(), source: basename(String(opts.source || 'activity.jsonl')), fingerprint, data: safe }
}

export function appendActivityRecord(stateDir, row, opts = {}) {
  return withFileLockSync(lockOf(stateDir), () => {
    const result = putEvent(stateDir, activityEvent(row, opts))
    if (result.ok) {
      const receipt = join(rootOf(stateDir), 'projected', result.eventId.slice(0, 2), `${result.eventId}.json`)
      if (!existsSync(receipt)) {
        // A receipt after the append lets a retry repair a crash after event persistence.
        // A crash before the receipt may duplicate a line; every reader deduplicates by eventId.
        const fd = openSync(join(stateDir, 'activity.jsonl'), 'a', 0o600)
        try { appendFileSync(fd, JSON.stringify(result.event.data) + '\n', 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
        atomicWriteFileSync(receipt, JSON.stringify({ eventId: result.eventId }))
      }
    }
    return { ...result, row: result.event?.data }
  }, opts)
}

/** Read at most maxBytes from the tail. Partial UTF-8/JSON lines are skipped, never fabricated. */
export function readActivityTail(stateDir, opts = {}) {
  const file = opts.file ? String(opts.file) : join(stateDir, 'activity.jsonl')
  const maxBytes = bounded(opts.maxBytes, 1024, 4 * 1024 * 1024, 256 * 1024)
  const limit = bounded(opts.limit, 1, 5000, 300)
  let fd
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const bytes = Buffer.alloc(size - start)
    const n = readSync(fd, bytes, 0, bytes.length, start)
    const text = bytes.subarray(0, n).toString('utf8')
    const lines = text.split('\n')
    if (start) lines.shift()
    if (!text.endsWith('\n')) lines.pop()
    const byId = new Map()
    for (const line of lines) {
      try {
        const event = activityEvent(JSON.parse(line))
        const row = event.data
        byId.set(row.eventId, row)
      } catch { /* malformed source is reported by importActivityFile instead */ }
    }
    return { rows: [...byId.values()].slice(-limit), bytesRead: n, size, truncated: start > 0 }
  } catch (e) {
    if (e?.code === 'ENOENT') return { rows: [], bytesRead: 0, size: 0, truncated: false }
    throw e
  } finally { if (fd !== undefined) closeSync(fd) }
}

/** Import a bounded chunk; repeat while more=true. Cursor advances only past complete source lines. */
export function importActivityFile(stateDir, file, opts = {}) {
  return withFileLockSync(lockOf(stateDir), () => importActivityFileUnlocked(stateDir, file, opts), opts)
}

function importActivityFileUnlocked(stateDir, file, opts = {}) {
  const maxBytes = bounded(opts.maxBytes, 1024, 4 * 1024 * 1024, 512 * 1024)
  const sourcePath = resolve(file)
  const cursorFile = join(rootOf(stateDir), 'imports', `${SHA(sourcePath)}.json`)
    const st = statSync(file)
    const cursor = readJsonFileSync(cursorFile, {})
    const identity = `${st.dev}:${st.ino}:${st.birthtimeMs}`
    const offset = cursor.identity === identity && Number(cursor.offset) <= st.size ? Number(cursor.offset) || 0 : 0
    const fd = openSync(file, 'r')
    let buffer
    try {
      buffer = Buffer.alloc(Math.min(maxBytes, Math.max(0, st.size - offset)))
      const n = readSync(fd, buffer, 0, buffer.length, offset)
      buffer = buffer.subarray(0, n)
    } finally { closeSync(fd) }
    const end = buffer.lastIndexOf(10)
    if (end < 0 && buffer.length) return { ok: false, error: buffer.length >= maxBytes ? 'ACTIVITY_LINE_TOO_LARGE' : 'ACTIVITY_PARTIAL_LINE', offset, more: true, imported: 0, duplicates: 0, invalid: 0 }
    const complete = end < 0 ? Buffer.alloc(0) : buffer.subarray(0, end + 1)
    let imported = 0; let duplicates = 0; let invalid = 0; let conflicts = 0
    let consumed = 0; let rows = 0
    const maxRows = bounded(opts.maxRows, 1, 1000, 32)
    while (consumed < complete.length && rows < maxRows) {
      const endOfLine = complete.indexOf(10, consumed)
      const line = complete.subarray(consumed, endOfLine).toString('utf8')
      consumed = endOfLine + 1
      if (!line.trim()) continue
      rows++
      let event
      try { event = activityEvent(JSON.parse(line), { source: basename(file) }) }
      catch (e) {
        if (e instanceof SyntaxError || e instanceof TypeError) { invalid++; continue }
        throw e
      }
      // Canonical event/cursor/disk failures are not malformed source lines.
      const result = putEvent(stateDir, event)
      if (!result.ok) conflicts++
      else if (result.duplicate) duplicates++
      else imported++
    }
    const nextOffset = offset + consumed
    atomicWriteFileSync(cursorFile, JSON.stringify({ schema: 1, identity, offset: nextOffset, size: st.size, at: new Date().toISOString(), invalid: (Number(cursor.invalid) || 0) + invalid, conflicts: (Number(cursor.conflicts) || 0) + conflicts }))
    return { ok: conflicts === 0, imported, duplicates, invalid, conflicts, offset: nextOffset, size: st.size, bytesRead: buffer.length, more: nextOffset < st.size }
}

const archiveQueueFile = (stateDir) => join(rootOf(stateDir), 'archive-imports.json')
const archiveReceipt = (stateDir, relative) => join(rootOf(stateDir), 'archive-imported', `${SHA(relative)}.json`)
const validArchiveRelative = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}\/[^\\/]+\.jsonl$/.test(s)

function readArchiveQueue(stateDir) {
  const queue = readJsonFileSync(archiveQueueFile(stateDir), { schema: 1, pending: [], discovery: { days: [], position: 0, nextScanAt: 0 } })
  if (!queue || !Array.isArray(queue.pending) || queue.pending.some((s) => !validArchiveRelative(s)) || !queue.discovery || !Array.isArray(queue.discovery.days) || queue.discovery.days.some((s) => !/^\d{4}-\d{2}-\d{2}$/.test(s)) || !Number.isSafeInteger(queue.discovery.position) || queue.discovery.position < 0) throw new TypeError('ARCHIVE_IMPORT_QUEUE_INVALID')
  return queue
}

function discoverArchiveDay(stateDir, queue, opts) {
  const root = join(rootOf(stateDir), 'activity')
  const discovery = queue.discovery
  if (discovery.position >= discovery.days.length) {
    if (Date.now() < (Number(discovery.nextScanAt) || 0)) return 0
    try { discovery.days = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink() && /^\d{4}-\d{2}-\d{2}$/.test(d.name)).map((d) => d.name).sort() }
    catch (e) { if (e?.code !== 'ENOENT') throw e; discovery.days = [] }
    discovery.position = 0
    discovery.nextScanAt = Date.now() + bounded(opts.scanEveryMs, 1000, 24 * 60 * 60 * 1000, 60 * 60 * 1000)
  }
  const day = discovery.days[discovery.position++]
  if (!day) { discovery.position = discovery.days.length; return 0 }
  const names = readdirSync(join(root, day), { withFileTypes: true }).filter((d) => d.isFile() && !d.isSymbolicLink() && d.name.endsWith('.jsonl')).map((d) => `${day}/${d.name}`).sort()
  const have = new Set(queue.pending)
  let found = 0
  for (const relative of names) {
    if (!validArchiveRelative(relative) || have.has(relative)) continue
    const st = statSync(join(root, relative)); const receipt = readJsonFileSync(archiveReceipt(stateDir, relative), null, { maxBytes: 8192 })
    if (receipt?.size === st.size && receipt?.mtimeMs === st.mtimeMs) continue
    queue.pending.push(relative); have.add(relative); found++
  }
  return found
}

/** One archived-file chunk per call, one discovery directory per call, with durable queue/cursors. */
export function importArchivedActivityChunk(stateDir, opts = {}) {
  return withFileLockSync(lockOf(stateDir), () => {
    const queue = readArchiveQueue(stateDir)
    const discovered = discoverArchiveDay(stateDir, queue, opts)
    const relative = queue.pending[0]
    if (!relative) {
      atomicWriteFileSync(archiveQueueFile(stateDir), JSON.stringify(queue))
      return { ok: true, processed: false, imported: 0, duplicates: 0, discovered, pending: 0, more: queue.discovery.position < queue.discovery.days.length }
    }
    const file = join(rootOf(stateDir), 'activity', relative)
    const st = lstatSync(file)
    if (!st.isFile() || st.isSymbolicLink() || lstatSync(join(rootOf(stateDir), 'activity', relative.slice(0, 10))).isSymbolicLink()) throw new Error('ARCHIVE_SOURCE_NOT_REGULAR')
    const result = importActivityFileUnlocked(stateDir, file, opts)
    // Immutable archives with a damaged final line remain intact and are reported once;
    // their receipt is invalidated if repaired. Disk/cursor failures throw before advancing.
    if (!result.more || result.error) {
      atomicWriteFileSync(archiveReceipt(stateDir, relative), JSON.stringify({ schema: 1, file: relative, size: st.size, mtimeMs: st.mtimeMs, offset: result.offset, error: result.error || null, invalid: result.invalid || 0, conflicts: result.conflicts || 0, at: new Date().toISOString() }))
      queue.pending.shift()
    }
    atomicWriteFileSync(archiveQueueFile(stateDir), JSON.stringify(queue))
    return { ...result, file: relative, processed: true, discovered, pending: queue.pending.length, more: queue.pending.length > 0 || queue.discovery.position < queue.discovery.days.length }
  }, opts)
}

/** Never overwrite .1. A fresh unique archive survives clear-screen and any number of rotations. */
export function rotateActivityLog(stateDir, opts = {}) {
  return withFileLockSync(lockOf(stateDir), () => {
    const file = join(stateDir, 'activity.jsonl')
    if (!existsSync(file)) return { ok: true, rotated: false }
    const size = statSync(file).size
    if (!opts.force && size <= bounded(opts.limit, 1024, 64 * 1024 * 1024, 512 * 1024)) return { ok: true, rotated: false, size }
    if (!size) return { ok: true, rotated: false, size }
    const queue = readArchiveQueue(stateDir) // Corruption must fail before moving the live log.
    const oldCursor = readJsonFileSync(join(rootOf(stateDir), 'imports', `${SHA(resolve(file))}.json`), null, { maxBytes: 8192 })
    const now = new Date().toISOString()
    const day = now.slice(0, 10)
    const dir = join(rootOf(stateDir), 'activity', day)
    mkdirSync(dir, { recursive: true })
    const archive = join(dir, `activity-${now.replace(/[:.]/g, '-')}-${randomUUID()}.jsonl`)
    renameSync(file, archive)
    atomicWriteFileSync(file, '')
    const archivedStat = statSync(archive)
    if (oldCursor?.identity === `${archivedStat.dev}:${archivedStat.ino}:${archivedStat.birthtimeMs}`) atomicWriteFileSync(join(rootOf(stateDir), 'imports', `${SHA(resolve(archive))}.json`), JSON.stringify(oldCursor))
    const relative = `${day}/${basename(archive)}`
    if (!queue.pending.includes(relative)) queue.pending.push(relative)
    atomicWriteFileSync(archiveQueueFile(stateDir), JSON.stringify(queue))
    return { ok: true, rotated: true, size, archive }
  }, opts)
}

/** Snapshots are mode-scoped observations, never automatic approvals or invented experiences. */
export function captureMemorySnapshot(stateDir, name, text, opts = {}) {
  if (opts.mode !== 'dafeiyu') return { ok: false, skipped: true, reason: 'mode_required' }
  if (!['soul.md', 'voice.md', 'seen.md'].includes(name)) return { ok: false, error: 'MEMORY_NAME_NOT_ALLOWED' }
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) return { ok: false, error: 'MEMORY_TEXT_TOO_LARGE' }
  const safe = redactRecordText(text, { maxLength: 1024 * 1024 })
  const digest = SHA(safe)
  const keyFile = join(rootOf(stateDir), 'memory-heads.json')
  return withFileLockSync(lockOf(stateDir), () => {
    const rawHeads = readJsonFileSync(keyFile, {})
    if (!rawHeads || typeof rawHeads !== 'object' || Array.isArray(rawHeads)) throw new TypeError('MEMORY_HEAD_INVALID')
    const heads = rawHeads
    const prev = object(heads[name])
    if (heads[name] !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(String(prev.eventId)) || !/^[a-f0-9]{64}$/.test(String(prev.digest))) throw new TypeError('MEMORY_HEAD_INVALID')
      const previous = readJsonFileSync(fileOf(stateDir, prev.eventId), null)
      if (!previous || previous.eventId !== prev.eventId || previous.type !== 'memory' || previous.data?.name !== name || previous.data?.digest !== prev.digest || previous.fingerprint !== SHA(stable(previous.data))) throw new Error('MEMORY_EVENT_INVALID')
      indexEvent(stateDir, previous)
    }
    if (prev.digest === digest) return { ok: true, duplicate: true, eventId: prev.eventId, path: fileOf(stateDir, prev.eventId) }
    const operation = redactRecordText(opts.operation || 'snapshot', { maxLength: 80 })
    const eventId = SHA(`memory:${name}:${prev.eventId || 'root'}:${digest}:${operation}`)
    const at = iso(opts.at) || new Date().toISOString()
    const data = { name, text: safe, digest, previousEventId: prev.eventId || '', operation, mode: 'dafeiyu' }
    const event = { schema: 1, eventId, type: 'memory', at, recordedAt: new Date().toISOString(), source: redactRecordText(opts.source || name, { maxLength: 160 }), fingerprint: SHA(stable(data)), data }
    const result = putEvent(stateDir, event)
    if (result.ok) atomicWriteFileSync(keyFile, JSON.stringify({ ...heads, [name]: { digest, eventId, at } }))
    return result
  }, opts)
}

/** Dates are explicit or recent observed days; traversal and unbounded all-history loads are rejected. */
export function readRecordEvents(stateDir, opts = {}) {
  const limit = bounded(opts.limit, 1, 5000, 300)
  const maxBytes = bounded(opts.maxBytes, 1024, 4 * 1024 * 1024, 512 * 1024)
  const daysDir = join(rootOf(stateDir), 'days')
  let days
  if (opts.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(opts.date))) throw new TypeError('RECORD_DATE_INVALID')
    days = [String(opts.date)]
  } else {
    try { days = readdirSync(daysDir).filter((s) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(s)).map((s) => s.slice(0, 10)).sort().reverse().slice(0, 31) } catch (e) { if (e?.code === 'ENOENT') return []; throw e }
  }
  const rows = []; const have = new Set()
  for (const day of days) {
    let fd; let text
    try {
      const file = join(daysDir, `${day}.jsonl`)
      fd = openSync(file, 'r')
      const size = fstatSync(fd).size
      const start = Math.max(0, size - maxBytes)
      const bytes = Buffer.alloc(size - start)
      const n = readSync(fd, bytes, 0, bytes.length, start)
      text = bytes.subarray(0, n).toString('utf8')
      if (start) text = text.slice(text.indexOf('\n') + 1)
    } catch (e) { if (e?.code === 'ENOENT') continue; throw e } finally { if (fd !== undefined) closeSync(fd) }
    for (const line of text.split('\n').reverse()) {
      let ref
      try { ref = JSON.parse(line) } catch { continue }
      if (!/^[a-f0-9]{64}$/.test(String(ref?.eventId)) || have.has(ref.eventId)) continue
      have.add(ref.eventId)
      const event = readJsonFileSync(fileOf(stateDir, ref.eventId), null)
      if (!event || (opts.type && event.type !== opts.type)) continue
      rows.push(event)
      if (rows.length >= limit) return rows
    }
  }
  return rows
}

/** Persist the small learning audit returned by the pure learn module after a committed state change. */
export function appendLearningRecord(stateDir, audit, opts = {}) {
  if (!audit || typeof audit !== 'object' || !/^[a-f0-9]{64}$/.test(String(audit.eventId))) return { ok: false, error: 'LEARNING_AUDIT_INVALID' }
  const data = sanitizeRecord(audit, { maxKeys: 20000, maxLength: 4000 })
  if (Buffer.byteLength(JSON.stringify(data)) > 4 * 1024 * 1024) return { ok: false, error: 'LEARNING_AUDIT_TOO_LARGE' }
  const eventId = SHA(`learning:${audit.eventId}`)
  const event = { schema: 1, eventId, type: 'learning', at: iso(audit.at) || null, recordedAt: new Date().toISOString(), source: 'learn', fingerprint: SHA(stable(data)), data }
  return withFileLockSync(lockOf(stateDir), () => putEvent(stateDir, event), opts)
}

