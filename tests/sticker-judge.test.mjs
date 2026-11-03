import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'fish-sticker-judge-')), builtin = join(root, 'builtin')
mkdirSync(builtin)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64')
writeFileSync(join(builtin, '贴贴.png'), png)
const priorBuiltin = process.env.DAFEIYU_STICKER_DIR
process.env.DAFEIYU_STICKER_DIR = builtin
const { collectSticker, listStickers, evictionCandidate, stickerScoreOf, STICKER_MAX, STICKER_LEGACY_SCORE } = await import('../lib/sticker.mjs')
const { judgeStickerCandidate, lexiconVeto, parseJudgeReply, STICKER_JUDGE_MIN_SCORE } = await import('../lib/sticker-judge.mjs')
const { createStickerAutomation, STICKER_DEFAULTS } = await import('../lib/sticker-automation.mjs')

const lookupImpl = async () => [{ address: '8.8.8.8', family: 4 }]
const image = index => Buffer.concat([png, Buffer.from(`#${index}`)])
const fetchFor = index => async () => new Response(image(index), { headers: { 'content-type': 'image/png' } })
const flush = () => new Promise(resolve => setImmediate(resolve))
let sequence = 0
const home = () => {
  const dir = join(root, 'home-' + ++sequence)
  mkdirSync(dir)
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ tokensTotal: 1234 }))
  return dir
}

test.after(() => {
  if (priorBuiltin === undefined) delete process.env.DAFEIYU_STICKER_DIR
  else process.env.DAFEIYU_STICKER_DIR = priorBuiltin
  rmSync(root, { recursive: true, force: true })
})

/** 一个只会吐固定文本的假 llm；用来验"模型说了什么"与"模型坏了会怎样"。 */
const fakeLlm = text => ({ prepareCall: async () => ({ config: {}, stream: async function* () { yield { type: 'text-delta', text } } }) })
const brokenLlm = () => ({ prepareCall: async () => { throw new Error('线路挂了') } })

test('local lexicon vetoes obvious ads, adults, gore and privacy leaks before any model call', () => {
  assert.match(lexiconVeto({ comment: '扫码加微信领红包' }), /ad/)
  assert.match(lexiconVeto({ comment: '进群日结兼职' }), /ad/)
  assert.match(lexiconVeto({ comment: '这种裸照也发' }), /adult/)
  assert.match(lexiconVeto({ comment: '太血腥了' }), /gore/)
  assert.match(lexiconVeto({ comment: '我身份证在这' }), /privacy/)
  assert.equal(lexiconVeto({ comment: '这个梗真的好笑' }), '')
  assert.equal(lexiconVeto({}), '')
  let called = 0
  const llm = { prepareCall: async () => { called++; throw new Error('不该被调用') } }
  return judgeStickerCandidate({ llm, route: 'p/m', candidate: { comment: '加微信' } }).then(verdict => {
    assert.equal(verdict.suitable, false); assert.equal(verdict.score, 0); assert.equal(verdict.source, 'lexicon'); assert.equal(called, 0)
  })
})

test('model replies are parsed tolerantly and unusable output is rejected', () => {
  assert.deepEqual(parseJudgeReply('{"suitable":true,"score":72,"description":"被逗笑时","tags":["笑","猫"],"reason":"梗图"}'),
    { suitable: true, score: 72, description: '被逗笑时', tags: ['笑', '猫'], reason: '梗图' })
  assert.equal(parseJudgeReply('```json\n{"suitable":true,"score":61,"tags":[]}\n```').score, 61)
  assert.equal(parseJudgeReply('我觉得可以：{"suitable":true,"score":55} 就这样').score, 55)
  assert.equal(parseJudgeReply('{"suitable":false,"score":90}').score, 0, 'suitable=false must never keep a high score')
  assert.equal(parseJudgeReply('完全不是 JSON'), null)
  assert.equal(parseJudgeReply(''), null)
  assert.equal(parseJudgeReply('{"suitable":true}'), null, 'a score is mandatory when suitable')
})

test('judging fails open: no route, broken model and unparsable output all keep the picture without a score', async () => {
  const candidate = { comment: '这个图好好笑', name: '评论图-1', width: 256, height: 256 }
  const noRoute = await judgeStickerCandidate({ llm: fakeLlm('{}'), route: '', candidate })
  assert.deepEqual([noRoute.ok, noRoute.suitable, noRoute.score], [false, true, null])
  const noLlm = await judgeStickerCandidate({ route: 'p/m', candidate })
  assert.equal(noLlm.suitable, true); assert.equal(noLlm.score, null)
  const bad = await judgeStickerCandidate({ llm: brokenLlm(), route: 'p/m', candidate })
  assert.deepEqual([bad.ok, bad.suitable, bad.score, bad.source], [false, true, null, 'error'])
  const junk = await judgeStickerCandidate({ llm: fakeLlm('我看不出来'), route: 'p/m', candidate })
  assert.deepEqual([junk.ok, junk.suitable, junk.score, junk.source], [false, true, null, 'parse'])
})

test('a model verdict becomes a score, and a low score rejects the picture', async () => {
  const candidate = { comment: '这张猫太好笑了', width: 256, height: 256 }
  const good = await judgeStickerCandidate({ llm: fakeLlm('{"suitable":true,"score":88,"description":"被逗笑时","tags":["猫","笑"]}'), route: 'p/m', candidate })
  assert.deepEqual([good.ok, good.suitable, good.score, good.source], [true, true, 88, 'model'])
  assert.deepEqual(good.tags, ['猫', '笑'])
  const weak = await judgeStickerCandidate({ llm: fakeLlm(`{"suitable":true,"score":${STICKER_JUDGE_MIN_SCORE - 1}}`), route: 'p/m', candidate })
  assert.deepEqual([weak.ok, weak.suitable, weak.score], [true, false, STICKER_JUDGE_MIN_SCORE - 1])
  const refused = await judgeStickerCandidate({ llm: fakeLlm('{"suitable":false,"score":10,"reason":"长截图"}'), route: 'p/m', candidate })
  assert.deepEqual([refused.suitable, refused.score], [false, 0])
})

test('eviction picks the lowest score, needs a strictly better newcomer and never touches pending pictures', () => {
  const book = {
    甲: { file: '甲.png', score: 90, addedAt: '2026-11-01T00:00:00.000Z' },
    乙: { file: '乙.png', score: 60, addedAt: '2026-11-02T00:00:00.000Z' },
    丙: { file: '丙.png', score: 40, status: 'pending', addedAt: '2026-10-01T00:00:00.000Z' },
  }
  const all = Object.entries(book).map(([name, meta]) => ({ name, source: 'collected', file: meta.file }))
  assert.equal(evictionCandidate(all, book, 95).name, '乙', 'pending 丙 分数最低但不参与淘汰')
  assert.equal(evictionCandidate(all, book, 61).name, '乙')
  assert.equal(evictionCandidate(all, book, 60), null, '一样好不算更好')
  assert.equal(evictionCandidate(all, book, null), null, '没有分数就没有淘汰资格')
  assert.equal(stickerScoreOf({}), STICKER_LEGACY_SCORE, '没判过分的老图按刚够格算')
  assert.equal(stickerScoreOf({ score: 140 }), 100, '分数被钳到 0–100')
  assert.equal(evictionCandidate([], {}, 99), null)
})

test('capacity is 100 and a full book evicts the weakest picture only when automation runs without review', async () => {
  assert.equal(STICKER_MAX, 100)
  // capacity 1 的账本：先放一张 60 分的，再来一张 80 分的自动收集 —— 应该顶掉旧的。
  const dir = home()
  const first = await collectSticker(dir, { name: '旧的', url: 'https://images.example.com/a.png', lookupImpl, fetchImpl: fetchFor(1),
    capacity: 1, automatic: true, score: 60 })
  assert.equal(first.ok, true); assert.equal(first.score, 60); assert.equal(first.evicted, undefined)
  const better = await collectSticker(dir, { name: '新的', url: 'https://images.example.com/b.png', lookupImpl, fetchImpl: fetchFor(2),
    capacity: 1, automatic: true, score: 80 })
  assert.equal(better.ok, true); assert.deepEqual(better.evicted, { name: '旧的', score: 60 })
  assert.equal(existsSync(join(dir, 'stickers', '旧的.png')), false, '被顶掉的图片文件要真删')
  const kept = listStickers(dir, { source: 'collected' }).map(item => item.name)
  assert.deepEqual(kept, ['新的'])
  const state = JSON.parse(readFileSync(join(dir, 'state.json')))
  assert.equal(state.stickers.新的.score, 80); assert.equal(state.stickers.旧的, undefined)
  assert.equal(state.tokensTotal, 1234, '淘汰不能把 state.json 的其它字段冲掉')

  // 一样好、更差：都不许换，容量满就是满。
  const same = await collectSticker(dir, { name: '同分', url: 'https://images.example.com/c.png', lookupImpl, fetchImpl: fetchFor(3),
    capacity: 1, automatic: true, score: 80 })
  assert.equal(same.ok, false); assert.equal(same.code, 'STICKER_CAPACITY')
  const worse = await collectSticker(dir, { name: '更差', url: 'https://images.example.com/d.png', lookupImpl, fetchImpl: fetchFor(4),
    capacity: 1, automatic: true, score: 30 })
  assert.equal(worse.ok, false); assert.equal(worse.code, 'STICKER_CAPACITY')
})

test('manual collection and reviewed automation never evict an approved picture', async () => {
  const manual = home()
  await collectSticker(manual, { name: '手挑的', url: 'https://images.example.com/a.png', lookupImpl, fetchImpl: fetchFor(1), capacity: 1, score: 50 })
  const byHand = await collectSticker(manual, { name: '更好的', url: 'https://images.example.com/b.png', lookupImpl, fetchImpl: fetchFor(2),
    capacity: 1, score: 99 })
  assert.equal(byHand.ok, false, '手工上传是人自己挑的，机器不能替人删')
  assert.equal(byHand.code, 'STICKER_CAPACITY')

  const reviewed = home()
  await collectSticker(reviewed, { name: '已批', url: 'https://images.example.com/a.png', lookupImpl, fetchImpl: fetchFor(1),
    capacity: 1, automatic: true, score: 50 })
  const pending = await collectSticker(reviewed, { name: '待审', url: 'https://images.example.com/b.png', lookupImpl, fetchImpl: fetchFor(2),
    capacity: 1, automatic: true, stickerReview: true, score: 99 })
  assert.equal(pending.ok, false, '开着人工审核时不淘汰：新图先落 pending，不该顺手删掉已批的图')
  assert.equal(pending.code, 'STICKER_CAPACITY')
})

test('automation judges before downloading and passes the score into the library', async () => {
  const dir = home(), calls = [], verdicts = []
  const cfg = { ...STICKER_DEFAULTS, stickerAutoCollect: true, stickerCollectProbability: 100, stickerCollectCooldown: 0, stickerCapacity: 100 }
  const auto = createStickerAutomation({
    stateDir: dir, getConfig: () => cfg, random: () => 0.99,
    judge: async ({ candidate }) => { verdicts.push(candidate.comment); return { ok: true, suitable: true, score: 77, description: '被逗笑时', tags: ['笑'], reason: '梗图', source: 'model' } },
    collect: (stateDir, opts) => { calls.push(opts); return collectSticker(stateDir, { ...opts, lookupImpl, fetchImpl: fetchFor(1) }) },
  })
  const result = { comments: [{ rpid: '12345678901234567', content: '这张猫好好笑', user: '甲', like: 88, images: [{ url: 'https://images.example.com/j.png', w: 256, h: 256 }] }] }
  assert.equal(auto.offer(result, 'BV1234567890').queued, 1)
  await flush(); await flush()
  assert.deepEqual(verdicts, ['这张猫好好笑'], '判图拿得到评论正文')
  assert.equal(calls.length, 1); assert.equal(calls[0].score, 77); assert.equal(calls[0].description, '被逗笑时'); assert.deepEqual(calls[0].tags, ['笑'])
  const stored = listStickers(dir, { source: 'collected' })
  assert.equal(stored.length, 1); assert.equal(stored[0].score, 77); assert.equal(stored[0].judged, 'model')
  auto.stop()
})

test('a rejected picture is never downloaded and keeps the collection loop alive', async () => {
  const dir = home(), events = [], calls = [], verdicts = ['长截图，不收', '这张可以']
  const cfg = { ...STICKER_DEFAULTS, stickerAutoCollect: true, stickerCollectProbability: 100, stickerCollectCooldown: 0, stickerCapacity: 100 }
  const auto = createStickerAutomation({
    stateDir: dir, getConfig: () => cfg, random: () => 0.99, onEvent: (kind, value) => events.push({ kind, value }),
    judge: async () => ({ ok: true, suitable: verdicts.shift() === '这张可以', score: 70, description: '', tags: [], reason: '模型觉得不合适', source: 'model' }),
    collect: (stateDir, opts) => { calls.push(opts); return collectSticker(stateDir, { ...opts, lookupImpl, fetchImpl: async () => new Response(image(calls.length), { headers: { 'content-type': 'image/png' } }) }) },
  })
  auto.offer({ comments: [{ rpid: '1', content: '截图', images: [{ url: 'https://images.example.com/x.png', w: 256, h: 256 }] }] }, 'BV1234567890')
  await flush(); await flush()
  assert.equal(calls.length, 0, '判为不合适时根本不该下载那张图')
  assert.equal(events.some(x => x.kind === 'collect-skipped' && x.value.code === 'STICKER_UNSUITABLE'), true)
  auto.offer({ comments: [{ rpid: '2', content: '猫', images: [{ url: 'https://images.example.com/y.png', w: 256, h: 256 }] }] }, 'BV1234567890')
  await flush(); await flush(); await flush()
  assert.equal(calls.length, 1, '上一张被拒不能把后面的都堵死')
  assert.equal(listStickers(dir, { source: 'collected' }).length, 1)
  auto.stop()
})

test('a broken judge never stops collection — it only costs the score', async () => {
  const dir = home(), order = []
  const cfg = { ...STICKER_DEFAULTS, stickerAutoCollect: true, stickerCollectProbability: 100, stickerCollectCooldown: 0, stickerCapacity: 100 }
  const auto = createStickerAutomation({
    stateDir: dir, getConfig: () => cfg, random: () => 0.99,
    judge: async () => { order.push('judge'); throw new Error('模型超时') },
    collect: (stateDir, opts) => { order.push(`collect:${opts.score}`); return collectSticker(stateDir, { ...opts, lookupImpl, fetchImpl: fetchFor(1) }) },
  })
  auto.offer({ comments: [{ rpid: '1', content: '猫', images: [{ url: 'https://images.example.com/z.png', w: 256, h: 256 }] }] }, 'BV1234567890')
  await flush(); await flush(); await flush()
  assert.deepEqual(order, ['judge', 'collect:null'], '判图炸了也要照老规矩收，只是没有分数')
  const stored = listStickers(dir, { source: 'collected' })
  assert.equal(stored.length, 1); assert.equal(stored[0].score, null, '没分数就不显示分数，也不参与淘汰')
  auto.stop()
})

test('turning judge off skips the model entirely but still collects', async () => {
  const dir = home(), judged = []
  const cfg = { ...STICKER_DEFAULTS, stickerAutoCollect: true, stickerCollectProbability: 100, stickerCollectCooldown: 0, stickerCapacity: 100, stickerJudge: false }
  const auto = createStickerAutomation({
    stateDir: dir, getConfig: () => cfg, random: () => 0.99,
    judge: async () => { judged.push('called'); return { suitable: true, score: 90 } },
    collect: (stateDir, opts) => collectSticker(stateDir, { ...opts, lookupImpl, fetchImpl: fetchFor(1) }),
  })
  auto.offer({ comments: [{ rpid: '1', content: '猫', images: [{ url: 'https://images.example.com/off.png', w: 256, h: 256 }] }] }, 'BV1234567890')
  await flush(); await flush(); await flush()
  assert.deepEqual(judged, [])
  assert.equal(listStickers(dir, { source: 'collected' }).length, 1)
  auto.stop()
})

test('local lexicon still blocks unsuitable pictures when the model judge is switched off', async () => {
  const dir = home(), events = [], judged = []
  const cfg = { ...STICKER_DEFAULTS, stickerAutoCollect: true, stickerCollectProbability: 100, stickerCollectCooldown: 0, stickerCapacity: 100, stickerJudge: false }
  const auto = createStickerAutomation({
    stateDir: dir, getConfig: () => cfg, random: () => 0.99, onEvent: (kind, value) => events.push({ kind, value }),
    judge: async () => { judged.push('called'); return { suitable: true, score: 90 } },
    collect: (stateDir, opts) => collectSticker(stateDir, { ...opts, lookupImpl, fetchImpl: fetchFor(1) }),
  })
  auto.offer({ comments: [{ rpid: '1', content: '扫码加微信领红包', images: [{ url: 'https://images.example.com/ad.png', w: 256, h: 256 }] }] }, 'BV1234567890')
  await flush(); await flush()
  assert.deepEqual(judged, [], '关掉大模型判断时不该叫模型')
  assert.equal(listStickers(dir, { source: 'collected' }).length, 0, '本地词表始终有效，广告图照样拦')
  assert.equal(events.filter(x => x.kind === 'collect-skipped').length, 1)
  assert.equal(events[0].value.code, 'STICKER_UNSUITABLE')
  auto.stop()
})
