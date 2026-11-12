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

test('specific memory sources never evaluate unrelated inputs and count only their selected scope', () => {
  const input = { soulText: soulSetSection(soulTemplate(), 'mood', '- 想看新鲜事') }
  for (const key of ['learn', 'voiceText', 'taste', 'seen', 'events']) Object.defineProperty(input, key, { get() { throw new Error('UNRELATED_SOURCE_READ: ' + key) } })
  const result = memoryCenterSnapshot(input, { source: 'soul' })
  assert.equal(result.total, 1)
  assert.equal(result.matched, 1)
  assert.deepEqual(result.counts, { learning: 0, soul: 1, voice: 0, taste: 0, seen: 0, history: 0 })
  assert.throws(() => memoryCenterSnapshot(input, { source: 'all' }), /UNRELATED_SOURCE_READ/)
})

test('combined learning pages retain searchable legacy records beyond the old 1200-row ceiling', () => {
  const items = Object.fromEntries(Array.from({ length: 1305 }, (_, index) => {
    const id = 'fact:' + String(index).padStart(4, '0')
    return [id, { id, kind: 'fact', state: 'pending', text: '历史经验' + index, at: '2026-01-01' }]
  }))
  const lastPage = memoryCenterSnapshot({ learn: { items } }, { source: 'learning', offset: 1295, limit: 20 })
  assert.equal(lastPage.matched, 1305)
  assert.equal(lastPage.items.length, 10)
  assert.equal(lastPage.more, false)
  assert.equal(memoryCenterSnapshot({ learn: { items } }, { source: 'learning', filter: '历史经验1304' }).matched, 1)
})

test('memory search shares multiword and alias matching with learning while preserving state and paging', () => {
  const learn = { items: {
    old: { kind: 'fact', state: 'approved', text: '定格动画通过逐格拍摄制作', when: '了解AI辅助', sources: ['BV1234567890'] },
    pending: { kind: 'fact', state: 'pending', text: '另一个定格动画待审说法', from: 'BV1234567891' },
  } }
  const input = { learn }, before = JSON.stringify(input)
  const result = memoryCenterSnapshot(input, { source: 'learning', query: 'STOP MOTION ＢＶ１２３４５６７８９０', limit: 1 })
  assert.equal(result.total, 2)
  assert.equal(result.matched, 1)
  assert.equal(result.count, 1)
  assert.equal(result.hasMore, false)
  assert.equal(result.nextOffset, null)
  assert.equal(result.items[0].id, 'old')
  assert.equal(result.items[0].availableForRecall, true)
  assert.deepEqual(result.items[0].sources, ['BV1234567890'])
  assert.equal(result.items[0].sourceLinks[0].url, 'https://www.bilibili.com/video/BV1234567890')
  const all = memoryCenterSnapshot(input, { source: 'learning', filter: '动画', limit: 1 })
  assert.equal(all.hasMore, true)
  assert.equal(all.nextOffset, 1)
  const last = memoryCenterSnapshot(input, { source: 'learning', filter: '动画', offset: all.nextOffset, limit: 1 })
  assert.notEqual(last.items[0].id, all.items[0].id)
  assert.equal(JSON.stringify(input), before)
  assert.throws(() => memoryCenterSnapshot({ learn: { items: [] } }, { source: 'learning' }), { code: 'LEARN_STATE_INVALID' })
})
