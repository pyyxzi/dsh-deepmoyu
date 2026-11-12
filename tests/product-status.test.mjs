import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSevenDayRetrospective, buildRecoverySnapshot } from '../lib/product-status.mjs'

test('seven-day retrospective counts only real reports, ledger runs and token days', () => {
  const reports = {
    '2026-10-27': '### BV1abcdefghi - 本地模型装进背包\n理由',
    '2026-10-28': '### BV1klmnopqrs：本地模型装进背包\n### BV1uvwxyzABC - 另一个主题',
  }
  const out = buildSevenDayRetrospective({
    now: new Date('2026-10-29T12:00:00+08:00'),
    timeZoneOffsetMinutes: 480,
    tokenDays: { '2026-10-27': 100, '2026-10-29': 50 },
    ledger: [{ startedAt: '2026-10-27T10:00:00.000Z' }, { startedAt: '2026-10-28T11:00:00.000Z' }],
    readReport: (day) => reports[day] || '',
  })
  assert.equal(out.days.length, 7)
  assert.equal(out.totals.picks, 3)
  assert.equal(out.totals.tokens, 150)
  assert.equal(out.totals.runs, 2)
  assert.equal(out.themes.some((row) => row.count === 2 && row.sources.length === 2), true)
  assert.equal(out.complete, false)
  assert.equal(out.changes.available, false)
  assert.deepEqual(out.changes.new, [])
  assert.equal(out.days.find((row) => row.day === '2026-10-29').picks, null)
  assert.equal(out.days.find((row) => row.day === '2026-10-29').tokens, 50)
})

test('theme comparison uses two evidenced report windows and keeps BV/day sources', () => {
  const reports = {
    '2026-10-20': '### BV1abcdefghi - Rust async basics',
    '2026-10-27': '### BV1klmnopqrs - Rust async patterns',
    '2026-10-28': '### BV1uvwxyzABC - Remotion motion design',
  }
  const out = buildSevenDayRetrospective({
    now: new Date('2026-10-29T12:00:00+08:00'), timeZoneOffsetMinutes: 480,
    readReport: (day) => reports[day] || '',
  })
  assert.equal(out.changes.available, true)
  assert.deepEqual(out.changes.coverage, { currentReportDays: 2, previousReportDays: 1 })
  assert.equal(out.changes.continued.some((row) => row.clue === 'rust' && row.previous === 1 && row.current === 1), true)
  assert.equal(out.changes.new.some((row) => row.clue === 'remotion' && row.sources.some((source) => source.day === '2026-10-28' && source.bvid === 'BV1uvwxyzABC')), true)
  assert.equal(out.changes.decreased.some((row) => row.clue === 'basics' && row.previous === 1 && row.current === 0), true)
  assert.equal(out.changes.label, '标题线索 / 非兴趣结论')
})

test('recovery keeps paused session, failed background and interrupted video honest', () => {
  const out = buildRecoverySnapshot({
    now: Date.parse('2026-10-29T10:00:00+08:00'),
    feiyu: { active: false, goal: { phase: 'paused', rounds: 3 }, stopReason: 'settings' },
    background: { active: false, stopReason: 'error', error: 'fixture failure' },
    videoSessions: [{ sessionId: 'pv-a', stage: 'interrupted', running: false, error: 'host restarted' }],
  })
  assert.equal(out.needsAction, true)
  assert.equal(out.rows.find((row) => row.id === 'session').state, 'paused')
  assert.equal(out.rows.find((row) => row.id === 'background').state, 'failed')
  assert.equal(out.rows.find((row) => row.id === 'video').state, 'interrupted')
  assert.ok(!out.rows.some((row) => /完成/.test(row.label)))
})

test('running video is running only when renderer confirms it', () => {
  const waiting = buildRecoverySnapshot({ videoSessions: [{ stage: 'render', running: false }] })
  assert.equal(waiting.rows.find((row) => row.id === 'video').state, 'interrupted')
  const running = buildRecoverySnapshot({ videoSessions: [{ stage: 'render', running: true, date: '2026-10-28' }] })
  assert.equal(running.rows.find((row) => row.id === 'video').state, 'running')
})

test('ledger task after UTC midnight boundary belongs to local day', () => {
  const out = buildSevenDayRetrospective({
    now: new Date('2026-10-29T12:00:00+08:00'),
    timeZoneOffsetMinutes: 480,
    ledger: [{ startedAt: '2026-10-28T16:30:00.000Z' }],
  })
  assert.equal(out.days.find((row) => row.day === '2026-10-29').runs, 1)
  assert.equal(out.days.find((row) => row.day === '2026-10-28').runs, 0)
})

test('durable ended background failure survives missing in-memory run', () => {
  const out = buildRecoverySnapshot({
    background: null,
    lastBackground: { kind: 'background', endedAt: '2026-10-29T01:00:00Z', stopReason: 'spawn-error' },
  })
  const row = out.rows.find((item) => item.id === 'background')
  assert.equal(row.state, 'failed')
  assert.equal(row.action, 'background')
})

test('report read failure stays visible and cannot mark retrospective complete', () => {
  const out = buildSevenDayRetrospective({
    now: new Date('2026-10-29T12:00:00+08:00'), timeZoneOffsetMinutes: 480,
    tokenDays: Object.fromEntries(['23', '24', '25', '26', '27', '28', '29'].map((day) => [`2026-10-${day}`, 0])),
    readReport: (day) => { if (day === '2026-10-27') throw new Error('too large'); return '### BV1abcdefghi - fixture' },
  })
  assert.equal(out.complete, false)
  assert.equal(out.errors.length, 1)
  assert.equal(out.days.find((row) => row.day === '2026-10-27').reportError, 'too large')
})

test('cross-midnight background window is described without claiming it is active', () => {
  const out = buildRecoverySnapshot({
    now: Date.parse('2026-10-29T12:00:00+08:00'),
    window: { start: '20:00', end: '02:00', active: false, holdUntil: 0 },
  })
  const row = out.rows.find((item) => item.id === 'schedule')
  assert.equal(row.state, 'scheduled')
  assert.equal(row.label, '跨午夜时段已安排')
  assert.match(row.detail, /20:00–02:00/)
  const held = buildRecoverySnapshot({ now: 1000, window: { holdUntil: 2000 } })
  assert.equal(held.rows.find(item => item.state === 'held').action, 'background')
})

test('recovery identifies only recorded active hold reasons and never invents a manual stop', () => {
  for (const reason of ['rest', 'manual', undefined, 'unexpected']) {
    const result = buildRecoverySnapshot({ now: 1000, window: { holdUntil: 2000, holdReason: reason } })
    const held = result.rows.find(row => row.state === 'held')
    assert.equal(held.holdReason, reason === 'rest' || reason === 'manual' ? reason : 'unknown')
    if (reason === 'rest') {
      assert.match(held.label, /自然休息/)
      assert.match(held.detail, /休息结束后重新检查/)
      assert.doesNotMatch(held.label + held.detail, /手动/)
    } else if (reason === 'manual') assert.match(held.label, /手动停止/)
    else assert.doesNotMatch(held.label + held.detail, /手动|自然休息/)
  }
  for (const holdUntil of [0, 999, 1000, Infinity, NaN]) {
    const result = buildRecoverySnapshot({ now: 1000, window: { holdUntil, holdReason: 'manual' } })
    assert.equal(result.rows.some(row => row.state === 'held'), false, 'expired/invalid hold cannot retain a current reason')
  }
})

test('queued session and background continuations stay visible without requesting manual recovery', () => {
  const nextAt = Date.parse('2026-11-12T10:00:05+08:00')
  const result = buildRecoverySnapshot({ now: nextAt - 1000,
    feiyu: { active: false, goal: { phase: 'active', activation: 'disarmed' }, continuation: { state: 'waiting-retry', reason: 'max-tokens', nextAt } },
    background: { active: false, stopReason: 'exit', continuationPending: true, nextStartAt: nextAt },
    lastBackground: { stopReason: 'spawn-error' },
  })
  assert.equal(result.needsAction, false)
  assert.equal(result.rows.some(row => row.id === 'idle'), false)
  const session = result.rows.find(row => row.id === 'session'), background = result.rows.find(row => row.id === 'background')
  assert.equal(session.state, 'waiting-retry')
  assert.equal(session.nextAt, nextAt)
  assert.match(session.label, /等待自动续刷/)
  assert.match(session.detail, /本轮输出达到上限/)
  assert.equal(background.state, 'waiting-retry')
  assert.equal(background.nextStartAt, nextAt)
  assert.match(background.label, /等待接力/)
  assert.doesNotMatch(session.label + background.label, /失败|中断/)
})

test('continuation failures and bounded empty loops ask for action, including durable no-progress after restart', () => {
  const out = buildRecoverySnapshot({ now: 1000,
    feiyu: { active: false, goal: { phase: 'active', activation: 'disarmed' }, continuation: { state: 'needs-attention', reason: 'usage-unknown' } },
    background: { active: false, stopReason: 'no-progress' }, window: { holdUntil: 2000, holdReason: 'unknown' },
  })
  assert.equal(out.needsAction, true)
  assert.equal(out.rows.find(row => row.id === 'session').state, 'needs-attention')
  assert.match(out.rows.find(row => row.id === 'session').detail, /用量尚未确认/)
  const background = out.rows.find(row => row.id === 'background')
  assert.equal(background.state, 'needs-attention')
  assert.equal(background.reason, 'no-progress')
  assert.equal(background.holdReason, 'unknown')
  assert.doesNotMatch(background.label + background.detail, /手动停止|自然休息/)
  const restarted = buildRecoverySnapshot({ lastBackground: { stopReason: 'no-progress', endedAt: '2026-11-12' } })
  assert.equal(restarted.rows.find(row => row.id === 'background').reason, 'no-progress')
  assert.equal(restarted.needsAction, true)
})
