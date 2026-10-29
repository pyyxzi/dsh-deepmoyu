import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { McpClient } from '../lib/mcp.mjs'
import { parseJsonExactIntegers } from '../lib/ids.mjs'

const BIG = '1234567890123456789', OTHER = '9876543210987654321'

test('JSON scanner preserves raw integer tokens without changing strings, escapes, fractions or safe protocol numbers', () => {
  const text = `literal ${BIG}; quoted "rpid":${OTHER}; escaped backslash \\ and newline\n中文`
  const raw = `{"uid":${BIG},"oid":${OTHER},"rpid":${BIG},"root":${OTHER},"parent":${BIG},"id":2,"safe":9007199254740991,"negative":-${BIG},"text":${JSON.stringify(text)},"fraction":1.25,"exponent":1e3,"zero":-0,"nested":[${OTHER},{"\\u0075id":${BIG}}]}`
  const parsed = parseJsonExactIntegers(raw)
  for (const field of ['uid', 'rpid', 'parent']) assert.equal(parsed[field], BIG)
  for (const field of ['oid', 'root']) assert.equal(parsed[field], OTHER)
  assert.equal(parsed.negative, '-' + BIG); assert.equal(parsed.text, text)
  assert.equal(parsed.id, 2); assert.equal(typeof parsed.id, 'number'); assert.equal(parsed.safe, Number.MAX_SAFE_INTEGER)
  assert.equal(parsed.fraction, 1.25); assert.equal(parsed.exponent, 1000); assert.ok(Object.is(parsed.zero, -0))
  assert.deepEqual(parsed.nested, [OTHER, { uid: BIG }])
  assert.equal(parseJsonExactIntegers('9'.repeat(400)), '9'.repeat(400))
})

test('string scanning honours escaped quotes/backslashes and preserves decimal-looking object keys', () => {
  const samples = [BIG, `"rpid":${BIG}`, `\\"${BIG}`, '\\u0022 ' + BIG, 'line\n' + BIG, 'path\\folder\\' + BIG]
  for (const text of samples) {
    const raw = JSON.stringify({ [BIG]: text, nested: [text, { content: text }] })
    assert.deepEqual(parseJsonExactIntegers(raw), JSON.parse(raw))
  }
  const exponent = parseJsonExactIntegers('[1.234567890123456789e18,9007199254740992.0]')
  assert.equal(typeof exponent[0], 'number'); assert.equal(typeof exponent[1], 'number')
})

test('lossless preprocessing never repairs malformed JSON into apparently valid data', () => {
  for (const raw of [`{${BIG}:1}`, `{"uid":0${BIG}}`, `{"uid":${BIG}garbage}`, `{"uid":+${BIG}}`, `{"uid":--${BIG}}`, '[1e+]', '[1.]', '{"text":"unterminated', '[01]', '[-]']) {
    assert.throws(() => JSON.parse(raw), SyntaxError)
    assert.throws(() => parseJsonExactIntegers(raw), SyntaxError, raw)
  }
  assert.throws(() => parseJsonExactIntegers(null), /must be a string/)
})

test('real McpClient decodes raw 19-digit Python content JSON across a fake stdio transport; request IDs stay small numbers', async () => {
  const cp = createRequire(import.meta.url)('node:child_process'), original = cp.spawn, requests = []
  let child, mode = 'json', killed = 0
  const text = `来自 Python 的合成正文 ${BIG}，包括 "oid":${OTHER} 和反斜杠 \\。`
  const payload = `{"uid":${BIG},"oid":${OTHER},"rpid":${BIG},"root":${OTHER},"count":3,"text":${JSON.stringify(text)}}`
  cp.spawn = () => {
    child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    child.stdout.setEncoding = child.stderr.setEncoding = encoding => assert.equal(encoding, 'utf8')
    child.kill = () => { killed++; queueMicrotask(() => child.emit('exit', 0)) }
    child.stdin = { writable: true, end() {}, write(line) {
      const request = JSON.parse(line); requests.push(request)
      if (request.id === undefined) return
      assert.ok(Number.isSafeInteger(request.id)); assert.ok(request.id > 0 && request.id < 100)
      const result = request.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'synthetic', version: '0' } }
        : { content: [{ type: 'text', text: mode === 'json' ? payload : mode === 'plain' ? text : '  ' }], structuredContent: { safe: 7 } }
      const wire = JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n'
      queueMicrotask(() => { child.stdout.emit('data', wire.slice(0, 13)); child.stdout.emit('data', wire.slice(13, 91)); child.stdout.emit('data', wire.slice(91)) })
    } }
    return child
  }; syncBuiltinESMExports()
  const client = new McpClient({ command: 'synthetic-python-never-executed' })
  try {
    const result = await client.call('bili_video_info', { uid: BIG, rpid: OTHER }, { timeoutMs: 1000 })
    assert.deepEqual(result, { uid: BIG, oid: OTHER, rpid: BIG, root: OTHER, count: 3, text })
    const submitted = requests.find(request => request.method === 'tools/call')
    assert.deepEqual(submitted.params.arguments, { uid: BIG, rpid: OTHER })
    assert.equal(requests[0].id, 1); assert.equal(submitted.id, 2)
    mode = 'plain'; assert.equal(await client.call('bili_video_info', {}, { timeoutMs: 1000 }), text)
    mode = 'empty'; assert.deepEqual(await client.call('bili_video_info', {}, { timeoutMs: 1000 }), {})
  } finally { client.stop(); await new Promise(resolve => setImmediate(resolve)); cp.spawn = original; syncBuiltinESMExports() }
  assert.equal(killed, 1)
})
