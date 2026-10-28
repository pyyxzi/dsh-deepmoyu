/** Crash-safe local writes and short cross-process transactions. No async callbacks under this lock. */
import { openSync, closeSync, writeFileSync, readFileSync, readSync, fstatSync, fsyncSync, renameSync, unlinkSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export function atomicWriteFileSync(file, content, { mode = 0o600 } = {}) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temp, 'wx', mode)
    writeFileSync(fd, content)
    fsyncSync(fd)
    closeSync(fd); fd = undefined
    renameSync(temp, file)
    return file
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* already closed */ }
    try { unlinkSync(temp) } catch (e) { if (e?.code !== 'ENOENT') { /* original error wins */ } }
  }
}

export function readJsonFileSync(file, fallback, { maxBytes = 8 * 1024 * 1024 } = {}) {
  let fd
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    if (size > maxBytes) throw new Error('RECORD_FILE_TOO_LARGE')
    const bytes = Buffer.alloc(size + 1)
    let count = 0
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, count)
      if (!n) break
      count += n
    }
    if (count > size) throw new Error('RECORD_FILE_CHANGED_RETRY_LATER')
    return JSON.parse(bytes.subarray(0, count).toString('utf8'))
  } catch (e) {
    if (e?.code === 'ENOENT') return fallback
    throw e
  } finally { if (fd !== undefined) closeSync(fd) }
}

const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  try { process.kill(pid, 0); return true } catch (e) { return e?.code !== 'ESRCH' }
}
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function recoverDeadLockSync(lock, staleMs) {
  // A second exclusive file serializes recovery. An orphan recovery file fails closed,
  // EXCEPT when it is clearly abandoned (2026-10-26): recovery is a sub-second operation,
  // so a .recover older than a few minutes means its owner crashed between creating it
  // and unlinking it — without this age check that orphan blocked every future recovery
  // forever (all writers stuck on RECORD_LOCK_BUSY until someone deleted the file by hand).
  const recovery = `${lock}.recover`
  let fd
  try { fd = openSync(recovery, 'wx', 0o600) } catch (e) {
    // Windows 上抢一个正被别的进程持有/正在写的文件，拿到的是 EPERM/EACCES 而不是 EEXIST
    // （2026-10-26 实测：4 个进程抢同一把锁时约 1/6 的概率撞到）。语义一样是"别人在用"，
    // 所以照样 fail closed，别把整次写入炸掉。
    if (e?.code === 'EEXIST' || e?.code === 'EPERM' || e?.code === 'EACCES') {
      try {
        const age = Date.now() - statSync(recovery).mtimeMs
        if (age > Math.max(3 * 60_000, staleMs)) {
          try { unlinkSync(recovery) } catch { /* 删不掉就按老的 fail-closed 走 */ }
          return true   // 让外层重试抢锁；若锁真被活人持有，下一轮会正常走到"创建 .recover"分支（不会死循环）
        }
      } catch { /* stat 不到就按老的 fail-closed 走 */ }
      return false
    }
    throw e
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
    const stat = statSync(lock)
    let owner = null
    try { owner = readJsonFileSync(lock, null, { maxBytes: 4096 }) } catch { /* incomplete lock: age applies */ }
    if ((owner && !alive(Number(owner.pid))) || (!owner && Date.now() - stat.mtimeMs > staleMs)) {
      unlinkSync(lock)
      return true
    }
    return false
  } catch (e) { if (e?.code === 'ENOENT') return true; throw e }
  finally { closeSync(fd); try { unlinkSync(recovery) } catch { /* recovery must not remove a new lock */ } }
}

export function withFileLockSync(file, fn, opts = {}) {
  if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') throw new TypeError('RECORD_LOCK_CALLBACK_MUST_BE_SYNC')
  const lock = `${file}.lock`
  const token = randomUUID()
  const requestedTimeout = Number(opts.timeoutMs)
  const timeoutMs = Number.isFinite(requestedTimeout) ? Math.max(0, Math.min(requestedTimeout, 10000)) : 1000
  const staleMs = Math.max(1000, Number(opts.staleMs) || 120000)
  const until = Date.now() + timeoutMs
  mkdirSync(dirname(lock), { recursive: true })
  while (true) {
    let fd
    try {
      fd = openSync(lock, 'wx', 0o600)
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() }))
      closeSync(fd); fd = undefined
      break
    } catch (e) {
      if (fd !== undefined) { try { closeSync(fd) } catch { /* original error wins */ }; try { unlinkSync(lock) } catch { /* best effort */ } }
      // ⚠️ Windows 的竞态（2026-10-26 实测，4 进程 × 15 次约 1/6 概率）：锁文件正被别的进程
      //    创建/删除的那一瞬间，`openSync(...,'wx')` 拿到的是 EPERM/EACCES 而不是 EEXIST。
      //    那不是"不许写"，只是"晚了一步"——按争用重试，不然整次事务直接炸掉。
      if (e?.code !== 'EEXIST' && e?.code !== 'EPERM' && e?.code !== 'EACCES') throw e
      try { if (recoverDeadLockSync(lock, staleMs)) continue }
      catch (readError) { if (readError?.code === 'ENOENT') continue }
      if (Date.now() >= until) throw Object.assign(new Error('RECORD_LOCK_BUSY'), { code: 'RECORD_LOCK_BUSY' })
      pause(Math.min(10, Math.max(1, until - Date.now())))
    }
  }
  try {
    const result = fn()
    if (result && typeof result.then === 'function') throw new TypeError('RECORD_LOCK_CALLBACK_MUST_BE_SYNC')
    return result
  } finally {
    try {
      if (JSON.parse(readFileSync(lock, 'utf8')).token === token) unlinkSync(lock)
    } catch { /* never remove another owner's lock */ }
  }
}
