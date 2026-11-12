import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { McpClient } from '../lib/mcp.mjs'
import { dayKey } from '../lib/state.mjs'

const UID = '123', SEQ = '1234567890123456789'
const incoming = (extra = {}) => ({ uid: UID, msg_seqno: SEQ, is_follow: true, days_ago: 0, ...extra })
async function fixture(run, { permission = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fish-dm-conversation-')), home = join(root, 'bili-duty')
  mkdirSync(home)
  writeFileSync(join(home, 'config.json'), JSON.stringify({ autoReplyDm: permission,
    dmReplyFollowedOnly: true, learnAutoReview: false, reportLevel: 'off', idleChatter: false }))
  const stateFile = join(home, 'state.json'), today = dayKey()
  writeFileSync(stateFile, JSON.stringify({ day: today, unrelated: 'keep', dmPerUser: { [UID]: { day: today, n: 3 } } }))
  const tools = new Map(), cleanups = [], calls = []
  const agent = { id: 'dm-conversation', session: { id: 'dm-conversation', header: { agentPreset: 'dafeiyu' }, log: [] },
    ctx: { tools: { register(spec) { tools.set(spec.name, spec); return () => tools.delete(spec.name) } } } }
  const ctx = { logger: { info() {} }, settings: { describe: () => [] },
    get(key) { if (key === 'dshHomePath') return (...parts) => join(root, ...parts); if (key === 'agents') return { list: () => [agent] } },
    tools: { register() { throw Error('GLOBAL_TOOL_LEAK') } }, on() { return () => {} },
    effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off) },
    webServer: { register() { return { dispose() {} } } },
  }
  let inbox = [incoming()]
  const original = McpClient.prototype.call
  McpClient.prototype.call = async (name, args) => {
    calls.push({ name, args })
    if (name === 'bili_dm_list') return { items: structuredClone(inbox) }
    if (name === 'bili_send_message') return { success: true }
    throw Error('UNEXPECTED_PLATFORM_TOOL:' + name)
  }
  try {
    apply(ctx, {}); await new Promise(resolve => setImmediate(resolve))
    await run({ stateFile, calls, inbox: rows => { inbox = rows }, state: () => JSON.parse(readFileSync(stateFile, 'utf8')),
      execute: (name, args = {}) => tools.get(name).execute(args, { agent }) })
  } finally {
    for (const off of cleanups.reverse()) try { await off() } catch {}
    McpClient.prototype.call = original
    rmSync(root, { recursive: true, force: true })
  }
}

test('a verified new incoming message continues beyond three daily replies without bypassing dedupe or pacing', async () => fixture(async f => {
  const inbox = await f.execute('bili_dm_inbox')
  assert.equal(inbox.items[0].sent_today, 3)
  assert.equal(inbox.items[0].can_reply, true)
  assert.equal(inbox.items[0].at_per_user_cap, false)
  const sent = await f.execute('bili_dm_reply', { uid: UID, msg_seqno: SEQ, text: '你刚说的这个细节，我也注意到了。' })
  assert.equal(sent.ok, true)
  assert.equal(sent.sentToday, 4)
  assert.equal(f.state().dmPerUser[UID].n, 4)
  assert.equal(f.state().unrelated, 'keep')
  assert.equal(f.calls.filter(row => row.name === 'bili_send_message').length, 1)
  const again = await f.execute('bili_dm_reply', { uid: UID, msg_seqno: SEQ, text: '这条不能重复发。' })
  assert.equal(again.alreadyReplied, true)
  const next = String(BigInt(SEQ) + 1n)
  f.inbox([incoming({ msg_seqno: next })])
  const paced = await f.execute('bili_dm_reply', { uid: UID, msg_seqno: next, text: '有新消息也仍需按发送间隔等待。' })
  assert.equal(paced.ok, false)
  assert.equal(paced.pace, true)
  assert.equal(paced.reason, 'gap')
  assert.equal(f.calls.filter(row => row.name === 'bili_send_message').length, 1)
}))

test('omitted, stale and ineligible message evidence cannot turn the conversation allowance into unsolicited sending', async () => fixture(async f => {
  const missing = await f.execute('bili_dm_reply', { uid: UID, text: '省略消息编号不能突破防打扰限制。' })
  assert.equal(missing.perUserCap, true)
  assert.equal(f.calls.length, 0)
  const stale = await f.execute('bili_dm_reply', { uid: UID, msg_seqno: '98765', text: '不存在的旧消息不能回。' })
  assert.equal(stale.staleSeqno, true)
  f.inbox([incoming({ is_follow: false })])
  const stranger = await f.execute('bili_dm_reply', { uid: UID, msg_seqno: SEQ, text: '关注权限仍然有效。' })
  assert.equal(stranger.blocked, true)
  f.inbox([incoming({ days_ago: 10 })])
  const old = await f.execute('bili_dm_reply', { uid: UID, msg_seqno: SEQ, text: '过期来信不能拿来激活连续发送。' })
  assert.equal(old.blocked, true)
  const forced = await f.execute('bili_dm_reply', { uid: UID, text: 'force不能授权。', force: true })
  assert.equal(forced.ok, false)
  assert.equal(f.calls.filter(row => row.name === 'bili_send_message').length, 0)
  assert.equal(f.state().dmPerUser[UID].n, 3)
}))

test('fresh incoming messages still require the manual auto-reply permission', async () => fixture(async f => {
  const result = await f.execute('bili_dm_reply', { uid: UID, msg_seqno: SEQ, text: '没有本人授权不能发。' })
  assert.equal(result.ok, false)
  assert.equal(result.blocked, true)
  assert.equal(f.calls.length, 0)
}, { permission: false }))
