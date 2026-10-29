import test from 'node:test'
import assert from 'node:assert/strict'
import { memoryCenterSnapshot, memoryFingerprint } from '../lib/memory-center.mjs'
import { learnAdd } from '../lib/learn.mjs'
import { soulTemplate, soulSetSection } from '../lib/persona.mjs'

test('memory center searches every authority separately and never turns history into mutable memory', () => {
  const added = learnAdd({}, { kind: 'fact', text: '纸张动画的留白更舒服', from: 'BV1bKJX6mEnY' })
  const soul = soulSetSection(soulTemplate(), 'mood', '<!-- keep comment -->\n- 今天特别喜欢纸张动画\n- 下次再看一遍')
  const input = { learn: added.ledger, soulText: soul, voiceText: '# 语气\n<!-- secret comment -->\n- 先说具体细节，再开玩笑',
    taste: { '1234567890123456789': { text: '纸张的摩擦声很舒服', likes: 3, likesAt: '', at: '2026-10-29T01:00:00Z' } },
    seen: { BV1bKJX6mEnY: { note: '纸张动画', at: '2026-10-29T01:01:00Z' }, invalid: { note: 'not a BV' } },
    events: [{ eventId: 'old', type: 'memory', source: 'soul.md', at: '2026-10-28', data: { name: 'soul.md', text: '纸张动画的旧心情', operation: 'write' } }],
  }
  const before = JSON.stringify(input)
  const all = memoryCenterSnapshot(input)
  assert.deepEqual(all.counts, { learning: 1, soul: 2, voice: 1, taste: 1, seen: 1, history: 1 })
  assert.equal(all.total, 7)
  assert.equal(all.historyReadOnly, true)
  for (const row of all.items.filter((row) => ['seen', 'history'].includes(row.source))) { assert.equal(row.mutable, false); assert.deepEqual(row.actions, []) }
  assert.ok(all.items.find((row) => row.source === 'voice').id === '2', 'raw line indexes preserve HTML comments')
  assert.ok(!JSON.stringify(all).includes('secret comment'))
  const search = memoryCenterSnapshot(input, { filter: '纸张' })
  assert.equal(search.matched, 5)
  assert.equal(memoryCenterSnapshot(input, { source: 'soul', filter: '纸张' }).matched, 1)
  assert.equal(memoryCenterSnapshot(input, { filter: 'BV1bKJX6mEnY' }).matched, 2)
  assert.equal(JSON.stringify(input), before)
})

test('memory projection redacts secrets, bounds pagination, and fingerprints the actual mutable source', () => {
  const raw = { text: 'Cookie: SESSDATA=very-secret-value; bili_jct=12345678901234567890123456789012', likes: 4 }
  const result = memoryCenterSnapshot({ taste: { '123': raw } }, { limit: 9999, offset: -1 })
  assert.equal(result.limit, 50)
  assert.equal(result.offset, 0)
  assert.equal(result.items[0].version, memoryFingerprint(raw))
  assert.ok(!result.items[0].text.includes('very-secret-value'))
  assert.deepEqual(result.items[0].actions, ['forget'])
  const entries = Object.fromEntries(Array.from({ length: 150 }, (_, index) => ['fact:' + index, { id: 'fact:' + index, text: '经验 ' + index, kind: 'fact', state: 'pending', at: '2026-10-29' }]))
  const combined = memoryCenterSnapshot({ learn: { items: entries } }, { source: 'learning', offset: 140, limit: 20 })
  assert.equal(combined.matched, 150, 'combined search does not silently stop at learnList first page')
  assert.equal(combined.items.length, 10)
  assert.equal(combined.more, false)
})
