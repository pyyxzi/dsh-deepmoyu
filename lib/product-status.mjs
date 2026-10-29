const dayAtOffset = (date, offsetMinutes) => {
  const d = new Date(new Date(date).getTime() + offsetMinutes * 60_000)
  const pad = (v) => String(v).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

const THEME_STOP = new Set(['今天', '视频', '这个', '那个', '一个', '为什么', '如何', '真的', '关于', '我们', '你们', '他们', '什么', '竟然', '居然', '还是', '已经', '可以', '没有', '一下', '看看', '实测', '教程', '分享'])
const titleClues = (title) => {
  const text = String(title || '').normalize('NFKC').replace(/[\[\]【】《》「」“”'"()（）!?！？:：,，。·|/\\_-]+/g, ' ').trim()
  if (!text) return []
  let parts = []
  try {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
    parts = [...segmenter.segment(text)].filter((row) => row.isWordLike).map((row) => row.segment)
  } catch { parts = text.match(/[\p{Script=Han}]{2,6}|[A-Za-z][A-Za-z0-9+#.]{2,}/gu) || [] }
  return [...new Set(parts.map((part) => String(part).trim().toLowerCase()).filter((part) => part.length >= 2 && part.length <= 18 && !THEME_STOP.has(part) && !/^\d+$/.test(part)))].slice(0, 6)
}

const addThemeSource = (map, clue, source) => {
  const row = map.get(clue) || { count: 0, sources: [] }
  row.count++
  if (row.sources.length < 5 && !row.sources.some((item) => item.day === source.day && item.bvid === source.bvid)) row.sources.push(source)
  map.set(clue, row)
}

export function buildSevenDayRetrospective({ now = new Date(), tokenDays = {}, ledger = [], readReport = () => '', timeZoneOffsetMinutes = -new Date(now).getTimezoneOffset() } = {}) {
  const runsByDay = new Map()
  for (const row of Array.isArray(ledger) ? ledger : []) {
    const parsed = Date.parse(row?.startedAt)
    const key = Number.isFinite(parsed) ? dayAtOffset(parsed, timeZoneOffsetMinutes) : ''
    if (/^\d{4}-\d{2}-\d{2}$/.test(key)) runsByDay.set(key, (runsByDay.get(key) || 0) + 1)
  }
  const currentThemes = new Map()
  const previousThemes = new Map()
  const days = []
  const errors = []
  let currentReportDays = 0
  let previousReportDays = 0
  for (let offset = 13; offset >= 0; offset--) {
    const shifted = new Date(new Date(now).getTime() + timeZoneOffsetMinutes * 60_000)
    shifted.setUTCHours(12, 0, 0, 0)
    shifted.setUTCDate(shifted.getUTCDate() - offset)
    const day = dayAtOffset(shifted.getTime() - timeZoneOffsetMinutes * 60_000, timeZoneOffsetMinutes)
    let report = ''
    let reportError = ''
    try { report = String(readReport(day) || '').replace(/```[\s\S]*?```/g, '') }
    catch (error) { reportError = String(error?.message || error).slice(0, 160); errors.push({ day, error: reportError }) }
    const currentPeriod = offset <= 6
    const picked = new Set()
    const topics = []
    for (const match of report.matchAll(/^#{2,3}[ \t]*(BV[0-9A-Za-z]{10})[ \t]*[-—·:：]?[ \t]*(.*)$/gm)) {
      const bvid = match[1]
      picked.add(bvid)
      const title = String(match[2] || '').replace(/\s+/g, ' ').trim().slice(0, 50)
      if (!title || topics.includes(title)) continue
      topics.push(title)
      for (const clue of titleClues(title)) addThemeSource(currentPeriod ? currentThemes : previousThemes, clue, { day, bvid, title })
    }
    const reportKnown = Boolean(report)
    if (reportKnown) currentPeriod ? currentReportDays++ : previousReportDays++
    const tokenKnown = Object.hasOwn(tokenDays || {}, day)
    const tokens = tokenKnown ? Math.max(0, Number(tokenDays?.[day]) || 0) : null
    const runs = Math.max(0, Number(runsByDay.get(day)) || 0)
    if (currentPeriod) days.push({ day, report: reportKnown, reportError, picks: reportKnown ? picked.size : null, tokenKnown, tokens, runs, topics: topics.slice(0, 4) })
  }
  const totals = days.reduce((sum, row) => ({
    picks: sum.picks + (row.picks ?? 0),
    tokens: sum.tokens + (row.tokens ?? 0),
    runs: sum.runs + row.runs,
    activeDays: sum.activeDays + ((row.report || (row.tokens ?? 0) > 0 || row.runs > 0) ? 1 : 0),
    reportDays: sum.reportDays + (row.report ? 1 : 0),
    tokenDays: sum.tokenDays + (row.tokenKnown ? 1 : 0),
  }), { picks: 0, tokens: 0, runs: 0, activeDays: 0, reportDays: 0, tokenDays: 0 })
  const themes = [...currentThemes.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 5).map(([title, row]) => ({ title, count: row.count, sources: row.sources }))
  const comparisonAvailable = currentReportDays > 0 && previousReportDays > 0
  const changes = { available: comparisonAvailable, label: '标题线索 / 非兴趣结论', coverage: { currentReportDays, previousReportDays }, new: [], continued: [], decreased: [] }
  if (comparisonAvailable) {
    const keys = new Set([...currentThemes.keys(), ...previousThemes.keys()])
    for (const clue of keys) {
      const current = currentThemes.get(clue) || { count: 0, sources: [] }
      const previous = previousThemes.get(clue) || { count: 0, sources: [] }
      const row = { clue, current: current.count, previous: previous.count, sources: [...current.sources, ...previous.sources].slice(0, 6) }
      if (current.count > 0 && previous.count === 0) changes.new.push(row)
      if (current.count > 0 && previous.count > 0) changes.continued.push(row)
      if (previous.count > current.count) changes.decreased.push(row)
    }
    const rank = (a, b) => Math.max(b.current, b.previous) - Math.max(a.current, a.previous) || a.clue.localeCompare(b.clue, 'zh-CN')
    changes.new.sort(rank); changes.continued.sort(rank); changes.decreased.sort(rank)
    changes.new = changes.new.slice(0, 5); changes.continued = changes.continued.slice(0, 5); changes.decreased = changes.decreased.slice(0, 5)
  }
  return { days, totals, themes, changes, errors, complete: errors.filter((row) => days.some((day) => day.day === row.day)).length === 0 && days.every((row) => row.report && row.tokenKnown), note: errors.length ? `14 天比较窗口内有 ${errors.length} 天的日报无法安全读取；覆盖天数已单独列出。` : themes.length ? '主题是日报标题中的词语线索，不代表已经形成兴趣偏好。' : '这七天还没有足够的日报标题可提取线索。' }
}

export function buildRecoverySnapshot({ now = Date.now(), feiyu = {}, background = null, backgroundAlive = false, lastBackground = null, schedule = {}, scheduleEnabled = false, window = {}, videoSessions = [], lastRunAt = null } = {}) {
  const rows = []
  const phase = String(feiyu?.goal?.phase || '')
  if (feiyu.active) rows.push({ id: 'session', kind: 'session', state: 'running', label: '当前会话正在刷', detail: `已进行 ${Number(feiyu?.goal?.rounds || feiyu?.roundsThisRun) || 0} 轮`, action: 'logs', actionLabel: '看实时流水' })
  else if (phase === 'paused' || phase === 'blocked') rows.push({ id: 'session', kind: 'session', state: phase, label: phase === 'blocked' ? '当前会话已到达保险丝' : '当前会话已暂停', detail: feiyu?.stopReason ? `停因：${feiyu.stopReason}` : '可以从运行方式页继续或收台', action: 'run', actionLabel: phase === 'blocked' ? '打开清台/重开控件' : '打开继续/收台控件' })

  if (backgroundAlive && background?.active) rows.push({ id: 'background', kind: 'background', state: 'running', label: background.task === 'learn-review' ? '后台正在审核记忆' : '后台正在刷', detail: background.windowEndAt ? `时段任务，计划到 ${new Date(background.windowEndAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '后台任务仍在运行', action: 'logs', actionLabel: '看后台进度' })
  else if (background?.error || ['error', 'spawn-error'].includes(background?.stopReason) || ['error', 'spawn-error'].includes(lastBackground?.stopReason)) {
    const source = background?.error || background?.stopReason ? background : lastBackground
    rows.push({ id: 'background', kind: 'background', state: 'failed', label: '上次后台任务中断', detail: String(source?.error || source?.stopReason || '后台进程异常退出').slice(0, 180), action: 'background', actionLabel: '打开后台重试控件' })
  }
  else if (Number(window?.holdUntil) > Number(now)) rows.push({ id: 'background', kind: 'background', state: 'held', label: '本时段已手动停止', detail: `到 ${new Date(Number(window.holdUntil)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 前不会自动拉起`, action: 'background', actionLabel: '需要时立即恢复' })

  if (scheduleEnabled || (window?.start && window?.end)) {
    const crossMidnight = String(window.start || '') > String(window.end || '')
    rows.push({ id: 'schedule', kind: 'schedule', state: schedule?.lastError ? 'failed' : schedule?.inWindow || window?.active ? 'ready' : 'scheduled', label: schedule?.lastError ? '定时启动最近失败' : schedule?.inWindow || window?.active ? '当前在定时窗口内' : crossMidnight ? '跨午夜时段已安排' : '定时运行已安排', detail: schedule?.lastError ? String(schedule.lastError).slice(0, 180) : schedule?.nextRunAt ? `下次检查 ${new Date(schedule.nextRunAt).toLocaleString('zh-CN', { hour12: false })}` : window?.start && window?.end ? `${window.start}–${window.end}，等待进入窗口` : '等待下一个本地时间窗口', action: 'background', actionLabel: '查看后台与定时' })
  }

  const sessions = Array.isArray(videoSessions) ? videoSessions : []
  const runningVideo = sessions.find((row) => row?.running === true)
  const brokenVideo = sessions.find((row) => ['interrupted', 'failed'].includes(String(row?.stage || '')) || (!row?.running && ['cover', 'render', 'verify', 'publish'].includes(String(row?.stage || ''))))
  if (runningVideo) rows.push({ id: 'video', kind: 'video', state: 'running', label: '视频制作仍在进行', detail: `${runningVideo.date || ''}${runningVideo.stage ? ' · 阶段 ' + runningVideo.stage : ''}`.trim(), action: 'video', actionLabel: '查看制作会话', sessionId: runningVideo.sessionId || '' })
  else if (brokenVideo) {
    const state = brokenVideo.stage === 'failed' ? 'failed' : 'interrupted'
    rows.push({ id: 'video', kind: 'video', state, label: state === 'interrupted' ? '视频制作被中断' : '上次视频制作失败', detail: String(brokenVideo.error || '回到制作会话查看原因并重新提交').slice(0, 180), action: 'video', actionLabel: '处理制作任务', sessionId: brokenVideo.sessionId || '' })
  }

  if (!rows.length) rows.push({ id: 'idle', kind: 'idle', state: 'ok', label: '没有需要恢复的任务', detail: lastRunAt ? `上次运行 ${new Date(lastRunAt).toLocaleString('zh-CN', { hour12: false })}` : '可以安排当前会话、后台或定时冲浪', action: 'run', actionLabel: '安排下一轮' })
  return { needsAction: rows.some((row) => ['paused', 'blocked', 'failed', 'interrupted'].includes(row.state)), rows }
}
