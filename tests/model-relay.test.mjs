import test from 'node:test'
import assert from 'node:assert/strict'
import { createModelRelay, RELAY_PROVIDER, splitModelRoute, usageTokens } from '../lib/model-relay.mjs'
import { createRelayAdapter, createRelayClient } from '../lib/model-relay-adapter.mjs'

const model = 'buddy/glm-5.3-flash'
function fakeLlm(overrides = {}) {
  const calls = []
  return {
    calls,
    listProviders: () => [{ id: 'buddy', name: 'Buddy' }],
    async resolveModelInfo(provider, id) { return { provider, id, name: id, context: { contextWindow: 131072 }, defaultMaxTokens: 8192 } },
    async prepareCall(config, signal) {
      calls.push({ config, signal })
      return { config: { ...config, maxTokens: config.maxTokens || 8192 }, async *stream(options) {
        assert.equal(options.provider, 'buddy'); assert.equal(options.model, 'glm-5.3-flash')
        assert.equal(options.maxTokens, 8192)
        assert.equal(options.messages[0].source.provider, 'buddy')
        assert.equal(options.messages[0].source.model, 'glm-5.3-flash')
        assert.equal(options.attribution, undefined)
        yield { type: 'text-delta', index: 0, text: '小鱼找到一条！' }
        yield { type: 'tool-call-delta', index: 1, id: 'call-a', name: 'bili_search', argumentsDelta: '{}' }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20 } }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 6, cacheReadTokens: 20, totalTokens: 36 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } }
    },
    ...overrides,
  }
}
const messages = [{ role: 'assistant', source: { kind: 'model', provider: RELAY_PROVIDER, model, replayState: { ok: true } }, content: [{ type: 'text', text: 'old reply' }] }]

test('parent relay streams the exact configured model with prepared defaults and final usage once', async () => {
  const usage = [], events = [], llm = fakeLlm()
  const relay = createModelRelay({ getLlm: () => llm })
  try {
    assert.equal(await relay.ready, true)
    const grant = relay.open(model, { onUsage: x => usage.push(x), onEvent: x => events.push(x) })
    const adapter = createRelayAdapter(grant.env)
    const info = await adapter.resolveModel(RELAY_PROVIDER, model)
    assert.equal(info.provider, RELAY_PROVIDER); assert.equal(info.id, model); assert.equal(info.context.contextWindow, 131072)
    const prepared = await adapter.prepareCall(RELAY_PROVIDER, model)
    const chunks = []
    for await (const chunk of prepared.stream({ provider: RELAY_PROVIDER, model, messages, attribution: { sessionId: 'not-forwarded' } })) chunks.push(chunk)
    assert.equal(chunks[0].text, '小鱼找到一条！')
    assert.deepEqual(llm.calls[0].config, { provider: 'buddy', model: 'glm-5.3-flash' })
    assert.deepEqual(usage, [{ input: 30, output: 6, total: 36 }])
    assert.ok(events.some(e => e.stage === 'tool' && /bili_search/.test(e.text)))
    assert.ok(events.some(e => e.stage === 'model-done'))
    assert.equal(adapter.providerRetryPolicy().maxRetries, 0)
    grant.revoke()
    await assert.rejects(adapter.resolveModel(RELAY_PROVIDER, model), /撤销或过期/)
  } finally { relay.close() }
})

test('capabilities reject browser origins, unauthorized use, route override, and unavailable parent adapters', async () => {
  const relay = createModelRelay({ getLlm: () => fakeLlm() })
  try {
    await relay.ready
    assert.throws(() => relay.open('other/model'), /没有注册/)
    const grant = relay.open(model)
    const url = grant.env.BILI_DUTY_RELAY_URL, auth = 'Bearer ' + grant.env.BILI_DUTY_RELAY_CAPABILITY
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 403)
    assert.equal((await fetch(url, { method: 'POST', headers: { authorization: auth, origin: 'http://127.0.0.1' }, body: '{}' })).status, 403)
    const adapter = createRelayAdapter(grant.env)
    await assert.rejects(adapter.resolveModel(RELAY_PROVIDER, 'other/model'), /路线/)
    assert.throws(() => createRelayAdapter({ ...grant.env, BILI_DUTY_RELAY_URL: 'https://remote.invalid/call' }), /本机/)
    grant.revoke()
  } finally { relay.close() }
})

test('revoking a run aborts active model IO, never retries and closes the stream', async () => {
  let started, aborted
  const begin = new Promise(resolve => { started = resolve }), done = new Promise(resolve => { aborted = resolve })
  const llm = fakeLlm({ async prepareCall(config, signal) {
    return { config, async *stream() {
      started()
      await new Promise(resolve => { signal.addEventListener('abort', () => { aborted(); resolve() }, { once: true }) })
      signal.throwIfAborted()
    } }
  } })
  const relay = createModelRelay({ getLlm: () => llm })
  try {
    await relay.ready
    const grant = relay.open(model), adapter = createRelayAdapter(grant.env)
    const reading = (async () => { for await (const _ of adapter.stream({ provider: RELAY_PROVIDER, model, messages: [] })) {} })()
    await begin; grant.revoke(); await done
    await assert.rejects(reading)
  } finally { relay.close() }
})

test('terminal errors are shown and partial measured usage is not lost on interruption', async () => {
  const usage = [], events = []
  const llm = fakeLlm({ async prepareCall(config) { return { config, async *stream() {
    yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: 'fixture failure' } } }
  } } } })
  const relay = createModelRelay({ getLlm: () => llm })
  try {
    await relay.ready
    const grant = relay.open(model, { onUsage: x => usage.push(x), onEvent: x => events.push(x) })
    const adapter = createRelayAdapter(grant.env)
    for await (const _ of adapter.stream({ provider: RELAY_PROVIDER, model, messages: [] })) {}
    assert.deepEqual(usage, [{ input: 11, output: 2, total: 13 }])
    assert.ok(events.some(e => e.stage === 'model-error' && /NO_ADAPTER/.test(e.text) && !/fixture/.test(e.text)))
    assert.ok(!events.some(e => e.stage === 'model-done'))
  } finally { relay.close() }
})

test('model routes and usage validation never invent a route or estimate missing usage', () => {
  assert.deepEqual(splitModelRoute(' buddy/path/model '), { provider: 'buddy', model: 'path/model' })
  for (const route of ['', 'buddy', '/model', 'buddy/', 'buddy/model with space']) assert.throws(() => splitModelRoute(route))
  assert.equal(usageTokens(undefined), null)
  assert.equal(usageTokens({ inputTokens: 2 }), null)
  assert.deepEqual(usageTokens({ inputTokens: 0, outputTokens: 0 }), { input: 0, output: 0, total: 0 })
})

test('provider and tool exception events contain only safe diagnostics, including unlabelled private echoes', async () => {
  const events = [], secret = '收件人的合成私信正文-fixture-private', key = 'fixture-api-key'
  let mode = 'resolve'
  const failure = () => Object.assign(new Error(`Error unlabelled ${secret}; text=${secret}; content=${secret}; api_key=${key}`), { code: 'ETIMEDOUT' })
  const llm = fakeLlm({
    resolveModelInfo: async () => { if (mode === 'resolve') throw failure(); return { provider: 'buddy', id: 'glm-5.3-flash' } },
    prepareCall: async config => {
      if (mode === 'prepare') throw failure()
      return { config, async *stream() {
        if (mode === 'stream') throw failure()
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: secret + key } } }
      } }
    },
  })
  const relay = createModelRelay({ getLlm: () => llm })
  try {
    await relay.ready
    const grant = relay.open(model, { onEvent: event => { events.push(event); return Promise.reject(new Error('optional observer')) },
      tools: [{ name: 'bili_dm_reply', execute: async () => { throw failure() } }] })
    const adapter = createRelayAdapter(grant.env), client = createRelayClient(grant.env)
    await assert.rejects(adapter.resolveModel(RELAY_PROVIDER, model))
    for (mode of ['prepare', 'stream', 'terminal']) {
      try { for await (const _ of adapter.stream({ provider: RELAY_PROVIDER, model, messages: [] })) {} } catch { /* caller receives its own failure */ }
    }
    await assert.rejects(client.post({ action: 'tool-call', name: 'bili_dm_reply', args: { text: secret } }))
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(events.filter(event => event.stage === 'model-error').length >= 4)
    assert.ok(events.some(event => event.stage === 'tool-error' && /ETIMEDOUT/.test(event.text)))
    const saved = JSON.stringify(events)
    assert.ok(!saved.includes(secret)); assert.ok(!saved.includes(key)); assert.match(saved, /原始输出已省略/)
  } finally { relay.close() }
})
