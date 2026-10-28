/** Headless-only adapter: stream the selected exact route through the parent process.
 * Environment capability never enters YAML, logs, a tool result or the browser. */
import { RELAY_PROVIDER, splitModelRoute } from './model-relay.mjs'

export const name = 'dafeiyu-model-relay'
export const inject = ['llm']
const fail = (message, code = 'MODEL_RELAY_ERROR') => Object.assign(new Error(message), { code })
export function createRelayClient(env = process.env, request = globalThis.fetch) {
  const endpoint = new URL(env.BILI_DUTY_RELAY_URL || 'http://127.0.0.1:0/call')
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/call' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.port === '0') throw fail('模型桥接必须是本机回环地址', 'RELAY_INVALID_URL')
  const token = String(env.BILI_DUTY_RELAY_CAPABILITY || '')
  if (!/^[a-f0-9]{64}$/.test(token)) throw fail('后台模型凭据缺失，请从桌宠重新开跑', 'RELAY_NO_CAPABILITY')
  const selected = String(env.BILI_DUTY_RELAY_MODEL || '')
  splitModelRoute(selected)
  const post = async (body, signal) => {
    const response = await request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body), signal, redirect: 'error' })
    if (!response.ok) { const detail = await response.json().catch(() => ({})); throw fail(detail.error?.message || `后台模型桥接HTTP ${response.status}`, detail.error?.code) }
    return response
  }
  return { selected, post }
}
export function createRelayAdapter(env = process.env, request = globalThis.fetch) {
  const { selected, post } = createRelayClient(env, request)
  const check = (provider, model) => { if (provider !== RELAY_PROVIDER || model !== selected) throw fail('后台模型路线与本次授权不一致', 'RELAY_ROUTE_MISMATCH') }
  const resolveModel = async (provider, model, signal) => {
    check(provider, model)
    const result = await (await post({ action: 'resolve' }, signal)).json()
    if (!result.model?.name) throw fail('宿主没有返回模型信息', 'RELAY_INVALID_MODEL_INFO')
    return { ...result.model, provider: RELAY_PROVIDER, id: selected }
  }
  async function* stream(options) {
    check(options.provider, options.model)
    const data = { messages: options.messages }
    for (const key of ['maxTokens', 'temperature', 'topP', 'reasoningEffort', 'stop', 'systemPrompt', 'tools', 'toolChoice', 'toolHistory']) if (options[key] !== undefined) data[key] = options[key]
    const response = await post({ action: 'stream', options: data }, options.signal)
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let pending = '', ended = false
    const parse = line => {
      const row = JSON.parse(line)
      if (row.error) throw fail(row.error.message, row.error.code)
      return row
    }
    try {
      while (true) {
        const part = await reader.read()
        pending += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true })
        if (pending.length > 16 * 1024 * 1024) throw fail('模型桥接行过长', 'RELAY_FRAME_LIMIT')
        let newline
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
          if (!line) continue
          const row = parse(line)
          if (row.chunk) yield row.chunk
          if (row.done) { ended = true; return }
        }
        if (part.done) break
      }
      if (!ended) throw fail('后台模型连接提前结束，未自动重发', 'RELAY_STREAM_CLOSED')
    } finally { try { await reader.cancel() } catch { /* abort closes parent request */ }; reader.releaseLock() }
  }
  return {
    providerInfo: () => ({ id: RELAY_PROVIDER, name: '鲸鱼摸鱼 · 主进程同模型桥接' }),
    // Child must not replay a possibly sent request. The real provider retains its own retry policy.
    providerRetryPolicy: () => ({ mode: 'normal', maxRetries: 0, retryableCodes: ['MODEL_RELAY_ERROR'], initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 }),
    listModels: async provider => [await resolveModel(provider, selected)],
    resolveModel,
    prepareCall: async (provider, model, signal) => ({ model: await resolveModel(provider, model, signal), stream }),
    stream,
  }
}
export function apply(ctx) {
  if (process.env.BILI_DUTY_ROLE !== 'background' || !process.env.BILI_DUTY_HOME) throw fail('模型桥接只供明确启动的后台任务使用', 'RELAY_INVALID_ROLE')
  const adapter = createRelayAdapter()
  ctx.effect(() => ctx.llm.registerAdapter([RELAY_PROVIDER], adapter), 'dafeiyu: parent model relay')
}
