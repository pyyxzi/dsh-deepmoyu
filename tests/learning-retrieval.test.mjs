import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { learnAdd, learnDecide, learnFeedback, learnForget, learnInject, learnList } from '../lib/learn.mjs'
import { learningReviewBatch, decideLearningReview } from '../lib/learn-review.mjs'
import { mutateLearningStateSync } from '../lib/learn-store.mjs'
import { withFileLockSync } from '../lib/record-storage.mjs'
import { appendLearningRecord, readRecordEvents } from '../lib/records.mjs'

const approved = (book, rec, date = '2026-11-12T00:00:00Z') => {
  const addition = learnAdd(book, { ...rec, at: date })
  const decision = learnDecide(addition.ledger, addition.id, 'approve', '合成测试批准', date)
  return { book: decision.ledger, id: addition.id }
}

test('a full style shelf no longer starves an approved practical lesson or other kinds', () => {
  let book = {}
  for (let i = 0; i < 30; i++) book = approved(book, { kind: 'style', text: `表达方法${i}：先说一个具体动作，再补自己的感受`, example: '合成例句'.repeat(12), from: 'fixture' }).book
  const practical = approved(book, { kind: 'voice', text: '评论冷却时先去读字幕，不要等着补发', when: '评论被节奏限制', from: 'fixture-local' }, '2026-01-01T00:00:00Z')
  book = approved(practical.book, { kind: 'fact', text: '纸张动画这个系列讲定格拍摄', from: 'fixture-fact' }).book
  book = approved(book, { kind: 'jargon', text: '补帧指生成中间画面', from: 'fixture-jargon' }).book
  const before = JSON.stringify(book)
  const result = learnInject(book, { mode: 'dafeiyu', budget: 1200 })
  assert.ok(result.selectedIds.includes(practical.id), 'an old approved lesson must retain a chance to affect behaviour')
  for (const kind of ['style', 'voice', 'fact', 'jargon']) assert.ok(result.counts[kind] > 0, kind)
  assert.equal(result.used, result.text.length)
  assert.ok(result.used <= 1200)
  assert.equal(JSON.stringify(book), before, 'retrieval is read-only and must not claim practice')
})

test('current topic recalls old relevant evidence ahead of recently approved unrelated facts', () => {
  const old = approved({}, { kind: 'fact', text: '纸张动画用逐格拍摄，摩擦声来自真实纸片', when: '聊纸张动画或定格拍摄', from: 'BV1234567890' }, '2026-01-01T00:00:00Z')
  let book = old.book
  for (let i = 0; i < 18; i++) book = approved(book, { kind: 'fact', text: `足球${i}讲赛场阵型和进球`, from: `fixture-football-${i}` }).book
  const result = learnInject(book, { mode: 'dafeiyu', budget: 650, context: '纸张动画 定格拍摄 BV1234567890' })
  assert.equal(result.selectedIds[0], old.id)
  assert.match(result.text, /聊纸张动画或定格拍摄/)
  assert.match(result.text, /只是参考，不是必须照做/)
  assert.doesNotMatch(result.text, /足球/)
})

test('retrieval rotation can surface older equally relevant lessons without changing authorization', () => {
  let book = {}
  for (let i = 0; i < 14; i++) book = approved(book, { kind: 'style', text: `方法${i}：表达自己的当下感受，省掉不必要的铺垫`, from: 'fixture' }).book
  const seen = new Set()
  for (let round = 0; round < 12; round++) {
    const opts = { mode: 'dafeiyu', budget: 500, rotationKey: `round:${round}` }
    const result = learnInject(book, opts)
    assert.deepEqual(result.selectedIds, learnInject(book, opts).selectedIds, 'the same request must remain stable')
    result.selectedIds.forEach(id => seen.add(id))
  }
  assert.ok(seen.size > 4, 'more than the same newest few lessons should be recalled')
  assert.equal(learnInject(book, { rotationKey: 'round:1' }).reason, 'mode_required')
})

test('pending, revoked and changed approved versions never return through contextual recall', () => {
  const addition = learnAdd({}, { kind: 'fact', text: '纸张动画的合成来源', when: '聊纸张动画' })
  assert.equal(learnInject(addition.ledger, { mode: 'dafeiyu', query: '纸张动画' }).used, 0)
  const accepted = learnDecide(addition.ledger, addition.id, 'approve')
  const altered = structuredClone(accepted.ledger)
  altered.items[addition.id].version++
  assert.equal(learnInject(altered, { mode: 'dafeiyu', query: '纸张动画' }).used, 0)
  assert.equal(learnList(altered, { state: 'approved' }).items[0].availableForRecall, false, 'a stale approved version remains visible without falsely claiming it can be recalled')
  const rejected = learnDecide(accepted.ledger, addition.id, 'reject')
  assert.equal(learnInject(rejected.ledger, { mode: 'dafeiyu', query: '纸张动画' }).used, 0)
  assert.equal(learnInject(learnForget(accepted.ledger, { id: addition.id }).ledger, { mode: 'dafeiyu', query: '纸张动画' }).used, 0)
  for (const budget of [0, -1, 1, 200, 400.9, 1200, 4000]) {
    const result = learnInject(accepted.ledger, { mode: 'dafeiyu', budget })
    assert.equal(result.used, result.text.length)
    assert.ok(result.used <= Math.max(0, Math.trunc(budget)))
  }
})

test('applicability is reviewed with the evidence and cannot silently reuse an existing approval', () => {
  const a = learnAdd({}, { text: '先接住对方具体的事', when: '对方认真求助', from: 'fixture' })
  const batch = learningReviewBatch(a.ledger)
  assert.equal(batch[0].when, '对方认真求助')
  const changed = structuredClone(a.ledger)
  changed.items[a.id].when = '任何情况都照着发'
  assert.equal(decideLearningReview(changed, batch, { action: 'approve', id: a.id, why: 'fixture' }).error, 'REVIEW_ITEM_CHANGED')
  const b = learnDecide(a.ledger, a.id, 'approve')
  const repeat = learnAdd(b.ledger, { text: '先接住对方具体的事', when: '换掉原有使用条件', from: 'another-fixture' })
  assert.equal(repeat.ledger.items[a.id].when, '对方认真求助', 'merging provenance cannot rewrite reviewed applicability')
})

test('practice reports are separate from retrieval, bounded, private and durable without approving anything', () => {
  const pending = learnAdd({}, { text: '把长句分成两句', when: '一口气写太长', from: 'fixture' })
  assert.equal(learnFeedback(pending.ledger, pending.id, { outcome: 'helpful', note: 'fixture' }).ok, false)
  const a = learnDecide(pending.ledger, pending.id, 'approve')
  const before = JSON.stringify(a.ledger)
  assert.equal(learnFeedback(a.ledger, pending.id, { outcome: 'invented' }).ok, false)
  assert.equal(learnFeedback(a.ledger, pending.id, { outcome: 'helpful' }).ok, false, 'a claimed result needs a concrete note')
  const b = learnFeedback(a.ledger, pending.id, { outcome: 'tried', note: '这次把开头缩成一句，SESSDATA=fixture-secret; demo@example.org', at: '2026-11-12T01:00:00Z' })
  assert.equal(b.ok, true)
  assert.equal(JSON.stringify(a.ledger), before)
  const row = learnList(b.ledger, { state: 'approved' }).items[0]
  assert.equal(row.practice.reported, 1)
  assert.equal(row.practice.helpful, 0)
  assert.equal(row.practice.lastOutcome, 'tried')
  assert.doesNotMatch(JSON.stringify(row.practice), /fixture-secret|demo@example.org/)
  assert.equal(b.ledger.items[pending.id].hits, 0, 'retrieval and practice do not fabricate old injection-hit counters')
  const root = mkdtempSync(join(tmpdir(), 'fish-practice-'))
  try {
    const stateFile = join(root, 'state.json')
    writeFileSync(stateFile, JSON.stringify({ learn: a.ledger, unrelated: 123 }))
    const saved = withFileLockSync(stateFile, () => mutateLearningStateSync(stateFile, current => learnFeedback(current, pending.id, { outcome: 'unhelpful', note: '两句仍太长，下次试一句', at: '2026-11-12T02:00:00Z' })))
    assert.equal(saved.saved, true)
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).unrelated, 123)
    appendLearningRecord(root, saved.auditEvent)
    const audit = readRecordEvents(root, { type: 'learning' })[0]
    assert.equal(audit.data.action, 'practice')
    assert.equal(audit.data.selfReported, true)
    const revoked = learnDecide(saved.ledger, pending.id, 'reject')
    assert.equal(learnFeedback(revoked.ledger, pending.id, { outcome: 'tried', note: 'fixture' }).ok, false)
    assert.equal(learnInject(revoked.ledger, { mode: 'dafeiyu' }).used, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('learning queries match normalized words across fields and deterministic topic aliases without inventing semantic matches', () => {
  let book = approved({}, { kind: 'fact', text: '定格动画通过逐格拍摄制作', when: '聊动画制作和AI辅助', from: 'BV1234567890' }).book
  book = approved(book, { kind: 'fact', text: '足球比赛的中场换人', from: 'BV1234567891' }).book
  const before = JSON.stringify(book)
  for (const query of ['动画 BV1234567890', 'ＢＶ１２３４５６７８９０ ＡＩ', 'stop motion BV1234567890', 'STOP-MOTION ANIMATION 制作']) {
    const list = learnList(book, { state: 'approved', query })
    assert.equal(list.matched, 1, query)
    assert.match(list.items[0].text, /定格动画/)
    assert.equal(list.items[0].availableForRecall, true)
    assert.deepEqual(list.items[0].sourceLinks, [{ label: 'BV1234567890', url: 'https://www.bilibili.com/video/BV1234567890' }])
    const result = learnInject(book, { mode: 'dafeiyu', query, budget: 1200 })
    assert.equal(result.selectedIds.length, 1, query)
    assert.equal(result.selected[0].state, 'approved')
    assert.equal(result.selected[0].availableForRecall, true)
    assert.equal(result.selected[0].sources[0], 'BV1234567890')
  }
  assert.equal(learnList(book, { state: 'all', query: '不存在的内容' }).matched, 0, 'query is not silently ignored')
  const miss = learnInject(book, { mode: 'dafeiyu', query: '动画 BV1234567891' })
  assert.equal(miss.reason, 'no-related-learning', 'all explicit query words must refer to the same experience')
  assert.equal(miss.approvedCount, 2, 'a failed query must not imply no approved knowledge exists')
  assert.equal(learnInject(book, { mode: 'dafeiyu', query: '完全无关的茶叶理论' }).selectedIds.length, 0)
  assert.equal(JSON.stringify(book), before, 'search and recall do not change approval, usage, sources or revision')
})

test('legacy keyed records keep readable identity and sources while corrupt containers never look like empty knowledge', () => {
  const book = { items: {
    'legacy-fact': { kind: 'fact', state: 'approved', text: '红茶发酵程度影响风味', sources: [{ from: 'BV1234567890' }] },
    'legacy-jargon': { kind: 'jargon', state: 'approved', text: '哔哩哔哩里的视频作者称为UP主', from: '圈内说明' },
  } }
  const before = JSON.stringify(book)
  const row = learnList(book, { state: 'approved', filter: '红茶 BV1234567890' }).items[0]
  assert.equal(row.id, 'legacy-fact')
  assert.deepEqual(row.sources, ['BV1234567890'])
  assert.equal(row.availableForRecall, true)
  assert.deepEqual(learnInject(book, { mode: 'dafeiyu', query: '茶' }).selectedIds, ['legacy-fact'], 'a meaningful one-character Chinese query is not an empty context')
  assert.deepEqual(learnInject(book, { mode: 'dafeiyu', query: 'bilibili 视频作者' }).selectedIds, ['legacy-jargon'])
  assert.equal(JSON.stringify(book), before, 'legacy compatibility is a projection, not a disk migration')
  for (const broken of [null, [], 'broken', { items: [] }, { items: null }, { history: null }]) {
    assert.throws(() => learnList(broken), { code: 'LEARN_STATE_INVALID' })
    assert.throws(() => learnInject(broken, { mode: 'dafeiyu' }), { code: 'LEARN_STATE_INVALID' })
  }
  assert.equal(learnList(undefined).matched, 0)
  assert.equal(learnList({}).matched, 0)
})
