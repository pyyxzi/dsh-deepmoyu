/**
 * 更新通道（2026-10-30 使用者要求「加一个更新通道，方便及时更新」）。
 *
 * ⚠️ 历史教训（必须保留这道闸）：2026-10-21 曾经有过一个「一键升级」按钮，它让宿主跑
 *   `dsh plugin add dsh-deepmoyu`，把整个包目录重装成 registry 上的版本。当时本机装的是
 *   **目录联接（junction）指向源码目录的分叉**，一次点击就把所有改动换掉了（m17605）。
 *
 * 所以这个模块的职责不是「能升级就行」，而是**先证明这次升级不会毁掉用户手里的东西**：
 *   1. 只允许「registry 安装」自更新（包目录必须是 profile 的 node_modules 下真实目录）；
 *      目录联接 / git 检出 / 包目录不在 profile 里 ⇒ 一律锁定，只给检查结果和手动升级建议。
 *   2. 有刷站/后台/渲染在跑时拒绝：正在跑的进程读的是旧文件，换包会让下一次 import 半新半旧。
 *   3. 单飞：同一时间只允许一个升级进程。
 * 纯函数 + 依赖注入，测试不需要网络、不需要真 dsh。
 */
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const PACKAGE_NAME = 'dsh-deepmoyu'
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
export const MIRROR_REGISTRY = 'https://registry.npmmirror.com'
export const ACCEPT_PACKUMENT = 'application/vnd.npm.install-v1+json'

const num = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** `2.4.10` / `2.4.1-beta.2` / `v2.4.1` → 可比较结构；非法返回 null。 */
export function parseVersion(raw) {
  const text = String(raw ?? '').trim().replace(/^v/i, '')
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] || '' }
}

/**
 * 比较两个版本：a>b 返回 1，相等 0，a<b 返回 -1。
 * 预发布版本低于同号正式版（`2.4.1-beta` < `2.4.1`），与 semver 一致；
 * 预发布段按点分隔逐段比，数字段按数值（`beta.10` > `beta.2`，不能比字符串）。
 * 无法解析的版本按 0.0.0 处理，绝不因为解析失败就说「有新版」。
 */
export function compareVersions(a, b) {
  const left = parseVersion(a) || { major: 0, minor: 0, patch: 0, pre: '0' }
  const right = parseVersion(b) || { major: 0, minor: 0, patch: 0, pre: '0' }
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  const lseg = left.pre.split('.')
  const rseg = right.pre.split('.')
  for (let i = 0; i < Math.max(lseg.length, rseg.length); i++) {
    const l = lseg[i], r = rseg[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l === r) continue
    const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r)
    if (ln && rn) return Number(l) > Number(r) ? 1 : -1
    if (ln) return -1
    if (rn) return 1
    return l > r ? 1 : -1
  }
  return 0
}

/** 从 npm packument 里挑出要提示的版本：优先 dist-tags.latest，没有就取最高正式版。 */
export function pickPublished(packument) {
  if (!packument || typeof packument !== 'object') return null
  const tags = packument['dist-tags'] && typeof packument['dist-tags'] === 'object' ? packument['dist-tags'] : {}
  const latest = String(tags.latest || '').trim()
  if (parseVersion(latest)) {
    const time = packument.time && typeof packument.time === 'object' ? String(packument.time[latest] || '') : ''
    return { version: latest, publishedAt: time, source: 'dist-tags.latest' }
  }
  const versions = packument.versions && typeof packument.versions === 'object' ? Object.keys(packument.versions) : []
  const stable = versions.filter((version) => parseVersion(version) && !parseVersion(version).pre)
  if (!stable.length) return null
  stable.sort(compareVersions)
  const version = stable[stable.length - 1]
  const time = packument.time && typeof packument.time === 'object' ? String(packument.time[version] || '') : ''
  return { version, publishedAt: time, source: 'highest-stable' }
}

/**
 * 判断这份安装能不能自更新。返回 `{ updatable, mode, reason, profile }`。
 *
 * mode:
 *   `registry`  —— 包目录是 profile/node_modules/<pkg> 下的真实目录（市场或 `dsh plugin add` 装的）⇒ 可自更新
 *   `link`      —— 目录联接 / 符号链接（本机分叉的接法）⇒ 只检查不升级
 *   `source`    —— 包目录里带 .git，是源码检出 ⇒ 只检查不升级
 *   `unknown`   —— 在 DSH_HOME 的 profiles 里找不到对应安装 ⇒ 只检查不升级
 */
export function detectInstallMode({ pluginDir, dshHome, packageName = PACKAGE_NAME } = {}) {
  const dir = String(pluginDir || '')
  if (!dir) return { updatable: false, mode: 'unknown', reason: '拿不到插件目录，无法判断安装方式', profile: '' }
  let real = dir
  try { real = realpathSync(dir) } catch { /* 目录不可读就按原样比 */ }
  let linked = false
  try { linked = lstatSync(dir).isSymbolicLink() } catch { linked = false }
  if (existsSync(join(dir, '.git'))) {
    return { updatable: false, mode: 'source', profile: '', real,
      reason: '这是源码检出（目录里有 .git），自更新会用 registry 版本覆盖你的改动；请改用 git pull 后重启 DSH' }
  }
  if (linked) {
    return { updatable: false, mode: 'link', profile: '', real,
      reason: '这是目录联接安装（包目录指向别处，常见于本机分叉），自更新会把指向的目录换掉；请手动覆盖或重新 link' }
  }
  const home = String(dshHome || '')
  const profilesDir = home ? join(home, 'profiles') : ''
  let names = []
  try { names = profilesDir ? readdirSync(profilesDir) : [] } catch { names = [] }
  for (const name of names) {
    const candidate = join(profilesDir, name, 'node_modules', packageName)
    let candidateReal = ''
    try { candidateReal = realpathSync(candidate) } catch { continue }
    if (candidateReal !== real) continue
    let isLink = false
    try { isLink = lstatSync(candidate).isSymbolicLink() } catch { isLink = false }
    if (isLink) {
      return { updatable: false, mode: 'link', profile: name, real,
        reason: `profile「${name}」里这个包是链接安装（可能指向本机源码），自更新会替换掉它；请手动处理` }
    }
    return { updatable: true, mode: 'registry', profile: name, real, reason: '' }
  }
  return { updatable: false, mode: 'unknown', profile: '',
    reason: '没在 DSH 的 profiles 里找到这份安装（可能是手动放置或另装了一份），为避免误覆盖，自更新已锁定' }
}

/** npm packument 请求（带超时与体积上限，只读）。 */
export async function fetchPackument({ registry = DEFAULT_REGISTRY, packageName = PACKAGE_NAME, fetchImpl = globalThis.fetch, timeoutMs = 8000, maxBytes = 2 * 1024 * 1024 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 没有 fetch，无法检查更新')
  const base = String(registry || DEFAULT_REGISTRY).replace(/\/+$/, '')
  const url = `${base}/${encodeURIComponent(packageName).replace('%40', '@')}`
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  if (timer?.unref) timer.unref()
  try {
    const response = await fetchImpl(url, {
      headers: { accept: ACCEPT_PACKUMENT, 'user-agent': `${packageName}-update-check` },
      redirect: 'follow',
      signal: controller ? controller.signal : undefined,
    })
    if (response.status === 404) return { ok: false, code: 'NOT_PUBLISHED', error: 'registry 上还没有这个包（或名称被占用），暂时无法检查更新', registry: base }
    if (!response.ok) return { ok: false, code: 'HTTP_' + response.status, error: `registry 返回 HTTP ${response.status}`, registry: base }
    const text = await response.text()
    if (text.length > maxBytes) return { ok: false, code: 'TOO_LARGE', error: 'registry 响应过大，已放弃解析', registry: base }
    let body
    try { body = JSON.parse(text) } catch { return { ok: false, code: 'BAD_JSON', error: 'registry 返回的不是合法 JSON', registry: base } }
    return { ok: true, body, registry: base }
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')
    return { ok: false, code: aborted ? 'TIMEOUT' : 'NETWORK', error: aborted ? `连接 registry 超时（${Math.round(timeoutMs / 1000)} 秒）` : `连不上 registry：${error?.message || error}`, registry: base }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 组装给界面/工具看的检查结果。纯函数：不联网、不抛错。
 * `latest` 拿不到时 `ok:false` 但**不当成「已经最新」**——未知就是未知。
 */
export function buildUpdateReport({ current, published, install, registry = DEFAULT_REGISTRY, checkedAt = Date.now(), error = '' } = {}) {
  const cur = String(current || '')
  const hasCurrent = Boolean(parseVersion(cur))
  const latest = published && parseVersion(published.version) ? String(published.version) : ''
  const outdated = Boolean(hasCurrent && latest && compareVersions(latest, cur) > 0)
  const ahead = Boolean(hasCurrent && latest && compareVersions(cur, latest) > 0)
  const canUpgrade = Boolean(outdated && install && install.updatable === true)
  let hint = ''
  if (error) hint = error
  else if (!latest) hint = '暂时读不到 registry 上的版本，稍后再试'
  else if (ahead) hint = `当前 ${cur} 比 registry 上的 ${latest} 还新（本地开发版或未发布提交）`
  else if (!outdated) hint = '已是最新版本'
  else if (!install || install.updatable !== true) hint = (install && install.reason) || '当前安装方式不支持自更新，请手动升级'
  else hint = `可以升级到 ${latest}；升级后需要重启 DSH 才能加载新代码`
  return {
    ok: !error,
    package: PACKAGE_NAME,
    current: cur,
    latest,
    outdated,
    ahead,
    canUpgrade,
    install: install || { updatable: false, mode: 'unknown', profile: '', reason: '无法判断安装方式' },
    registry: String(registry || DEFAULT_REGISTRY).replace(/\/+$/, ''),
    publishedAt: published ? String(published.publishedAt || '') : '',
    checkedAt: num(checkedAt, 0),
    hint,
    error: error || '',
  }
}

/** 组合：检测安装方式 + 查 registry + 生成结果。检查本身永不抛错。 */
export async function checkForUpdate({ current, pluginDir, dshHome, registry = DEFAULT_REGISTRY, fetchImpl = globalThis.fetch, packageName = PACKAGE_NAME, timeoutMs = 8000, checkedAt = Date.now() } = {}) {
  const install = detectInstallMode({ pluginDir, dshHome, packageName })
  const fetched = await fetchPackument({ registry, packageName, fetchImpl, timeoutMs })
  if (!fetched.ok) return { ...buildUpdateReport({ current, published: null, install, registry, checkedAt, error: fetched.error }), code: fetched.code }
  const published = pickPublished(fetched.body)
  if (!published) return { ...buildUpdateReport({ current, published: null, install, registry, checkedAt, error: 'registry 上的版本信息不完整，无法判断' }), code: 'NO_VERSIONS' }
  return buildUpdateReport({ current, published, install, registry, checkedAt })
}

/**
 * 生成升级命令。只允许 `plugin add <包名>`，不接受任意参数、不接受本地路径。
 * 返回 `{ command, args, env, profile }` 或 `{ ok:false, code, error }`。
 */
export function upgradeCommand({ dshCli, profile, packageName = PACKAGE_NAME, electron = false, registry = '' } = {}) {
  const cli = String(dshCli || '')
  if (!cli) return { ok: false, code: 'NO_DSH_CLI', error: '找不到 dsh 命令行，无法自动升级；请在终端手动执行 dsh plugin --profile <名称> add ' + packageName }
  const name = String(profile || '')
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) return { ok: false, code: 'NO_PROFILE', error: '不知道这份安装属于哪个 profile，无法安全升级' }
  const env = { DSH_UPDATE_AT: String(Date.now()) }
  if (electron) env.ELECTRON_RUN_AS_NODE = '1'
  const reg = String(registry || '').trim()
  if (reg) {
    if (!/^https?:\/\/[^\s]+$/i.test(reg)) return { ok: false, code: 'BAD_REGISTRY', error: 'registry 地址无效' }
    env.npm_config_registry = reg
  }
  return { ok: true, command: process.execPath, args: [cli, 'plugin', '--profile', name, 'add', packageName], env, profile: name, packageName }
}

/** 升级前必须满足的条件；返回拒绝原因或空串。 */
export function upgradeBlocker({ report, busy = {}, upgrading = false, runningSend = false } = {}) {
  if (upgrading) return '已经有一个升级在进行，请等它结束'
  if (!report || report.ok === false) return '还没成功检查到可用版本，先点「检查更新」'
  if (!report.outdated) return report.ahead ? '当前版本已经比 registry 上的新，不需要升级' : '已经是最新版本'
  if (!report.canUpgrade) return (report.install && report.install.reason) || '当前安装方式不支持自更新'
  if (runningSend) return '刷站任务正在运行，等它停下再升级（避免跑着的进程读到半新半旧的代码）'
  const active = Object.entries(busy || {}).filter(([, value]) => value === true).map(([key]) => key)
  if (active.length) return `有任务在运行（${active.join(' / ')}），结束之后再升级`
  return ''
}

/** 从升级进程输出里认出结果，给界面一句人话。 */
export function summarizeUpgrade({ code, output = '', timedOut = false, latest = '' } = {}) {
  const text = String(output || '')
  if (timedOut) return { ok: false, code: 'TIMEOUT', message: '升级超时（可能网络慢），请查看日志；已安装的版本没有被删除' }
  const clean = text.replace(/\[[-=]{4,}\]/g, '').trim()
  const tail = clean.split(/\r?\n/).filter(Boolean).slice(-6).join(' / ').slice(0, 400)
  if (code === 0) return { ok: true, code: 'DONE', message: `已安装${latest ? ' ' + latest : '新版本'}；完全重启 DSH 后生效`, tail }
  const known = [
    [/E404|404 Not Found/i, 'registry 上找不到这个版本（可能还没发布成功）'],
    [/E401|E403|ENEEDAUTH|Unauthorized/i, '没有发布/读取权限，检查 npm 登录状态'],
    [/EBUSY|EPERM|EACCES/i, '文件被占用（通常是 DSH 还在用旧文件）；完全退出 DSH 后重试'],
    [/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network/i, '网络连不上 registry，可换镜像或稍后再试'],
    [/EINTEGRITY|integrity/i, '包完整性校验失败，可能被镜像缓存污染，清缓存后重试'],
  ]
  for (const [pattern, message] of known) if (pattern.test(clean)) return { ok: false, code: 'FAILED', message, tail }
  return { ok: false, code: 'FAILED', message: `升级没有成功（退出码 ${code}）${tail ? '：' + tail : ''}`, tail }
}

/** 把 npm 退出码/输出整理成可读日志，供界面与 duty.log 共用。 */
export function upgradeLogLine({ phase, at = Date.now(), detail = '' } = {}) {
  const stamp = new Date(num(at, Date.now())).toISOString()
  return `${stamp} [update:${phase}] ${String(detail).slice(0, 2000)}`
}

/** 目录是否像一份完整安装（用于升级后自检，避免把半截目录当成功）。 */
export function looksLikeInstall(dir) {
  try {
    if (!statSync(dir).isDirectory()) return false
    return ['package.json', 'index.js', 'client.js', 'selfcheck.mjs'].every((name) => existsSync(join(dir, name)))
  } catch { return false }
}
