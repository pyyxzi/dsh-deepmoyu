/** Model-authored arguments are preferences, never evidence of human authorization. */
export const MODEL_CONFIG_KEYS = Object.freeze([
  'focus', 'keywords', 'reportLevel', 'perDay', 'momentStyle', 'interactionStyle',
  'idleChatter', 'chatterFrequency', 'notificationLevel', 'focusMode',
  'quietHoursEnabled', 'quietHoursStart', 'quietHoursEnd', 'petReducedMotion', 'petShow',
])
const permitted = new Set(MODEL_CONFIG_KEYS)
export function modelConfigDecision(patch) {
  const keys = Object.keys(patch || {})
  if (keys.includes('persona')) return { ok: false, code: 'PERSONA_MANUAL_ONLY', error: '全局人格只能由本人在工作台保存；角色工具不能改写或清空本人的人格设置。' }
  if (keys.includes('sendReview')) return { ok: false, code: 'SEND_REVIEW_MANUAL_ONLY', error: '发送预览开关只能由本人在工作台 → 互动与投递中修改。' }
  if (keys.includes('stickerReview')) return { ok: false, code: 'STICKER_REVIEW_MANUAL_ONLY', error: '表情人工审核开关只能由本人在工作台 → 记忆与素材中修改。' }
  // 📝 视频发布者提示词（2026-11-20）：拾取方式决定"要不要回复别人的评论"，属于发送策略 —— 模型不得碰。
  //    这两个键也**故意不在 MODEL_CONFIG_KEYS 白名单里**（漏网会落到下面的通用拦截，这里是给它更明白的报错）。
  if (keys.includes('ownerPromptMode') || keys.includes('ownerPromptSources')) {
    return { ok: false, code: 'OWNER_PROMPT_MANUAL_ONLY', blockedKeys: keys.filter(k => k === 'ownerPromptMode' || k === 'ownerPromptSources'),
      error: '视频发布者提示词的拾取设置（ownerPromptMode/ownerPromptSources）只能由本人在工作台 → 互动与投递中修改；模型不能改动。拾取到的提示词内容本身在工具回执 owner_prompt 字段里，直接读即可。' }
  }
  const blockedKeys = keys.filter(key => !permitted.has(key))
  return blockedKeys.length ? { ok: false, code: 'AUTHORIZATION_MANUAL_ONLY', blockedKeys,
    error: '发送授权、收件人、防护、预算、自动任务和执行环境配置只能由本人在工作台修改；模型只能调整内容与陪伴偏好。' } : { ok: true }
}
export function modelForceDecision(args) {
  return args && Object.hasOwn(args, 'force') && args.force !== false
    ? { ok: false, blocked: true, code: 'FORCE_NOT_AUTHORIZATION', error: '模型提供的 force 参数不是本人授权，不能绕过发送开关、审核、判重或节奏。请在工作台启用发送预览并由本人逐条批准，或手动调整发送权限。' }
    : null
}
