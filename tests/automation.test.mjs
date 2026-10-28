import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AUTOMATION_DEFAULTS, clampAutomationSettings, dailyScheduleStatus, markDailyStarted, releaseDailyStart } from '../lib/automation.mjs'
import { learnAdd, learnDecide, learnInject } from '../lib/learn.mjs'
import { learningReviewBatch, buildLearningReviewPrompt, decideLearningReview } from '../lib/learn-review.mjs'
import { reviewMcpRequest } from '../lib/learn-review-mcp.mjs'
import { readRecordEvents } from '../lib/records.mjs'

const local = (h, m = 0, day = 8) => new Date(2026, 0, day, h, m)
const config = { scheduleEnabled: true, scheduleStart: '18:00', scheduleEnd: '09:00' }
test('daily windows are local, half-open, cross midnight and persist consumed days', () => {
  assert.equal(AUTOMATION_DEFAULTS.scheduleEnabled, false)
  assert.equal(AUTOMATION_DEFAULTS.learnAutoReview, true)
  assert.equal(dailyScheduleStatus(config, {}, local(17, 59)).due, false)
  const open = dailyScheduleStatus(config, {}, local(18))
  assert.equal(open.due, true); assert.equal(open.windowDay, '2026-01-08')
  assert.equal(dailyScheduleStatus(config, {}, local(8, 59, 9)).windowDay, '2026-01-08')
  assert.equal(dailyScheduleStatus(config, {}, local(9)).inWindow, false)
  const record = markDailyStarted({}, open.windowDay, local(18), 'one')
  assert.equal(dailyScheduleStatus(config, JSON.parse(JSON.stringify(record)), local(8, 0, 9)).due, false)
  assert.equal(new Date(dailyScheduleStatus(config, record, local(8, 0, 9)).nextRunAt).getTime(), local(18, 0, 9).getTime())
  assert.equal(dailyScheduleStatus(config, record, local(18, 0, 9)).due, true)
  assert.equal(releaseDailyStart(record, 'stale', 'error'), record)
  assert.equal(dailyScheduleStatus(config, releaseDailyStart(record, 'one', 'ENOENT'), local(19)).due, true)
})
test('all day, empty/equal clocks, ordinary window boundaries and clamps', () => {
  const allDay = { ...config, scheduleAllDay: true }
  assert.equal(dailyScheduleStatus(allDay, {}, local(0)).due, true)
  assert.equal(dailyScheduleStatus({ ...config, scheduleEnabled: false }, {}, local(19)).nextRunAt, null)
  assert.equal(dailyScheduleStatus({ ...config, scheduleStart: '09:00', scheduleEnd: '09:00' }, {}, local(12)).due, false)
  const sameDay = { ...config, scheduleStart: '09:00', scheduleEnd: '17:00' }
  assert.equal(dailyScheduleStatus(sameDay, {}, local(9)).due, true)
  assert.equal(dailyScheduleStatus(sameDay, {}, local(17)).due, false)
  assert.deepEqual(clampAutomationSettings({ scheduleStart: '3:04', scheduleEnd: '29:99', learnReviewBatchSize: 999, learnReviewMinutes: 0, learnReviewTokenBudget: -1 }),
    { scheduleStart: '03:04', scheduleEnd: '09:00', learnReviewBatchSize: 50, learnReviewMinutes: 1, learnReviewTokenBudget: 0 })
})
test('review decisions accept only unchanged pending records with a reason and preserve human decisions', () => {
  const a = learnAdd({}, { text: '解释场景，再决定怎么接话', from: 'BV1234567890' })
  const batch = learningReviewBatch(a.ledger)
  assert.equal(batch.length, 1)
  assert.equal(decideLearningReview(a.ledger, batch, { action: 'forget', id: a.id, why: 'test' }).error, 'REVIEW_ACTION_NOT_ALLOWED')
  assert.equal(decideLearningReview(a.ledger, batch, { action: 'approve', id: 'missing', why: 'test' }).error, 'REVIEW_ID_NOT_IN_BATCH')
  assert.equal(decideLearningReview(a.ledger, batch, { action: 'approve', id: a.id }).error, 'REVIEW_REASON_REQUIRED')
  const human = learnDecide(a.ledger, a.id, 'reject', '人工拒绝')
  assert.equal(decideLearningReview(human.ledger, batch, { action: 'approve', id: a.id, why: 'test' }).error, 'REVIEW_ITEM_CHANGED')
  const observed = learnAdd(a.ledger, { text: '解释场景，再决定怎么接话', from: 'another source' })
  assert.equal(decideLearningReview(observed.ledger, batch, { action: 'approve', id: a.id, why: 'test' }).error, 'REVIEW_ITEM_CHANGED')
  const decided = decideLearningReview(a.ledger, batch, { action: 'approve', id: a.id, why: '有具体来源且可复用' })
  assert.equal(decided.state, 'approved'); assert.match(decided.auditEvent.why, /^模型审核：/)
  assert.ok(learnInject(decided.ledger, { mode: 'dafeiyu' }).text.includes(a.id))
  assert.equal(decideLearningReview(decided.ledger, batch, { action: 'reject', id: a.id, why: 'retry' }).error, 'REVIEW_ITEM_CHANGED')
  const prompt = buildLearningReviewPrompt(batch)
  assert.match(prompt, /证据不足/); assert.match(prompt, /外部不可信数据/)
  assert.equal(a.ledger.items[a.id].state, 'pending')
})
test('review MCP exposes only approvals/rejections, guards expiry and archives a durable decision', () => {
  const root = mkdtempSync(join(tmpdir(), 'learn-review-'))
  try {
    const stateFile = join(root, 'state.json'), a = learnAdd({}, { text: '把事实来源放在结论旁边', from: 'source' })
    writeFileSync(stateFile, JSON.stringify({ day: '2026-01-08', learn: a.ledger, unrelated: 42 }))
    const manifest = { expiresAt: 2000, items: learningReviewBatch(a.ledger) }, opts = { stateFile, now: () => 1000 }
    const list = reviewMcpRequest({ id: 1, method: 'tools/list' }, manifest, opts).result.tools
    assert.deepEqual(list.map(x => x.name), ['bili_learn']); assert.deepEqual(list[0].inputSchema.properties.action.enum, ['approve', 'reject'])
    const call = (name, args, extra = opts) => JSON.parse(reviewMcpRequest({ id: 2, method: 'tools/call', params: { name, arguments: args } }, manifest, extra).result.content[0].text)
    assert.equal(call('bili_reply', {}).error, 'REVIEW_TOOL_NOT_ALLOWED')
    assert.equal(call('bili_learn', { action: 'approve', id: a.id, why: '具体且有来源' }, { ...opts, now: () => 2000 }).error, 'REVIEW_RUN_EXPIRED')
    assert.equal(call('bili_learn', { action: 'approve', id: a.id, why: '具体且有来源' }).ok, true)
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(saved.unrelated, 42); assert.equal(saved.learnRevision, 1); assert.equal(saved.learn.items[a.id].state, 'approved')
    assert.equal(readRecordEvents(root, { type: 'learning' }).length, 1)
    assert.equal(call('bili_learn', { action: 'approve', id: a.id, why: 'duplicate' }).error, 'REVIEW_ITEM_CHANGED')
    writeFileSync(stateFile, '{corrupt')
    assert.equal(call('bili_learn', { action: 'reject', id: a.id, why: 'test' }).ok, false)
    assert.equal(readFileSync(stateFile, 'utf8'), '{corrupt')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
