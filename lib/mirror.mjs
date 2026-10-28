/** Human-readable mirrors are sanitized projections; runtime originals and immutable records stay authoritative. */
import { existsSync, mkdirSync, readFileSync, statSync, lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { atomicWriteFileSync, readJsonFileSync, withFileLockSync } from './record-storage.mjs'
import { redactRecordText, sanitizeRecord } from './record-privacy.mjs'
import { readActivityTail } from './records.mjs'

export const MIRROR_NAMES = ['seen.md', 'voice.md', 'soul.md', 'state.json', 'feiyu.json', 'duty.md', 'charter.sha256', 'config.json']
export const MIRROR_HEAVY = ['activity.jsonl']
export const MIRROR_SUBDIR = ''
export const MIRROR_MAX_BYTES = 2 * 1024 * 1024
const ALLOWED = new Set([...MIRROR_NAMES, ...MIRROR_HEAVY])
const ARTIFACT_DIRS = new Set(['out', 'digest', 'tmp', 'records'])
const hash = (text) => createHash('sha256').update(text).digest('hex')
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const fileStamp = (st) => ({ size: st.size, mtimeMs: st.mtimeMs })

function workRootOf(target) {
  let p = String(target || '').replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '')
  if (!p) return ''
  const parts = p.split(/[\\/]/)
  while (parts.length > 1 && ARTIFACT_DIRS.has(String(parts[parts.length - 1]).toLowerCase())) parts.pop()
  if (parts.length > 2) parts.pop()
  // ⭐ 2026-10-26：按平台选拼接符 —— 以前写死 '\\'，POSIX 上会把 /home/u/ws 拼成字面 `\home\u`
  //   还能通过长度检查，进而在 cwd 下创建反斜杠名字的目录。
  const sep = process.platform === 'win32' ? '\\' : '/'
  const root = parts.join(sep)
  // Windows 盘符（C:\）或 POSIX 绝对根（/）都算"根太浅，推不出工作区"
  if (process.platform === 'win32') return /^[A-Za-z]:\\?$/.test(root) || root.length < 4 ? '' : root
  return root === '/' || root.length < 2 ? '' : root
}

export function resolveMirrorDir(stateDir, explicit = '') {
  const want = String(explicit || '').trim()
  if (want) return want
  for (const link of ['out', 'digest']) {
    try {
      const target = readlinkSync(join(stateDir, link))
      const root = target ? workRootOf(target) : ''
      if (root) return MIRROR_SUBDIR ? join(root, MIRROR_SUBDIR) : root
    } catch { /* no junction; try the next artifact directory */ }
  }
  return ''
}

function mirrorText(fromDir, name, source) {
  if (name.endsWith('.json')) return JSON.stringify(sanitizeRecord(JSON.parse(source), { maxKeys: 10000, maxLength: 16000, maxDepth: 10 }), null, 2) + '\n'
  if (name === 'activity.jsonl') {
    const tail = readActivityTail(fromDir, { maxBytes: MIRROR_MAX_BYTES, limit: 5000 })
    if (tail.truncated) throw new Error('MIRROR_ACTIVITY_NEEDS_ROTATION')
    const complete = source.split('\n').filter((s) => s.trim())
    // Never disguise truncation or a malformed source as a complete history snapshot.
    if (complete.length > 5000 || complete.some((s) => { try { const row = JSON.parse(s); return typeof row?.text !== 'string' } catch { return true } })) throw new Error('MIRROR_ACTIVITY_INVALID_OR_TOO_MANY_ROWS')
    if (complete.length && !source.endsWith('\n')) throw new Error('MIRROR_ACTIVITY_PARTIAL_LINE')
    return tail.rows.map((r) => JSON.stringify(r)).join('\n') + (tail.rows.length ? '\n' : '')
  }
  if (source.length > 1024 * 1024) throw new Error('MIRROR_TEXT_TOO_LARGE')
  return redactRecordText(source, { maxLength: MIRROR_MAX_BYTES })
}

/** Best effort and allowlisted, even when callers supply opts.names. Writes are atomic and serialized. */
export function mirrorOnce(fromDir, toDir, opts = {}) {
  const out = { ok: false, dir: String(toDir || ''), copied: [], skipped: [], failed: [] }
  const want = opts.names ?? (opts.heavy ? [...MIRROR_NAMES, ...MIRROR_HEAVY] : MIRROR_NAMES)
  const names = Array.isArray(want) ? [...new Set(want)] : []
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  if (!fromDir || !toDir || !Array.isArray(want)) { out.failed.push({ name: '*', error: 'MIRROR_DIRECTORY_OR_NAMES_INVALID' }); return out }
  try {
    if (samePath(resolve(fromDir), resolve(toDir))) throw new Error('MIRROR_SAME_DIRECTORY')
    mkdirSync(toDir, { recursive: true })
    if (samePath(realpathSync(fromDir), realpathSync(toDir))) throw new Error('MIRROR_SAME_DIRECTORY')
    return withFileLockSync(join(toDir, '_mirror'), () => {
      const manifestFile = join(toDir, '_mirror.json')
      let prior = null
      if (existsSync(manifestFile)) {
        if (lstatSync(manifestFile).isSymbolicLink()) throw new Error('MIRROR_MANIFEST_SYMLINK')
        prior = readJsonFileSync(manifestFile, null, { maxBytes: 128 * 1024 })
      }
      const files = { ...(prior?.files && typeof prior.files === 'object' && !Array.isArray(prior.files) ? prior.files : {}) }
      for (const name of names) {
        if (typeof name !== 'string' || !ALLOWED.has(name)) { out.failed.push({ name: String(name).slice(0, 100), error: 'MIRROR_NAME_NOT_ALLOWED' }); continue }
        const src = join(fromDir, name); const dst = join(toDir, name)
        try {
          if (!existsSync(src)) { out.skipped.push(name); continue }
          const st = lstatSync(src)
          if (!st.isFile() || st.isSymbolicLink()) throw new Error('MIRROR_SOURCE_NOT_REGULAR')
          if (st.size > MIRROR_MAX_BYTES) throw new Error('MIRROR_SOURCE_TOO_LARGE')
          if (existsSync(dst) && (lstatSync(dst).isSymbolicLink() || !lstatSync(dst).isFile())) throw new Error('MIRROR_DESTINATION_NOT_REGULAR')
          const source = readFileSync(src, 'utf8')
          const text = mirrorText(fromDir, name, source)
          const after = statSync(src)
          if (st.size !== after.size || st.mtimeMs !== after.mtimeMs) throw new Error('MIRROR_SOURCE_CHANGED_RETRY_LATER')
          const digest = hash(text)
          if (Buffer.byteLength(text) > MIRROR_MAX_BYTES * 4) throw new Error('MIRROR_RESULT_TOO_LARGE')
          if (existsSync(dst) && statSync(dst).size <= MIRROR_MAX_BYTES * 4 && hash(readFileSync(dst)) === digest) out.skipped.push(name)
          else { atomicWriteFileSync(dst, text); out.copied.push(name) }
          files[name] = { sha256: digest, bytes: Buffer.byteLength(text), source: fileStamp(st), at: files[name]?.sha256 === digest ? files[name].at : new Date().toISOString() }
        } catch (e) { out.failed.push({ name, error: redactRecordText(e?.message || e, { maxLength: 200 }) }) }
      }
      const manifest = { schema: 2, at: new Date().toISOString(), from: '[插件状态目录]', names: names.filter((n) => ALLOWED.has(n)), heavy: Boolean(opts.heavy), copied: out.copied, failed: out.failed, files, note: '这是脱敏的只读镜像。原件在插件状态目录；活动/人格变更的不可变事件在原件 records/。镜像不会自动批准学习，凭证不复制。' }
      if (out.copied.length || out.failed.length || !prior) atomicWriteFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
      out.ok = out.failed.length === 0
      try { if (out.copied.length) log(`记录镜像：同步了 ${out.copied.length} 个文件`) } catch { /* logger cannot break best-effort snapshots */ }
      return out
    })
  } catch (e) { out.failed.push({ name: '*', error: redactRecordText(e?.message || e, { maxLength: 200 }) }); return out }
}

export function listMirror(toDir) {
  const rows = []
  for (const name of [...MIRROR_NAMES, ...MIRROR_HEAVY]) {
    try { const st = statSync(join(toDir, name)); if (st.isFile()) rows.push({ name, size: st.size, at: new Date(st.mtimeMs).toISOString() }) } catch { /* absent */ }
  }
  return rows
}

export function readMirrorManifest(toDir) {
  try { return readJsonFileSync(join(toDir, '_mirror.json'), null, { maxBytes: 128 * 1024 }) } catch { return null }
}
