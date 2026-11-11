import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'
import { McpClient } from '../lib/mcp.mjs'
import { DAY_COUNTER_FIELDS, dayKey, dayResetPatch, isNewDay, resetDayCounters } from '../lib/state.mjs'

const root = mkdtempSync(join(tmpdir(), 'fish-moment-quota-'))
const flush = () => new Promise(resolve => setImmediate(resolve))
const BV = 'BV1234567890'
const TEXT = '倒影一晃，画面里那点重量就有了。'
let sequence = 0

test.after(() => rmSync(root, { recursive: true, force: true }))

test('the shared day-reset patch covers every per-day counter, including moments', () => {
  // 2026-11-02 真机事故：`bumpState` / 私信记账各自手写重置清单、都漏了 `moments`，
  // 跨天之后 `st.day` 已经是今天而 `moments` 还留着昨天的 20 ⇒ 说说被永久静默拦截。
  // 这条断言锁住"只有一份名单"，以后新增按天字段忘了登记就会红。
  assert.deepEqual([...DAY_COUNTER_FIELDS].sort(), ['count', 'moments', 'picked', 'tokensToday'])
  const patch = dayResetPatch('2026-11-03')
  assert.equal(patch.day, '2026-11-03')
  assert.deepEqual(patch.windows, {})
  for (const key of DAY_COUNTER_FIELDS) assert.equal(patch[key], 0, key)
  const st = { day: '2026-11-02', count: 7, picked: 3, moments: 20, tokensToday: 11912161, windows: { noon: 'x' }, unrelated: 42 }
  assert.equal(isNewDay(st, '2026-11-03'), true)
  assert.equal(isNewDay({ ...st, day: '2026-11-03' }, '2026-11-03'), false)
  assert.equal(isNewDay({}, '2026-11-03'), true)
  assert.equal(isNewDay(undefined, '2026-11-03'), true)
  resetDayCounters(st, '2026-11-03')
  assert.equal(st.day, '2026-11-03')
  assert.equal(st.moments, 0)
  assert.deepEqual(st.windows, {})
  assert.equal(st.unrelated, 42)
})

async function fixture(state) {
  const dir = join(root, String(++sequence)), home = join(dir, 'bili-duty')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    autoComment: true, replyToComments: true, autoMoment: true, momentPerDay: 3,
    learnAutoReview: false, reportLevel: 'off', sendReview: false, dmMode: 'off',
  }))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const cleanups = [], tools = new Map(), calls = []
  const agent = { id: 'moment-fish-' + sequence, session: { header: { agentPreset: 'dafeiyu', cwd: dir } },
    ctx: { tools: { register(spec) { tools.set(spec.name, spec); return () => tools.delete(spec.name) } } } }
  const original = McpClient.prototype.call
  McpClient.prototype.call = async function(name, args) { calls.push({ name, args }); return { success: true, rpid_str: '7654321' } }
  const ctx = { logger: { info() {} }, get: key => key === 'dshHomePath' ? (...parts) => join(dir, ...parts) : key === 'agents' ? { list: () => [agent] } : undefined,
    tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } }, settings: { describe: () => [] }, on() { return () => {} },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) }, webServer: { register() { return { dispose() {} } } } }
  apply(ctx, {}); await flush()
  return { home, calls, execute: (name, args) => tools.get(name).execute(args, { agent }),
    state: () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')),
    close() { for (const fn of cleanups.reverse()) try { fn() } catch {}; McpClient.prototype.call = original } }
}

test('a stale moments counter from a previous day no longer blocks today\'s moment, and the cap still applies within the day', async () => {
  const today = dayKey()
  // 真机现状复刻：day 已经是今天（别的记账把它推过来了），moments 还是昨天的 20。
  const f = await fixture({ day: today, moments: 20, momentsDay: '2026-10-30', lastMomentAt: '2026-10-30T05:22:07.489Z', unrelated: 61 })
  try {
    const out = await f.execute('bili_moment', { text: TEXT })
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(out.momentsToday, 1)
    assert.equal(f.calls.filter(row => row.name === 'bili_send_dynamic').length, 1)
    const saved = f.state()
    assert.equal(saved.day, today)
    assert.equal(saved.moments, 1, 'the stale 20 must not carry into today\'s count')
    assert.equal(saved.momentsDay, today)
    assert.equal(saved.unrelated, 61)
  } finally { f.close() }
})

test('a genuine same-day counter keeps blocking and says so out loud', async () => {
  const today = dayKey()
  const f = await fixture({ day: today, moments: 3, momentsDay: today, unrelated: 61 })
  try {
    const out = await f.execute('bili_moment', { text: TEXT })
    assert.equal(out.ok, false)
    assert.equal(out.blocked, true)
    assert.match(out.hint, /3\/3/)
    assert.deepEqual(f.calls, [], 'a blocked moment must not reach the platform')
    assert.equal(f.state().moments, 3)
    assert.equal(f.state().unrelated, 61)
  } finally { f.close() }
})

test('rejecting oversized images before reserving leaves the daily quota untouched', async () => {
  // 2026-11-12 补漏回归：以前「超 9 张」在预占名额之后才 return，配额被白烧一个。
  const today = dayKey()
  const f = await fixture({ day: today, moments: 0, momentsDay: today })
  try {
    const out = await f.execute('bili_moment', { text: TEXT, images: Array.from({ length: 10 }, (_, i) => `pic-${i}`) })
    assert.equal(out.ok, false)
    assert.equal(out.blocked, true)
    assert.match(out.error, /最多 9 张/)
    assert.deepEqual(f.calls, [], 'a shape-rejected moment must not reach the platform')
    assert.equal(f.state().moments, 0, 'no slot may be consumed by input validation')
  } finally { f.close() }
})

test('an image rejected by the send whitelist refunds the reserved quota slot', async () => {
  // 2026-11-12 补漏回归：P0-1 白名单拒绝路径此前直接 return，预占的名额没退回。
  const today = dayKey()
  const f = await fixture({ day: today, moments: 0, momentsDay: today })
  try {
    const out = await f.execute('bili_moment', { text: TEXT, images: ['https://example.com/cat.png'] })
    assert.equal(out.ok, false)
    assert.equal(out.blocked, true)
    assert.match(out.error, /表情库|纯文字/)
    assert.deepEqual(f.calls, [], 'a whitelist-rejected moment must not reach the platform')
    assert.equal(f.state().moments, 0, 'the reserved slot must be refunded on image validation failure')
  } finally { f.close() }
})

test('legacy state without momentsDay is judged by lastMomentAt instead of trusting a possibly stale number', async () => {
  const today = dayKey()
  const f = await fixture({ day: today, moments: 20, lastMomentAt: '2026-10-30T05:22:07.489Z' })
  try {
    assert.equal((await f.execute('bili_moment', { text: TEXT })).momentsToday, 1)
    assert.equal(f.state().moments, 1)
  } finally { f.close() }
})

test('bili_comment is the direct under-video path and never becomes a floor reply', async () => {
  const today = dayKey()
  const f = await fixture({ day: today, moments: 0, momentsDay: today })
  try {
    const out = await f.execute('bili_comment', { bvid: BV, text: '镜头停在倒影上的那几秒，光线变化特别清楚。' })
    assert.equal(out.success, true, JSON.stringify(out))
    const sent = f.calls.find(row => row.name === 'bili_reply')
    assert.ok(sent, 'bili_comment must go through the same guarded MCP call')
    assert.equal(sent.args.rpid, '0')
    assert.equal(sent.args.root, '0')
    assert.equal(sent.args.bvid, BV)
    const saved = f.state()
    assert.ok(saved.repliedComments[`nu:${BV}`], 'a new comment is remembered per video')
    assert.equal(Object.keys(saved.repliedComments).some(key => key.startsWith('video:')), false, 'bili_comment must not write a floor-reply key')
  } finally { f.close() }
})
