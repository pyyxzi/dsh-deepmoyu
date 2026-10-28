/**
 * lib/state.mjs —— 插件的"家"与配置
 * ============================================================================
 * 规矩（抄 whale_craft）：**配置、凭证、报告、日志都放插件自己的家** ——
 * `$DSH_HOME/bili-duty/`，**绝不写进插件包目录**（装进 node_modules 后可能只读、升级也会被覆盖）。
 *
 * 还有一件小事但很要紧：vendored 的 `mcp_server.py` 里，凭证路径是
 * `Path(__file__).parent / "bili_credential.json"` —— 所以**运行时要把脚本拷到家目录里再跑**，
 * 这样凭证才会落在家的目录，而不是插件包里。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { atomicWriteFileSync, readJsonFileSync } from './record-storage.mjs'

/**
 * 谷时窗口（北京时间）—— 想改就改这一处。
 * ⭐ 官方口径（2026-09-10 起的新定价）：**高峰 = 工作日 9:00–12:00 与 14:00–18:00，其余全是谷时**
 *    ⇒ 12:00–14:00（夹在两个高峰之间）✓、18:00 之后的一整晚 ✓、以及**整个周末** ✓ 都便宜。
 * ⚠️ 我们原来写的 00:30–08:30 是 DeepSeek **早年**的错峰优惠时段，**已经过时** ✗
 *    —— 2026-10-14 使用者在"陌生人验收"里问「晚上峰谷真的是12点半才开始的吗」才查出来 ✓。
 */
export const WINDOWS = {
  noon: { label: '中午谷时', start: '12:00', end: '14:00' },
  night: { label: '晚上/夜间谷时', start: '18:00', end: '09:00' },
}

/**
 * ⭐ 2026-10-14 真机上踩到的坑（dsh 只留一句 `warning: 1 entry did not activate` + 堆栈）：
 *    `ctx.get('dshHomePath')` 返回的是**函数**，不是字符串！
 *    形状：`dshHomePath(...segments) => join(resolveDshHome(), ...segments)`（whale_craft 就是这么用的）。
 *    我一开始当字符串用（`String(p)`），路径就成了「函数源码 + \bili-duty」⇒ mkdir ENOENT ⇒ apply 抛错 ⇒ 插件不激活。
 */
export function stateDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('bili-duty')                       // ← 函数形态：把目录名传进去
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'bili-duty')
    }
  } catch { /* 拿不到就用下面的兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-duty')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (e) {
    // ⭐ 2026-10-26：损坏 ≠ 不存在 —— 读侧仍按 fallback 走（不让插件整个趴下），
    //   但必须喊出来：写侧（writeJson）这时会持续拒写，账本"看着像被清空"得有这句才查得到原因。
    if (e?.code !== 'ENOENT') {
      try { console.error(`[dsh-deepmoyu] ${file} 解析失败（${e?.message ?? e}）——按空数据处理；写侧会拒绝写入直到修好`) } catch { /* 无处可说就算了 */ }
    }
    return fallback
  }
}

export function writeJson(file, value) {
  // Corrupt history must never become an empty, apparently fresh ledger.
  const existing = readJsonFileSync(file, undefined)
  if (existing !== undefined && (!existing || typeof existing !== 'object' || Array.isArray(existing))) {
    throw new Error('STATE_JSON_INVALID: expected an object')
  }
  atomicWriteFileSync(file, JSON.stringify(value, null, 2))
}

/** 首次运行：把 vendored 的脚本拷进家里（脚本变了就覆盖）。章程不在这里 —— 它走下面的 ensureCharter */
export function ensureHomeFiles(pluginDir, stateDir, log = () => {}) {
  const copies = [
    [join(pluginDir, 'vendor', 'bilibili-mcp', 'mcp_server.py'), join(stateDir, 'mcp_server.py'), true],
    // ⭐ 判重账本（2026-10-21）：mcp_server.py 里 `from runtime_guard import RuntimeGuard`，
    //    而 Python 脚本跑在家目录 ⇒ 这个模块**必须**跟 mcp_server.py 一起铺过去，
    //    否则家目录那份 import 失败、整个 MCP 服务起不来（所有 B站 工具全挂）。
    [join(pluginDir, 'vendor', 'bilibili-mcp', 'runtime_guard.py'), join(stateDir, 'runtime_guard.py'), true],
    [join(pluginDir, 'lib', 'asr.py'), join(stateDir, 'asr.py'), true],
    [join(pluginDir, 'lib', 'favops.py'), join(stateDir, 'favops.py'), true],
    // 🎬 「昨日冲浪报告」视频（2026-10-22）：pv.mjs 起的是**家目录**那两个脚本，
    //    所以它们必须跟 mcp_server.py 一样铺过来；不铺 ⇒ 家目录没有、渲染直接报「脚本没铺好」。
    [join(pluginDir, 'lib', 'pv.py'), join(stateDir, 'pv.py'), true],
    [join(pluginDir, 'lib', 'pv_plan.py'), join(stateDir, 'pv_plan.py'), true],
    [join(pluginDir, 'lib', 'pv_cover.py'), join(stateDir, 'pv_cover.py'), true],
    // 🎙 真·本鱼音色（2026-10-22）：pv.py 用 subprocess 调它跑 GPT-SoVITS 批量合成，
    //    同样必须在家目录里 —— 不然设置页填了音色也会报「找不到 pv_gsv.py」。
    [join(pluginDir, 'lib', 'pv_gsv.py'), join(stateDir, 'pv_gsv.py'), true],
    // 🐟 真·本鱼立绘（2026-10-22）：pv.py 找素材的顺序是 lib/assets/avatar → <home>/assets/avatar，
    //    跑在家目录那份 pv.py 只能看到家目录 ⇒ 立绘必须铺过来，否则永远退回程序化角色。
    [join(pluginDir, 'assets', 'avatar', 'bust.png'), join(stateDir, 'assets', 'avatar', 'bust.png'), true],
    [join(pluginDir, 'assets', 'avatar', 'face.png'), join(stateDir, 'assets', 'avatar', 'face.png'), true],
    [join(pluginDir, 'assets', 'avatar', 'fish.png'), join(stateDir, 'assets', 'avatar', 'fish.png'), true],
  ]
  for (const [from, to, overwrite] of copies) {
    try {
      if (!existsSync(from)) { log(`缺文件：${from}`); continue }
      if (!overwrite && existsSync(to)) continue
      if (overwrite && existsSync(to) && readFileSync(from).equals(readFileSync(to))) continue
      mkdirSync(dirname(to), { recursive: true })
      atomicWriteFileSync(to, readFileSync(from))
      log(`已铺好：${to}`)
    } catch (e) { log(`铺 ${to} 失败：${e?.message ?? e}`) }
  }
}

/**
 * 值班章程（prompts/duty.md）放在哪一份 —— 家里那份优先，没有才用插件里那份。
 * （家里那份由下面的 ensureCharter 保证铺好）
 */
export function charterPath(pluginDir, stateDir) {
  const home = join(stateDir, 'duty.md')
  try { if (existsSync(home)) return home } catch { /* 兜底：用插件里那份 */ }
  return join(pluginDir, 'prompts', 'duty.md')
}

/**
 * ⭐ 值班章程怎么升级 —— 2026-10-17 审查里的 M6 就是这里。
 *    老规矩（index.js 里比 mtime）：家里那份比 shipped 新 ⇒ 听使用者的。听着合理，实际是一把**单向锁**：
 *    使用者只要改过章程一个字，家里那份就永远比 shipped 新 ⇒ 插件后续版本改进的章程
 *    （0.1.5 的注入防护、空输出定义恰好就写在章程里）**永远进不来** ✗。
 *    改成记账制 —— 上次铺的是哪一版（sha256）记在 charter.sha256：
 *      · 家里那份 === 我们上次铺的 ⇒ 他没动过 ⇒ 直接用 shipped 覆盖（升级 ✓）
 *      · 家里那份变过      ⇒ 他改过 ⇒ **一个字都不动**，新版另存 duty.md.new 让他自己合 ✓
 *      · 没有账本（带账本的第一个版本刚跑起来）⇒ 分不清「没改只是版本旧」和「改过」，
 *        按「改过」处理 —— 宁可让他手动合一次，也不能偷偷吃掉他的改动 ✓
 */
export function ensureCharter(pluginDir, stateDir, log = () => {}) {
  const shipped = join(pluginDir, 'prompts', 'duty.md')
  const home = join(stateDir, 'duty.md')
  const ledger = join(stateDir, 'charter.sha256')
  const fresh = join(stateDir, 'duty.md.new')
  const readIf = (f) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
  try {
    if (!existsSync(shipped)) { log(`缺文件：${shipped}`); return }
    const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
    const newText = readFileSync(shipped, 'utf8')
    const hShip = sha(newText)
    const hLast = readIf(ledger).trim()
    if (!existsSync(home)) {
      atomicWriteFileSync(home, newText); atomicWriteFileSync(ledger, hShip)
      log('已铺好值班章程')
      return
    }
    const hHome = sha(readFileSync(home, 'utf8'))
    if (hHome === hShip) {                              // 家里那份就是最新版（他可能只是没动过）
      if (hLast !== hShip) atomicWriteFileSync(ledger, hShip)
      return
    }
    if (!hLast || hHome !== hLast) {                    // 他改过（或没账本、分不清）⇒ 只另存新版
      if (hShip !== hLast && readIf(fresh) !== newText) {
        atomicWriteFileSync(fresh, newText)
        log(`值班章程有新版、但家里那份你改过 ⇒ 新版另存为 ${fresh}，自己合一下`)
      }
      return
    }
    atomicWriteFileSync(home, newText); atomicWriteFileSync(ledger, hShip)   // 他没动过 ⇒ 直接升级
    log('值班章程已更新到插件里这一版')
  } catch (e) { log(`铺值班章程失败：${e?.message ?? e}`) }
}

/** 'HH:MM' → 当天的分钟数 */
function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** 现在在不在这个窗口里（支持跨零点，比如 23:00–02:00） */
export function inWindow(now, win) {
  const start = minutesOf(win.start); const end = minutesOf(win.end)
  if (start === null || end === null) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  return start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end)
}

/** 本地日期 YYYY-MM-DD */
export function dayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

