import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
const between = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length)
  assert.ok(a >= 0 && b > a, `missing source block: ${start}`)
  return source.slice(a, b)
}

test('status polling is single-flight and stale HTTP cannot overwrite a local save', () => {
  const block = between('function useStatus(', '/* 🗑 旧的全页设置 Panel')
  assert.match(block, /if \(inFlight\.current\) return/)
  assert.match(block, /const epoch = localEpoch\.current/)
  assert.match(block, /epoch !== localEpoch\.current/)
  assert.match(block, /seq !== requestSeq\.current/)
  assert.match(block, /externalSet\.current = \(next\) => \{ localEpoch\.current \+= 1; setSt\(next\) \}/)
  assert.ok(block.indexOf('epoch !== localEpoch.current') > block.indexOf("await jget('/status"), 'stale guard must run after the response arrives')
  assert.match(block, /setInterval\(tick, intervalMs \|\| 5000\)/, 'existing polling cadence stays intact')
})

test('activity polling cannot overlap and clear invalidates an older response', () => {
  const block = between("const activityCursor = React.useRef('')", 'const logRev = React.useRef')
  assert.match(block, /if \(dead \|\| activityRequest\.current\) return/)
  assert.match(block, /const token = \{ epoch: activityEpoch\.current \}/)
  assert.match(block, /activityRequest\.current !== token \|\| token\.epoch !== activityEpoch\.current/)
  assert.match(block, /activityEpoch\.current \+= 1; activityCursor\.current = ''/)
  assert.match(block, /if \(sinceUid !== activityCursor\.current\) sinceUid = activityCursor\.current/)
})

test('login polling is single-flight and an older timer cannot regress a newer login', () => {
  const block = between('const onLoginStart = async () => {', 'const onInstall = async () => {')
  assert.match(block, /const generation = \+\+loginGeneration\.current/)
  assert.match(block, /if \(loginPolling\.current\) return/)
  assert.match(block, /generation !== loginGeneration\.current \|\| loginTimer\.current !== timer/)
  const awaited = block.indexOf("await jpost('/login/poll'")
  assert.ok(block.indexOf('generation !== loginGeneration.current || loginTimer.current !== timer', awaited) > awaited, 'timer/generation must be rechecked after the response')
  assert.match(block, /finally \{ if \(generation === loginGeneration\.current && loginTimer\.current === timer\) loginPolling\.current = false \}/)
})
