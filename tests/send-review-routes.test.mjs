import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'
import { McpClient } from '../lib/mcp.mjs'

const root = mkdtempSync(join(tmpdir(), 'fish-send-review-'))
let sequence = 0
const flush = () => new Promise(resolve => setImmediate(resolve))
async function fixture(extra = {}, existing) {
  const dir = existing || join(root, String(++sequence)), home = join(dir, 'bili-duty')
  mkdirSync(home, { recursive: true })
  if (!existing) {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ sendReview: true, autoComment: true, replyToComments: true, autoReplyDm: true,
      autoMoment: true, momentPerDay: 3, learnAutoReview: false, reportLevel: 'off', ...extra }))
    writeFileSync(join(home, 'state.json'), JSON.stringify({ unrelated: 61, tokensTotal: 0 }))
  }
  const cleanups = [], tools = new Map(), calls = []
  const agent = { id: 'review-fish-' + sequence, session: { header: { agentPreset: 'dafeiyu', cwd: dir } },
    ctx: { tools: { register(spec) { tools.set(spec.name, spec); return () => tools.delete(spec.name) } } } }
  let handler, reply = { success: true, rpid: '7654321' }
  const original = McpClient.prototype.call
  McpClient.prototype.call = async function(name, args) {
    calls.push({ name, args })
    if (typeof reply === 'function') return reply(name, args)
    if (name === 'bili_dm_list') return { items: [{ uid: '123', msg_seqno: '456', is_followed: true, following: true, timestamp: Math.floor(Date.now() / 1000), last_msg: { timestamp: Math.floor(Date.now() / 1000) } }] }
    return typeof reply === 'function' ? reply(name, args) : reply
  }
  const ctx = { logger: { info() {} }, get: key => key === 'dshHomePath' ? (...parts) => join(dir, ...parts) : key === 'agents' ? { list: () => [agent] } : undefined,
    tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } }, settings: { describe: () => [] }, on() { return () => {} },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } } }
  apply(ctx, {}); await flush()
  const request = async (path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) => {
    const req = new EventEmitter(); req.url = '/api/bili-duty' + path; req.method = method; req.headers = headers; req.destroy = () => {}
    const res = { writeHead(status) { this.status = status }, end(value) { this.body = Buffer.isBuffer(value) ? value : value ? JSON.parse(value) : {} } }
    const promise = handler(req, res)
    if (method === 'POST') { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }
    await promise; return res
  }
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const writeState = value => writeFileSync(join(home, 'state.json'), JSON.stringify(value))
  const execute = (name, args, exec = { agent }) => tools.get(name).execute(args, exec)
  const items = async () => (await request('/send-review')).body.items
  const decide = (row, decision = 'approve', extra = {}) => request('/send-review', { id: row.id, decision, expectedHash: row.hash, ...extra })
  return { dir, home, agent, calls, tools, request, state, writeState, execute, items, decide, setReply(value) { reply = value },
    close() { for (const fn of cleanups.reverse()) try { fn() } catch {}; McpClient.prototype.call = original } }
}
const comment = (bvid = 'BV1234567890', text = '镜头停在倒影上的那几秒，光线变化特别清楚。') => ({ bvid, text })
test.after(() => rmSync(root, { recursive: true, force: true }))

test('all fish sends become durable previews, force and fake approval cannot bypass, and only exact manual hash approval sends once', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.execute('bili_reply', { ...comment(), force: true })).code, 'FORCE_NOT_AUTHORIZATION')
    const queued = await f.execute('bili_reply', { ...comment(), _reviewApproved: true })
    assert.equal(queued.queued, true); assert.equal(f.calls.length, 0)
    const [row] = await f.items(); assert.match(row.hash, /^[a-f0-9]{64}$/)
    assert.equal(row.args.picture, ''); assert.ok(!Object.hasOwn(row.args, 'force')); assert.ok(!Object.hasOwn(row.args, '_reviewApproved'))
    assert.equal((await f.execute('bili_reply', comment())).duplicate, true)
    assert.equal((await f.items()).length, 1)
    assert.equal((await f.decide(row, 'approve', { expectedHash: '0'.repeat(64) })).body.ok, false)
    assert.equal((await f.request('/send-review', { id: row.id, decision: 'approve', expectedHash: row.hash }, 'POST', { origin: 'https://evil.example' })).status, 403)
    const sent = await f.decide(row); assert.equal(sent.body.sent, true)
    assert.equal(f.calls.filter(x => x.name === 'bili_reply').length, 1)
    assert.equal((await f.decide(row)).status, 409)
    assert.equal((await f.request('/status')).body.sendReview.counts.sent, 1)
    assert.equal(f.state().unrelated, 61)
  } finally { f.close() }
})

test('approval rechecks current permissions, pacing and dedupe; it is not force', async () => {
  const f = await fixture()
  try {
    await f.execute('bili_reply', comment()); const [row] = await f.items()
    await f.request('/config', { autoComment: false })
    const denied = await f.decide(row); assert.equal(denied.body.sent, false); assert.equal(denied.body.item.state, 'pending'); assert.equal(f.calls.length, 0)
    await f.request('/config', { autoComment: true })
    f.writeState({ ...f.state(), pace: { last: { comment: { at: Date.now(), next: Date.now() + 120000 } } } })
    const paced = await f.decide(row); assert.equal(paced.body.result.pace, true); assert.equal(f.calls.length, 0)
    const state = f.state(); delete state.pace; state.repliedComments = { 'nu:BV1234567890': { at: new Date().toISOString() } }; f.writeState(state)
    const dup = await f.decide(row); assert.equal(dup.body.result.alreadyCommented, true); assert.equal(f.calls.length, 0)
    assert.equal((await f.decide(row, 'reject')).body.ok, true)
  } finally { f.close() }
})

test('comment/reply, opus reply, DM reply, moments and configured result delivery all enter preview without network sends', async () => {
  const f = await fixture({ dmMode: 'both', dmUid: 123, dmReplyFollowedOnly: false })
  try {
    for (const [name, args] of [
      ['bili_reply', comment()], ['bili_reply', { ...comment('BV1234567891'), rpid: '77' }],
      ['bili_reply_opus', { opus_id: '1234567890123456789', rpid: '888', text: '镜头里的光线变化确实很清楚。' }],
      ['bili_dm_reply', { uid: '123', msg_seqno: '456', text: '看到了，倒影那段确实有意思。' }],
      ['bili_moment', { text: '倒影一晃，画面里那点重量就有了。' }],
      ['bili_deliver', { text: '精选结果：https://www.bilibili.com/video/BV1234567890' }],
    ]) assert.equal((await f.execute(name, args)).queued, true, name)
    assert.equal(f.calls.length, 0); assert.equal((await f.items()).length, 6)
    const delivery = (await f.items()).find(row => row.tool === 'bili_deliver')
    await f.request('/config', { dmUid: 124 })
    assert.equal((await f.decide(delivery)).body.sent, false); assert.equal(f.calls.length, 0)
  } finally { f.close() }
})

test('previews survive restart; rejected items stay rejected and unknown in-flight sends are never replayed', async () => {
  const first = await fixture(); const dir = first.dir
  await first.execute('bili_reply', comment()); const [row] = await first.items(); first.close()
  const f = await fixture({}, dir)
  try {
    assert.equal((await f.items())[0].id, row.id)
    const state = f.state(); state.sendReview[0].state = 'approving'; f.writeState(state)
    assert.equal((await f.items())[0].state, 'unknown')
    assert.equal((await f.decide(row)).body.ok, false); assert.equal(f.calls.length, 0)
  } finally { f.close() }
})

test('unknown outcomes stay unrepeatable while concurrent approvals can submit only once', async () => {
  const f = await fixture()
  try {
    await f.execute('bili_reply', comment()); const [row] = await f.items()
    let release, entered
    const began = new Promise(resolve => { entered = resolve })
    f.setReply(async () => { entered(); await new Promise(resolve => { release = resolve }); return {} })
    const first = f.decide(row); await began
    assert.equal((await f.decide(row)).status, 409)
    release(); const result = await first
    assert.equal(result.body.item.state, 'unknown'); assert.equal(f.calls.length, 1)
    assert.equal((await f.execute('bili_reply', comment())).duplicate, true)
    assert.equal((await f.decide(row)).status, 409)
  } finally { f.close() }
})

test('tools cannot disable manual preview and switching it off does not release existing drafts', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.execute('bili_config', { patch: { sendReview: false, autoComment: true } })).code, 'SEND_REVIEW_MANUAL_ONLY')
    await f.execute('bili_reply', comment()); const [row] = await f.items()
    await f.request('/config', { sendReview: false })
    assert.equal((await f.items())[0].state, 'pending'); assert.equal(f.calls.length, 0)
    assert.equal((await f.decide(row, 'reject')).body.ok, true); assert.equal(f.calls.length, 0)
    await f.execute('bili_reply', comment('BV1234567891')); assert.equal(f.calls.length, 1)
  } finally { f.close() }
})

test('a permission revoked while a DM approval reads context prevents the later send submission', async () => {
  const f = await fixture({ dmReplyFollowedOnly: false })
  try {
    await f.execute('bili_dm_reply', { uid: '123', msg_seqno: '456', text: '倒影那段确实很有意思。' }); const [row] = await f.items()
    let release, entered
    const began = new Promise(resolve => { entered = resolve })
    f.setReply(async (name) => {
      if (name === 'bili_dm_list') { entered(); await new Promise(resolve => { release = resolve }); return { items: [{ uid: '123', msg_seqno: '456', is_follow: true, days_ago: 0 }] } }
      return { success: true }
    })
    const approval = f.decide(row); await began
    await f.request('/config', { autoReplyDm: false }); release()
    const result = await approval
    assert.equal(result.body.sent, false); assert.equal(result.body.item.state, 'pending')
    assert.equal(f.calls.filter(call => call.name === 'bili_send_message').length, 0)
    assert.match(result.body.error, /权限已关闭/)
  } finally { f.close() }
})

test('dynamic preview uses hash-bound image bytes and real extensions; missing media stays pending before submission', async () => {
  const f = await fixture({ stickerReview: false })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8r+DAwMDAxAAGABFdAWPYSWFdAAAAAElFTkSuQmCC', 'base64')
  try {
    await f.request('/stickers/upload', { name: '预览图片', dataBase64: png.toString('base64') })
    await f.execute('bili_moment', { text: '倒影一晃，画面里那点重量就有了。', images: ['预览图片'] })
    const [row] = await f.items(); assert.equal(row.attachments[0].fmt, 'png')
    assert.deepEqual((await f.request(row.attachments[0].imageUrl.replace('/api/bili-duty', ''))).body, png)
    f.setReply(async (name, args) => { if (name === 'bili_send_dynamic') { assert.match(args.images[0], /\.png$/); assert.deepEqual(readFileSync(args.images[0]), png) }; return { success: true } })
    assert.equal((await f.decide(row)).body.sent, true)
    const nextState = f.state(); delete nextState.pace; f.writeState(nextState)
    await f.execute('bili_moment', { text: '再看一次，亮点落在画面的边角。', images: ['预览图片'] })
    const next = (await f.items()).find(item => item.state === 'pending')
    rmSync(join(f.home, 'send-review-media', next.attachments[0].hash + '.png'))
    const before = f.calls.length, result = await f.decide(next)
    assert.equal(result.body.item.state, 'pending'); assert.equal(f.calls.length, before)
  } finally { f.close() }
})

test('stale or altered previews fail closed and corrupt state never turns into an empty replacement queue', async () => {
  const f = await fixture()
  try {
    await f.execute('bili_reply', comment()); const [row] = await f.items()
    let state = f.state(); state.sendReview[0].createdAt = '2020-01-01T00:00:00.000Z'; f.writeState(state)
    assert.match((await f.decide(row)).body.error, /24 小时/); assert.equal(f.calls.length, 0)
    state = f.state(); state.sendReview[0].createdAt = new Date().toISOString(); state.sendReview[0].args.text = 'altered'; f.writeState(state)
    assert.match((await f.decide(row)).body.error, /已变化/); assert.equal(f.calls.length, 0)
    assert.ok(!Object.hasOwn((await f.request('/status')).body.sendReview, 'items'))
    writeFileSync(join(f.home, 'state.json'), '{corrupt')
    await assert.rejects(() => f.execute('bili_reply', comment('BV1234567891')))
    assert.equal(readFileSync(join(f.home, 'state.json'), 'utf8'), '{corrupt'); assert.equal(f.calls.length, 0)
  } finally { f.close() }
})
