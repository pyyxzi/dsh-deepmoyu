import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateRunSettings, clampRunSettings, resolveRunOptions, scheduleRunDeadline } from '../lib/run-settings.mjs'

test('legacy values only migrate missing mode keys', () => {
  const migrated = migrateRunSettings({ modelId: 'old/model', tokenBudget: 120000, maxRounds: 12, sessionModelId: '', backgroundTokenBudget: 0 })
  assert.equal(migrated.sessionModelId, '')
  assert.equal(migrated.backgroundModelId, 'old/model')
  assert.equal(migrated.sessionTokenBudget, 120000)
  assert.equal(migrated.backgroundTokenBudget, 0)
  assert.equal(migrated.sessionMaxRounds, 12)
  assert.equal(migrated.backgroundMinutes, 45)
})

test('mode options remain independent and explicit rounds are not inferred from tokens', () => {
  const cfg = { sessionModelId: 's/m', sessionTokenBudget: 10, sessionMaxRounds: 19, sessionMinutes: 0, backgroundModelId: 'b/m', backgroundTokenBudget: 90000, backgroundMinutes: 17 }
  assert.deepEqual(resolveRunOptions(cfg, 'session', { tokenBudget: 5000000 }).maxRounds, 19)
  const session = resolveRunOptions(cfg, 'session', { model: 'x/y', maxRounds: 7, durationMinutes: 20 })
  assert.equal(session.model, 'x/y'); assert.equal(session.maxRounds, 7); assert.equal(session.tokenBudget, 10)
  const bg = resolveRunOptions(cfg, 'background')
  assert.equal(bg.model, 'b/m'); assert.equal(bg.durationMinutes, 17)
  assert.equal(bg.tokenBudgetEnforcement, 'advisory'); assert.equal(bg.maxRoundsEnforcement, 'single-run')
  assert.equal(cfg.sessionModelId, 's/m')
})

test('new config bounds clamp to documented integer ranges', () => {
  assert.deepEqual(clampRunSettings({ sessionMinutes: -1, backgroundMinutes: 999, sessionMaxRounds: 2000, sessionTokenBudget: 9999999, backgroundTokenBudget: -1 }), { sessionMinutes: 0, backgroundMinutes: 180, sessionMaxRounds: 1000, sessionTokenBudget: 5000000, backgroundTokenBudget: 0 })
})

test('deadline timer works without a tool or idle event and is unreferenced', () => {
  let callback, delay, unref = false, expired = false
  const timer = { unref() { unref = true } }
  const timers = { setTimeout(fn, ms) { callback = fn; delay = ms; return timer } }
  assert.equal(scheduleRunDeadline(0, () => {}, timers), null)
  assert.equal(scheduleRunDeadline(Date.now() + 5000, () => { expired = true }, timers), timer)
  assert.ok(delay > 4000 && delay <= 5000); assert.ok(unref)
  callback(); assert.ok(expired)
})
