/** Bind role tools only to real agent.ctx registries. No global-schema fallback. */
export function createToolScopeRegistry({ ctx, enabled, log = () => {} }) {
  const definitions = new Map(), mounted = new Map()
  const invalidContexts = new WeakSet()
  let lastError = ''
  const scopedRegistry = agent => {
    try {
      const receiver = agent?.ctx, registry = receiver?.tools
      // A distinct ctx object does not prove isolation when an old adapter aliases the root service.
      return receiver && receiver !== ctx && registry && registry !== ctx.tools && !invalidContexts.has(receiver)
        && typeof registry.register === 'function' ? registry : null
    } catch { return null }
  }
  const dispose = value => { try { if (typeof value === 'function') value(); else value?.dispose?.() } catch (error) { log(String(error?.message ?? error)) } }
  const detach = agent => {
    const record = mounted.get(agent)
    if (!record) return
    for (const value of record.values()) dispose(value)
    mounted.delete(agent)
  }
  const refresh = agent => {
    if (!agent || !enabled(agent)) { detach(agent); return false }
    // Cordis resolves this service through the receiver ctx. Using ctx.tools at
    // plugin scope would register every schema in every normal conversation.
    const registry = scopedRegistry(agent)
    if (!registry) {
      lastError = '当前 DSH 未提供可确认的 agent.ctx.tools 会话作用域；已禁用对话内鲸鱼工具，未回退为全局工具。'
      detach(agent); return false
    }
    let record = mounted.get(agent)
    if (!record) { record = new Map(); mounted.set(agent, record) }
    for (const [name, definition] of definitions) {
      if (record.has(name)) continue
      try {
        const before = typeof ctx.tools?.get === 'function' ? ctx.tools.get(name) : undefined
        const off = registry.register(definition)
        // Old/adapted receivers must not silently route agent.ctx calls to the
        // root layer. The installed DSH exposes get(name, undefined) for this
        // exact global view; preserve any pre-existing foreign registration.
        if (typeof ctx.tools?.get === 'function' && ctx.tools.get(name) !== before) {
          dispose(off); invalidContexts.add(agent.ctx); detach(agent)
          throw new Error('宿主会话注册落入全局工具层，已撤回且禁用；请更新 DSH。')
        }
        record.set(name, off)
      }
      catch (error) { lastError = String(error?.message ?? error); log('鲸鱼工具会话挂载失败：' + lastError); if (invalidContexts.has(agent.ctx)) return false }
    }
    if (record.size === definitions.size) lastError = ''
    return record.size === definitions.size
  }
  const agents = () => { try { return ctx.get('agents')?.list?.() || [] } catch { return [] } }
  const refreshAll = () => { for (const agent of agents()) refresh(agent) }
  return {
    register(definition) { definitions.set(definition.name, definition); refreshAll(); return definition },
    refresh, detach, refreshAll,
    snapshot() {
      const live = agents()
      const supported = live.some(agent => Boolean(scopedRegistry(agent)))
      return { mode: 'session-scoped', supported, checked: live.length > 0, mountedSessions: mounted.size,
        toolCount: definitions.size, globalFallback: false,
        error: lastError || (live.length && !supported ? '当前 DSH 未提供 agent.ctx.tools；鲸鱼工具保持禁用，不会注入普通会话。' : '') }
    },
    dispose() { for (const agent of [...mounted.keys()]) detach(agent) },
  }
}
