import test from 'node:test'
import assert from 'node:assert/strict'
import { createBrowseProgress, observeBrowseProgress, browseProgressBrief } from '../lib/browse-progress.mjs'

const A = 'BV14AHP6VExR', B = 'BV14AHP6VExS', C = 'BV14AHP6VExT'
// Include the private fixture's digit sequence in a legitimate timestamp:
// privacy checks must inspect stored values/keys, not arbitrary number substrings.
const NOW = 1794488400123
const observe = (state, tool, args, result) => observeBrowseProgress(state, { tool, args, result, now: NOW })

test('a run keeps remaining candidates across reads, missing subtitles and repeated discovery', () => {
  const initial = createBrowseProgress(NOW)
  let state = observe(initial, 'bili_search', {}, { fresh: [{ bvid: A }, { bvid: B }, { bvid: A }, { bvid: C }] })
  assert.deepEqual(browseProgressBrief(state, NOW).next.args, { bvid: A })
  state = observe(state, 'bili_subtitle', { bvid: A }, { text: '实际原文' })
  assert.equal(browseProgressBrief(state, NOW).next.action, 'reflect-or-move-on')
  state = observe(state, 'bili_subtitle', { bvid: B }, { message: '该视频没有字幕' })
  assert.deepEqual(browseProgressBrief(state, NOW).next.args, { bvid: C })
  state = observe(state, 'bili_search', {}, { fresh: [{ bvid: A }, { bvid: B }, { bvid: C }] })
  assert.deepEqual(state.pendingBvids, [C])
  assert.deepEqual(initial.pendingBvids, [], 'updates cannot mutate a saved checkpoint')
  assert.deepEqual(state.readBvids, [A])
  assert.deepEqual(state.skippedBvids, [B])
})

test('repeated blocked sends lead to read work, preserving retry time and unknown outcome', () => {
  let state = observe(createBrowseProgress(NOW), 'bili_search', {}, { fresh: [{ bvid: A }] })
  state = observe(state, 'bili_reply', { bvid: B, text: '不能保存的私密正文' }, { blocked: true, pace: true, reason: 'gap', retryAt: new Date(NOW + 60000).toISOString() })
  state = observe(state, 'bili_dm_reply', { uid: '123', text: '不能保存的私信' }, { unknown: true, error: '不能保存的外部错误原文' })
  const brief = browseProgressBrief(state, NOW)
  assert.equal(brief.next.action, 'continue-reading')
  assert.deepEqual(brief.next.args, { bvid: A })
  assert.equal(brief.blockedSendKinds[0].retryAt, NOW + 60000)
  assert.equal(brief.blockedSendKinds[1].reason, 'unknown-result')
  assert.doesNotMatch(JSON.stringify(state), /私密|私信|外部错误|"uid"\s*:|"123"/)
  assert.equal(browseProgressBrief(state, NOW + 60001).blockedSendKinds.length, 1)
  assert.deepEqual(createBrowseProgress(NOW).blockedSendKinds, [], 'another run has no shared state')
})

test('exhausted discovery changes source and the working set stays bounded', () => {
  let state = observe(createBrowseProgress(NOW), 'bili_search', {}, { fresh: [] })
  assert.equal(browseProgressBrief(state).next.action, 'change-source')
  for (let i = 0; i < 100; i++) state = observe(state, 'bili_search', {}, { fresh: [{ bvid: 'BV' + String(i).padStart(10, '0') }] })
  assert.equal(state.pendingBvids.length, 24)
  assert.equal(state.pendingBvids[0], 'BV0000000000', 'new discovery cannot evict unfinished work at the head')
  state = observe(state, 'bili_comment', {}, { blocked: true })
  state = observe(state, 'bili_comment', {}, { blocked: true })
  state.pendingBvids = []
  assert.equal(browseProgressBrief(state).next.action, 'discover')
})

test('pace checks move work forward, resolve expired channel waits and preserve unknown sends', () => {
  let state = observe(createBrowseProgress(NOW), 'bili_search', {}, { fresh: [{ bvid: A }, { bvid: B }] })
  state = observe(state, 'bili_subtitle', { bvid: A }, { text: '实际字幕' })
  state = observe(state, 'bili_pace', { kind: 'comment' }, { ok: true, kinds: {
    comment: { waitSec: 60, nextAt: new Date(NOW + 60000).toISOString(), blockedBy: 'gap' },
  } })
  assert.equal(browseProgressBrief(state, NOW).next.action, 'reflect-or-move-on')
  assert.equal(browseProgressBrief(state, NOW).next.bvid, A)
  assert.equal(state.blockedSendKinds[0].retryAt, NOW + 60000)
  state = observe(state, 'bili_dm_reply', {}, { unknown: true })
  state = observe(state, 'bili_pace', {}, { ok: true, kinds: {
    comment: { waitSec: 0 }, dm: { waitSec: 0 },
  } })
  assert.deepEqual(state.blockedSendKinds.map(row => row.kind), ['dm'])
  assert.equal(state.blockedSendKinds[0].reason, 'unknown-result')
  const other = observe(createBrowseProgress(NOW), 'bili_pace', {}, { ok: true, kinds: {
    comment: { waitSec: 0 }, moment: { waitSec: 100, blockedBy: 'hour' },
  } })
  assert.equal(other.blockedAttempts, 0, 'one blocked channel in an overview is not a failed action')
})

test('an explicit local skip removes queued work without pretending subtitles were read', () => {
  let state = observe(createBrowseProgress(NOW), 'bili_search', {}, { fresh: [{ bvid: A }, { bvid: B }] })
  state = observe(state, 'bili_seen', { action: 'mark', bvid: A, note: '不保存备注' }, { ok: true })
  assert.deepEqual(state.pendingBvids, [B])
  assert.deepEqual(state.readBvids, [])
  assert.deepEqual(state.skippedBvids, [A])
  assert.doesNotMatch(JSON.stringify(state), /不保存/)
})

test('an elapsed pace limit cannot leave later rounds stuck in blocked guidance', () => {
  let state = observe(createBrowseProgress(NOW), 'bili_pace', { kind: 'comment' }, { ok: true, kinds: {
    comment: { waitSec: 60, nextAt: new Date(NOW + 60000).toISOString(), blockedBy: 'gap' },
  } })
  assert.equal(browseProgressBrief(state, NOW).next.action, 'discover')
  assert.equal(browseProgressBrief(state, NOW + 60001).next.action, 'discover')
  state = observe(state, 'bili_comment', {}, { ok: false, error: 'synthetic temporary failure' })
  assert.equal(browseProgressBrief(state, NOW + 60001).next.action, 'discover')
})

test('one blocked channel or uncertain target cannot suppress later reactions and discovery', () => {
  for (const reason of ['gap', 'hour', 'quota', 'unknown-result']) {
    let state = observe(createBrowseProgress(NOW), 'bili_search', { page: 2 }, { page: 2, has_more: true, fresh: [{ bvid: A }] })
    state = reason === 'unknown-result'
      ? observe(state, 'bili_dm_reply', { uid: '987654321', msg_seqno: '123', text: '不保留的私信正文' }, { unknown: true })
      : observe(state, 'bili_pace', { kind: 'comment' }, { ok: true, kinds: { comment: {
        waitSec: 3600, nextAt: new Date(NOW + 3600000).toISOString(), blockedBy: reason,
      } } })
    state = observe(state, 'bili_subtitle', { bvid: A }, { text: '新的实际阅读原文' })
    let brief = browseProgressBrief(state, NOW)
    assert.equal(brief.next.action, 'reflect-or-move-on', reason)
    assert.equal(brief.next.bvid, A)
    assert.equal(brief.blockedSendKinds.length, 1)
    assert.equal(brief.blockedSendKinds[0].scope, reason === 'unknown-result' ? 'target' : 'channel')
    assert.match(brief.next.hint, /独立且已授权/)
    assert.match(brief.next.hint, /同一次被拦发送/)
    assert.match(brief.next.hint, /未知结果的同一目标不重试/)
    // Skipping further reflection should resume real pagination, not a synthetic global rest.
    state = observe(state, 'bili_seen', { action: 'mark', bvid: A }, { ok: true })
    brief = browseProgressBrief(state, NOW)
    assert.equal(brief.next.action, 'search-next-page', reason)
    assert.equal(brief.next.page, 3)
    if (reason === 'unknown-result') {
      state = observe(state, 'bili_pace', { kind: 'dm' }, { ok: true, kinds: { dm: { waitSec: 0 } } })
      assert.equal(browseProgressBrief(state, NOW + 86400000).blockedSendKinds[0].reason, 'unknown-result', 'an open channel cannot erase the unresolved target')
    }
    assert.doesNotMatch(JSON.stringify(state), /987654321|私信正文/)
  }
})

test('global risk cooldowns and burst limits remain all-send pauses in progress guidance', () => {
  for (const reason of ['cooldown', 'burst']) {
    for (const viaPace of [true, false]) {
      let state = observe(createBrowseProgress(NOW), 'bili_search', {}, { fresh: [{ bvid: A }, { bvid: B }] })
      state = viaPace
        ? observe(state, 'bili_pace', { kind: 'comment' }, { ok: true, kinds: { comment: {
          waitSec: 3600, nextAt: new Date(NOW + 3600000).toISOString(), blockedBy: reason,
        } } })
        : observe(state, 'bili_comment', { bvid: C }, { blocked: true, pace: true, reason, riskCooldown: reason === 'cooldown', retryAt: NOW + 3600000 })
      assert.equal(browseProgressBrief(state, NOW).blockedSendKinds[0].scope, 'all')
      assert.match(browseProgressBrief(state, NOW).next.hint, /只读，停所有发送/)
      state = observe(state, 'bili_subtitle', { bvid: A }, { text: '冷却仍可读实际原文' })
      const brief = browseProgressBrief(state, NOW)
      assert.equal(brief.next.action, 'reflect-or-move-on')
      assert.equal(brief.blockedSendKinds[0].scope, 'all')
      assert.match(brief.next.hint, /只有局部通道或目标受限时/)
      assert.match(brief.next.hint, /只读，停所有发送/)
    }
  }
})

test('a failed or pending subtitle stays deferred, becomes retryable later, and never masquerades as read', () => {
  let state = observe(createBrowseProgress(NOW), 'bili_search', {}, { fresh: [{ bvid: A }, { bvid: B }] })
  state = observe(state, 'bili_subtitle', { bvid: A }, { ok: false, segments: 20, text: '不完整残留文本' })
  assert.deepEqual(state.readBvids, [])
  assert.deepEqual(state.skippedBvids, [])
  assert.equal(state.deferredReads[0].reason, 'transport')
  assert.deepEqual(browseProgressBrief(state, NOW).pendingBvids, [B])
  assert.deepEqual(browseProgressBrief(state, NOW + 30001).pendingBvids, [B, A])
  state = observeBrowseProgress(state, { tool: 'bili_subtitle', args: { bvid: A },
    result: { guard_status: 'pending', retryAt: new Date(NOW + 180000).toISOString() }, now: NOW + 30001 })
  assert.equal(state.deferredReads[0].reason, 'lease')
  assert.equal(state.deferredReads[0].retryAt, NOW + 180000)
  const restored = structuredClone(state)
  assert.deepEqual(browseProgressBrief(restored, NOW + 180001).pendingBvids, [B, A], 'a relay checkpoint retains due reads')
  state = observeBrowseProgress(restored, { tool: 'bili_subtitle', args: { bvid: A }, result: { error: 'temporary' }, now: NOW + 180001 })
  assert.equal(state.deferredReads[0].retryAt, 0)
  assert.deepEqual(browseProgressBrief(state, NOW + 3600000).pendingBvids, [B], 'retries are bounded instead of an automatic polling loop')
  assert.deepEqual(state.skippedBvids, [])
  state = observe(state, 'bili_subtitle', { bvid: A }, { text: '成功取得的真实原文' })
  assert.deepEqual(state.readBvids, [A])
  assert.deepEqual(state.deferredReads, [])
})

test('a segment count without original text is insufficient evidence of reading', () => {
  let state = observe(createBrowseProgress(NOW), 'bili_subtitle', { bvid: A }, { segments: 4 })
  assert.deepEqual(state.readBvids, [])
  assert.equal(state.deferredReads.length, 1)
  state = observe(state, 'bili_subtitle', { bvid: A }, { segments: 0, text: '' })
  assert.deepEqual(state.skippedBvids, [A])
  assert.deepEqual(state.deferredReads, [])
})

test('exhausted pages use real pagination while transport failures remain distinct from empty sources', () => {
  let state = observe(createBrowseProgress(NOW), 'bili_search', { keyword: '合成公开关键词', page: 2 }, { page: 2, has_more: true, fresh: [] })
  let brief = browseProgressBrief(state, NOW)
  assert.equal(brief.next.action, 'search-next-page')
  assert.equal(brief.next.page, 3)
  assert.doesNotMatch(JSON.stringify(state), /合成公开关键词/, 'only an opaque discovery fingerprint is retained')
  const failed = observe(createBrowseProgress(NOW), 'bili_search', {}, { ok: false, error: 'failure' })
  assert.equal(failed.emptySources, 0)
  assert.equal(failed.lastDiscovery.outcome, 'error')
  assert.equal(browseProgressBrief(failed).next.action, 'change-source')
  for (let i = 0; i < 3; i++) state = observe(state, 'bili_rank', {}, { fresh: [] })
  assert.equal(browseProgressBrief(state).next.action, 'rest-or-change-source')
})

test('three empty search pages stop pagination even when the platform has more unfiltered results', () => {
  let state = createBrowseProgress(NOW)
  for (let page = 1; page <= 3; page++) {
    state = observe(state, 'bili_search', { keyword: '合成关键词', page }, { page, has_more: true, fresh: [] })
    const next = browseProgressBrief(state, NOW, { compact: true }).next
    assert.equal(next.action, page < 3 ? 'search-next-page' : 'rest-or-change-source')
  }
  assert.equal(state.emptySources, 3)
})

test('a compact queue keeps revealing the remaining candidates beyond its first three', () => {
  const ids = Array.from({ length: 6 }, (_, i) => 'BV' + String(i).padStart(10, '0'))
  let state = observe(createBrowseProgress(NOW), 'bili_search', {}, { fresh: ids.map(bvid => ({ bvid })) })
  for (let index = 0; index < ids.length; index++) {
    const brief = browseProgressBrief(state, NOW, { compact: true })
    assert.deepEqual(brief.pendingBvids, ids.slice(index, index + 3))
    assert.equal(brief.pendingCount, ids.length - index)
    state = observe(state, 'bili_subtitle', { bvid: ids[index] }, { text: '实际合成字幕' })
  }
  assert.equal(browseProgressBrief(state, NOW, { compact: true }).pendingCount, 0)
})

test('unchanged queries keep the semantic revision and compact guidance omits repeated prose', () => {
  const result = { ok: true, kinds: { comment: { waitSec: 60, nextAt: new Date(NOW + 60000).toISOString(), blockedBy: 'gap' } } }
  const state = observe(createBrowseProgress(NOW), 'bili_pace', { kind: 'comment' }, result)
  const repeated = observeBrowseProgress(state, { tool: 'bili_pace', args: { kind: 'comment' }, result, now: NOW + 1000 })
  assert.equal(repeated, state)
  assert.equal(repeated.revision, 1)
  const compact = browseProgressBrief(state, NOW, { compact: true })
  assert.equal(compact.next.hint, undefined)
  assert.equal(compact.nextReadRetryAt, 0)
  assert.doesNotMatch(JSON.stringify(compact), /Infinity/)
  const old = { phase: 'read', pendingBvids: [A, B], readBvids: [], skippedBvids: [] }
  const migrated = observe(old, 'bili_comments', {}, { comments: [] })
  assert.equal(migrated.version, 2)
  assert.equal(migrated.revision, 1)
  assert.deepEqual(migrated.pendingBvids, [A, B])
})
