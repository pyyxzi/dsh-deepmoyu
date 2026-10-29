import test from 'node:test'
import assert from 'node:assert/strict'
import { COMPANION_DEFAULTS, clampCompanionSettings, companionPolicy, nextChatterAt, companionPrompt } from '../lib/companion.mjs'
import { interactionStyleGuide, buildFeiyuObjective, buildLiveBrief } from '../lib/prompts.mjs'

test('companion clocks are local, half-open and cross midnight without modifying run permissions', () => {
  const cfg = { quietHoursEnabled: true, quietHoursStart: '23:00', quietHoursEnd: '08:00', autoComment: true }
  for (const [hour, minute, quiet] of [[22, 59, false], [23, 0, true], [7, 59, true], [8, 0, false]]) {
    const p = companionPolicy(cfg, new Date(2026, 9, 29, hour, minute))
    assert.equal(p.quiet, quiet)
    assert.equal(p.chatterAllowed, !quiet)
  }
  assert.equal(cfg.autoComment, true)
  assert.equal(companionPolicy({ ...cfg, quietHoursStart: '08:00', quietHoursEnd: '08:00' }).quiet, false)
  assert.equal(companionPolicy({ focusMode: true }).silenced, true)
  assert.equal(companionPolicy({ idleChatter: false }).chatterAllowed, false)
})

test('preferences validate strict booleans and leave unrelated defaults intact', () => {
  const clean = clampCompanionSettings({ focusMode: 'false', quietHoursEnabled: 1, petReducedMotion: {}, chatterFrequency: 'fast', notificationLevel: 'off', quietHoursStart: '99:42', autoComment: false })
  for (const key of ['focusMode', 'quietHoursEnabled', 'petReducedMotion', 'chatterFrequency', 'notificationLevel', 'quietHoursStart']) assert.equal(clean[key], COMPANION_DEFAULTS[key])
  assert.equal(clean.autoComment, false)
  assert.equal(companionPolicy({ quietHoursEnabled: false }, new Date(2026, 9, 29, 0)).silenced, false)
})

test('frequency picks a single bounded due time; prompt keeps terminal receipts visible', () => {
  const now = new Date(2026, 9, 29, 12).getTime()
  assert.equal(nextChatterAt({}, now, 0), now + 132 * 60_000)
  assert.equal(nextChatterAt({}, now, 1), now + 210 * 60_000)
  assert.equal(nextChatterAt({ chatterFrequency: 'rare' }, now, -1), now + 240 * 60_000)
  assert.equal(nextChatterAt({ chatterFrequency: 'lively' }, now, 2), now + 90 * 60_000)
  assert.match(companionPrompt({ focusMode: true }), /完成结果.*仍要清楚反馈/)
})

test('all four interaction choices affect real objective and live brief without changing authorization', () => {
  for (const interactionStyle of ['quiet', 'companion', 'creator', 'steward']) {
    const cfg = { interactionStyle, perDay: 5, momentPerDay: 1, dmMode: 'off' }
    const base = { cfg, stateDir: 'fixture', outDir: 'fixture/out', digestDir: 'fixture/digest', charter: 'fixture/duty.md', day: '2026-10-29' }
    assert(buildFeiyuObjective(base).includes(interactionStyleGuide(interactionStyle)))
    const brief = buildLiveBrief({ ...base, picked: 0, moments: 0 })
    assert(brief.includes(interactionStyleGuide(interactionStyle)))
    assert.match(brief, /评论：关/)
    assert.match(brief, /私信回复：关/)
  }
})
