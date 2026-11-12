import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { apply } from '../index.js'
import { McpClient } from '../lib/mcp.mjs'
import { createRelayClient } from '../lib/model-relay-adapter.mjs'
import { backgroundMcpRequest } from '../lib/background-mcp.mjs'
import { DAFEIYU_DEFAULT_PERSONA, DAFEIYU_MOMENT_GUIDE } from '../lib/persona.mjs'

const A = 'BV14AHP6VExR', B = 'BV14AHP6VExS', C = 'BV14AHP6VExT'
const immediate = () => new Promise(resolve => setImmediate(resolve))
const promptProgress = prompt => JSON.parse(String(prompt).split('\n').find(line => line.startsWith('【这次刷到哪里】')).slice('【这次刷到哪里】'.length))

test('a clean background relay carries unfinished and deferred work into its first prompt and guarded bridge', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-background-progress-')), home = join(root, 'bili-duty')
  mkdirSync(home)
  const cli = join(root, 'synthetic-cli.js'); writeFileSync(cli, '// never executed')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ dshBin: cli, backgroundModelId: 'buddy/fixture',
    backgroundMinutes: 15, learnAutoReview: false, idleChatter: false, pvAuto: false, reportLevel: 'off',
    updateMirror: false, autoComment: false, replyToComments: false, autoReplyDm: false, autoMoment: false,
    browseRecentDays: 7, keywords: ['科技'] }))
  const cp = createRequire(import.meta.url)('node:child_process')
  const original = { spawn: cp.spawn, call: McpClient.prototype.call, setTimeout, clearTimeout, setInterval, clearInterval }
  const children = [], relays = [], timers = new Set(), intervals = new Set(), cleanups = [], platformCalls = [], relaySystems = []
  let handler, sequence = 0
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === 2500) {
      const timer = { unref() {}, cancelled: false, fire: () => fn(...args) }; relays.push(timer); return timer
    }
    const timer = original.setTimeout(fn, ms, ...args); timers.add(timer); return timer
  }
  globalThis.clearTimeout = timer => {
    if (timer?.fire) timer.cancelled = true
    else { timers.delete(timer); original.clearTimeout(timer) }
  }
  globalThis.setInterval = (fn, ms, ...args) => { const timer = original.setInterval(fn, ms, ...args); intervals.add(timer); return timer }
  globalThis.clearInterval = timer => { intervals.delete(timer); original.clearInterval(timer) }
  cp.spawn = (command, args, options) => {
    assert.ok(options.env?.BILI_DUTY_RELAY_CAPABILITY, 'only the owned synthetic child may be spawned')
    const child = new EventEmitter(); Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, kill: () => true })
    children.push({ child, args, env: options.env }); return child
  }
  syncBuiltinESMExports()
  McpClient.prototype.call = async (name, args) => {
    platformCalls.push({ name, args })
    if (name === 'bili_search') return { page: args.page || 1, has_more: true,
      videos: args.keyword === '第二个具体搜索词' ? [] : [A, B, C].map(bvid => ({ bvid, title: '科技合成片', play: 100000, duration: 600, pubdate: Math.floor(Date.now() / 1000) })) }
    if (name === 'bili_guard_status') return { seenVideos: {} }
    if (name === 'bili_subtitle') return args.bvid === C
      ? { ok: false, text: '失败回执附带的残留片段，不是完成阅读', segments: 20 }
      : { text: '实际合成字幕原文', segments: 1 }
    if (name === 'bili_comments') return { comments: [] }
    throw new Error('UNEXPECTED_PLATFORM_TOOL: ' + name)
  }
  const model = { listProviders: () => [{ id: 'buddy' }], async resolveModelInfo(provider, id) { return { provider, id, name: id } }, async prepareCall(config) {
    return { config, async *stream(options) { relaySystems.push(options.system); yield { type: 'finish', reason: { kind: 'stop' } } } }
  } }
  const ctx = { logger: { info() {} }, settings: { describe: () => [] },
    get: key => key === 'llm' ? model : key === 'dshHomePath' ? (...parts) => join(root, ...parts) : key === 'agents' ? { list: () => [] } : undefined,
    tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } }, on() { return () => {} },
    effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off); return off },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } },
  }
  const request = async (path, body, method = 'POST') => {
    const req = new EventEmitter(); Object.assign(req, { url: '/api/bili-duty' + path, method, headers: {}, destroy() {} })
    const res = { writeHead(status) { this.status = status }, end(text) { this.body = JSON.parse(text) } }
    const pending = handler(req, res)
    if (method === 'POST') { req.emit('data', Buffer.from(JSON.stringify(body || {}))); req.emit('end') }
    await pending
    assert.equal(res.status, 200, JSON.stringify(res.body)); return res.body
  }
  const call = async (client, name, args = {}) => {
    const response = await backgroundMcpRequest({ id: ++sequence, method: 'tools/call', params: { name, arguments: args } }, client)
    return JSON.parse(response.result.content[0].text)
  }
  try {
    apply(ctx, {}); await immediate()
    assert.equal((await request('/pet/start', { mode: 'background', durationMinutes: 15 })).started, true)
    assert.equal(children.length, 1)
    assert.ok(children[0].args.at(-1).includes(DAFEIYU_DEFAULT_PERSONA), 'a fresh background uses the same built-in voice without a custom persona')
    assert.ok(children[0].args.at(-1).includes(DAFEIYU_MOMENT_GUIDE), 'the spawned prompt preserves context-first video moments')
    const liveGrant = createRelayClient(children[0].env)
    await (await liveGrant.post({ action: 'stream', options: { messages: [] } })).text()
    assert.match(relaySystems.at(-1), /【当前全局人格：内置大肥鱼】/)
    const custom = 'SAME_GRANT_CUSTOM_PERSONA: dry and brief'
    assert.equal((await request('/config', { persona: custom })).ok, true)
    await (await liveGrant.post({ action: 'stream', options: { messages: [] } })).text()
    assert.match(relaySystems.at(-1), new RegExp(custom))
    assert.doesNotMatch(relaySystems.at(-1), /你是大肥鱼，也叫鲸鱼摸鱼/)
    const first = createRelayClient(children[0].env)
    const interest = { action: 'open', question: '合成片里的结构为什么能折叠', query: '折叠结构原理', bvid: A }
    const unread = await call(first, 'bili_curiosity', interest)
    assert.equal(unread.ok, false)
    assert.equal(unread.code, 'CURIOSITY_READ_REQUIRED', 'a background capability without an agent cannot fabricate read evidence')
    assert.deepEqual((await call(first, 'bili_search', { keyword: '科技' })).browse_progress.pendingBvids, [A, B, C])
    await call(first, 'bili_subtitle', { bvid: A })
    const opened = await call(first, 'bili_curiosity', interest)
    assert.equal(opened.ok, true, 'the real agent-free background execution retains its own subtitle evidence')
    const topicId = opened.item.id
    const finding = await call(first, 'bili_curiosity', { action: 'note', id: topicId, bvid: A, text: '折叠位置由相邻连接点共同限制。', seconds: 12 })
    assert.equal(finding.ok, true)
    assert.equal(finding.finds.length, 1)
    assert.equal(finding.finds[0].url, `https://www.bilibili.com/video/${A}?t=12`)
    assert.match(finding.finds[0].id, /^cf-[a-f0-9]{16}$/)
    const failure = await call(first, 'bili_subtitle', { bvid: C })
    assert.equal(failure.browse_progress.deferredReadCount, 1)
    assert.equal(failure.browse_progress.recentReadCount, 1)
    assert.equal(failure.browse_progress.recentSkippedCount, 0)
    const failedEvidence = await call(first, 'bili_curiosity', { action: 'note', id: topicId, bvid: C, text: '这段失败字幕不能当作收获' })
    assert.equal(failedEvidence.ok, false)
    assert.equal(failedEvidence.code, 'CURIOSITY_READ_REQUIRED')
    const persisted = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    assert.ok(persisted.seenVideos[A])
    assert.equal(Object.hasOwn(persisted.seenVideos, C), false, 'a failed result with residual text cannot become permanent read evidence')
    const unchanged = await call(first, 'bili_comments', { bvid: A })
    assert.equal(Object.hasOwn(unchanged, 'browse_progress'), false, 'unchanged helper results do not repeat the same progress block')
    await request('/config', { browseRecentDays: 0, keywords: ['旅行'] })
    const beforeClose = relays.length
    children[0].child.exitCode = 0; children[0].child.emit('close', 0)
    assert.equal(relays.length, beforeClose + 1, 'clean close schedules one new continuation')
    const continuation = relays.at(-1)
    assert.equal(continuation.cancelled, false)
    continuation.fire(); await immediate()
    assert.equal(children.length, 2)
    const firstPrompt = children[1].args.at(-1), resumed = promptProgress(firstPrompt)
    assert.deepEqual(resumed.pendingBvids, [B], 'the very first relay prompt retains unfinished candidates')
    assert.equal(resumed.recentReadCount, 1)
    assert.equal(resumed.deferredReadCount, 1)
    assert.match(firstPrompt, /最近 7 天/)
    assert.match(firstPrompt, /科技/)
    const second = createRelayClient(children[1].env)
    const returned = await call(second, 'bili_pace', { kind: 'comment' })
    assert.equal(Object.hasOwn(returned, 'browse_progress'), false, 'an unchanged checkpoint already visible in the first prompt is not repeated')
    const continuedBoard = await call(second, 'bili_curiosity', { action: 'list' })
    assert.equal(continuedBoard.items.find(item => item.id === topicId).notes.length, 1)
    assert.equal(continuedBoard.finds[0].id, finding.finds[0].id)
    const viewedBoard = await request('/curiosity', undefined, 'GET')
    assert.equal(viewedBoard.finds.length, 1)
    assert.equal(viewedBoard.finds[0].text, '折叠位置由相邻连接点共同限制。')
    assert.equal(viewedBoard.finds[0].id, finding.finds[0].id, 'the bridge and HTTP workbench show one durable note projection')
    const completed = await call(second, 'bili_subtitle', { bvid: B })
    assert.deepEqual(completed.browse_progress.pendingBvids, [])
    assert.equal(completed.browse_progress.recentReadCount, 2)
    assert.equal(completed.browse_progress.deferredReadCount, 1)
    await assert.rejects(first.post({ action: 'tools-list' }), /撤销或过期/)
    const emptyPage = await call(second, 'bili_search', { keyword: '第二个具体搜索词', page: 2 })
    assert.equal(emptyPage.browse_progress.next.action, 'search-next-page')
    assert.deepEqual(emptyPage.browse_progress.next.args, { keyword: '第二个具体搜索词', page: 3 })
    const beforeSecondClose = relays.length
    children[1].child.exitCode = 0; children[1].child.emit('close', 0)
    assert.equal(relays.length, beforeSecondClose + 1)
    relays.at(-1).fire(); await immediate()
    assert.equal(children.length, 3)
    const thirdPrompt = promptProgress(children[2].args.at(-1))
    assert.equal(thirdPrompt.next.action, 'search-next-page')
    assert.deepEqual(thirdPrompt.next.args, { keyword: '第二个具体搜索词', page: 3 }, 'a new child receives a usable next-page query instead of only a page number')
    assert.equal(thirdPrompt.recentReadCount, 2)
    await assert.rejects(second.post({ action: 'tools-list' }), /撤销或过期/)
    await request('/pet/stop')
    const beforeStopClose = relays.length
    children[2].child.exitCode = 0; children[2].child.emit('close', 0)
    assert.equal(relays.length, beforeStopClose, 'manual stop cannot schedule another relay')
    assert.ok(platformCalls.every(row => ['bili_search', 'bili_guard_status', 'bili_subtitle', 'bili_comments'].includes(row.name)))
  } finally {
    for (const child of children) child.child.exitCode = 0
    for (const off of cleanups.reverse()) { try { await off() } catch {} }
    for (const timer of timers) original.clearTimeout(timer)
    for (const timer of intervals) original.clearInterval(timer)
    Object.assign(globalThis, { setTimeout: original.setTimeout, clearTimeout: original.clearTimeout, setInterval: original.setInterval, clearInterval: original.clearInterval })
    cp.spawn = original.spawn; McpClient.prototype.call = original.call; syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})
