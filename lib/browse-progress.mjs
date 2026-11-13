/** Small per-run working memory. Callers own storage and scope; no private text is retained. */
import { bvidOf } from './ledger.mjs'

const LIMIT = 24
const READ_RETRY_LIMIT = 3 // initial failure + at most two suggested retries
const DISCOVERY = new Set(['bili_search', 'bili_rank', 'bili_hot_videos', 'bili_user_videos'])
const millis = (value) => typeof value === 'number' && Number.isFinite(value) ? value : Date.parse(value) || 0
const unique = (list, newest = true) => {
  const ids = [...new Set(list.map(bvidOf).filter(Boolean))]
  return newest ? ids.slice(-LIMIT) : ids.slice(0, LIMIT)
}
const SEND_KINDS = ['comment', 'reply', 'opusReply', 'dm', 'moment']
const fingerprint = (value) => {
  let code = 2166136261
  for (const char of String(value)) code = Math.imul(code ^ char.charCodeAt(0), 16777619)
  return (code >>> 0).toString(16)
}
const sourceOf = (tool, args, result) => ({ tool,
  key: fingerprint(JSON.stringify([tool, args.keyword || '', args.uid || '', args.rid || '', args.order || '', args.days ?? ''])),
  page: Number.isSafeInteger(Number(result.page ?? args.page)) ? Math.max(1, Number(result.page ?? args.page)) : 1,
  hasMore: typeof result.has_more === 'boolean' ? result.has_more : null })
const dueReads = (state, now) => (state.deferredReads || [])
  .filter(row => row.retryAt > 0 && row.retryAt <= millis(now) && row.attempts < READ_RETRY_LIMIT).map(row => row.bvid)
const semantic = ({ updatedAt, revision, ...rest }) => JSON.stringify(rest)
const sendKind = (tool, args) => tool === 'bili_comment' ? 'comment'
  : tool === 'bili_reply' ? (args?.rpid && String(args.rpid) !== '0' ? 'reply' : 'comment')
    : tool === 'bili_reply_opus' ? 'opusReply' : tool === 'bili_dm_reply' || tool === 'bili_deliver' ? 'dm'
      : tool === 'bili_moment' ? 'moment' : ''
const blockedReason = (result) => result?.unknown || result?.guard_status === 'unknown' ? 'unknown-result'
  : result?.quotaReached || result?.limit_reached ? 'quota'
    : result?.pace || result?.riskCooldown ? (['cooldown', 'quota', 'burst', 'hour', 'gap'].includes(result?.reason) ? result.reason : 'pace')
      : result?.already_replied ? 'already-sent' : 'unavailable'
const blockScope = reason => ['cooldown', 'burst'].includes(reason) ? 'all'
  : ['unknown-result', 'already-sent'].includes(reason) ? 'target' : 'channel'

export function createBrowseProgress(now = Date.now()) {
  return { phase: 'discover', startedAt: millis(now), updatedAt: millis(now), pendingBvids: [],
    version: 2, revision: 0, readBvids: [], skippedBvids: [], deferredReads: [], lastBvid: '',
    emptySources: 0, blockedAttempts: 0, blockedSendKinds: [], lastDiscovery: null,
    /* 2026-11-14：连续读了几条还没说话。使用者要求「刷过的视频尽量留下评论」，
     * 光在提示词里说"尽量"没用 —— 把这个数摆到 `next.hint` 里，模型才看得见自己欠了几条。 */
    readsSinceComment: 0,
    /* 2026-11-14：连续几条视频没字幕。真机事故：22 条连续无字幕后，鱼开始翻日志、
     * 查 sqlite、在工作区写 `_diag_sub.py` 排查 —— 使用者看到的是「让他刷视频，他在改文件」。
     * 这个计数到 5 就把下一步改成"换来源"，别让它死磕同一批候选。 */
    noSubtitleStreak: 0 }
}

export function observeBrowseProgress(state, { tool, args = {}, result, now = Date.now() } = {}) {
  const src = state && typeof state === 'object' ? state : createBrowseProgress(now)
  const next = { ...createBrowseProgress(now), ...src, version: 2, updatedAt: millis(now),
    pendingBvids: unique(Array.isArray(src.pendingBvids) ? src.pendingBvids : [], false),
    readBvids: unique(Array.isArray(src.readBvids) ? src.readBvids : []),
    skippedBvids: unique(Array.isArray(src.skippedBvids) ? src.skippedBvids : []),
    deferredReads: (Array.isArray(src.deferredReads) ? src.deferredReads : []).slice(-LIMIT).map(row => ({ ...row })),
    blockedSendKinds: (Array.isArray(src.blockedSendKinds) ? src.blockedSendKinds : []).map(row => ({ ...row })) }
  const out = result && typeof result === 'object' ? result : {}
  if (DISCOVERY.has(tool)) {
    const rows = Array.isArray(out.fresh) ? out.fresh : out.videos || out.items || out.list || []
    const known = new Set([...next.readBvids, ...next.skippedBvids, ...next.deferredReads.map(row => row.bvid)])
    const candidates = (Array.isArray(rows) ? rows : [])
      .filter(row => !row?.already_seen).map(bvidOf).filter(id => id && !known.has(id))
    next.pendingBvids = unique([...next.pendingBvids, ...candidates], false)
    const failed = Boolean(out.error || out.ok === false || out.success === false)
    next.lastDiscovery = { ...sourceOf(tool, args, out), outcome: candidates.length ? 'found' : failed ? 'error' : 'empty' }
    if (!failed) next.emptySources = candidates.length ? 0 : Math.min(3, (Number(next.emptySources) || 0) + 1)
    next.phase = next.pendingBvids.length ? 'read' : 'discover'
  } else if (tool === 'bili_subtitle') {
    const bvid = bvidOf(args.bvid)
    const content = !out.error && out.ok !== false && out.success !== false && Boolean(
      String(out.text || out.full_text || out.content || '').trim())
    if (bvid) {
      next.pendingBvids = next.pendingBvids.filter(id => id !== bvid)
      next.lastBvid = bvid
      if (content) {
        next.deferredReads = next.deferredReads.filter(row => row.bvid !== bvid)
        next.skippedBvids = next.skippedBvids.filter(id => id !== bvid)
        next.readBvids = unique([...next.readBvids, bvid])
        next.phase = 'reflect'
        /* 只有**新读**才 +1：补查同一片的字幕（缓存快照）不算又欠一条评论。 */
        if (!(src.readBvids || []).includes(bvid)) next.readsSinceComment = Math.min(99, (Number(src.readsSinceComment) || 0) + 1)
        next.noSubtitleStreak = 0
      } else {
        const absent = out.preference_skipped === true || (!out.error && out.ok !== false && out.success !== false &&
          (/没有字幕|无字幕|no (?:available )?subtitles?/i.test(String(out.message || ''))
            || (Number(out.segments) === 0 && typeof out.text === 'string' && !out.text.trim())))
        if (absent) {
          next.deferredReads = next.deferredReads.filter(row => row.bvid !== bvid)
          next.skippedBvids = unique([...next.skippedBvids, bvid])
          next.noSubtitleStreak = Math.min(99, (Number(src.noSubtitleStreak) || 0) + 1)
        } else {
          const previous = next.deferredReads.find(row => row.bvid === bvid)
          const attempts = Math.min(READ_RETRY_LIMIT, (Number(previous?.attempts) || 0) + 1)
          const reason = out.guard_status === 'pending' ? 'lease' : 'transport'
          const waitMs = attempts === 1 ? 30_000 : 120_000
          const retryAt = attempts < READ_RETRY_LIMIT ? Math.max(millis(now) + waitMs, millis(out.retryAt || out.retry_at)) : 0
          next.deferredReads = [...next.deferredReads.filter(row => row.bvid !== bvid), { bvid, attempts, retryAt, reason }].slice(-LIMIT)
        }
        next.phase = next.pendingBvids.length ? 'read' : 'discover'
      }
    }
  }
  if (tool === 'bili_pace' && out.kinds && typeof out.kinds === 'object') {
    const rows = Object.entries(out.kinds).filter(([kind, row]) => SEND_KINDS.includes(kind) && row && typeof row === 'object')
    for (const [kind, row] of rows) {
      const previous = next.blockedSendKinds.find(block => block.kind === kind)
      // An open rate limit does not resolve an uncertain prior send.
      if (previous?.reason === 'unknown-result') continue
      next.blockedSendKinds = next.blockedSendKinds.filter(block => block.kind !== kind)
      if (Number(row.waitSec) > 0) next.blockedSendKinds.push({ kind, scope: blockScope(row.blockedBy),
        reason: ['cooldown', 'quota', 'burst', 'hour', 'gap'].includes(row.blockedBy) ? row.blockedBy : 'pace',
        retryAt: millis(row.nextAt) || millis(now) + Math.ceil(Number(row.waitSec)) * 1000 })
    }
    // A pace query describes sending availability; it must not discard a fresh reading reaction.
    if (rows.length && rows.every(([, row]) => Number(row.waitSec) > 0)) {
      next.blockedAttempts = Math.max(1, Number(next.blockedAttempts) || 0)
    }
  }
  if (tool === 'bili_seen' && args.action === 'mark' && out.ok === true) {
    const marked = String(args.bvid || '').split(/[,，\s]+/).map(bvidOf).filter(Boolean)
    next.pendingBvids = next.pendingBvids.filter(id => !marked.includes(id))
    next.skippedBvids = unique([...next.skippedBvids, ...marked.filter(id => !next.readBvids.includes(id))])
    next.deferredReads = next.deferredReads.filter(row => !marked.includes(row.bvid))
    next.phase = next.pendingBvids.length ? 'read' : 'discover'
  }
  const kind = sendKind(tool, args)
  if (kind) {
    if (out.blocked || out.pace || out.unknown || out.retry_blocked || out.already_replied
      || out.ok === false || out.success === false || out.error) {
      next.blockedAttempts = Math.min(999, (Number(next.blockedAttempts) || 0) + 1)
      const reason = blockedReason(out)
      const retryAt = millis(out.retryAt || out.retry_at) || (reason === 'unknown-result' ? 0 : millis(now) + 60_000)
      next.blockedSendKinds = next.blockedSendKinds.filter(row => row.kind !== kind)
      next.blockedSendKinds.push({ kind, reason, retryAt, scope: out.riskCooldown ? 'all' : blockScope(reason) })
      next.phase = next.pendingBvids.length ? 'read' : 'discover'
    } else if (out.ok === true || out.success === true || out.guard_status === 'sent') {
      next.blockedAttempts = 0
      next.phase = next.pendingBvids.length ? 'read' : 'discover'
      /* 说了一句（新评论或回复）就把"欠着没说"清零。 */
      if (kind === 'comment' || kind === 'reply' || kind === 'opusReply') next.readsSinceComment = 0
    }
  }
  if (semantic(next) === semantic(src)) return src
  return { ...next, revision: (Number(src.revision) || 0) + 1 }
}

export function browseProgressBrief(state, now = Date.now(), { compact = false, dmDue = false, momentDue = false } = {}) {
  const src = state || createBrowseProgress(now)
  const pending = unique([...(Array.isArray(src.pendingBvids) ? src.pendingBvids : []), ...dueReads(src, now)], false)
  const deferred = (src.deferredReads || []).filter(row => !pending.includes(row.bvid))
  const blocked = (Array.isArray(src.blockedSendKinds) ? src.blockedSendKinds : [])
    .filter(row => row.reason === 'unknown-result' || !row.retryAt || row.retryAt > millis(now))
    .map(row => ({ ...row, scope: blockScope(row.reason) === 'all' ? 'all' : row.scope || blockScope(row.reason) }))
  let next
  /* 💬 动态提醒句（2026-11-14）：使用者要「大约每半小时一条」。这句要跟着
   *    **读片/发现两条主路径**走 —— 只挂在 discover 上的话，模型连续读片时永远看不到。 */
  const momentLine = momentDue ? ' 另外：距上一条动态已经满半小时了，有想说的就 bili_moment 发一条（把看的视频 BV 号传给 bvid，会自动补链接），可以带 1–2 张表情。' : ''
  /* 🥇 私信优先（2026-11-14）：使用者明确要求「私信优先级最高，有人私信就要回」。
   * 这一条必须排在所有"继续读片"的建议之前 —— 否则模型永远先读下一条视频。
   * `dmDue` 由宿主按"距上次成功查收件箱超过 20 分钟"算出来，这里只负责把它顶到最前。 */
  if (dmDue) next = {
    action: 'check-dm', tool: 'bili_dm_inbox',
    hint: '距离上次看私信已经有一阵了。先 bili_dm_inbox 看一眼：有人发了新的就优先回，没有就继续刷。' }
  /* 🚫 连续无字幕（2026-11-14 真机事故）：22 条连续没字幕时，鱼开始写脚本查原因。
   *    这里在 ≥5 条时把下一步强制改成"换来源"，并且明说别去排查。 */
  else if (Number(src.noSubtitleStreak) >= 5) next = {
    action: 'change-source',
    hint: `连续 ${src.noSubtitleStreak} 条视频没有字幕了。换关键词、分区或榜单入口，别在同一批候选上继续试；也别写脚本、改文件或跑命令去查原因 —— 换个来源继续刷就好。` }
  else if (src.phase === 'reflect' && src.lastBvid) next = {
    action: 'reflect-or-move-on', bvid: src.lastBvid,
    /* 2026-11-14：使用者要求「刷过的视频尽量留下评论」。这里不再说"也可以略过"，
     * 而是把"连读了几条没说话"摆出来 —— 模型看得见欠账，才会真的开口。 */
    hint: (Number(src.readsSinceComment) >= 2
      ? `已经连读 ${src.readsSinceComment} 条没说话了。这条只要有一点真实反应就发一句 bili_comment；确实无话可说再略过。`
      : '刚读完这条。想一想有没有想说的：有一点真实反应就发一句 bili_comment，不必等特别惊艳的片。')
      + ' 按 blockedSendKinds 避让：scope=all 的整体风控冷却或连发暂停期间只读，停所有发送；只有局部通道或目标受限时，仍可处理原本独立且已授权的互动。不换措辞、接口或通道重试同一次被拦发送，未知结果的同一目标不重试。值得学的记成有适用场景的待审经验，再处理下一个候选。'
      + momentLine }
  else if (pending.length && Number(src.blockedAttempts) >= 1 && blocked.length) next = {
    action: 'continue-reading', tool: 'bili_subtitle', args: { bvid: pending[0] },
    hint: '先读这个候选。scope=all 的整体风控冷却或连发暂停期间只读，停所有发送；只有局部通道或目标受限时，才可继续新的阅读与独立且已授权的接话。不换措辞、接口或通道重试同一次被拦发送，未知结果的同一目标不重试。' }
  else if (pending.length) next = { action: 'read-next', tool: 'bili_subtitle', args: { bvid: pending[0] }, hint: '继续处理剩余候选，无需重新搜索同一批。' }
  else if (Number(src.emptySources) >= 3) next = { action: 'rest-or-change-source', hint: '连续三个发现请求没有新候选。先整理已看内容或休息；继续探索时换关键词或来源，不重复空查询。' }
  else if (src.lastDiscovery?.tool === 'bili_search' && src.lastDiscovery.hasMore === true && src.lastDiscovery.page < 50) next = {
    action: 'search-next-page', tool: 'bili_search', page: src.lastDiscovery.page + 1,
    hint: `这页候选已经处理完。沿用刚才的关键词和筛选，翻到第 ${src.lastDiscovery.page + 1} 页，不重复第一页。` }
  else if (src.lastDiscovery?.outcome === 'error') next = { action: 'change-source', hint: '刚才发现请求失败，不能据此说没有视频。先处理别的来源，不重复请求同一个失败入口。' }
  else if (deferred.length && !Number(src.emptySources)) next = { action: 'discover-or-wait',
    hint: '还有暂时读不到的候选。先找其他视频；达到建议重试时间后可补查，重试已用完的留给后续人工决定，不连续轮询。' }
  else next = { action: Number(src.emptySources) ? 'change-source' : 'discover',
    /* 💬 动态只在"找下一批候选"的建议里**附带**提一句，不单独占一个动作 ——
     *   否则 `next` 被它顶掉，模型会一直想着发动态、不再发现新片（2026-11-14 调参）。
     *   2026-11-14 使用者要求「大约每半小时一条」，阈值改由宿主按 30 分钟算（见 renderBrowseProgress）。 */
    hint: momentLine
      + (Number(src.emptySources) ? '这个入口没有新候选。换关键词、分区或发现入口；连续空结果时整理后休息，不要重复同一查询。'
        : '按这次兴趣找一小批候选。已完成的片翻篇，不为发言数凑任务。') }
  if (compact) { const { hint, ...briefNext } = next; next = briefNext }
  const retryTimes = deferred.map(row => row.retryAt).filter(at => at > millis(now))
  return { phase: src.phase || 'discover', pendingBvids: compact ? pending.slice(0, 3) : pending, pendingCount: pending.length,
    recentReadCount: (src.readBvids || []).length, recentSkippedCount: (src.skippedBvids || []).length,
    deferredReadCount: deferred.length, nextReadRetryAt: retryTimes.length ? Math.min(...retryTimes) : 0,
    blockedAttempts: Number(src.blockedAttempts) || 0, blockedSendKinds: blocked, next }
}
