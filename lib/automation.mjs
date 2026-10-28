/** Local daily windows and bounded automation settings; no timers or I/O here. */
export const AUTOMATION_DEFAULTS = Object.freeze({
  scheduleEnabled: false, scheduleAllDay: false, scheduleStart: '18:00', scheduleEnd: '09:00',
  learnAutoReview: true, learnReviewModelId: '', learnReviewBatchSize: 20,
  learnReviewMinutes: 10, learnReviewTokenBudget: 12000,
})
export const AUTOMATION_LIMITS = Object.freeze({
  learnReviewBatchSize: [1, 50], learnReviewMinutes: [1, 60], learnReviewTokenBudget: [0, 5_000_000],
})
const own = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k)
export function localDay(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
export function clampClock(value, fallback = '18:00') {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  return m && Number(m[1]) <= 23 && Number(m[2]) <= 59
    ? `${m[1].padStart(2, '0')}:${m[2]}` : fallback
}
export function clampAutomationSettings(patch = {}) {
  const out = { ...patch }
  for (const key of ['scheduleEnabled', 'scheduleAllDay', 'learnAutoReview']) {
    if (own(out, key)) out[key] = typeof out[key] === 'boolean' ? out[key] : AUTOMATION_DEFAULTS[key]
  }
  for (const key of ['scheduleStart', 'scheduleEnd']) if (own(out, key)) out[key] = clampClock(out[key], AUTOMATION_DEFAULTS[key])
  if (own(out, 'learnReviewModelId')) out.learnReviewModelId = String(out.learnReviewModelId ?? '').trim().slice(0, 200)
  for (const [key, [lo, hi]] of Object.entries(AUTOMATION_LIMITS)) if (own(out, key)) {
    const n = Number(out[key])
    out[key] = Math.max(lo, Math.min(hi, Number.isFinite(n) ? Math.floor(n) : AUTOMATION_DEFAULTS[key]))
  }
  return out
}
const atMinute = (date, minute, delta = 0) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta, Math.floor(minute / 60), minute % 60)
const minuteOf = clock => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3))

/** Cross-midnight windows belong to the day they start; [start,end), equal means empty. */
export function dailyScheduleStatus(config = {}, record = {}, now = new Date()) {
  const cfg = { ...AUTOMATION_DEFAULTS, ...clampAutomationSettings(config) }
  const enabled = cfg.scheduleEnabled, allDay = cfg.scheduleAllDay
  const start = cfg.scheduleStart, end = cfg.scheduleEnd
  const minute = now.getHours() * 60 + now.getMinutes(), from = minuteOf(start), to = minuteOf(end)
  const inWindow = allDay || (from !== to && (from < to ? minute >= from && minute < to : minute >= from || minute < to))
  const windowStart = allDay ? atMinute(now, 0) : atMinute(now, from, from > to && minute < to ? -1 : 0)
  const windowDay = localDay(windowStart)
  const days = Array.isArray(record.startedDays) ? record.startedDays : []
  const ran = days.includes(windowDay) || record.lastStartedDay === windowDay
  const due = enabled && inWindow && !ran
  let nextRunAt = null
  if (enabled && (allDay || from !== to)) {
    let candidate = due ? new Date(now) : allDay ? atMinute(now, 0, 1) : atMinute(now, from, minute < from ? 0 : 1)
    // Clock rollback and restarts must not re-run an already consumed window.
    for (let i = 0; !due && i < 366 && (days.includes(localDay(candidate)) || record.lastStartedDay === localDay(candidate)); i++) candidate = atMinute(candidate, allDay ? 0 : from, 1)
    nextRunAt = candidate.toISOString()
  }
  return { enabled, allDay, start, end, inWindow, windowDay, due, ran, nextRunAt,
    lastStartedAt: record.lastStartedAt || null, lastStartedDay: record.lastStartedDay || null,
    lastError: record.lastError || '', lastAttemptAt: record.lastAttemptAt || null }
}

export function markDailyStarted(record = {}, windowDay, at = new Date(), runId = '') {
  return { ...record, lastStartedDay: windowDay, lastStartedAt: at.toISOString(), lastRunId: runId,
    startedDays: [...new Set([...(Array.isArray(record.startedDays) ? record.startedDays : []), windowDay])].sort().slice(-366), lastError: '' }
}

/** A failed spawn releases only its own attempt, never a later successful run. */
export function releaseDailyStart(record = {}, runId, error) {
  if (!runId || record.lastRunId !== runId) return record
  const day = record.lastStartedDay
  return { ...record, startedDays: (record.startedDays || []).filter(d => d !== day), lastStartedDay: null,
    lastStartedAt: null, lastRunId: '', lastError: String(error || 'spawn failed').slice(0, 300) }
}
