/** Verified, bounded uv bootstrap. User data and install artifacts stay outside the package. */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, copyFileSync, chmodSync, rmSync, readFileSync, renameSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { open, unlink } from 'node:fs/promises'

const inflight = new Map()
const MAX_ARCHIVE = 192 * 1024 * 1024
const SHA = /^[0-9a-f]{64}$/i
const nativeRun = (command, args, options = {}) => new Promise(resolveRun => {
  execFile(command, args, { timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true, ...options }, error => {
    resolveRun({ status: error ? error.code || 1 : 0, error })
  })
})

export function uvAssetFor(platform = process.platform, arch = process.arch, libc = 'gnu') {
  const cpu = { x64: 'x86_64', arm64: 'aarch64', ia32: 'i686' }[arch]
  if (!cpu) return null
  if (platform === 'win32') return { name: `uv-${cpu}-pc-windows-msvc.zip`, bin: 'uv.exe', wheel: { x64: 'win_amd64', arm64: 'win_arm64', ia32: 'win32' }[arch] }
  if (platform === 'darwin' && arch !== 'ia32') return { name: `uv-${cpu}-apple-darwin.tar.gz`, bin: 'uv' }
  if (platform === 'linux') return { name: `uv-${cpu}-unknown-linux-${libc === 'musl' ? 'musl' : 'gnu'}.tar.gz`, bin: 'uv' }
  return null
}

export function findBin(name, dir) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) { const hit = findBin(name, path); if (hit) return hit }
    else if (entry.isFile() && entry.name === name) return path
  }
  return null
}

export async function extractArchive(name, archive, into, run = nativeRun) {
  const attempts = [['tar', ['-xf', archive, '-C', into]], ['unzip', ['-o', archive, '-d', into]]]
  for (const [command, args] of attempts) {
    try {
      const result = await run(command, args, { timeout: 90_000 })
      if (result.status === 0) { const hit = findBin(name, into); if (hit) return hit }
    } catch { /* An unavailable extractor must not hide the next supported one. */ }
  }
  return null
}

/** The deadline covers headers and the whole streamed response, including slow bodies. */
async function consumeUvResponse(url, { fetchImpl = globalThis.fetch, timeoutMs = 120_000, maxBytes = MAX_ARCHIVE } = {}, consume) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('UV_DOWNLOAD_TIMEOUT')), timeoutMs)
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) throw new Error('UV_HTTP_' + response.status)
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('UV_DOWNLOAD_TOO_LARGE')
    if (!response.body) throw new Error('UV_EMPTY_RESPONSE')
    let total = 0
    for await (const chunk of response.body) {
      total += chunk.length
      if (total > maxBytes) { controller.abort(); throw new Error('UV_DOWNLOAD_TOO_LARGE') }
      await consume(chunk)
    }
    if (!total) throw new Error('UV_EMPTY_RESPONSE')
    return total
  } finally { clearTimeout(timer); controller.abort() }
}

export async function fetchUvBytes(url, options = {}) {
  const chunks = []
  const length = await consumeUvResponse(url, { maxBytes: 8 * 1024 * 1024, ...options }, chunk => { chunks.push(Buffer.from(chunk)) })
  return Buffer.concat(chunks, length)
}

/** Large binaries stream to a private exclusive file rather than buffering hundreds of MB in the host. */
export async function downloadUvArchive(url, file, options = {}) {
  const handle = await open(file, 'wx', 0o600)
  const digest = createHash('sha256')
  let complete = false
  try {
    await consumeUvResponse(url, options, async chunk => {
      digest.update(chunk)
      let offset = 0
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset)
        if (!bytesWritten) throw new Error('UV_DOWNLOAD_WRITE_FAILED')
        offset += bytesWritten
      }
    })
    await handle.sync()
    complete = true
    return digest.digest('hex')
  } finally {
    await handle.close()
    if (!complete) try { await unlink(file) } catch { /* Only this newly created file is ours. */ }
  }
}

function linuxLibc() {
  if (process.platform !== 'linux') return 'gnu'
  try { return process.report.getReport().header.glibcVersionRuntime ? 'gnu' : 'musl' } catch { return 'gnu' }
}

export function officialUvWheel(metadata, wheel) {
  const candidates = (Array.isArray(metadata?.urls) ? metadata.urls : []).filter(entry => {
    const filename = String(entry.filename || '')
    if (!new RegExp('^uv-\\d+\\.\\d+\\.\\d+-py3-none-' + wheel + '\\.whl$').test(filename) || !SHA.test(String(entry.digests?.sha256 || ''))) return false
    try { const url = new URL(entry.url); return url.protocol === 'https:' && url.hostname === 'files.pythonhosted.org' && !url.username && !url.password && !url.port } catch { return false }
  })
  candidates.sort((a, b) => {
    const x = a.filename.split('-')[1].split('.').map(Number), y = b.filename.split('-')[1].split('.').map(Number)
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]
  })
  return candidates[0] || null
}

async function installUv({ dir, log, asset, fetchImpl, run, timeoutMs }) {
  const target = join(dir, asset.bin)
  const usable = async path => {
    try { return (await run(path, ['--version'], { timeout: 15_000 })).status === 0 } catch { return false }
  }
  if (existsSync(target) && await usable(target)) return target
  mkdirSync(dir, { recursive: true })
  // Each installer owns its extraction tree and staging file; concurrent hosts
  // cannot delete another installer's archive or partially overwrite uv.exe.
  const tmp = mkdtempSync(join(dir, '.uv-install-'))
  const staged = `${target}.${process.pid}.${randomUUID()}.staging`
  const official = `https://github.com/astral-sh/uv/releases/latest/download/${asset.name}`
  const sources = [
    { label: 'GitHub 官方', url: official, file: asset.name },
    { label: 'GitHub 下载代理 gh-proxy.com', url: `https://gh-proxy.com/${official}`, file: asset.name },
    { label: 'GitHub 下载代理 ghproxy.net', url: `https://ghproxy.net/${official}`, file: asset.name },
  ]
  const bytes = (url, limit = MAX_ARCHIVE, deadline = timeoutMs) => fetchUvBytes(url, { fetchImpl, maxBytes: limit, timeoutMs: deadline })
  let githubDigest
  try {
    if (asset.wheel) {
      try {
        // Trust metadata from PyPI itself, never a mirror that can replace both
        // a wheel and its claimed checksum. Download hosts are restricted too.
        const metadata = JSON.parse((await bytes('https://pypi.org/pypi/uv/json', 8 * 1024 * 1024, 20_000)).toString())
        const wheel = officialUvWheel(metadata, asset.wheel)
        if (wheel) sources.push({ label: 'PyPI 官方 wheel', url: wheel.url, file: wheel.filename, sha: wheel.digests.sha256.toLowerCase() })
      } catch (error) { log('PyPI 元数据不可用，继续其他来源：' + String(error.message)) }
    }
    for (const source of sources) {
      try {
        log('正在下载 uv：' + source.label)
        if (!source.sha && githubDigest === undefined) {
          try {
            const text = (await bytes(official + '.sha256', 4096, 20_000)).toString()
            githubDigest = /\b([0-9a-f]{64})\b/i.exec(text)?.[1]?.toLowerCase() || null
          } catch { githubDigest = null }
        }
        const wanted = source.sha || githubDigest
        if (!SHA.test(String(wanted || ''))) { log('缺少官方 SHA-256，已跳过该来源'); continue }
        const file = join(tmp, randomUUID() + '-' + source.file)
        const digest = await downloadUvArchive(source.url, file, { fetchImpl, timeoutMs, maxBytes: MAX_ARCHIVE })
        if (digest !== wanted) { log('SHA-256 不一致，已拒绝该文件'); continue }
        const into = mkdtempSync(join(tmp, 'extract-'))
        const executable = await extractArchive(asset.bin, file, into, run)
        if (!executable) { log('归档中缺少可执行文件'); continue }
        copyFileSync(executable, staged)
        try { chmodSync(staged, 0o755) } catch { /* Windows permissions differ. */ }
        if (!await usable(staged)) { log('uv 版本检查失败，未替换目标文件'); continue }
        renameSync(staged, target)
        if (!await usable(target)) { log('uv 安装后不可执行'); continue }
        log('uv 已通过官方校验和版本检查')
        return target
      } catch (error) { log(source.label + ' 失败：' + String(error.message)) }
    }
    log('未获得通过官方校验且可执行的 uv。可手动安装 Python/uv 后重试。')
    return null
  } finally {
    try { rmSync(staged, { force: true }) } catch { /* Never remove another installer staging file. */ }
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** Optional I/O implementations make install failures testable without executing a downloaded binary. */
export function ensureUv({ dir, log = () => {}, fetchImpl = globalThis.fetch, run = nativeRun,
  platform = process.platform, arch = process.arch, libc = linuxLibc(), timeoutMs = 120_000 }) {
  const asset = uvAssetFor(platform, arch, libc)
  if (!asset) { log(`当前平台不支持自动下载 uv：${platform}/${arch}`); return Promise.resolve(null) }
  const destination = resolve(dir)
  const key = destination + '/' + asset.name
  if (inflight.has(key)) return inflight.get(key)
  const pending = installUv({ dir: destination, log, asset, fetchImpl, run, timeoutMs }).finally(() => inflight.delete(key))
  inflight.set(key, pending)
  return pending
}
