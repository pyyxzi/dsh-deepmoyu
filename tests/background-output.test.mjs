import test from 'node:test'
import assert from 'node:assert/strict'
import { createBackgroundOutput } from '../lib/background-output.mjs'

function fixture(extra = {}) {
  const diagnostics = [], progress = []
  const output = createBackgroundOutput({ onDiagnostic: value => diagnostics.push(value), onProgress: value => progress.push(value), ...extra })
  return { diagnostics, progress, output }
}

test('incremental UTF-8 preserves split Chinese error markers and tool names across every byte boundary', () => {
  const bytes = Buffer.from('启动失败：合成私信正文\nbili_search {"text":"合成内容"}\n')
  for (let cut = 1; cut < bytes.length; cut++) {
    const f = fixture(); f.output.push(bytes.subarray(0, cut)); f.output.push(bytes.subarray(cut)); f.output.flush()
    assert.equal(f.diagnostics.length, 1); assert.match(f.diagnostics[0].text, /后台任务启动失败/)
    assert.equal(f.progress.length, 1); assert.equal(f.progress[0].text, '工具：bili_search')
    assert.doesNotMatch(JSON.stringify(f.diagnostics), /合成私信正文|合成内容|�/)
  }
})

test('structured metadata never reproduces secrets, JSON text/content, private inboxes or echoed provider errors', () => {
  const secrets = ['fixture-raw-secret', 'fixture-private-message', 'fixture-content', '收件人的私信正文', 'bili_fake_secret']
  const f = fixture()
  for (const value of [
    `Error: Authorization: Bearer ${secrets[0]} text=${secrets[1]}`,
    `provider Error: {"content":"${secrets[2]}","text":"${secrets[1]}","api_key":"${secrets[0]}"}`,
    `Error 私信正文：${secrets[3]} 接收人：1234567890`,
    `Error: ${secrets[1]} (no recognizable field labels)`,
    `Error tool=bili_dm_reply arguments={"message":"${secrets[1]}","cookie":"${secrets[0]}"}`,
    `Error response={"messages":["${secrets[3]}"]} ${secrets[4]}`,
    `Error RELAY_ROUTE_MISMATCH body=${secrets[1]}`,
  ]) f.output.push(value + '\n', 'stderr')
  f.output.flush()
  const saved = JSON.stringify({ diagnostics: f.diagnostics, progress: f.progress, lastError: f.output.lastError })
  for (const secret of secrets) assert.ok(!saved.includes(secret), secret)
  assert.equal(f.diagnostics.length, 7)
  assert.deepEqual(f.diagnostics.at(-1).codes, ['RELAY_ROUTE_MISMATCH'])
  assert.ok(f.progress.some(row => row.text === '工具：bili_dm_reply'))
  assert.ok(f.diagnostics.every(row => row.text.includes('原始输出已省略')))
})

test('megabyte lines are bounded once, discard their continuation, and resume only at a newline', () => {
  const f = fixture()
  f.output.push('Error: ' + 'x'.repeat(20000), 'stderr')
  f.output.push('Error: fixture-continuation '.repeat(40000), 'stderr')
  f.output.push('\nbili_subtitle\n', 'stderr')
  f.output.flush()
  assert.equal(f.diagnostics.length, 1); assert.match(f.diagnostics[0].text, /长行已截断/)
  assert.ok(f.diagnostics[0].text.length < 200)
  assert.equal(f.progress.length, 1); assert.equal(f.progress[0].text, '工具：bili_subtitle')
})

test('stdout and stderr carry independent partial lines, deduplicate tool progress, and flush once', () => {
  const f = fixture()
  f.output.push('bili_se'); f.output.push('Error ENO', 'stderr'); f.output.push('arch\n')
  f.output.push('ENT', 'stderr'); f.output.push('bili_search\nbili_reply\n')
  assert.equal(f.diagnostics.length, 0)
  f.output.flush(); f.output.flush(); f.output.push('Error NO_ADAPTER\n')
  assert.deepEqual(f.progress.map(row => row.text), ['工具：bili_search', '工具：bili_reply'])
  assert.equal(f.diagnostics.length, 1); assert.deepEqual(f.diagnostics[0].codes, ['ENOENT'])
})

test('warning and stack metadata stay private; warnings never overwrite the last error', () => {
  const f = fixture()
  f.output.push('\u001b[31mError NO_ADAPTER secret-route\u001b[0m\n', 'stderr')
  const error = f.output.lastError
  f.output.push('(node:99) ExperimentalWarning: private details\n    at privateFunction (C:/private/file.js:2:3)\n', 'stderr')
  f.output.flush()
  assert.match(error, /适配器不可用.*NO_ADAPTER/); assert.equal(f.output.lastError, error)
  assert.equal(f.diagnostics[1].error, false); assert.match(f.diagnostics[1].text, /实验性能力警告/)
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /secret-route|private details|privateFunction|private\/file/)
})

test('sync throws and rejected callback promises cannot crash output processing', async () => {
  const sync = fixture({ onDiagnostic() { throw new Error('diagnostic consumer') }, onProgress() { throw new Error('progress consumer') } })
  assert.doesNotThrow(() => { sync.output.push('Error ETIMEDOUT bili_search\n'); sync.output.flush() })
  assert.match(sync.output.lastError, /ETIMEDOUT/)
  const async = fixture({ onDiagnostic: async () => { throw new Error('async diagnostic') }, onProgress: async () => { throw new Error('async progress') } })
  async.output.push('Error ENOENT bili_search\n'); async.output.flush()
  await new Promise(resolve => setImmediate(resolve))
  assert.match(async.output.lastError, /ENOENT/)
})

test('ordinary model text, raw arguments, invalid channels and unknown fake tool names are not diagnostics', () => {
  const f = fixture()
  f.output.push('normal assistant text\n{"text":"synthetic private message"}\nbili_fake_secret\n')
  f.output.push('Error NO_ADAPTER\n', '__proto__'); f.output.push('Error NO_ADAPTER\n', 'bad-channel')
  f.output.flush()
  assert.equal(f.diagnostics.length, 0); assert.equal(f.progress.length, 0); assert.equal(f.output.lastError, '')
})
