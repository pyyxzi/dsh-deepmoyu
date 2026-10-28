/**
 * lib/tokens.mjs —— 每轮任务的 token 账本（2026-10-27）
 * ============================================================================
 * 它记什么：**每一次"刷B站的任务"从开跑到收工烧了多少 token**，一条一条记账：
 *   · 鲸鱼摸鱼会话（goal）—— token 从宿主 dsh-token-meter 投影读得到 ⇒ **精确计量**；
 *   · 后台轮 / 学习审核（headless 子进程）—— 那是另一个 dsh 进程，宿主看不到它的计量
 *     ⇒ 记 `tokensUnknown: true`，界面如实写「未计量」，**绝不编一个数**。
 *
 * 为什么单独一个文件、不塞进 state.json：state.json 是节奏/判重/累计那本"总账"，
 * 被 mirror + 多个写入方盯着；这本是"流水明细"，裁剪策略完全不同（只留最近 N 条）。
 * `tokensTotal`（总闸的口径）仍由 index.js 的 agent/status 增量记账维护 —— 那里记**增量**，
 * 这里记**每个任务各自的累计**，两边互不抄数，也互不依赖。
 *
 * 写入纪律（跟 record-storage 同一条）：
 *   · 全部走 `withFileLockSync`（多窗口/热重载会有两个宿主实例同时写）；
 *   · 任何失败**不外抛**——账本缺一笔不影响刷B站，调用方各自 try/catch 记日志。
 * ============================================================================
 */
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteFileSync, readJsonFileSync, withFileLockSync } from './record-storage.mjs'

/** 账本文件名（相对插件家目录） */
export const TOKEN_LEDGER_NAME = 'token-ledger.json'
/** 只留最近多少条任务（再多界面也看不完，白占磁盘） */
export const TOKEN_LEDGER_MAX = 120

const ledgerFileOf = (stateDir) => join(stateDir, TOKEN_LEDGER_NAME)

/** 读整本账（文件不存在/坏了 ⇒ 空账，不抛） */
export function readTokenLedger(stateDir) {
  try {
    const v = readJsonFileSync(ledgerFileOf(stateDir), null)
    if (v && typeof v === 'object' && Array.isArray(v.entries)) {
      return { version: 1, entries: v.entries.filter((e) => e && typeof e === 'object'), updatedAt: String(v.updatedAt || '') }
    }
  } catch { /* 坏账当空账 —— 写侧还有 STATE_JSON_INVALID 那道闸兜底 */ }
  return { version: 1, entries: [], updatedAt: '' }
}

const sanitizeTokens = (t) => {
  if (!t || typeof t !== 'object') return null
  const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0)
  const input = num(t.input)
  const output = num(t.output)
  const total = Number.isFinite(Number(t.total)) && Number(t.total) > 0
    ? num(t.total)
    : input + output
  return { input, output, total }
}

const sanitizeEntry = (e) => {
  if (!e || typeof e !== 'object') return null
  const out = {
    id: String(e.id || '').slice(0, 80) || `tok-${Date.now()}-${randomUUID().slice(0, 6)}`,
    kind: e.kind === 'session' ? 'session' : 'background',
    label: String(e.label || '').slice(0, 60),
    model: String(e.model || '').slice(0, 160),
    budget: Number.isFinite(Number(e.budget)) ? Math.max(0, Math.round(Number(e.budget))) : 0,
    maxRounds: Number.isFinite(Number(e.maxRounds)) ? Math.max(0, Math.round(Number(e.maxRounds))) : 0,
    startedAt: String(e.startedAt || new Date().toISOString()),
    endedAt: String(e.endedAt || ''),
    durationSec: Number.isFinite(Number(e.durationSec)) ? Math.max(0, Math.round(Number(e.durationSec))) : 0,
    rounds: Number.isFinite(Number(e.rounds)) ? Math.max(0, Math.round(Number(e.rounds))) : 0,
    tokens: sanitizeTokens(e.tokens),
    tokensUnknown: Boolean(e.tokensUnknown),
    unknownRequests: Number.isFinite(Number(e.unknownRequests)) ? Math.max(0, Math.round(Number(e.unknownRequests))) : 0,
    stopReason: String(e.stopReason || '').slice(0, 40),
    code: e.code === null || e.code === undefined ? null : Number(e.code),
    why: String(e.why || '').slice(0, 60),
    adopted: Boolean(e.adopted),
  }
  if (out.tokensUnknown) out.tokens = null
  return out
}

/** 每次落盘前的统一收尾：按 startedAt 排序、裁掉超限的旧条目 */
const compact = (entries) => entries
  .filter((e) => e && typeof e === 'object')
  .sort((a, b) => (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0))
  .slice(-TOKEN_LEDGER_MAX)

const withLedger = (stateDir, fn, fallback = null) => {
  try {
    return withFileLockSync(ledgerFileOf(stateDir), () => {
      const book = readTokenLedger(stateDir)
      const next = fn(book)
      if (!next) return fallback
      const entries = compact(next.entries.map((e) => sanitizeEntry(e)).filter(Boolean))
      atomicWriteFileSync(ledgerFileOf(stateDir), JSON.stringify({ version: 1, entries, updatedAt: new Date().toISOString() }, null, 2))
      return fallback === undefined ? entries : fallback
    })
  } catch { return fallback }
}

/**
 * 开一条新任务。返回建立好的条目（含 id —— 调用方把它存进内存态，后面 update/end 都靠它）。
 * @param spec {kind:'session'|'background', label, model, budget, maxRounds, why, adopted}
 */
export function tokenTaskStart(stateDir, spec = {}) {
  const id = `tok-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
  const entry = sanitizeEntry({
    id,
    kind: spec.kind,
    label: spec.label,
    model: spec.model,
    budget: spec.budget,
    maxRounds: spec.maxRounds,
    startedAt: String(spec.startedAt || new Date().toISOString()),
    why: spec.why,
    adopted: spec.adopted,
    tokens: null,
    tokensUnknown: spec.tokensUnknown === true || spec.kind !== 'session',
  })
  const saved = withLedger(stateDir, (book) => ({ entries: [...book.entries.filter((e) => e.id !== id), entry] }), entry)
  return saved || entry
}

/** 任务进行中的增量更新（rounds / tokens）。找不到这条任务就安静忽略。 */
export function tokenTaskUpdate(stateDir, id, patch = {}) {
  if (!id) return null
  return withLedger(stateDir, (book) => {
    const at = book.entries.findIndex((e) => e.id === id)
    if (at < 0) return null
    const cur = book.entries[at]
    const next = { ...cur }
    if (patch.rounds !== undefined && Number.isFinite(Number(patch.rounds))) next.rounds = Math.max(0, Math.round(Number(patch.rounds)))
    const tok = sanitizeTokens(patch.tokens)
    if (tok && (!next.tokensUnknown || patch.measured === true)) { next.tokens = tok; next.tokensUnknown = false }
    if (patch.unknownRequests !== undefined) next.unknownRequests = Math.max(0, Math.round(Number(patch.unknownRequests) || 0))
    const entries = book.entries.slice()
    entries[at] = next
    return { entries }
  })
}

/**
 * 收账（任务结束）。
 * 幂等语义：**数据字段（endedAt/durationSec/rounds/tokens）以第一次收账为准**，
 * 之后再收只更新 `stopReason` / `code` —— stop→clear 连着收时，账不会被第二轮重写
 * （feiyuStop 先收、feiyuClear 再收，两边的 rounds 都来自同一个 goal，谁先到谁定数）。
 * 例外：后台任务开户时标了 `tokensUnknown`，第一次收账若带来了**真测到的** tokens
 * （子进程信标对账成功），就把「未计量」翻成真数 —— 有据可查的数永远比诚实占位更好。
 * @param patch {stopReason, endedAt, durationSec, rounds, tokens, code}
 */
export function tokenTaskEnd(stateDir, id, patch = {}) {
  if (!id) return null
  return withLedger(stateDir, (book) => {
    const at = book.entries.findIndex((e) => e.id === id)
    if (at < 0) return null
    const cur = book.entries[at]
    const first = !cur.endedAt
    const next = { ...cur }
    if (first) {
      next.endedAt = String(patch.endedAt || new Date().toISOString())
      const startMs = Date.parse(cur.startedAt) || 0
      const endMs = Date.parse(next.endedAt) || Date.now()
      next.durationSec = Math.max(0, Math.round((endMs - startMs) / 1000))
    }
    if (patch.stopReason !== undefined) next.stopReason = String(patch.stopReason || '').slice(0, 40) || cur.stopReason
    if (patch.code !== undefined) next.code = patch.code === null ? null : Number(patch.code)
    if (first && patch.rounds !== undefined && Number.isFinite(Number(patch.rounds))) next.rounds = Math.max(0, Math.round(Number(patch.rounds)))
    const tok = sanitizeTokens(patch.tokens)
    if (first && tok) {
      next.tokens = tok
      next.tokensUnknown = false   // 信标对上账 ⇒「未计量」撤销（没有数的时候这里根本不会被调）
    }
    if (first && patch.unknownRequests !== undefined) next.unknownRequests = Math.max(0, Math.round(Number(patch.unknownRequests) || 0))
    if (!next.label && patch.label) next.label = String(patch.label).slice(0, 60)
    const entries = book.entries.slice()
    entries[at] = next
    return { entries }
  })
}

/** 清空明细（「总 token 清零」按钮一起清的就是它；上限不动） */
export function clearTokenLedger(stateDir) {
  withLedger(stateDir, () => ({ entries: [] }), true)
}

/**
 * 给界面/工具看的快照：最新在前的条目 + 几个派生读数。
 * `measuredSums` 是"看得见的这 N 条里计了量的总和"——只用于展示，
 * 总闸口径永远以 state.json 的 tokensTotal 为准（那边是全量增量记账）。
 */
export function tokenLedgerSnapshot(stateDir, { limit = 40 } = {}) {
  const book = readTokenLedger(stateDir)
  const entries = book.entries.slice(-Math.max(1, Math.min(200, Math.floor(Number(limit) || 40)))).reverse()
  const sums = { tasks: 0, input: 0, output: 0, total: 0, unknown: 0, partial: 0, unknownRequests: 0 }
  for (const e of entries) {
    sums.unknownRequests += Number(e.unknownRequests) || 0
    if (e.tokensUnknown || !e.tokens) { sums.unknown += 1; continue }
    if (Number(e.unknownRequests) > 0) sums.partial += 1
    sums.tasks += 1
    sums.input += e.tokens.input || 0
    sums.output += e.tokens.output || 0
    sums.total += e.tokens.total || 0
  }
  return { ok: true, entries, sums }
}

/** 每类任务的人话标签（client 侧也有一份兜底；这里给 petLog / 工具回执用） */
export function tokenTaskLabel(kind, why = '') {
  if (kind === 'session') return '鲸鱼摸鱼会话'
  if (/^(?:review|learn-review)/.test(String(why))) return '学习审核'
  if (why === 'schedule') return '定时后台轮'
  if (String(why).startsWith('window:')) return '谷时后台轮'
  if (String(why).startsWith('pet')) return '桌宠后台轮'
  if (why === 'manual') return '手动后台轮'
  return '后台刷一轮'
}
