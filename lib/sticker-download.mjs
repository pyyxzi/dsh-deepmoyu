/** Bounded public-image download. DNS is checked once per redirect and pinned for the connection. */
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'

export const IMAGE_DOWNLOAD_MAX = 5 * 1024 * 1024
export const IMAGE_DOWNLOAD_TIMEOUT = 8_000

export function isPublicImageAddress(address) {
  const host = String(address || '').toLowerCase().replace(/^\[|\]$/g, '')
  const family = isIP(host)
  if (family === 4) {
    const [a, b, c] = host.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113))
  }
  if (family !== 6 || host.includes('%') || host.includes('.')) return false
  const words = host.split(':')
  const first = Number.parseInt(words[0] || '0', 16)
  const second = Number.parseInt(words[1] || '0', 16)
  // Only global unicast; exclude transition, documentation and special-purpose networks.
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && first !== 0x3fff
    && !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8))
}

export function publicImageUrl(input) {
  const raw = String(input || '')
  if (raw.length > 2048) throw new Error('图片地址过长')
  let url
  try { url = new URL(raw) } catch { throw new Error('url 不是合法地址') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('url 必须是 http(s) 地址')
  if (url.username || url.password) throw new Error('图片地址不能带账号或密码')
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('图片地址只接受 80 / 443 端口')
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host || host === 'localhost' || host === 'metadata.google.internal'
    || /\.(localhost|local|internal|lan|home|arpa)$/.test(host)
    || (!isIP(host) && !host.includes('.')) || (isIP(host) && !isPublicImageAddress(host))) {
    throw new Error('不给下内网/本机地址——只收公网 http(s) 的图')
  }
  url.hash = ''
  return url
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function imageTarget(url, lookupImpl, signal) {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }]
    : await abortable(Promise.resolve().then(() => lookupImpl(host, { all: true, verbatim: true })), signal)
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(a => !isPublicImageAddress(a.address))) {
    throw new Error('图片域名解析到内网/保留地址，拒绝下载')
  }
  return addresses[0]
}

function requestImage(url, target, signal) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', signal, agent: false,
      headers: { accept: 'image/png,image/jpeg,image/gif,image/webp', 'user-agent': 'dsh-deepmoyu/2.2', 'accept-encoding': 'identity' },
      lookup: (_host, options, callback) => {
        if (options?.all) callback(null, [target])
        else callback(null, target.address, target.family)
      },
    }, resolve)
    request.on('error', reject)
    request.end()
  })
}

async function readResponse(response, maxBytes) {
  const type = String(response.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase()
  if (type && !['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'application/octet-stream'].includes(type)) {
    response.destroy()
    throw new Error('内容不是支持的图片格式（jpg/png/gif/webp）')
  }
  const length = Number(response.headers?.['content-length'])
  if (Number.isFinite(length) && length > maxBytes) {
    response.destroy()
    throw new Error('图片超过 5MB，太大了')
  }
  const chunks = []
  let size = 0
  for await (const chunk of response) {
    size += chunk.length
    if (size > maxBytes) {
      response.destroy()
      throw new Error('图片超过 5MB，太大了')
    }
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, size)
}

/** fetchImpl/lookupImpl are trusted test seams; production always uses a pinned native connection. */
export async function downloadStickerImage(input, { signal, lookupImpl = (host, options) => dns.promises.lookup(host, options), fetchImpl, timeoutMs = IMAGE_DOWNLOAD_TIMEOUT, maxBytes = IMAGE_DOWNLOAD_MAX } = {}) {
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason || new Error('图片下载已取消'))
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('图片下载超时')), timeoutMs)
  timer.unref?.()
  try {
    let url = publicImageUrl(input)
    for (let redirects = 0; redirects <= 3; redirects++) {
      controller.signal.throwIfAborted()
      const target = await imageTarget(url, lookupImpl, controller.signal)
      if (fetchImpl) {
        const response = await abortable(Promise.resolve().then(() => fetchImpl(url.href, { method: 'GET', redirect: 'manual', signal: controller.signal })), controller.signal)
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers?.get?.('location')
          await response.body?.cancel?.()
          if (!location || redirects === 3) throw new Error('图片重定向过多或缺少地址')
          url = publicImageUrl(new URL(location, url).href)
          continue
        }
        if (!response.ok) throw new Error(`下载失败：HTTP ${response.status || '?'}`)
        const declared = Number(response.headers?.get?.('content-length'))
        if (Number.isFinite(declared) && declared > maxBytes) { await response.body?.cancel?.(); throw new Error('图片超过 5MB，太大了') }
        let bytes
        if (response.body) {
          const { Readable } = await import('node:stream')
          const stream = Readable.fromWeb(response.body)
          stream.headers = { 'content-type': response.headers?.get?.('content-type'), 'content-length': response.headers?.get?.('content-length') }
          bytes = await abortable(readResponse(stream, maxBytes), controller.signal)
        } else bytes = Buffer.from(await abortable(response.arrayBuffer(), controller.signal))
        if (bytes.length > maxBytes) throw new Error('图片超过 5MB，太大了')
        return { bytes, sourceUrl: url.href }
      }
      const response = await requestImage(url, target, controller.signal)
      if (response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers.location
        response.destroy()
        if (!location || redirects === 3) throw new Error('图片重定向过多或缺少地址')
        url = publicImageUrl(new URL(location, url).href)
        continue
      }
      if (response.statusCode !== 200) { response.destroy(); throw new Error(`下载失败：HTTP ${response.statusCode || '?'}`) }
      const bytes = await readResponse(response, maxBytes)
      return { bytes, sourceUrl: url.href }
    }
    throw new Error('图片重定向过多')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
