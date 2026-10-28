/**
 * lib/uvfetch.mjs —— 「机器上连 uv 和 Python 都没有」时，**插件自己把 uv 弄到手**
 * ============================================================================
 * 为什么值得单独做：uv 是**单个可执行文件**（Windows 上 ~32MB 的 uv.exe ✓），
 * **解压就能用、不用管理员、不用进 PATH** ✓，而且它还能自己把 Python 拉下来 ✓
 * ⇒ 只要拿到它，"首次安装"就从「先去装个 Python」变成「点一下就好」✓
 *
 * 两个源，按顺序试：
 *   ① **GitHub 官方 release**（`uv-x86_64-pc-windows-msvc.zip`）—— 有加速器时最快 ✓
 *   ② ⭐ **PyPI 清华镜像的 uv wheel** —— wheel 本身就是个 zip，里面装着 `uv.exe` ✓
 *      （国内速度快、不依赖 GitHub ✓）
 *
 * 解压：优先用 **系统自带的 `tar`**（Windows 10+ 的 bsdtar 能直接读 zip ✓），
 *       再退到 `unzip`；然后**在解压出来的整棵树里按文件名找** ✓
 *       —— 不管官方把它放在哪一层都能找着 ✓
 * ============================================================================
 */
import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, copyFileSync, chmodSync, rmSync, readFileSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const ASSETS = {
  win32: { name: 'uv-x86_64-pc-windows-msvc.zip', bin: 'uv.exe' },
  darwin: { name: 'uv-aarch64-apple-darwin.tar.gz', bin: 'uv' },
  linux: { name: 'uv-x86_64-unknown-linux-gnu.tar.gz', bin: 'uv' },
}

/** 算一个文件的 sha256 */
function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * 取"官方期望的 sha256"（2026-10-26 收紧）：
 *   · PyPI wheel：镜像 JSON 里自带的 `digests.sha256`（拿不到 ⇒ 这个源作废，不再"跳过校验"）
 *   · GitHub 资产：**永远从 GitHub 官方地址**取 `<文件名>.sha256` ——
 *     ⚠️ 不能跟着下载走同一个代理：恶意代理可以把压缩包和校验值一起换掉，
 *     那份"校验"只是给使用者虚假的安全感。取不到官方值 ⇒ 拒绝使用这个源。
 */
async function expectedSha(source, officialUrl) {
  if (source.sha) return String(source.sha).toLowerCase()
  try {
    const r = await fetch(String(officialUrl || source.url) + '.sha256')
    if (!r.ok) return null
    const m = /([0-9a-f]{64})/i.exec(await r.text())
    return m ? m[1].toLowerCase() : null
  } catch { return null }
}

/** 在目录树里按文件名找可执行文件（递归） */
export function findBin(name, dir) {
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { const hit = findBin(name, p); if (hit) return hit }
    else if (e.name === name) return p
  }
  return null
}

/** 解压一个压缩包并找出目标文件（tar 优先 —— Windows 自带那份能读 zip） */
export function extractArchive(binName, archive, into) {
  const attempts = [['tar', ['-xf', archive, '-C', into]], ['unzip', ['-o', archive, '-d', into]]]
  for (const [cmd, args] of attempts) {
    try {
      const r = spawnSync(cmd, args, { stdio: 'ignore' })
      if (r.status === 0) { const hit = findBin(binName, into); if (hit) return hit }
    } catch { /* 换下一个工具 */ }
  }
  return null
}

/**
 * 确保家目录里有一份可用的 uv，返回它的路径（拿不到就返回 null）。
 * @param {{ dir: string, log?: (m: string) => void }} opts
 */
export async function ensureUv({ dir, log = () => {} }) {
  const a = ASSETS[process.platform] || ASSETS.linux
  const target = join(dir, a.bin)
  // ⭐ 2026-10-26：已存在的目标先验一下能不能跑 —— 上次中断/被 AV 拦下的半截文件不该永远被当可用
  if (existsSync(target)) {
    let runnable = false
    try { const r = spawnSync(target, ['--version'], { stdio: 'ignore', timeout: 15_000 }); runnable = r.status === 0 } catch { runnable = false }
    if (runnable) return target
    log('  → 家里已有的 uv 跑不起来（上次没下完？被安全软件动过？）⇒ 重新弄一份')
    try { rmSync(target, { force: true }) } catch { /* 删不掉就走下面的覆盖 */ }
  }

  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, '_tmp')
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })

  // 源按顺序试：直连 → 两个国内能用的 GitHub 加速代理（2026-10-14 实测这两条能出真 zip ✓）
  //          → 最后兜底是 PyPI 镜像上的 uv wheel（⚠️ 那个停在 0.2.33/2024-08，能用但不是最新 ✗）
  const asset = `https://github.com/astral-sh/uv/releases/latest/download/${a.name}`
  const sources = [
    { label: 'GitHub 直连', url: asset, file: join(tmp, a.name) },
    { label: 'GitHub 加速代理 gh-proxy.com', url: `https://gh-proxy.com/${asset}`, file: join(tmp, a.name), official: asset },
    { label: 'GitHub 加速代理 ghproxy.net', url: `https://ghproxy.net/${asset}`, file: join(tmp, a.name), official: asset },
  ]
  if (process.platform === 'win32') {
    try {
      const r = await fetch('https://pypi.tuna.tsinghua.edu.cn/pypi/uv/json')
      const j = await r.json()
      // ⚠️ PyPI 的 urls 顺序**不保证最新在前** ⇒ 必须按版本号自己排序挑最新（踩过：取到了 0.2.33 的老版本 ✗）
      const verOf = (name) => { const m = /-(\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.]+)?)-py3-none-win_amd64\.whl$/.exec(String(name)); return m ? m[1] : '0.0.0' }
      const cmpVer = (a, b) => {
        const A = verOf(a).split(/[.-]/).map(Number), B = verOf(b).split(/[.-]/).map(Number)
        for (let i = 0; i < 4; i++) { if ((A[i] || 0) !== (B[i] || 0)) return (B[i] || 0) - (A[i] || 0) }
        return 0
      }
      const w = (j.urls || [])
        .filter((u) => /win_amd64\.whl$/.test(String(u.filename)))
        .sort((x, y) => cmpVer(x.filename, y.filename))[0]
      // ⭐ 2026-10-26：镜像 JSON 里的文件名要消毒后再拼路径（`..\x` / 绝对分量不能进 tmp），
      //    且必须自带 sha256 —— 没有 digest 的源直接不用（fail closed，见下面的校验段）
      if (w?.url && /^[\w.-]+$/.test(String(w.filename)) && w.digests?.sha256) {
        sources.push({ label: 'PyPI 清华镜像（uv wheel）', url: w.url, file: join(tmp, String(w.filename)), sha: w.digests.sha256 })
        log(`  （备选源已就绪：${w.filename}）`)
      }
    } catch (e) {
      log(`  列 PyPI 版本时出错（不影响，继续试别的源）：${e?.message ?? e}`)
    }
  }

  for (const s of sources) {
    try {
      log(`正在下载 uv —— ${s.label}`)
      const res = await fetch(s.url)
      if (!res.ok) { log(`  → 返回 ${res.status}，换下一个源`); continue }
      await pipeline(Readable.fromWeb(res.body), createWriteStream(s.file))
      const mb = (statSync(s.file).size / 1048576).toFixed(1)
      log(`  → 下载完成 ${mb} MB`)
      // ⭐ 完整性校验：下载下来是要**被执行**的，必须跟官方 sha256 对上（防的是第三方代理动过包 ✗）
      //   2026-10-26 起从"拿不到就算了"改成 **fail closed**：拿不到官方校验值 ⇒ 这个源作废，
      //   绝不执行未校验的二进制（uv 会拉起整个 Python venv，投毒等于完整 RCE 链）。
      const want = await expectedSha(s, s.official || asset)
      if (!want) {
        log('  → 拿不到官方 sha256 ⇒ 拒绝使用这个源（不执行未校验的二进制）')
        continue
      }
      const gotSha = sha256Of(s.file)
      if (gotSha !== want) {
        log(`  → ⚠️ sha256 校验不过（期望 ${want.slice(0, 12)}… 实际 ${gotSha.slice(0, 12)}…）⇒ 丢弃这个源`)
        continue
      }
      log('  → 官方 sha256 校验通过 ✓')
      log('  → 开始解压')
      const hit = extractArchive(a.bin, s.file, tmp)
      if (!hit) { log('  → 解压后没找到可执行文件，换下一个源'); continue }
      // ⭐ 原子落盘（2026-10-26）：直接 copyFileSync 被中断会留半截 uv.exe，
      //    下次启动 `existsSync(target)` 又把它当好的（上面的可跑检查只能兜住一部分）
      const staging = `${target}.staging`
      copyFileSync(hit, staging)
      try { chmodSync(staging, 0o755) } catch { /* Windows 上不需要 */ }
      renameSync(staging, target)
      try {
        const r = spawnSync(target, ['--version'], { stdio: 'ignore', timeout: 15_000 })
        if (r.status !== 0) { log('  → 下载的 uv 跑不起来 ✗（校验过了但执行失败——多半是安全软件拦了）'); continue }
        log('  → 版本检查：能跑 ✓')
      } catch { /* 跑不起来也别拦着，后面自己会报错 */ }
      rmSync(tmp, { recursive: true, force: true })
      log(`  → uv 已就位：${target}`)
      return target
    } catch (e) {
      log(`  → ${s.label} 失败：${e?.message ?? e}`)
    }
  }

  rmSync(tmp, { recursive: true, force: true })
  log('所有源都没拿到**通过官方校验**的 uv（网络到不了 GitHub / PyPI 镜像，或代理给的包校验不过）。'
    + '可以手动下载 uv 放进上面那个目录，或先在机器上装好 uv 再点安装。')
  return null
}
