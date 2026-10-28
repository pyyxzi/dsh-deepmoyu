/**
 * lib/login.mjs —— 扫码登录（直接在 JS 里走 B站 passport 接口）
 * ============================================================================
 * 为什么不用它自带的 `bili_login`：那个把码存成 PNG 就返回，**字段全是空**（踩过一次，见 lesson）。
 * 我们按实测跑通的那条来：
 *   ① GET  /x/passport-login/web/qrcode/generate?source=main-fe-header  → data.url + data.qrcode_key
 *   ② 手机扫 → 轮询 /x/passport-login/web/qrcode/poll?qrcode_key=…
 *      data.code：86101 未扫 / 86090 已扫待确认 / 0 成功 / 86038 过期
 *   ③ ⭐ **凭证在轮询响应的 `Set-Cookie` 头里**（成功时那条 `data.url` 里没有 SESSDATA，
 *      那是别的域的游戏票 —— 别在 url 里找）
 *   ④ 写成 MCP 认识的四个字段：sessdata / bili_jct / buvid3 / dedeuserid
 *
 * 二维码图片：交给 venv 里的 Python `qrcode` 画（ASCII 的 URL，走 `-c` 安全；
 * 没装就退回"只给 URL"，前端会提示先跑「建 venv 装依赖」）。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from './record-storage.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const GEN = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
const pollUrl = (key) => 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(key) + '&source=main-fe-header'
const SPI = 'https://api.bilibili.com/x/frontend/finger/spi'

/** 从 Set-Cookie 数组里抠出我们要的几个 */
function pickCookies(list) {
  const jar = {}
  const want = { SESSDATA: 'sessdata', bili_jct: 'bili_jct', DedeUserID: 'dedeuserid', buvid3: 'buvid3' }
  for (const raw of list ?? []) {
    const first = String(raw).split(';')[0] || ''
    const i = first.indexOf('=')
    if (i <= 0) continue
    const name = first.slice(0, i).trim()
    const value = first.slice(i + 1).trim()
    if (want[name]) jar[want[name]] = value
  }
  return jar
}

/** 拿不到 buvid3 时补一张"指纹"（非致命，失败就当空） */
async function ensureBuvid3(jar) {
  if (jar.buvid3) return jar
  try {
    const r = await fetch(SPI, { headers: { 'User-Agent': UA } })
    const j = await r.json()
    const v = j?.data?.b_3
    if (v) jar.buvid3 = v
  } catch { /* 拿不到就算了 */ }
  return jar
}

export async function loginStart() {
  const r = await fetch(GEN, { headers: { 'User-Agent': UA } })
  const j = await r.json()
  const data = j?.data
  if (!data?.qrcode_key || !data?.url) throw new Error(`生成二维码失败：${j?.message || '返回里没有 qrcode_key'}`)
  return { key: data.qrcode_key, url: data.url }
}

/** 轮询一次。state: waiting / scanned / ok / expired / unknown */
export async function loginPoll(key) {
  const res = await fetch(pollUrl(key), { headers: { 'User-Agent': UA }, redirect: 'manual' })
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  let body = {}
  try { body = await res.json() } catch { /* poll 有时返回空体 */ }
  const code = body?.data?.code
  if (code === 0) {
    const jar = await ensureBuvid3(pickCookies(setCookies))
    if (!jar.sessdata) return { state: 'unknown', code, message: '登录成功了，但响应里没有 SESSDATA —— 把这次的结果记下来再排查' }
    return { state: 'ok', code, credential: jar }
  }
  const map = { 86101: 'waiting', 86090: 'scanned', 86038: 'expired' }
  return { state: map[code] ?? 'unknown', code, message: body?.message || '' }
}

/** 把凭证写进 MCP 读的那个文件（家目录里的 bili_credential.json）
 *  ⭐ 2026-10-26：SESSDATA/bili_jct 是完整账号控制凭证 —— 改走原子写（temp+fsync+rename、0600），
 *    以前裸 writeFileSync 半写会留残文件，POSIX 下还是默认 0644 的宽松权限。 */
export function saveCredential(stateDir, credential) {
  mkdirSync(stateDir, { recursive: true })
  const file = join(stateDir, 'bili_credential.json')
  atomicWriteFileSync(file, JSON.stringify({
    sessdata: credential.sessdata ?? '',
    bili_jct: credential.bili_jct ?? '',
    buvid3: credential.buvid3 || '',
    dedeuserid: credential.dedeuserid ?? '',
  }, null, 2))
  return file
}

/** 用 Python 的 qrcode 画一张 PNG，返回**文件路径**（拿不到就返回 null）
 *  ⭐ 2026-10-26：加 20 秒超时 —— python 挂住时（"既不起来也不退出"）这个 Promise 以前永远不 settle，
 *    `/login/start` 那个 HTTP 请求就永远挂着（probeCmd 那批同型问题修过，这里漏了）。 */
export function renderQrPng(pythonPath, stateDir, url, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const png = join(stateDir, `qrcode_login.${process.pid}.png`)
    const code = 'import sys, qrcode; qrcode.make(sys.argv[1]).save(sys.argv[2])'
    let child
    let settled = false
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } }
    const timer = setTimeout(() => {
      try { child?.kill('SIGKILL') } catch { /* 已经没了 */ }
      finish(null)
    }, timeoutMs)
    timer.unref?.()
    try {
      child = spawn(pythonPath || 'python', ['-c', code, url, png], { cwd: stateDir, windowsHide: true })
    } catch { finish(null); return }
    const done = () => { try { finish(existsSync(png) ? png : null) } catch { finish(null) } }
    child.on('exit', (c) => { if (c === 0) done(); else finish(null) })
    child.on('error', () => finish(null))
  })
}
