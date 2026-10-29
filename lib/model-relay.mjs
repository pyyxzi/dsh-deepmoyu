/** Local, per-run capability bridge to the parent's already configured LLM adapters.
 * No credentials/profile copies, no route fallback, no public web endpoint. */
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { redactRecordText } from './record-privacy.mjs'
import { summarizeBackgroundDiagnostic } from './background-output.mjs'

export const RELAY_PROVIDER = 'dafeiyu-parent'
const MAX_BODY = 16 * 1024 * 1024
const fail = (message, code = 'MODEL_RELAY_ERROR') => Object.assign(new Error(message), { code })
export function splitModelRoute(route) {
  const value = String(route || '').trim(), slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1 || /\s/.test(value)) throw fail('模型要写成非空 provider/model', 'INVALID_MODEL_ROUTE')
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}
const num = value => Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0
export function usageTokens(usage) {
  if (!usage || !Number.isFinite(Number(usage.inputTokens)) || !Number.isFinite(Number(usage.outputTokens))) return null
  const input = num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens)
  const output = num(usage.outputTokens)
  return { input, output, total: Math.max(input + output, num(usage.totalTokens)) }
}
const errorText = e => redactRecordText(e?.message || String(e), { maxLength: 800 })
const wireError = e => ({ message: errorText(e), code: String(e?.code || 'MODEL_RELAY_ERROR').slice(0, 80) })
const jsonReply = (res, code, body) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) } }
const safeNotify = (fn, value) => { try { Promise.resolve(fn?.(value)).catch(() => {}) } catch { /* logging may never break a model call */ } }
function routeMessages(messages, route) {
  return messages.map(message => message?.role === 'assistant' && message.source?.provider === RELAY_PROVIDER
    ? { ...message, source: { ...message.source, provider: route.provider, model: route.model } } : message)
}

export function createModelRelay({ getLlm, onError } = {}) {
  const grants = new Map(), sockets = new Set()
  let closed = false, startupError = null
  const server = createServer((req, res) => { void handle(req, res).catch(error => jsonReply(res, 500, { error: wireError(error) })) })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.on('error', error => { startupError = error; safeNotify(onError, summarizeBackgroundDiagnostic(error).text) })
  server.listen(0, '127.0.0.1', () => server.unref())
  server.unref()
  const ready = new Promise(resolve => {
    server.once('listening', () => resolve(true))
    server.once('error', () => resolve(false))
  })
  async function handle(req, res) {
    // No browser origins, CORS or ambient cookie auth. Each child gets a revocable capability.
    if (req.method !== 'POST' || req.url !== '/call' || req.headers.origin) return jsonReply(res, 403, { error: { code: 'RELAY_FORBIDDEN', message: '模型桥接拒绝此请求' } })
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '')
    const grant = grants.get(token)
    if (!grant || !timingSafeEqual(Buffer.from(token), Buffer.from(grant.token)) || Date.now() >= grant.expiresAt) return jsonReply(res, 403, { error: { code: 'RELAY_EXPIRED', message: '后台模型凭据已撤销或过期，请重新开跑' } })
    const abort = new AbortController()
    grant.controllers.add(abort)
    const disconnected = () => { if (!res.writableEnded) abort.abort() }
    req.on('aborted', disconnected); res.on('close', disconnected)
    const deadline = setTimeout(() => abort.abort(), Math.max(1, grant.expiresAt - Date.now())); deadline.unref?.()
    let lastUsage = null, streamed = false, terminalFailure = false, modelRequest = false, toolRequest = false
    try {
      const parts = []; let bytes = 0
      for await (const part of req) {
        bytes += part.length
        if (bytes > MAX_BODY) throw fail('后台模型请求超过16MB限制', 'RELAY_BODY_LIMIT')
        parts.push(part)
      }
      abort.signal.throwIfAborted()
      let body
      try { body = JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { throw fail('模型桥接请求不是有效JSON', 'RELAY_INVALID_JSON') }
      if (body.action === 'tools-list') return jsonReply(res, 200, { tools: [...grant.tools.values()].map(({ execute, ...definition }) => definition) })
      if (body.action === 'tool-call') {
        toolRequest = true
        const tool = grant.tools.get(body.name)
        if (!tool) throw fail('本轮未授权该工具', 'BACKGROUND_TOOL_NOT_ALLOWED')
        const previous = grant.toolQueue
        let release
        grant.toolQueue = new Promise(resolve => { release = resolve })
        try {
          await previous
          abort.signal.throwIfAborted()
          if (grants.get(token) !== grant) throw fail('后台任务已停止', 'RELAY_EXPIRED')
          safeNotify(grant.onEvent, { stage: 'tool-start', text: '正在执行：' + tool.name })
          const value = await tool.execute(body.args, abort.signal)
          safeNotify(grant.onEvent, { stage: 'tool-done', text: '工具返回：' + tool.name, ok: value?.ok !== false && value?.success !== false && !value?.error })
          return jsonReply(res, 200, { value })
        } finally { release() }
      }
      if (grant.busy) throw fail('同一后台任务已有模型请求进行中', 'RELAY_BUSY')
      grant.busy = true; modelRequest = true
      const llm = getLlm?.()
      if (typeof llm?.resolveModelInfo !== 'function' || typeof llm?.prepareCall !== 'function') throw fail('宿主模型服务尚未就绪，未切换到其他线路', 'RELAY_NO_LLM')
      const route = grant.route
      if (body.action === 'resolve') {
        const info = await llm.resolveModelInfo(route.provider, route.model, abort.signal)
        return jsonReply(res, 200, { model: info })
      }
      if (body.action !== 'stream' || !Array.isArray(body.options?.messages)) throw fail('模型桥接请求缺少消息', 'RELAY_INVALID_REQUEST')
      const source = body.options
      const config = { provider: route.provider, model: route.model }
      for (const key of ['maxTokens', 'temperature', 'topP', 'reasoningEffort', 'stop']) if (source[key] !== undefined) config[key] = source[key]
      const prepared = await llm.prepareCall(config, abort.signal)
      // Whitelist fields; the child cannot inject parent attribution, credentials, route or file readers.
      const options = { ...prepared.config, messages: routeMessages(source.messages, route), signal: abort.signal }
      for (const key of ['systemPrompt', 'tools', 'toolChoice', 'toolHistory']) if (source[key] !== undefined) options[key] = source[key]
      safeNotify(grant.onEvent, { stage: 'model-start', text: '模型正在读上下文并作答' })
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      streamed = true
      const toolNames = new Set()
      for await (const chunk of prepared.stream(options)) {
        abort.signal.throwIfAborted()
        if (chunk?.type === 'usage') lastUsage = usageTokens(chunk.usage)
        const tool = chunk?.type === 'tool-call-delta' ? chunk.name : chunk?.type === 'block-end' && chunk.block?.type === 'tool-call' ? chunk.block.name : ''
        if (tool && !toolNames.has(tool)) {
          toolNames.add(tool)
          safeNotify(grant.onEvent, { stage: 'tool', text: '模型请求工具：' + String(tool).replace(/[^\w.:-]/g, '').slice(0, 100) })
        }
        if (chunk?.type === 'finish' && ['error', 'aborted'].includes(chunk.reason?.kind)) {
          terminalFailure = true
          safeNotify(grant.onEvent, { stage: 'model-error', ...summarizeBackgroundDiagnostic(chunk.reason.failure || chunk.reason.kind) })
        }
        const wire = chunk?.error instanceof Error ? { ...chunk, error: wireError(chunk.error) } : chunk
        if (!res.write(JSON.stringify({ chunk: wire }) + '\n')) await once(res, 'drain', { signal: abort.signal })
      }
      if (!terminalFailure) safeNotify(grant.onEvent, { stage: 'model-done', text: '模型响应结束', tokens: lastUsage })
      res.end(JSON.stringify({ done: true }) + '\n')
    } catch (error) {
      safeNotify(grant.onEvent, { stage: toolRequest ? 'tool-error' : 'model-error', ...summarizeBackgroundDiagnostic(error) })
      if (res.headersSent) { if (!res.destroyed) res.end(JSON.stringify({ error: wireError(error) }) + '\n') }
      else jsonReply(res, 400, { error: wireError(error) })
    } finally {
      if (lastUsage) safeNotify(grant.onUsage, lastUsage)
      else if (streamed) safeNotify(grant.onEvent, { stage: 'usage-unknown', text: '本次响应没有返回可信用量，账本保留未计量' })
      clearTimeout(deadline); grant.controllers.delete(abort); if (modelRequest) grant.busy = false
      req.off('aborted', disconnected); res.off('close', disconnected)
    }
  }
  return {
    ready,
    get listening() { return server.listening && !closed && !startupError },
    open(model, { expiresAt, onUsage, onEvent, tools = [] } = {}) {
      if (closed || startupError || !server.listening) throw fail('后台模型桥接尚未就绪，请稍后重试；不会自动换模型', 'RELAY_NOT_READY')
      const route = splitModelRoute(model), llm = getLlm?.()
      if (!llm?.listProviders?.().some(provider => provider.id === route.provider)) throw fail(`当前宿主也没有注册模型线路 ${route.provider}，请先连接该线路；未切换其他模型`, 'NO_ADAPTER')
      const token = randomBytes(32).toString('hex')
      const grant = { token, route, expiresAt: Number(expiresAt) || Date.now() + 45 * 60_000, onUsage, onEvent, tools: new Map(tools.map(tool => [tool.name, tool])), toolQueue: Promise.resolve(), busy: false, controllers: new Set() }
      grants.set(token, grant)
      return {
        env: { BILI_DUTY_RELAY_URL: `http://127.0.0.1:${server.address().port}/call`, BILI_DUTY_RELAY_CAPABILITY: token, BILI_DUTY_RELAY_MODEL: model },
        revoke() { grants.delete(token); for (const abort of grant.controllers) abort.abort(); grant.controllers.clear() },
      }
    },
    close() {
      closed = true
      for (const grant of grants.values()) for (const abort of grant.controllers) abort.abort()
      grants.clear(); server.close(); for (const socket of sockets) socket.destroy()
    },
  }
}
