import test from 'node:test'
import assert from 'node:assert/strict'
import { replySkipReason, replyRemember, REPLY_LEDGER_MAX } from '../lib/reply.mjs'

const big = '1234567890123456789'
test('reply target preserves exact IDs, missing/zero fallback, and rejects invalid primaries', () => {
  assert.equal(replySkipReason({ reply_rpid: big }), '')
  assert.equal(replySkipReason({ root_rpid: big }), '')
  assert.equal(replySkipReason({ reply_rpid: 0, root_rpid: big }), '')
  assert.match(replySkipReason(undefined), /没有 rpid/)
  for (const value of [Number(big), {}, null, false, 'bad', -1]) assert.match(replySkipReason({ reply_rpid: value, root_rpid: big }), /无效|不安全/)
  assert.match(replySkipReason({ reply_rpid: big }, { at: '2026-10-29' }), new RegExp(`${big}.*2026-10-29`))
  assert.doesNotMatch(replySkipReason({ reply_rpid: big }, {}), /undefined|额度|上限|每轮|每日/)
})

test('legacy reply keys accept only safe decimal and video identities without mutating the ledger', () => {
  const original = { old: { at: '2026-01-01' } }, rec = { at: '2026-10-29' }
  assert.deepEqual(replyRemember(original, `video:${big}`, rec), { ...original, [`video:${big}`]: rec })
  assert.deepEqual(replyRemember(undefined, 123, rec), { 123: rec })
  assert.deepEqual(replyRemember([], `  video:000${big}  `, rec), { [`video:${big}`]: rec })
  for (const key of [undefined, null, {}, [], false, 0, '0', 'video:0', Number(big), -1, 1.5, 'NaN', '__proto__', 'constructor', 'video:bad', 'dm:123', 'opus:123']) {
    assert.deepEqual(replyRemember(original, key, rec), original, String(key))
  }
  assert.deepEqual(original, { old: { at: '2026-01-01' } })
})

test('reply pruning respects the shared limit and retains undated legacy entries', () => {
  const ledger = { legacy: {} }
  for (let i = 0; i < REPLY_LEDGER_MAX - 1; i++) ledger[String(i + 1)] = { at: new Date(1600000000000 + i * 1000).toISOString() }
  const result = replyRemember(ledger, `video:${big}`, { at: '2026-10-29' })
  assert.equal(Object.keys(result).length, REPLY_LEDGER_MAX)
  assert.ok(result.legacy); assert.equal(result['1'], undefined); assert.ok(result[`video:${big}`]); assert.ok(ledger['1'])
})
