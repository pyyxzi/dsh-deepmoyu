/** Presentation preferences never change browsing, account permissions or send gates. */
export const COMPANION_DEFAULTS = Object.freeze({
  idleChatter: true,
  chatterFrequency: 'normal', notificationLevel: 'normal', focusMode: false,
  quietHoursEnabled: false, quietHoursStart: '23:00', quietHoursEnd: '08:00', petReducedMotion: false,
})
const choices = { chatterFrequency: ['rare', 'normal', 'lively'], notificationLevel: ['minimal', 'normal', 'all'] }
const clock = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
export function clampCompanionSettings(patch = {}) {
  const out = { ...patch }
  for (const [key, list] of Object.entries(choices)) if (Object.hasOwn(out, key) && !list.includes(out[key])) out[key] = COMPANION_DEFAULTS[key]
  for (const key of ['idleChatter', 'focusMode', 'quietHoursEnabled', 'petReducedMotion']) if (Object.hasOwn(out, key) && typeof out[key] !== 'boolean') out[key] = COMPANION_DEFAULTS[key]
  for (const key of ['quietHoursStart', 'quietHoursEnd']) if (Object.hasOwn(out, key) && !clock(out[key])) out[key] = COMPANION_DEFAULTS[key]
  return out
}
export function companionPolicy(config = {}, now = new Date()) {
  const cfg = { ...COMPANION_DEFAULTS, ...clampCompanionSettings(config) }
  const minutes = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3))
  const start = minutes(cfg.quietHoursStart), end = minutes(cfg.quietHoursEnd)
  const at = now.getHours() * 60 + now.getMinutes()
  const quiet = cfg.quietHoursEnabled && start !== end && (start < end ? at >= start && at < end : at >= start || at < end)
  const focus = cfg.focusMode === true
  const ranges = { rare: [240, 360], normal: [132, 210], lively: [45, 90] }
  const range = ranges[cfg.chatterFrequency]
  return {
    quiet, focus, silenced: quiet || focus, reason: focus ? '专注模式' : quiet ? '夜间安静时段' : '',
    chatterAllowed: cfg.idleChatter !== false && !quiet && !focus,
    notificationLevel: cfg.notificationLevel, reducedMotion: cfg.petReducedMotion,
    chatterMinMinutes: range[0], chatterMaxMinutes: range[1],
    label: focus ? '专注陪伴' : quiet ? '夜间安静' : cfg.idleChatter === false ? '闲聊已关闭' : '自然陪伴',
  }
}
export function nextChatterAt(config = {}, now = Date.now(), random = Math.random()) {
  const policy = companionPolicy(config, new Date(now))
  const fraction = Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 0.5
  return now + (policy.chatterMinMinutes + fraction * (policy.chatterMaxMinutes - policy.chatterMinMinutes)) * 60_000
}
export function companionPrompt(config = {}, now = new Date()) {
  const policy = companionPolicy(config, now)
  return policy.silenced
    ? `【陪伴节奏】目前是${policy.reason}，少闲聊、少追问，完成结果和需要本人决定的事情仍要清楚反馈。运行任务、发送权限与原有安全闸照旧。`
    : '【陪伴节奏】只在有具体发现或需要接话时自然开口，不为显示在线编造观看、发言或心情经历。'
}
