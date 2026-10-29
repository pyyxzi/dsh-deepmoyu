/** Model-authored arguments are preferences, never evidence of human authorization. */
export const MODEL_CONFIG_KEYS = Object.freeze([
  'persona', 'focus', 'keywords', 'reportLevel', 'perDay', 'momentStyle', 'interactionStyle',
  'idleChatter', 'chatterFrequency', 'notificationLevel', 'focusMode',
  'quietHoursEnabled', 'quietHoursStart', 'quietHoursEnd', 'petReducedMotion', 'petShow',
])
const permitted = new Set(MODEL_CONFIG_KEYS)
export function modelConfigDecision(patch) {
  const keys = Object.keys(patch || {})
  if (keys.includes('sendReview')) return { ok: false, code: 'SEND_REVIEW_MANUAL_ONLY', error: '发送预览开关只能由本人在工作台 → 互动与投递中修改。' }
  if (keys.includes('stickerReview')) return { ok: false, code: 'STICKER_REVIEW_MANUAL_ONLY', error: '表情人工审核开关只能由本人在工作台 → 记忆与素材中修改。' }
  const blockedKeys = keys.filter(key => !permitted.has(key))
  return blockedKeys.length ? { ok: false, code: 'AUTHORIZATION_MANUAL_ONLY', blockedKeys,
    error: '发送授权、收件人、防护、预算、自动任务和执行环境配置只能由本人在工作台修改；模型只能调整内容与陪伴偏好。' } : { ok: true }
}
export function modelForceDecision(args) {
  return args && Object.hasOwn(args, 'force') && args.force !== false
    ? { ok: false, blocked: true, code: 'FORCE_NOT_AUTHORIZATION', error: '模型提供的 force 参数不是本人授权，不能绕过发送开关、审核、判重或节奏。请在工作台启用发送预览并由本人逐条批准，或手动调整发送权限。' }
    : null
}
