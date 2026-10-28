/**
 * lib/reply.mjs —— 评论回复的「这一条该不该回」+ 判重账本（纯函数：不碰网络、不碰磁盘）
 * ============================================================================
 * 为什么判重是这里唯一的刹车（2026-10-20 立，2026-10-21 加注）：
 *   使用者当时明确要求「有人回复自己的评论，那就都回复一下」—— **条数上限取消了**。
 *   2026-10-21 又补一句「现在也不用每条都回复了，他想回就回」⇒ 「都回」那条产品口径也取消了，
 *   但**判重一条都没放松**：回不回是鱼自己的事，回没回过是账本的事。
 *   判重一旦失效，她每一轮都会把 B站 的「收到的回复」通知**再回一遍**，
 *   对同一个人重复刷屏 —— 比不回复恶劣得多。
 *   ⇒ 判据抽成纯函数，`devtools/check-reply.cjs` 离线钉住，不等真机出事才发现。
 *
 * 不变量（改之前先读）：
 *   · 返回值 **空串 = 可以回**；非空 = 给模型看的一句人话，说清为什么不用回。
 *     宿主一律用 `can_reply: skip === ''` 判定 ⇒ 空串必须是唯一的放行信号。
 *   · ⚠️ **这里不许出现「额度 / 上限 / 每轮 / 每日」这类概念**：那条路已经退役了，
 *     一旦返回里冒出这些词，模型就会以为"还有配额没花完"或者"是不是被限额掐了"，
 *     于是开始挑着回、或者干脆不回。判据只剩「回没回过」和「有没有 rpid」两条。
 *   · 判据顺序：先看**有没有 rpid**（连回到哪都不知道，是 cannot），再看**回没回过**。
 *     反过来也能过测试，但先报"回过了"会掩盖"这条根本没 rpid"这个更根本的问题。
 *
 * ⚠️ 判重钥匙现在是**统一层** `lib/dup.mjs` 的 `keyVideoReply()`（`video:<rpid>`），
 *    记账走 `dupRemember()`；本文件的 `replyRemember()` 是同一份 `repliedComments`
 *    账本的老接口，保留是为了老数据/老调用方还能用，上限也对齐 `DUP_LEDGER_MAX`。
 */

/**
 * 判重账本（`state.json` 的 `repliedComments`）最多记多少条。
 * 与 `lib/dup.mjs` 的 `DUP_LEDGER_MAX` 取同一个数：两边写的是**同一个对象**，
 * 上限不一致会出现"这边刚裁完那边又超"的来回抖动。
 */
import { replyTargetId } from './ids.mjs'

export const REPLY_LEDGER_MAX = 2000

/**
 * 这条回复的「回到哪条评论下」的 rpid：优先 `reply_rpid`（别人回你的那条），
 * 没有就退回 `root_rpid`（一级评论的根）。两个都没有 ⇒ 0（判据会因此拦下来）。
 * 非法或已经舍入的 number 不允许偷偷改回 root；只有缺省/零才使用 root。
 */
const replyTarget = (it) => {
  const item = it && typeof it === 'object' ? it : {}
  return replyTargetId(item.reply_rpid, item.root_rpid)
}

/**
 * 这一条回复该不该回。
 *
 * @param {object} it   `bili_received_replies` 的一条：`{ reply_rpid, root_rpid, bvid, ... }`
 * @param {{at?: string}|null} [was] 判重结果：账本里已经有这条时传 `{ at }`（回过的时刻，可能为空）
 * @returns {string} 空串 = 可以回；非空 = 给模型看的中文理由
 */
export const replySkipReason = (it, was) => {
  const item = it && typeof it === 'object' ? it : {}
  let rpid
  try { rpid = replyTarget(item) } catch {
    return '这条回复的 rpid 无效或是不安全的 number —— 请提供原始十进制字符串，不猜测回复目标。'
  }

  /* ① 没有 rpid ⇒ 硬拦。
   * 没有 rpid 就不知道该把这条回复挂在谁的楼下 —— 发出去只会变成一条无主的新评论，
   * 或者干脆发不出去。这是"不能"，不是"不该"，所以排在最前面说。 */
  if (rpid === '0') {
    return '这条回复没有 rpid（`reply_rpid` 和 `root_rpid` 都是空的）—— 不知道该回到哪条评论下，跳过。'
  }

  /* ② 判重：同一条只回一次。
   * `was` 由宿主用 `dupLookup()` 查好传进来（钥匙 `video:<rpid>`，老账本裸 rpid 也认），
   * 这里只负责把它翻译成一句人话。文案带上 rpid 和回过的时刻：模型照着才知道
   * "是哪条回过了"，而不是把整批都当成"回过了"。
   * ⚠️ 账本里 `at` 可能没有（早期记录）⇒ 不能直接插值，否则文案里冒出 `undefined`。 */
  if (was && typeof was === 'object') {
    const at = String(was.at || '')
    return `这条评论（rpid=${rpid}）${at ? `在 ${at} ` : ''}已经回过了 —— 不用再回一遍。`
      + '想换个人回就翻 `bili_received_replies` 里 `can_reply=true` 的。'
  }

  return ''
}

/**
 * 记一笔判重账本。返回**新对象**，不改入参。
 *
 * @param {Record<string, object>} ledger `state.json` 的 `repliedComments`
 * @param {string|number} key 判重钥匙（现在是 `video:<rpid>`，老账本是裸 rpid）
 * @param {object} rec `{ bvid, rpid, at }`
 * @returns {Record<string, object>}
 *
 * ⚠️ 钥匙是 `'0'` 或空 ⇒ **不记**：`rpid=0` 表示"没取到"，记下去会把所有取不到
 *   rpid 的回复认成同一条 —— 要么全被挡、要么账本被垃圾键填满。
 * ⚠️ 账本是 `undefined`（第一次跑）⇒ 当成空账本，不抛错。
 */
export const replyRemember = (ledger, key, rec) => {
  const next = { ...(ledger && typeof ledger === 'object' && !Array.isArray(ledger) ? ledger : {}) }
  const k = String(key ?? '').trim()
  if (!k || k === '0') return next
  next[k] = rec
  const keys = Object.keys(next)
  if (keys.length > REPLY_LEDGER_MAX) {
    // 按记录时间砍最早的。没 `at` 的排最后（`'9999'`）⇒ 它们最晚被砍，优先保住。
    keys
      .sort((a, b) => String(next[a]?.at || '9999').localeCompare(String(next[b]?.at || '9999')))
      .slice(0, keys.length - REPLY_LEDGER_MAX)
      .forEach((x) => delete next[x])
  }
  return next
}
