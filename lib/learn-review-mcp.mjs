/** Review-only stdio MCP. No Bilibili dependency or network capability is registered. */
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { resolve, dirname, join } from 'node:path'
import { withFileLockSync, readJsonFileSync } from './record-storage.mjs'
import { mutateLearningStateSync } from './learn-store.mjs'
import { appendLearningRecord } from './records.mjs'
import { decideLearningReview, LEARN_REVIEW_TOOLS } from './learn-review.mjs'

export function reviewMcpRequest(message, manifest, { stateFile, manifestFile, now = Date.now } = {}) {
  const result = value => ({ jsonrpc: '2.0', id: message.id, result: value })
  if (message.id === undefined) return null
  if (message.method === 'initialize') return result({ protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'dafeiyu-learning-review', version: '1.0.0' } })
  if (message.method === 'ping') return result({})
  if (message.method === 'tools/list') return result({ tools: LEARN_REVIEW_TOOLS })
  if (message.method !== 'tools/call') return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }
  let out
  try {
    if (message.params?.name !== 'bili_learn') throw new Error('REVIEW_TOOL_NOT_ALLOWED')
    if (manifestFile) {
      const active = readJsonFileSync(manifestFile, null, { maxBytes: 256 * 1024 })
      if (!active || active.id !== manifest?.id) throw new Error('REVIEW_RUN_REVOKED')
      manifest = active
    }
    if (!manifest || !Array.isArray(manifest.items) || !Number.isFinite(manifest.expiresAt) || now() >= manifest.expiresAt) throw new Error('REVIEW_RUN_EXPIRED')
    if (!stateFile) throw new Error('REVIEW_STATE_REQUIRED')
    const r = withFileLockSync(stateFile, () => {
      if (manifestFile) {
        const active = readJsonFileSync(manifestFile, null, { maxBytes: 256 * 1024 })
        if (!active || active.id !== manifest.id) throw new Error('REVIEW_RUN_REVOKED')
        if (now() >= active.expiresAt) throw new Error('REVIEW_RUN_EXPIRED')
      }
      if (now() >= manifest.expiresAt) throw new Error('REVIEW_RUN_EXPIRED')
      return mutateLearningStateSync(stateFile, current => decideLearningReview(current, manifest.items, message.params?.arguments))
    })
    if (r.saved) appendLearningRecord(dirname(stateFile), r.auditEvent)
    out = { ok: r.ok === true, id: r.id || '', state: r.state || '', error: r.error || '', revision: r.revision, saved: r.saved }
  } catch (e) { out = { ok: false, error: String(e?.message || e) } }
  return result({ content: [{ type: 'text', text: JSON.stringify(out) }], isError: !out.ok })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const home = process.env.BILI_DUTY_HOME || ''
  const manifestFile = process.env.BILI_LEARN_REVIEW_MANIFEST || ''
  let manifest
  try { manifest = readJsonFileSync(manifestFile, null, { maxBytes: 256 * 1024 }) } catch { manifest = null }
  const stateFile = home ? join(home, 'state.json') : ''
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  input.on('line', line => {
    if (line.length > 64 * 1024) return
    try {
      const response = reviewMcpRequest(JSON.parse(line), manifest, { stateFile, manifestFile })
      if (response) process.stdout.write(JSON.stringify(response) + '\n')
    } catch { /* malformed JSON never becomes an instruction */ }
  })
}
