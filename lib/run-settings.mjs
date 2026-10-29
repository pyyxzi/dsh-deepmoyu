/** Independent persisted defaults and immutable options for each pet run. */
export const RUN_DEFAULTS = Object.freeze({
  sessionModelId: '', sessionTokenBudget: 0, sessionMaxRounds: 64, sessionMinutes: 0,
  backgroundModelId: '', backgroundTokenBudget: 0, backgroundMinutes: 45,
  backgroundWindowStart: '', backgroundWindowEnd: '',
})
export const RUN_LIMITS = Object.freeze({
  sessionTokenBudget: [0, 5_000_000], sessionMaxRounds: [1, 1000], sessionMinutes: [0, 1440],
  backgroundTokenBudget: [0, 5_000_000], backgroundMinutes: [1, 180],
})
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key)
const number = (value, fallback, lo, hi) => {
  const n = Number(value)
  return Math.max(lo, Math.min(Number.isFinite(n) ? Math.floor(n) : fallback, hi))
}
const model = (value) => String(value ?? '').trim().slice(0, 200)

/** Legacy shared values seed only keys which have never been stored separately. */
export function migrateRunSettings(source = {}, legacy = {}) {
  const out = { ...source }
  const old = { ...legacy, ...source }
  const seeds = {
    ...RUN_DEFAULTS, sessionModelId: old.modelId ?? '', backgroundModelId: old.modelId ?? '',
    sessionTokenBudget: old.tokenBudget ?? 0, backgroundTokenBudget: old.tokenBudget ?? 0,
    sessionMaxRounds: old.maxRounds ?? 64,
  }
  for (const [key, value] of Object.entries(seeds)) if (!own(source, key)) out[key] = value
  return clampRunSettings(out)
}

export function clampRunSettings(patch = {}) {
  const out = { ...patch }
  for (const key of ['backgroundWindowStart', 'backgroundWindowEnd']) if (own(out, key)) {
    const value = typeof out[key] === 'string' ? out[key].trim() : ''
    const parsed = parseHM(value)
    out[key] = parsed ? `${String(parsed.h).padStart(2, '0')}:${String(parsed.m).padStart(2, '0')}` : ''
  }
  for (const key of ['sessionModelId', 'backgroundModelId']) if (own(out, key)) out[key] = model(out[key])
  for (const [key, [lo, hi]] of Object.entries(RUN_LIMITS)) {
    if (own(out, key)) out[key] = number(out[key], RUN_DEFAULTS[key], lo, hi)
  }
  return out
}

/** A request overrides one run, never the other mode's saved defaults. */
export function resolveRunOptions(cfg = {}, mode = 'session', request = {}) {
  const base = migrateRunSettings(cfg)
  const background = mode === 'background'
  const prefix = background ? 'background' : 'session'
  return {
    model: model(own(request, 'model') ? request.model : base[prefix + 'ModelId']),
    tokenBudget: number(own(request, 'tokenBudget') ? request.tokenBudget : base[prefix + 'TokenBudget'], 0, 0, 5_000_000),
    maxRounds: background ? 1 : number(own(request, 'maxRounds') ? request.maxRounds : base.sessionMaxRounds, 64, 1, 1000),
    durationMinutes: number(own(request, 'durationMinutes') ? request.durationMinutes : base[prefix + 'Minutes'], background ? 45 : 0, background ? 1 : 0, background ? 180 : 1440),
    tokenBudgetEnforcement: background ? 'advisory' : 'round-boundary',
    maxRoundsEnforcement: background ? 'single-run' : 'goal-driver',
    durationEnforcement: background ? 'wall-clock' : 'wall-clock-pause',
  }
}

/** Timer wrapper is injectable so tests never start a real worker or wait minutes. */
export function scheduleRunDeadline(deadlineAt, expire, timers = globalThis) {
  const deadline = Number(deadlineAt) || 0
  if (!deadline) return null
  const timer = timers.setTimeout(expire, Math.max(0, deadline - Date.now()))
  timer?.unref?.()
  return timer
}

/** ⭐ 2026-10-28 后台「时段」任务：指定 start–end（HH:MM），段内一直刷而不是只跑一轮。
 *  这些是纯函数，单测直接覆盖（含跨午夜段）。 */
export function parseHM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!m) return null
  const h = Number(m[1]), min = Number(m[2])
  return h <= 23 && min <= 59 ? { h, m: min } : null
}

/**
 * 时段的**绝对结束时间戳**（ms）。start==end 或解析失败 ⇒ null。
 * 跨午夜段（end ≤ start）：启动时刻在 start 之后（晚间主体）⇒ end 在次日；
 * 启动时刻在 start 之前（半夜重启、接着刷尾段）⇒ end 就在今天。
 */
export function backgroundWindowEndAt(start, end, now = new Date()) {
  const s = parseHM(start), e = parseHM(end)
  if (!s || !e || (s.h === e.h && s.m === e.m)) return null
  const d = new Date(now)
  d.setHours(e.h, e.m, 0, 0)
  const cur = now.getHours() * 60 + now.getMinutes()
  if (e.h * 60 + e.m <= s.h * 60 + s.m && cur >= s.h * 60 + s.m) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** now 是否在 [start, end) 段内（支持跨午夜；start==end 视为没配时段）。 */
export function backgroundWindowActive(start, end, now = new Date()) {
  const s = parseHM(start), e = parseHM(end)
  if (!s || !e || (s.h === e.h && s.m === e.m)) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  const sm = s.h * 60 + s.m, em = e.h * 60 + e.m
  return sm < em ? cur >= sm && cur < em : cur >= sm || cur < em
}

/**
 * ⭐ 时段任务的「这一跳要不要拉起鱼」决策（纯函数，集成行为靠单测钉死）。
 * 段没配/不在段内/挂着免跑牌（st.bgWindowHold）/段已结束 ⇒ null；否则 { endAt, remainMin }。
 */
export function backgroundWindowLaunch(cfg = {}, st = {}, now = new Date()) {
  const start = String(cfg.backgroundWindowStart || '').trim()
  const end = String(cfg.backgroundWindowEnd || '').trim()
  if (!start || !end || !backgroundWindowActive(start, end, now)) return null
  const hold = Number(st.bgWindowHold) || 0
  if (hold > now.getTime()) return null
  const endAt = backgroundWindowEndAt(start, end, now)
  if (!endAt || endAt <= now.getTime()) return null
  return { endAt, remainMin: Math.max(1, Math.ceil((endAt - now.getTime()) / 60_000)) }
}
