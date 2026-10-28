/** New pet sessions use the Host's real SessionCreateRequest and session-local permission APIs. */
import { DAFEIYU_PRESET_ID } from './mode.mjs'

const MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const APPROVALS = new Set(['ask', 'never'])
const service = (ctx, key) => { try { return ctx?.get?.(key) } catch { return undefined } }
const contextId = (body, key) => {
  const value = body?.[key]
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || value.length > 400) throw new Error(`${key} 必须是有效的会话或工作区 ID`)
  return value.trim()
}
const sessionContext = (ctx, source) => ({ get: key => service(source?.agent?.ctx, key) ?? service(ctx, key) })

async function sourceSession(ctx, controller, id) {
  if (!id) return null
  let agent = service(ctx, 'agents')?.get?.(id)
  let session = agent?.session ?? service(ctx, 'sessions')?.get?.(id)
  if (!session && typeof controller.resolveAgent === 'function') {
    const resolved = await controller.resolveAgent(id)
    if (resolved?.error) throw resolved.error
    agent = resolved?.agent
    session = agent?.session
  }
  if (!session) throw new Error('找不到当前会话，请切回会话后重新打开桌宠')
  return { agent, session }
}

/** Read effective Host state; no caller-supplied permission values are accepted. */
function permissionsOf(ctx, session) {
  if (!session) return {}
  const presets = service(ctx, 'permissionPresets')
  const preset = typeof presets?.current === 'function' ? presets.current(session) : undefined
  let spec
  if (preset && preset !== 'custom' && typeof presets?.resolve === 'function') spec = presets.resolve(preset)
  const state = service(ctx, 'sessionProjections')?.stateOf?.(session, 'permissions')
  const sandbox = service(ctx, 'sandboxPolicy')?.resolve?.({ session })?.mode ?? state?.sandbox ?? spec?.sandbox
  const approval = service(ctx, 'approval')?.effectivePolicy?.(session) ?? state?.approval ?? spec?.approval
  return { ...(typeof preset === 'string' ? { preset } : {}),
    ...(MODES.has(sandbox) ? { sandbox } : {}), ...(APPROVALS.has(approval) ? { approval } : {}) }
}

function inheritPermissions(ctx, source, target) {
  if (!source.sandbox && !source.approval && !source.preset) return false
  if (!target || typeof target.append !== 'function') throw new Error('会话已创建，但宿主没有可写的会话权限接口；请手动检查该会话权限')
  const presets = service(ctx, 'permissionPresets')
  let appliedPreset = false
  if (source.preset && source.preset !== 'custom' && typeof presets?.set === 'function' && typeof presets?.resolve === 'function') {
    const spec = presets.resolve(source.preset)
    const matchesApproval = !source.approval || spec.approval === source.approval || source.preset === 'auto' && source.approval === 'never' && spec.approval === 'ask'
    if ((!source.sandbox || spec.sandbox === source.sandbox) && matchesApproval) {
      // permissionPresets.set is the Host's current-session setting API; it does not change future defaults.
      // Auto must keep its identity/admission check even when the source has the delegated "never" pin.
      presets.set(target, source.preset)
      appliedPreset = true
    }
  }
  if (source.preset === 'auto' && !appliedPreset) throw new Error('会话已创建，但无法保留当前会话的 Auto 审核权限；请手动检查该会话权限')
  const before = permissionsOf(ctx, target)
  // These are exactly the canonical setters' durable events (also used by Host subagent inheritance).
  // A custom combination has no selectable preset; never log the reserved derived identity "custom".
  if (source.sandbox && source.sandbox !== before.sandbox) target.append('sandbox/mode', { mode: source.sandbox })
  if (source.approval && source.approval !== before.approval) target.append('approval/policy', { policy: source.approval })
  const after = permissionsOf(ctx, target)
  for (const key of ['sandbox', 'approval']) if (source[key] && after[key] && after[key] !== source[key]) {
    throw new Error(`会话已创建，但 ${key} 权限继承未生效；请手动检查该会话权限`)
  }
  return true
}

/**
 * Host create accepts workspaceId OR cwd (never workspaceDir/workingDirectory or permission knobs).
 * Browser sends its selected sourceSessionId and, when known, owning workspaceId.
 * With no browser context, only a matching fallback directory or an unambiguous Workspace is usable.
 */
export async function createPetSession(ctx, controller, body = {}, { fallbackCwd = process.cwd() } = {}) {
  const sourceId = contextId(body, 'sourceSessionId'), workspaceId = contextId(body, 'workspaceId')
  const source = await sourceSession(ctx, controller, sourceId)
  const registry = service(ctx, 'workspaceRegistry')
  const workspaces = registry?.list?.() ?? []
  let owner = sourceId ? workspaces.find(workspace => workspace.sessionIds?.includes(sourceId)) : undefined
  if (!owner && source?.session.header?.cwd && typeof registry?.resolveByPath === 'function') owner = await registry.resolveByPath(source.session.header.cwd)
  let workspace = workspaceId ? registry?.get?.(workspaceId) : owner
  if (workspaceId && !workspace) throw new Error('找不到当前工作区，请刷新工作区列表后重试')
  if (workspaceId && owner && owner.id !== workspace.id) throw new Error('当前会话与工作区不一致，请重试')
  let cwd = source?.session.header?.cwd || fallbackCwd
  if (!workspace && !source) {
    if (cwd && typeof registry?.resolveByPath === 'function') workspace = await registry.resolveByPath(cwd)
    if (!workspace && workspaces.length === 1) workspace = workspaces[0]
    if (!workspace && workspaces.length > 1) throw new Error('无法确定当前工作区，请从当前会话重新打开桌宠')
  }
  if (workspace) cwd = workspace.path
  if (!cwd) throw new Error('无法确定新会话的工作目录，请先打开一个工作区会话')
  const inherited = permissionsOf(sessionContext(ctx, source), source?.session)
  const request = { agentPreset: DAFEIYU_PRESET_ID, ...(workspace ? { workspaceId: workspace.id } : { cwd }) }
  const result = await controller.create(request)
  const sessionId = String(result?.sessionId || '')
  if (!sessionId) throw new Error('会话建出来了但没拿到 sessionId')
  const agent = service(ctx, 'agents')?.get?.(sessionId)
  const target = agent?.session ?? service(ctx, 'sessions')?.get?.(sessionId)
  const targetCtx = sessionContext(ctx, { agent })
  let didInherit
  try { didInherit = source ? inheritPermissions(targetCtx, inherited, target) : false }
  catch (error) { error.sessionId = sessionId; throw error }
  return { ok: true, sessionId, preset: DAFEIYU_PRESET_ID, cwd,
    ...(workspace ? { workspaceId: workspace.id } : {}),
    permissions: { ...permissionsOf(targetCtx, target), inherited: didInherit } }
}
