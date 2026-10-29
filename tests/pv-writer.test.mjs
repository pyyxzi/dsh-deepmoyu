import assert from 'node:assert/strict'
import test from 'node:test'
import { applyScript, buildWriterPrompt, clampLine, extractJson, WRITER_MAX_CHARS, writeWithModel } from '../lib/pv-writer.mjs'

const plan = () => ({
  schema: 'dafeiyu-dialogue-v1',
  date: '2026-10-25',
  voice: { name: 'zh-CN-XiaoyiNeural' },
  sources: [{ id: 'note-1', title: '某条视频', excerpt: '一句话：其实主题不是吹牛。' }],
  shots: [
    { kind: 'dialogue', speaker: 'inner', text: '模板第一句', camera: 'reverse', expression: 'question', prop: 'rice', beat: '拌嘴' },
    { kind: 'dialogue', speaker: 'fish', text: '模板第二句', camera: 'close', expression: 'happy', prop: 'rice', beat: '' },
    { kind: 'dialogue', speaker: 'fish', text: '模板第三句', camera: 'wide', expression: 'happy', prop: 'note', beat: '收尾' },
  ],
})

/* ── 抠 JSON ─────────────────────────────────────────────────────────── */

test('extractJson takes a bare array and ignores prose around it', () => {
  assert.deepEqual(extractJson('[{"text":"甲"},{"text":"乙"}]'), [{ text: '甲' }, { text: '乙' }])
  assert.deepEqual(extractJson('好的，这是台词：\n[{"text":"甲"}]\n希望满意'), [{ text: '甲' }])
})

test('extractJson unwraps a fenced code block', () => {
  assert.deepEqual(extractJson('```json\n[{"text":"甲"}]\n```'), [{ text: '甲' }])
  assert.deepEqual(extractJson('```\n{"shots":[{"text":"甲"}]}\n```'), { shots: [{ text: '甲' }] })
})

test('extractJson returns null instead of throwing on garbage', () => {
  for (const bad of ['', '   ', '今天看了个视频', '[{"text":', undefined, null]) {
    assert.equal(extractJson(bad), null, `应该认输：${String(bad)}`)
  }
})

/* ── 截断 ────────────────────────────────────────────────────────────── */

test('clampLine leaves short lines untouched and collapses whitespace', () => {
  assert.equal(clampLine('  短句  '), '短句')
  assert.equal(clampLine('有\n换行\t和空格'), '有 换行 和空格')
})

test('clampLine cuts long lines at a sentence boundary', () => {
  const long = '甲'.repeat(WRITER_MAX_CHARS - 4) + '。后半句还有好多字呢'
  const out = clampLine(long)
  assert.ok(out.length <= WRITER_MAX_CHARS, `不该超过上限：${out.length}`)
  assert.ok(out.endsWith('。'), `应该在句号处收住：${out.slice(-6)}`)
})

test('clampLine never lets a boundary mark push it one char over the limit', () => {
  // 标点正好落在第 limit+1 个字符上：收进这一句就超了，只能退到下一档边界
  const out = clampLine('甲'.repeat(WRITER_MAX_CHARS) + '。后半句还有好多字呢')
  assert.ok(out.length <= WRITER_MAX_CHARS, `超上限了：${out.length}`)
})

test('clampLine still returns something for a line with no punctuation at all', () => {
  const out = clampLine('乙'.repeat(WRITER_MAX_CHARS + 40))
  assert.ok(out.length > 0 && out.length <= WRITER_MAX_CHARS)
})

/* ── 贴回 plan ───────────────────────────────────────────────────────── */

test('applyScript swaps only the text and keeps every staging field', () => {
  const base = plan()
  const result = applyScript(base, [{ text: '新第一句' }, { text: '新第二句' }, { text: '新第三句' }])
  assert.ok(!result.error, result.error)
  assert.equal(result.changed, 3)
  assert.deepEqual(result.plan.shots.map((s) => s.text), ['新第一句', '新第二句', '新第三句'])
  for (let i = 0; i < base.shots.length; i++) {
    const { text: _a, ...before } = base.shots[i]
    const { text: _b, ...after } = result.plan.shots[i]
    assert.deepEqual(after, before, `第 ${i + 1} 镜的镜头参数必须原样保留`)
  }
  // 顶层合规字段一个都不能丢
  for (const key of ['schema', 'date', 'voice', 'sources']) assert.deepEqual(result.plan[key], base[key], key)
})

test('applyScript accepts bare strings as well as {text} objects', () => {
  const result = applyScript(plan(), ['甲', '乙', '丙'])
  assert.ok(!result.error, result.error)
  assert.deepEqual(result.plan.shots.map((s) => s.text), ['甲', '乙', '丙'])
})

test('applyScript refuses a shot count that differs from the template', () => {
  const short = applyScript(plan(), [{ text: '只有一句' }])
  assert.match(short.error, /镜数/)
  // 少一句就整份放弃 —— 不能让收尾提前
  assert.ok(!('plan' in short))

  const long = applyScript(plan(), [{ text: '1' }, { text: '2' }, { text: '3' }, { text: '4' }])
  assert.match(long.error, /镜数/)
})

test('applyScript rejects a plan that has no shots', () => {
  assert.match(applyScript({ shots: [] }, []).error, /没有 shots/)
  assert.match(applyScript(null, []).error, /没有 shots/)
})

test('applyScript keeps the template line when the model returns an empty one', () => {
  const result = applyScript(plan(), [{ text: '   ' }, { text: '有内容' }, { text: '也有内容' }])
  assert.ok(!result.error, result.error)
  assert.equal(result.plan.shots[0].text, '模板第一句', '模型给空字符串时不该把这一镜清空')
  assert.equal(result.plan.shots[1].text, '有内容')
})

test('applyScript clamps overlong model lines', () => {
  const result = applyScript(plan(), [{ text: '甲'.repeat(200) }, { text: '乙' }, { text: '丙' }])
  assert.ok(!result.error, result.error)
  assert.ok(result.plan.shots[0].text.length <= WRITER_MAX_CHARS)
})

/* ── 提示词 ──────────────────────────────────────────────────────────── */

test('buildWriterPrompt carries the public notes but no private material', () => {
  const prompt = buildWriterPrompt(plan(), { day: '2026-10-25' })
  assert.match(prompt, /2026-10-25/)
  assert.match(prompt, /某条视频/)
  assert.match(prompt, /其实主题不是吹牛/)
  assert.match(prompt, /JSON/)
  // 镜数必须点明，否则模型给不出对得上的数组
  assert.match(prompt, /一共 3 镜/)
  assert.match(prompt, /内心小鱼/)
})

/* ── 整条链路：模型再好也不能让视频失败 ─────────────────────────────── */

const fakeLlm = (chunks) => ({
  prepareCall: async () => ({ config: {}, stream: async function* () { for (const c of chunks) yield c } }),
})

test('writeWithModel returns the template when no model is configured', async () => {
  const base = plan()
  const out = await writeWithModel({ plan: base, day: '2026-10-25', llm: fakeLlm([]), modelId: '' })
  assert.equal(out.used, false)
  assert.equal(out.plan, base, '没配模型就该原样返回同一个对象')
})

test('writeWithModel rejects a malformed route without calling the model', async () => {
  let called = false
  const llm = { prepareCall: async () => { called = true; return { config: {}, stream: async function* () {} } } }
  for (const bad of ['随便写', '/model', 'provider/', 'a b/c']) {
    const out = await writeWithModel({ plan: plan(), day: 'd', llm, modelId: bad })
    assert.equal(out.used, false, bad)
    assert.match(out.note, /provider\/model|模板/, bad)
  }
  assert.equal(called, false, '路线不合法时不该真去请求模型')
})

test('writeWithModel applies a good model answer', async () => {
  const body = JSON.stringify([{ text: '甲' }, { text: '乙' }, { text: '丙' }])
  const out = await writeWithModel({ plan: plan(), day: '2026-10-25', llm: fakeLlm([{ type: 'text-delta', text: body }]), modelId: 'buddy/glm-5.3-flash' })
  assert.equal(out.used, true, out.note)
  assert.equal(out.model, 'buddy/glm-5.3-flash')
  assert.deepEqual(out.plan.shots.map((s) => s.text), ['甲', '乙', '丙'])
})

test('writeWithModel falls back to the template when the model errors mid-stream', async () => {
  const base = plan()
  const llm = fakeLlm([{ type: 'text-delta', text: '[' }, { type: 'finish', reason: { kind: 'error', failure: { message: '超时' } } }])
  const out = await writeWithModel({ plan: base, day: 'd', llm, modelId: 'buddy/glm-5.3-flash' })
  assert.equal(out.used, false, '模型报错必须退回模板')
  assert.equal(out.plan, base)
  assert.match(out.note, /模板/)
})

test('writeWithModel falls back when the model answers with prose instead of JSON', async () => {
  const base = plan()
  const out = await writeWithModel({ plan: base, day: 'd', llm: fakeLlm([{ type: 'text-delta', text: '今天看了个视频，挺好玩的。' }]), modelId: 'buddy/x' })
  assert.equal(out.used, false)
  assert.equal(out.plan, base)
})

test('writeWithModel falls back when the shot count is wrong', async () => {
  const base = plan()
  const body = JSON.stringify([{ text: '就一句' }])
  const out = await writeWithModel({ plan: base, day: 'd', llm: fakeLlm([{ type: 'text-delta', text: body }]), modelId: 'buddy/x' })
  assert.equal(out.used, false)
  assert.equal(out.plan, base)
  assert.match(out.note, /镜数/)
})

test('writeWithModel falls back when the host has no llm service', async () => {
  const base = plan()
  const out = await writeWithModel({ plan: base, day: 'd', llm: null, modelId: 'buddy/x' })
  assert.equal(out.used, false)
  assert.equal(out.plan, base)
})
