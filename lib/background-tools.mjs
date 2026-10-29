/** Adapt the host fish tools for a per-run MCP capability, not a general tool executor. */
export function backgroundToolNames(cfg = {}) {
  const names = ['bili_whoami', 'bili_search', 'bili_subtitle', 'bili_comments', 'bili_video_info', 'bili_danmaku', 'bili_buzzwords', 'bili_rank', 'bili_hot_videos', 'bili_user_videos', 'bili_seen', 'bili_say', 'bili_pace', 'bili_my_notices', 'bili_my_dynamics', 'bili_opus_comments', 'bili_my_video_comments', 'bili_learn', 'bili_soul', 'bili_taste', 'bili_records', 'bili_sticker']
  if (cfg.autoComment || cfg.replyToComments) names.push('bili_reply', 'bili_reply_opus')
  if (cfg.replyToComments) names.push('bili_received_replies')
  if (cfg.autoMoment) names.push('bili_moment')
  if (cfg.autoReplyDm) names.push('bili_dm_inbox', 'bili_dm_thread', 'bili_dm_reply')
  if (['only', 'both'].includes(cfg.dmMode) && cfg.dmUid) names.push('bili_deliver')
  return names
}
export function toolInputSchema(parameters = {}) {
  const properties = {}, required = []
  for (const [key, field] of Object.entries(parameters)) {
    // force is direct-human authorization, never available in an unattended run.
    if (key === 'force') continue
    const { required: mandatory, ...schema } = field
    properties[key] = schema
    if (mandatory) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}
export function validateToolArguments(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('BACKGROUND_TOOL_ARGUMENTS_REQUIRED')
  for (const key of Object.keys(args)) if (!Object.hasOwn(schema.properties, key)) throw new Error('BACKGROUND_TOOL_UNKNOWN_ARGUMENT: ' + key)
  for (const key of schema.required) if (!Object.hasOwn(args, key) || args[key] === null) throw new Error('BACKGROUND_TOOL_REQUIRED_ARGUMENT: ' + key)
  const out = {}
  for (const [key, value] of Object.entries(args)) {
    if (value === null) continue // optional strict-mode nullable sentinel
    const field = schema.properties[key]
    const good = field.type === 'array' ? Array.isArray(value) && value.every(x => typeof x === (field.items?.type || 'string')) : field.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === field.type
    if (!good || (field.enum && !field.enum.includes(value))) throw new Error('BACKGROUND_TOOL_INVALID_ARGUMENT: ' + key)
    out[key] = value
  }
  return out
}
export function exposeBackgroundTools(registry, cfg, execute) {
  return backgroundToolNames(cfg).filter(name => registry.has(name)).map(name => {
    const spec = registry.get(name), inputSchema = toolInputSchema(spec.parameters)
    return { name, description: spec.description, inputSchema, execute: async (args, signal) => execute(name, validateToolArguments(inputSchema, args), signal) }
  })
}
