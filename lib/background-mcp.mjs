/** A child MCP facade. All calls go through the parent's existing guarded fish wrappers. */
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRelayClient } from './model-relay-adapter.mjs'

export async function backgroundMcpRequest(message, client) {
  if (message.id === undefined) return null
  const reply = result => ({ jsonrpc: '2.0', id: message.id, result })
  if (message.method === 'initialize') return reply({ protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'dafeiyu-background', version: '1.0.0' } })
  if (message.method === 'ping') return reply({})
  if (message.method === 'tools/list') return reply(await (await client.post({ action: 'tools-list' })).json())
  if (message.method !== 'tools/call') return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }
  try {
    const { value } = await (await client.post({ action: 'tool-call', name: message.params?.name, args: message.params?.arguments || {} })).json()
    return reply({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], isError: value?.ok === false || value?.success === false || Boolean(value?.error) })
  } catch (error) { return reply({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(error?.message || error) }) }], isError: true }) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.BILI_DUTY_ROLE !== 'background') throw new Error('BACKGROUND_MCP_INVALID_ROLE')
  const client = createRelayClient(), input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  let queue = Promise.resolve()
  input.on('line', line => {
    if (line.length > 16 * 1024 * 1024) return
    queue = queue.then(async () => {
      let message
      try { message = JSON.parse(line) } catch { return }
      try { const response = await backgroundMcpRequest(message, client); if (response) process.stdout.write(JSON.stringify(response) + '\n') }
      catch { if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'BACKGROUND_MCP_REQUEST_FAILED' } }) + '\n') }
    }).catch(() => {})
  })
}
