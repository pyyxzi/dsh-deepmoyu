import test from 'node:test'
import assert from 'node:assert/strict'
import { McpClient } from '../lib/mcp.mjs'

function controlledClient() {
  const events = [], writes = []
  let release
  const handshake = new Promise(resolve => { release = resolve })
  const client = new McpClient({ command: 'offline-transport-never-spawned' })
  const proc = { kill() {}, stdin: { writable: true, end() {}, write(line) {
    const message = JSON.parse(line)
    events.push('write')
    writes.push(message)
    assert.equal(client.pending.size, 1, 'the real request owns its pending slot before writing')
    queueMicrotask(() => {
      events.push('response')
      const pending = client.pending.get(message.id)
      client.pending.delete(message.id)
      pending.resolve({ content: [{ type: 'text', text: '{"ok":true}' }] })
    })
  } } }
  client.start = async () => {
    events.push('start')
    await handshake
    client.proc = proc
    events.push('ready')
  }
  return { client, events, writes, release }
}

test('revocation during an awaited handshake rejects before submitting any tool RPC', async () => {
  const { client, events, writes, release } = controlledClient()
  let allowed = true, checks = 0
  const revoked = new Error('permission revoked while MCP was initializing')
  const call = client.call('bili_reply', { text: 'offline preview' }, { beforeSubmit() {
    checks++
    events.push('check')
    assert.equal(client.pending.size, 0)
    if (!allowed) throw revoked
  } })
  assert.deepEqual(events, ['start'])
  assert.equal(checks, 0, 'submission is still waiting for the controlled handshake')
  allowed = false
  release()
  try {
    await assert.rejects(call, error => error === revoked)
    assert.equal(checks, 1)
    assert.deepEqual(events, ['start', 'ready', 'check'])
    assert.deepEqual(writes, [])
    assert.equal(client.pending.size, 0)
    assert.equal(client.nextId, 1, 'denied submission does not allocate a tools/call request')
  } finally { client.stop() }
})

test('allowed submission checks exactly once synchronously before the wire write', async () => {
  const { client, events, writes, release } = controlledClient()
  let checks = 0
  const call = client.call('bili_send_message', { receiver_uid: '123', text: 'offline preview' }, {
    timeoutMs: 1000,
    beforeSubmit() {
      checks++
      events.push('check')
      assert.equal(client.pending.size, 0)
      assert.equal(writes.length, 0)
      queueMicrotask(() => events.push('check-microtask'))
    },
  })
  release()
  try {
    assert.deepEqual(await call, { ok: true })
    assert.equal(checks, 1)
    assert.deepEqual(events, ['start', 'ready', 'check', 'write', 'check-microtask', 'response'])
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'tools/call')
    assert.deepEqual(writes[0].params, {
      name: 'bili_send_message', arguments: { receiver_uid: '123', text: 'offline preview' },
    })
    assert.equal(client.pending.size, 0)
  } finally { client.stop() }
})

test('legacy calls without beforeSubmit keep their request and response behavior', async () => {
  const { client, events, writes, release } = controlledClient()
  const call = client.call('bili_video_info', { bvid: 'BV0000000001' })
  release()
  try {
    assert.deepEqual(await call, { ok: true })
    assert.deepEqual(events, ['start', 'ready', 'write', 'response'])
    assert.equal(writes.length, 1)
    assert.equal(writes[0].params.name, 'bili_video_info')
    assert.equal(client.pending.size, 0)
  } finally { client.stop() }
})
