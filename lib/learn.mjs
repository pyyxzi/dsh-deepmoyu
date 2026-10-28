/**
 * lib/learn.mjs —— 「鲸鱼摸鱼的自主学习」：从 B站 现场学到东西，**先进待审队列，批准后才影响行为**
 * ============================================================================
 * 2026-10-21 使用者第 2 条要求（原话）：
 *   「参考一下这个插件 https://github.com/NickCharlie/astrbot_plugin_self_learning，
 *     把他写成适配鲸鱼摸鱼的，提高鲸鱼摸鱼的自主学习能力」
 *
 * ── 从那个参考项目抄的**核心思路**（不是抄代码，是抄判断）──────────────────
 *   1. **学到的先进审查队列，批准了才注入**。这是「自主学习」和「自己乱改人格」的分界线。
 *      不加这道闸，她学歪一次就永久歪了，而且没人知道是哪一轮学的。
 *   2. **风格用"例句"而不是抽象描述**。few-shot 永远比「你要活泼一点」这种话管用。
 *   3. **黑话要"统计预筛 → 判含义 → 注入解释"三段**，不能见到新词就当黑话学。
 *   4. **量化好感 / 记来源**：每条学习都带 `from`（哪个 BV / 哪条评论），
 *      这样以后能回答「你凭啥这么说话」，也能一键忘掉某个来源学到的东西。
 *   5. **可回滚**：`forget` 能删，`list` 能看全量。
 *
 * ── 鲸鱼摸鱼这边"学习"到底学什么（适配，不是照搬）─────────────────────────
 *   参考项目学的是 QQ 群聊：对话风格、群黑话、社交关系。
 *   鲸鱼摸鱼没有群，它的现场是 B站 的**视频和评论区**，所以换成：
 *     · `style`  说话方式 —— 从真人热评里学「怎么讲人话」（学方法，不抄原句）
 *     · `jargon` 黑话/梗  —— 从视频标签、热词、评论区高频词里学「这个圈子在说什么」
 *     · `fact`   场子常识 —— 从字幕里学「这个 UP 主/这个系列是什么来头」
 *     · `voice`  自己踩的坑 —— 发了评论没人理 / 被风控 / 被打回，记下来当反面教材
 *
 * ── 不变量（改之前必读）────────────────────────────────────────────────
 *   · **纯函数**，不碰网络不碰磁盘（读写全由 index.js 负责）。
 *   · **绝不自动批准**：`learnAdd` 只能进 `pending`。批准是使用者（或她自己在复核时）显式做的。
 *   · **去重按内容指纹**：同一句话从两个视频学来只算一条（不然队列会被"依旧""笑死"塞满）。
 *   · **上限**：待审最多 200 条，批准的按类别各留最近 120 条 —— 提示词是稀缺资源，
 *     学 500 条风格例句塞进系统提示词，等于什么都没学（还会把人格挤掉）。
 *   · 返回给模型的字符串里不许出现 `undefined` / `NaN`。
 */

import { createHash } from 'node:crypto'
import { redactRecordText } from './record-privacy.mjs'

/** 待审队列最多压多少条（满时明确拒绝新增，保留已有待审证据） */
export const LEARN_PENDING_MAX = 200
/** 每类「已批准」最多留多少条（会进提示词，宁少勿多） */
export const LEARN_APPROVED_MAX = 120
/** 「已拒绝」最多留多少条（2026-10-26：不进提示词、以前也没有淘汰 ⇒ state.json 里无界增长；
 *  超过就丢最旧的拒绝记录——它们只剩"别再学这条"的对账价值） */
export const LEARN_REJECTED_MAX = 400

/** 四类学习（顺序=提示词里的展示顺序） */
export const LEARN_KINDS = ['style', 'jargon', 'fact', 'voice']

/** 给人看的中文名 */
export const LEARN_KIND_LABEL = {
  style: '说话方式',
  jargon: '黑话/梗',
  fact: '场子常识',
  voice: '踩过的坑',
}

/**
 * 学习内容的一条记录长这样（全部字段都有默认值，缺了也不许炸）：
 * {
 *   id: string,          // 内容指纹（去重用），形如 `style:3f2a1b`
 *   kind: 'style',       // 四类之一
 *   text: string,        // 学到的东西（一句话，≤160 字）
 *   example: string,     // 例句（style/jargon 尤其重要：学口气不抄句子，所以标"参考"）
 *   from: string,        // 来源：'BV1xxxxxxxxx' / '热词' / '第 12 轮'
 *   at: string,          // ISO 时间
 *   state: 'pending' | 'approved' | 'rejected',
 *   decidedAt: string,   // 批准/拒绝的时间
 *   why: string,         // 批准/拒绝的理由（使用者写的，留个痕）
 *   hits: number,        // 被注入过几次（用于"这条到底有没用"）
 * }
 */

/** 简单稳定 hash（FNV-1a 32 位）—— 只用于去重指纹，不需要抗碰撞 */
const hash32 = (s) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 归一化文本：去掉多余空白、统一大小写视角（中文不受影响，英文标签有用） */
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** 内容指纹：类别 + 归一化正文（例句不参与，不然同一个说法换个例子就重复了） */
export const learnId = (kind, text) => `${String(kind || 'style')}:${hash32(norm(text).toLowerCase())}`

/** 账本的形状兜底（写坏了当空的用，绝不抛错） */
export const asBook = (ledger) => (ledger && typeof ledger === 'object' && !Array.isArray(ledger) ? ledger : {})

/**
 * 加一条学习（**只进 pending**，绝不自动批准）
 * @param ledger 现有账本 `{ items: {id: rec}, ... }`
 * @param rec    `{kind, text, example?, from?, at?}`
 * @returns {{ledger: object, added: boolean, reason: string, id: string}}
 */
const validAt = (v) => { const d = new Date(v); return v && Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString() }
const safeText = (v, n) => norm(redactRecordText(v, { maxLength: n * 4 })).slice(0, n)
const digest = (v) => createHash('sha256').update(String(v)).digest('hex')
const sourcesOf = (rec) => [...new Set([...(Array.isArray(rec?.sources) ? rec.sources.map((s) => typeof s === 'string' ? s : s?.from) : []), ...String(rec?.from || '').split(' · ')].map((s) => safeText(s, 120)).filter(Boolean))].slice(0, 20)
const reviseBook = (book, items, action, id, details, at) => {
  const revision = (Number.isSafeInteger(book.revision) && book.revision >= 0 ? book.revision : 0) + 1
  const auditEvent = { action, id, at, revision, ...details }
  auditEvent.eventId = digest(JSON.stringify(auditEvent))
  const history = [...(Array.isArray(book.history) ? book.history : []).slice(-499), auditEvent]
  return { ledger: { ...book, schema: 2, items, updatedAt: at, revision, history }, auditEvent }
}

export const learnAdd = (ledger, rec = {}) => {
  const book = asBook(ledger)
  const items = asBook(book.items)
  const input = asBook(rec)
  const kind = LEARN_KINDS.includes(input.kind) ? input.kind : 'style'
  const text = safeText(input.text, 160)
  if (!text) return { ledger: book, added: false, reason: '内容是空的', id: '' }
  const base = learnId(kind, text)
  const same = Object.values(items).find((x) => x && x.kind === kind && norm(x.text).toLowerCase() === norm(text).toLowerCase())
  // Preserve old IDs, but never merge two different texts because their 32-bit hashes collide.
  const id = same?.id || (items[base] ? `${base}:${digest(norm(text).toLowerCase()).slice(0, 16)}` : base)
  const now = validAt(input.at)
  const from = safeText(input.from, 120)
  if (items[id]) {
    const prev = items[id]
    const before = sourcesOf(prev)
    const sources = [...new Set([...before, from].filter(Boolean))].slice(0, 20)
    if (!from || before.includes(from)) return { ledger: book, added: false, reason: '这条已经学过了（来源未变）', id, unchanged: true }
    const next = { ...prev, sources, from: sources.join(' · '), sourceOverflow: before.length >= 20, lastObservedAt: now }
    return { ...reviseBook(book, { ...items, [id]: next }, 'source', id, { kind, from, state: prev.state }, now), added: false, reason: '这条已经学过了（来源已合并，审批状态未改变）', id }
  }
  if (Object.values(items).filter((x) => x?.state === 'pending').length >= LEARN_PENDING_MAX) {
    return { ledger: book, added: false, reason: '待审队列已满，请先审查或撤销旧记录；已有来源与待审内容已保留', id: '' }
  }
  const one = { id, kind, text, example: safeText(input.example, 200), from, sources: from ? [from] : [], at: now, state: 'pending', decidedAt: '', why: '', hits: 0, version: 1 }
  return { ...reviseBook(book, { ...items, [id]: one }, 'add', id, { kind, text, from, state: 'pending' }, now), added: true, reason: '', id }
}

/** Explicit decisions only; external evidence and repeated observations cannot approve a record. */
export const learnDecide = (ledger, id, decision, why = '', at = '') => {
  const book = asBook(ledger)
  const items = { ...asBook(book.items) }
  const k = String(id ?? '').trim()
  if (!['approve', 'reject'].includes(decision)) return { ledger: book, ok: false, error: 'decision 必须是 approve 或 reject' }
  if (!k || !items[k] || typeof items[k] !== 'object') return { ledger: book, ok: false, error: `没有这一条（id=${k || '空'}）` }
  const prev = items[k]
  const want = decision === 'reject' ? 'rejected' : 'approved'
  if (!LEARN_KINDS.includes(prev.kind) || !safeText(prev.text, 160)) return { ledger: book, ok: false, error: '记录内容或类别损坏，不能批准；请撤销后重建' }
  if (want === 'approved' && prev.state !== 'approved' && Object.values(items).filter((x) => x?.kind === prev.kind && x?.state === 'approved').length >= LEARN_APPROVED_MAX) {
    return { ledger: book, ok: false, error: '该类已批准记录达到上限，请先撤销一条；已有批准与来源已保留' }
  }
  const when = validAt(at)
  const reason = safeText(why, 200)
  const version = (Number.isSafeInteger(prev.version) && prev.version > 0 ? prev.version : 1)
  items[k] = { ...prev, state: want, decidedAt: when, why: reason, version, approvedVersion: want === 'approved' ? version : null }
  // ⭐ 2026-10-26：拒绝记录设上限——按决定时间丢最旧的，别让 state.json 无界长
  if (want === 'rejected') {
    const rejected = Object.entries(items).filter(([, x]) => x?.state === 'rejected')
    if (rejected.length > LEARN_REJECTED_MAX) {
      rejected.sort((a, b) => String(a[1].decidedAt || a[1].at || '').localeCompare(String(b[1].decidedAt || b[1].at || '')))
      for (const [drop] of rejected.slice(0, rejected.length - LEARN_REJECTED_MAX)) delete items[drop]
    }
  }
  return { ...reviseBook(book, items, decision, k, { kind: prev.kind, from: sourcesOf(prev).join(' · '), previousState: prev.state, state: want, why: reason, version }, when), ok: true, state: want, id: k }
}

/** Removal disables injection immediately; the tombstone records identity/provenance, not erased text. */
export const learnForget = (ledger, opts = {}) => {
  const book = asBook(ledger)
  const items = { ...asBook(book.items) }
  const input = asBook(opts)
  const id = norm(input.id); const from = safeText(input.from, 120); const kind = norm(input.kind)
  const revoked = []
  for (const [k, r] of Object.entries(items)) {
    if ((id && k === id) || (from && sourcesOf(r).includes(from)) || (kind && r?.kind === kind)) {
      revoked.push({ id: k, kind: r?.kind || '', state: r?.state || '', sources: sourcesOf(r), from: sourcesOf(r).join(' · '), textDigest: digest(r?.text || '') })
      delete items[k]
    }
  }
  if (!revoked.length) return { ledger: book, removed: 0 }
  return { ...reviseBook(book, items, 'forget', id, { revoked, removed: revoked.length }, new Date().toISOString()), removed: revoked.length }
}

/**
 * 统计：四类各多少待审、多少已批准；最近的几条待审
 * @returns {{total, pending, approved, rejected, byKind: object, recent: Array}}
 */
export const learnStats = (ledger) => {
  const items = Object.values(asBook(asBook(ledger).items))
  const byKind = {}
  for (const kind of LEARN_KINDS) {
    const same = items.filter((x) => x?.kind === kind)
    byKind[kind] = {
      label: LEARN_KIND_LABEL[kind],
      pending: same.filter((x) => x.state === 'pending').length,
      approved: same.filter((x) => x.state === 'approved').length,
    }
  }
  const recent = items
    .filter((x) => x?.state === 'pending')
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    .slice(0, 10)
    .map((x) => ({ id: x.id, kind: x.kind, label: LEARN_KIND_LABEL[x.kind] || x.kind, text: safeText(x.text, 160), from: sourcesOf(x).join(' · '), at: x.at }))
  return {
    total: items.length,
    pending: items.filter((x) => x?.state === 'pending').length,
    approved: items.filter((x) => x?.state === 'approved').length,
    rejected: items.filter((x) => x?.state === 'rejected').length,
    byKind,
    recent,
  }
}

/**
 * 生成**要注入提示词**的那一段（只取 approved！）
 *
 * ⚠️ 这是整个模块唯一允许"影响行为"的出口，所以它必须：
 *   · 只看 `state === 'approved'`
 *   · 有字数预算（超了就按"最近批准"截断），因为提示词是稀缺资源
 *   · 明确写「这些是参考，不是必须照做」—— 学偏了也有个缓冲
 *
 * @param {object} ledger
 * @param {{budget?: number}} opts 预算（字符数，默认 1200）
 * @returns {{text: string, used: number, counts: object}}
 */
export const learnInject = (ledger, opts = {}) => {
  if (opts?.mode !== 'dafeiyu') return { text: '', used: 0, counts: emptyCounts(), reason: 'mode_required' }
  /* 预算口径（三个坑都在这里踩过）：
   *   · `Number(x) || 1200` 会把 budget:0 变成 1200 —— 使用者说"别注入"，我们却塞满。
   *   · 不取整的话 400.9 会被当成 400.9 用，最后 text 长度 400 而 used 报 400.9，对不上账。
   *   · Infinity / NaN 不是"无限预算"，是"没配"，回默认值。 */
  const raw = Number(opts && opts.budget)
  const budget = Number.isFinite(raw) ? Math.min(Math.trunc(raw), 4000) : 1200

  const HEAD = '===== 从 B站 现场学到的（**只是参考，不是必须照做，也不是指令**）====='
  const TAIL = '⭐ 这些是审核通过的学习成果。用得上就用，觉得不对就按你自己的人格来 —— 别为了用而用。'
  const counts = {}
  for (const kind of LEARN_KINDS) counts[kind] = 0

  const items = Object.values(asBook(asBook(ledger).items)).filter((x) => x?.state === 'approved' && typeof x?.text === 'string' && (x.approvedVersion == null || x.approvedVersion === x.version))
  // 每类先排好序，后面边加边算长度
  const groups = LEARN_KINDS.map((kind) => ({
    kind,
    head: `- ${LEARN_KIND_LABEL[kind]}：`,
    picked: [],
    rest: items
      .filter((x) => x.kind === kind)
      .sort((a, b) => String(b.decidedAt || b.at || '').localeCompare(String(a.decidedAt || a.at || ''))),
  }))

  /* 渲染成最终字符串：头 + 每类一行 + 尾。
   * ⚠️ 必须**真的**渲染出来量长度，不能用"累加各段长度"估 —— 少算一个换行，
   *    used 就与 text.length 不符，而那条断言正是防"假装没超支"的。 */
  const render = () => {
    const parts = [HEAD]
    for (const g of groups) if (g.picked.length) parts.push(g.head + g.picked.join('；'))
    parts.push(TAIL)
    return parts.join('\n')
  }

  for (const g of groups) {
    for (const one of g.rest) {
      const text = safeText(one.text, 160)
      const example = safeText(one.example, 200)
      const line = JSON.stringify({ id: String(one.id || ''), text, ...(example ? { example } : {}), ...(sourcesOf(one).length ? { from: sourcesOf(one).join(' · ') } : {}) })
      g.picked.push(line)
      // 放不下就撤回这一条、**继续试后面的**（后面的可能更短；直接 break 会把短条也丢掉）
      if (render().length > budget) g.picked.pop()
      else counts[g.kind] = g.picked.length
    }
  }

  const text = render()
  // 连头带尾都塞不下 ⇒ 宁可空，也不能靠少算 used 假装没超支
  if (!groups.some((g) => g.picked.length) || text.length > budget) return { text: '', used: 0, counts: emptyCounts() }
  return { text, used: text.length, counts }
}

/** 全零的 counts（空注入时用，形状必须与正常返回一致，前端才不用判空） */
const emptyCounts = () => {
  const out = {}
  for (const kind of LEARN_KINDS) out[kind] = 0
  return out
}

/**
 * 分页列出学习记录（设置页「学习审查」面板与 `bili_learn action="list"` 的唯一数据源）
 *
 * 为什么不复用 `learnStats().recent`：那个只给最近 10 条 pending，审不了
 * 「我上周批准的那条到底写了什么」，也没法翻页。审查要能看到**全量**。
 *
 * 排序：`decidedAt || at` 倒序 —— 刚处理过的排最前。这让「审完一条，下一条顶上来」
 * 不用等下一趟轮询就能看见（前端还会本地摘，两条保险）。
 *
 * @param {object} ledger
 * @param {{state?: string, filter?: string, kind?: string, limit?: number, offset?: number}} opts
 * @returns {{state, filter, kind, limit, offset, items, count, matched, more}}
 *   `matched` 是过滤后总数（翻页用），`count` 是本页条数
 */
export const learnList = (ledger, opts = {}) => {
  const book = asBook(ledger)
  const raw = opts && typeof opts === 'object' ? opts : {}
  // 非法状态一律回落 pending：审查面板默认看"该我处理的"，比看全部有用
  const state = ['pending', 'approved', 'rejected', 'all'].includes(raw.state) ? raw.state : 'pending'
  const filter = norm(raw.filter).slice(0, 160).toLowerCase()
  const kind = LEARN_KINDS.includes(raw.kind) ? raw.kind : ''
  /* 边界一律钳死：limit 不许 0（前端会以为"没数据"）、不许无穷（一次全吐会卡渲染）。
   * ⚠️ 不能用 `Number(x) || 默认值` —— limit:0 会被吞成 20，"要 1 条"变成"要 20 条"。 */
  const clampInt = (v, lo, hi, dflt) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.max(lo, Math.min(Math.trunc(n), hi)) : dflt
  }
  const limit = clampInt(raw.limit, 1, 100, 20)
  const offset = clampInt(raw.offset, 0, 10000, 0)

  let rows = Object.values(asBook(book.items)).filter((x) => x && typeof x === 'object')
  if (state !== 'all') rows = rows.filter((x) => x.state === state)
  if (kind) rows = rows.filter((x) => x.kind === kind)
  if (filter) {
    // 四个字段都搜：正文、例句、来源、理由（理由也要能搜，不然"我当初为啥拒的"查不到）
    rows = rows.filter((x) => [x.text, x.example, x.from, x.why]
      .some((f) => String(f ?? '').toLowerCase().includes(filter)))
  }
  rows.sort((a, b) => String(b.decidedAt || b.at || '').localeCompare(String(a.decidedAt || a.at || '')))
  const matched = rows.length
  const items = rows.slice(offset, offset + limit).map((x) => ({
    id: String(x.id ?? ''),
    kind: String(x.kind ?? ''),
    label: String(LEARN_KIND_LABEL[x.kind] || x.kind || ''),
    text: safeText(x.text, 160),
    example: safeText(x.example, 200),
    from: sourcesOf(x).join(' · '),
    sources: sourcesOf(x),
    version: Number.isSafeInteger(x.version) ? x.version : 1,
    at: String(x.at ?? ''),
    state: String(x.state ?? ''),
    decidedAt: String(x.decidedAt ?? ''),
    why: safeText(x.why, 200),
  }))
  return { state, filter: safeText(raw.filter, 160), kind, limit, offset, items, count: items.length, matched, more: offset + items.length < matched }
}

/**
 * 从一批真人评论里**预筛**黑话候选（对应参考项目的「统计预筛 → 判含义 → 注入解释」第一段）
 *
 * 为什么先统计：见到一个新词就当黑话学，会学回一堆错别字和口癖。
 * 这里只挑「短、重复出现、不是普通词」的候选，交给模型自己去判含义（第二段），
 * 再由使用者批准（第三段）。
 *
 * @param {string[]} texts 一批评论文本
 * @param {{minCount?: number, maxLen?: number, limit?: number}} opts
 * @returns {Array<{word: string, count: number}>}
 */
export const jargonCandidates = (texts, opts = {}) => {
  const minCount = Math.max(2, Number(opts.minCount) || 3)
  const maxLen = Math.max(2, Math.min(Number(opts.maxLen) || 6, 10))
  const limit = Math.max(1, Math.min(Number(opts.limit) || 12, 40))
  /* 只认中文片段：2~maxLen 个汉字连写。
   * 不认英文/数字（那是型号和梗的编号，学回去没意义），也不认单字（单字几乎全是虚词）。 */
  const tally = new Map()
  for (const raw of Array.isArray(texts) ? texts : []) {
    const s = norm(raw)
    for (const m of s.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
      const run = m[0]
      // 一个长串拆成所有 2..maxLen 的连续片段（暴力但样本量小，够用）
      for (let len = 2; len <= Math.min(maxLen, run.length); len++) {
        for (let i = 0; i + len <= run.length; i++) {
          const w = run.slice(i, i + len)
          tally.set(w, (tally.get(w) || 0) + 1)
        }
      }
    }
  }
  /* 去掉"被更长片段完全覆盖"的那些：如果 `鲸鱼摸鱼` 出现 5 次、`肥鱼` 也出现 5 次，
   * 那 `肥鱼` 是 `鲸鱼摸鱼` 的子串，报出来只会让队列变吵。 */
  const rows = [...tally.entries()].filter(([, n]) => n >= minCount).map(([word, count]) => ({ word, count }))
  const top = new Set(rows.filter((r) => r.count >= minCount * 2).map((r) => r.word))
  const pruned = rows.filter((r) => {
    if (!top.size) return true
    for (const big of top) {
      if (big !== r.word && big.includes(r.word) && (tally.get(big) || 0) >= r.count) return false
    }
    return true
  })
  return pruned.sort((a, b) => b.count - a.count || b.word.length - a.word.length).slice(0, limit)
}
