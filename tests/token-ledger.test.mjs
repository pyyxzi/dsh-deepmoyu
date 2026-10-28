import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  tokenTaskStart, tokenTaskUpdate, tokenTaskEnd, tokenLedgerSnapshot, clearTokenLedger, TOKEN_LEDGER_MAX,
} from '../lib/tokens.mjs'

test('session task ledger records measured tokens and ends idempotently', () => {
  const home = mkdtempSync(join(tmpdir(), 'dafeiyu-token-'))
  try {
    const a = tokenTaskStart(home, { kind: 'session', label: '鲸鱼摸鱼会话', model: 'p/m', budget: 100000, maxRounds: 8, why: 'session' })
    assert.ok(a.id, 'start returns an id for the caller to keep')
    assert.equal(a.tokensUnknown, false)
    tokenTaskUpdate(home, a.id, { rounds: 2, tokens: { input: 8000, output: 1500 } })
    tokenTaskUpdate(home, a.id, { rounds: 5, tokens: { input: 21000, output: 3000 } })
    tokenTaskEnd(home, a.id, { stopReason: 'user', tokens: { input: 26000, output: 4000, total: 30000 } })
    // 收账是幂等的：clear 再收一次不重写时间、不重置 token
    tokenTaskEnd(home, a.id, { stopReason: 'clear', rounds: 9 })
    const snap = tokenLedgerSnapshot(home, { limit: 10 })
    assert.equal(snap.entries.length, 1)
    const e = snap.entries[0]
    assert.equal(e.rounds, 5, 'end with explicit rounds overrides, idempotent end does not reset to 9')
    assert.equal(e.stopReason, 'clear', 'later stopReason wins')
    assert.equal(e.tokens.total, 30000)
    assert.ok(e.endedAt, 'endedAt set once')
    assert.ok(e.durationSec >= 0)
    assert.equal(snap.sums.tasks, 1)
    assert.equal(snap.sums.total, 30000)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('background tasks stay unmeasured until real beacon data arrives, then count', () => {
  const home = mkdtempSync(join(tmpdir(), 'dafeiyu-token-'))
  try {
    // ① 没有信标对账：宿主读不到子进程的计量 ⇒ 如实标未计量，不计入总和（宁缺毋假）
    const b = tokenTaskStart(home, { kind: 'background', label: '桌宠后台轮', model: 'p/b', budget: 60000, why: 'pet' })
    assert.equal(b.tokensUnknown, true)
    tokenTaskEnd(home, b.id, { stopReason: 'exit', code: 0 })
    let snap = tokenLedgerSnapshot(home, {})
    assert.equal(snap.entries[0].tokens, null)
    assert.equal(snap.entries[0].tokensUnknown, true)
    assert.equal(snap.sums.tasks, 0)
    assert.equal(snap.sums.unknown, 1)
    assert.equal(snap.sums.total, 0)
    // ② 信标对账（reconcileBgUsage 按 pid 从 bg-usage.jsonl 读到的真实计量）：
    //    这不是猜数，是子进程自报 ⇒ 收下、翻成已计量、计入总和
    const c = tokenTaskStart(home, { kind: 'background', label: '桌宠后台轮·信标', model: 'p/b', budget: 60000, why: 'pet' })
    assert.equal(c.tokensUnknown, true)
    tokenTaskEnd(home, c.id, { stopReason: 'exit', code: 0, tokens: { input: 1, output: 2, total: 3 } })
    snap = tokenLedgerSnapshot(home, {})
    assert.equal(snap.entries[0].tokensUnknown, false, '真实计量到达后未计量翻转为已计量')
    assert.deepEqual(snap.entries[0].tokens, { input: 1, output: 2, total: 3 })
    assert.equal(snap.sums.tasks, 1)
    assert.equal(snap.sums.unknown, 1, '没计量到的那条仍然如实留在 unknown 里')
    assert.equal(snap.sums.total, 3)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('ledger is capped, newest-first in snapshots, and clear empties it', () => {
  const home = mkdtempSync(join(tmpdir(), 'dafeiyu-token-'))
  try {
    for (let i = 0; i < TOKEN_LEDGER_MAX + 10; i++) {
      const t = tokenTaskStart(home, { kind: 'background', label: 't' + i, why: 'manual', startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() })
      tokenTaskEnd(home, t.id, { stopReason: 'exit', code: 0 })
    }
    let snap = tokenLedgerSnapshot(home, { limit: 5 })
    assert.ok(snap.entries.length <= 5, 'snapshot respects limit')
    const all = tokenLedgerSnapshot(home, { limit: 200 })
    assert.ok(all.entries.length <= TOKEN_LEDGER_MAX, 'storage is capped')
    // 新任务在前：第一条应是最后一个启动的
    assert.equal(all.entries[0].label, 't' + (TOKEN_LEDGER_MAX + 9))
    clearTokenLedger(home)
    snap = tokenLedgerSnapshot(home, {})
    assert.equal(snap.entries.length, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
