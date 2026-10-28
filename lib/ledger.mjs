/**
 * lib/ledger.mjs —— 视频判重账本（纯函数，不碰网络、不碰磁盘、零依赖）
 * ================================================================================================
 * 为什么单独抽一个文件：同一套「什么算同一个视频」的规矩被三处用到 ——
 *   ① 发现流（推荐/搜索/热门/关注）给每条视频打「看过」标记；
 *   ② 评论成功、读到字幕之后把这条视频记进账本；
 *   ③ bili_seen 工具按 BV 号查单条。
 * 三处各写一遍迟早会漂移（一处认链接一处不认），所以收成一个纯函数模块：
 * 传进来「账本 + 若干行」，吐出去「新账本 / 打了标记的行」，函数自己不去读 state.json。
 *
 * 账本形状（存在 state.json 的 seenVideos 字段里）：
 *   { "BV1pMJv6WEmr": { at: "2026-10-20T01:00:00.000Z", note: "跳过：无字幕" } }
 *   · at   —— 第一次记下这条视频的时间，用来判「今天看了几条」和超上限时砍最早；
 *   · note —— 最近一次记它的原因（读过字幕 / 回过评论 / 手动补记），排查时看得懂。
 *
 * ⚠️ 只拿 BV 号当 key。同一个视频在不同入口会以 bvid / 完整链接 / 分享短链三种样子出现，
 *    不先归一化就会重复记账，所以所有入口都先过 bvidOf()。
 */

import { redactRecordText } from './record-privacy.mjs'

/** 账本最多留多少条 —— 超了按 at 砍最早的。
 *  5000 条约 0.5MB JSON，够一年正常使用；再多只会在 state.json 里堆垃圾，
 *  而且判重是 O(1) 查表，条数对速度没影响，纯粹是别让状态文件无限长。 */
export const SEEN_MAX = 5000

/** BV 号：BV + 10 位字母数字（现行 12 字符）。大小写都算，但不接受全小写前缀 ——
 *  小写 bv 是别的平台/手打串号，混进来只会让账本变脏。 */
const BV_RE = /^BV[0-9A-Za-z]{10}$/

/** 从一坨文本里抠 BV 号（链接、分享文案都适用）。 */
const BV_IN_TEXT = /(?<![0-9A-Za-z])BV[0-9A-Za-z]{10}(?![0-9A-Za-z])/

/** Only valid own keys count as seen videos; corrupted metadata cannot inflate totals. */
const normalizeLedger = (ledger) => {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) return {}
  return Object.fromEntries(Object.entries(ledger).filter(([key, value]) => BV_RE.test(key) && entryOf(value)))
}

/** 取一条账本记录。老版本把值直接存成备注字符串，这里顺手兼容一下，别让它变成"没记过"。 */
const entryOf = (value) => {
  if (typeof value === 'string') return value ? { at: '', note: value } : null
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  return null
}

/** 本地日历日 YYYY-MM-DD。用本地时区而不是 UTC —— 「今天看了几条」是给人看的，得按人的钟算。 */
const dayKey = (value) => {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 排序用的时间戳：拿不到 at 的老记录当成「最新」。
 *  ⚠️ 宁可多留一条也不误删 —— 没有时间戳只说明它来自早期版本，不代表它旧。 */
const atOf = (entry) => {
  const rec = entryOf(entry)
  return rec && typeof rec.at === 'string' && rec.at ? rec.at : '9999-12-31T23:59:59.999Z'
}

/** 超上限时按 at 从旧到新砍，保留顺序沿用原账本（不要按时间重排，免得每次写盘都抖动）。 */
const trimLedger = (book) => {
  const keys = Object.keys(book)
  if (keys.length <= SEEN_MAX) return book
  const ordered = keys
    .map((key) => ({ key, at: atOf(book[key]) }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  const keep = new Set(ordered.slice(ordered.length - SEEN_MAX).map((x) => x.key))
  const out = {}
  for (const key of keys) if (keep.has(key)) out[key] = book[key]
  return out
}

/**
 * 这个字符串是不是合法 BV 号。
 * 用途：bili_seen 工具的参数校验、账本记账前的闸门 —— 脏 key 一旦进账本，之后每次读都得带着它。
 */
export const isBvid = (value) => typeof value === 'string' && BV_RE.test(value.trim())

/**
 * 从一行里取出 BV 号，取不到返回空串。
 * 调用点会直接 rows.map(bvidOf) 这样传，所以**不能依赖第二个参数**（那是数组下标）。
 * 认的顺序：行里自带的 bvid（MCP 后端返回的就是这个字段）→ 各种链接字段里抠 → 放弃。
 */
export const bvidOf = (row) => {
  if (typeof row === 'string') {
    const hit = row.match(BV_IN_TEXT)
    return hit ? hit[0] : ''
  }
  if (!row || typeof row !== 'object') return ''
  const direct = typeof row.bvid === 'string' ? row.bvid.trim() : ''
  if (BV_RE.test(direct)) return direct
  for (const key of ['uri', 'url', 'arcurl', 'link', 'short_link', 'share_url', 'jump_url']) {
    const value = row[key]
    if (typeof value === 'string') {
      const hit = value.match(BV_IN_TEXT)
      if (hit) return hit[0]
    }
  }
  return ''
}

/**
 * 给一批行打上判重标记。
 * 入参 ledger 允许是空/脏（宿主会把 seenMap() 和永久账本直接展开进来），一律当空账本处理。
 * 返回：
 *   items      —— 原字段全保留，额外加 bvid / already_seen / seen_at / seen_note；
 *   fresh      —— 没看过的那些行（宿主拿它做「这次给你推的新货」）；
 *   seenCount  —— 看过几条；freshCount —— 没看过几条。
 * ⚠️ 不修改入参行：宿主手里的 raw 还要拿去渲染，就地加字段会污染上游。
 */
export const markSeen = (rows, ledger) => {
  const book = normalizeLedger(ledger)
  const items = []
  const fresh = []
  let seenCount = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    const bvid = bvidOf(row)
    const hit = bvid ? entryOf(book[bvid]) : null
    const already = Boolean(hit)
    const item = {
      ...(row && typeof row === 'object' && !Array.isArray(row) ? row : {}),
      bvid,
      already_seen: already,
      seen_at: (hit && hit.at) || '',
      seen_note: (hit && hit.note) || '',
    }
    items.push(item)
    if (already) seenCount += 1
    else fresh.push(item)
  }
  return { items, seenCount, freshCount: fresh.length, fresh }
}

/**
 * 记一条视频，返回**新账本**（不改入参，宿主用 seenSave(current => ...) 的写法）。
 * 两条容易踩的规矩：
 *   · at 记「第一次见到它」的时间 —— 重复记账不刷新，否则「今天看了几条」会一直虚高；
 *   · note 记「最近一次为什么记它」 —— 后写的覆盖前面的，排查时看到的是最新原因。
 * 非法 BV 直接原样返回副本：调用方可以无脑把返回值存回去，不用先自己校验。
 */
const rememberInto = (book, bvid, patch, now) => {
  const id = typeof bvid === 'string' ? bvid.trim() : ''
  if (!isBvid(id)) return
  const prev = entryOf(book[id]) || {}
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  const first = typeof prev.at === 'string' && Number.isFinite(new Date(prev.at).getTime()) ? prev.at : ''
  const incoming = typeof p.at === 'string' && Number.isFinite(new Date(p.at).getTime()) ? new Date(p.at).toISOString() : ''
  const at = first || incoming || now
  const note = redactRecordText(p.note === undefined ? prev.note || '' : p.note, { maxLength: 240 })
  book[id] = { ...prev, at, note, ...(p.source ? { source: redactRecordText(p.source, { maxLength: 120 }) } : {}), ...(p.eventId ? { eventId: redactRecordText(p.eventId, { maxLength: 80 }) } : {}) }
}

export const seenRemember = (ledger, bvid, patch = {}) => {
  const book = { ...normalizeLedger(ledger) }
  rememberInto(book, bvid, patch, new Date().toISOString())
  return trimLedger(book)
}

/** 批量记账：归一化和裁剪各一次，不随批量大小反复复制整本账。 */
export const seenRememberMany = (ledger, list, patch = {}) => {
  const book = { ...normalizeLedger(ledger) }
  const now = new Date().toISOString()
  for (const bvid of Array.isArray(list) ? list : []) rememberInto(book, bvid, patch, now)
  return trimLedger(book)
}

/**
 * 账本统计：总数、今天新增、最后一条时间。
 * today 按本地日历日算（跨时区/跨零点时人看到的才是"今天"）；
 * lastAt 取最晚的 at，取不到就是空串 —— 调用方直接拼进提示语，别给 null。
 */
export const seenStats = (ledger) => {
  const book = normalizeLedger(ledger)
  const keys = Object.keys(book)
  const today = dayKey(new Date())
  let todayCount = 0
  let lastAt = ''
  for (const key of keys) {
    const rec = entryOf(book[key])
    const at = rec && typeof rec.at === 'string' ? rec.at : ''
    if (!at) continue
    const day = dayKey(at)
    if (!day) continue
    if (day === today) todayCount += 1
    if (!lastAt || new Date(at).getTime() > new Date(lastAt).getTime()) lastAt = at
  }
  return { total: keys.length, today: todayCount, lastAt }
}
