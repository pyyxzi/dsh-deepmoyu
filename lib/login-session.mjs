/** One explicit login generation owns credential writes; late polls cannot replace a newer account. */
export function createLoginSession({ start, poll, save, now = Date.now, ttlMs = 180_000 }) {
  let generation = 0, active = null, disposed = false
  const expired = () => ({ state: 'expired', message: '登录请求已失效，请使用最新二维码重新登录。' })
  const current = attempt => !disposed && active === attempt && now() < attempt.expiresAt
  return {
    async start() {
      if (disposed) throw new Error('登录服务已关闭')
      const id = ++generation; active = null
      const result = await start()
      if (disposed || generation !== id) throw new Error('登录请求已被新的二维码替代')
      if (typeof result?.key !== 'string' || !result.key || result.key.length > 512) throw new Error('二维码登录响应缺少有效 key')
      active = Object.freeze({ ...result, generation: id, expiresAt: now() + ttlMs })
      return active
    },
    current,
    async poll(key) {
      const attempt = active
      if (typeof key !== 'string' || !key || key.length > 512 || !attempt || key !== attempt.key || !current(attempt)) return expired()
      const result = await poll(key)
      if (!current(attempt)) return expired()
      if (result?.state === 'ok') {
        const credential = result.credential
        if (!credential || typeof credential.sessdata !== 'string' || !credential.sessdata || typeof credential.bili_jct !== 'string' || !credential.bili_jct) return { state: 'unknown', message: '登录凭证不完整，未替换本机账号。' }
        const file = save(credential)
        active = null
        return { state: 'ok', file }
      }
      if (result?.state === 'expired') active = null
      return { state: result?.state || 'unknown', code: result?.code, message: result?.message || '' }
    },
    dispose() { disposed = true; generation++; active = null },
  }
}
