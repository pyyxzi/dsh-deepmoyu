import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'
import { McpClient } from '../lib/mcp.mjs'

/**
 * 2026-11-14：摸鱼会话的缓存命中率只有 26%，同机普通会话 97%。
 *
 * 根因：`systemPrompt.section` 里放了**每次工具调用都会变**的内容 ——
 *  `【这次刷到哪里】` 浏览进度 JSON、分钟级时钟、实时配额计数。
 *  这一段落在整份 14k 字提示词的 1400 字处，改一个数字后面全部作废。
 *
 * 这组测试钉住修复后的契约：
 *   ① 同一个小时里，**调多少次工具**，系统提示词都必须**字节一致**；
 *   ② 分钟级时间和浏览进度只出现在**工具回执**（尾部追加，缓存安全）；
 *   ③ 只有真的发生动作（挑片/发说说/改设置）才允许系统提示词变。
 */

const immediate = () => new Promise(resolve => setImmediate(resolve))
const A = 'BV1234567890', B = 'BV1234567891'

test('system prompt stays byte-identical across tool calls; volatile state rides tool results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-prompt-cache-')), home = join(root, 'bili-duty')
  mkdirSync(home)
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    idleChatter: false, learnAutoReview: false, reportLevel: 'off', pvAuto: false,
    autoComment: true, replyToComments: true, autoMoment: true, autoReplyDm: true,
    momentPerDay: 10, perDay: 20, sessionModelId: '', sessionMinutes: 0,
    browseRecentDays: 7, browseSort: 'click', browseMinViews: 0, browseMinMinutes: 0, browseMaxMinutes: 0,
  }))
  const events = new Map(), sections = new Map(), goalsByAgent = new Map(), cleanups = [], calls = []
  let handler, sequence = 0
  const agent = id => {
    const tools = new Map()
    return { id, status: 'idle', session: { id, header: { agentPreset: 'dafeiyu', cwd: root }, log: [] }, tools,
      ctx: { tools: { register(spec) { tools.set(spec.name, spec); return () => tools.delete(spec.name) } } } }
  }
  const fish = agent('cache-fish'), agents = [fish]
  const goals = {
    get: row => goalsByAgent.get(row.id),
    create(row, spec) { const goal = { ...spec, id: `goal-${++sequence}`, revision: 1, phase: 'active', activation: 'armed', roundsStarted: 1 }; goalsByAgent.set(row.id, goal); return goal },
    pause(row) { const goal = goalsByAgent.get(row.id); goal.phase = 'paused'; goal.activation = 'disarmed'; goal.revision++; return goal },
    resume(row) { const goal = goalsByAgent.get(row.id); goal.phase = 'active'; goal.activation = 'armed'; goal.revision++; return goal },
    clear(row) { const goal = goalsByAgent.get(row.id); goalsByAgent.delete(row.id); return goal },
  }
  const ctx = { logger: { info() {} }, settings: { describe: () => [] },
    get(key) {
      if (key === 'dshHomePath') return (...parts) => join(root, ...parts)
      if (key === 'agents') return { list: () => agents, get: id => agents.find(row => row.id === id) }
      if (key === 'goals') return goals
      if (key === 'systemPrompt') return { getSectionOrder: () => 600, section(spec) { sections.set(spec.name, spec); return () => sections.delete(spec.name) } }
    },
    tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } },
    on(name, fn) { const handlers = events.get(name) || []; handlers.push(fn); events.set(name, handlers); return () => events.set(name, handlers.filter(row => row !== fn)) },
    effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off); return off },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } },
  }
  const now = Date.now()
  const video = (bvid, title, hours, play) => ({ bvid, title, duration: 600, pubdate: Math.floor((now - hours * 3600000) / 1000), play })
  const videos = [video(A, '科技日常', 48, 50), video(B, '科技新片', 24, 100)]
  const original = McpClient.prototype.call
  McpClient.prototype.call = async (name, args) => {
    calls.push({ name, args: structuredClone(args) })
    if (name === 'bili_search') return { videos: structuredClone(videos), total: videos.length }
    if (name === 'bili_guard_status') return { ok: true, seenVideos: {} }
    if (name === 'bili_subtitle') return { bvid: args.bvid, text: '合成字幕。', segments: 1 }
    if (name === 'bili_dm_list') return { ok: true, count: 1, items: [{ uid: '42', name: '朋友', said: '在吗', msg_seqno: '9001', time: Math.floor(now / 1000), days_ago: 0, unread: 1, is_follow: true }] }
    throw new Error('UNEXPECTED_PLATFORM_TOOL: ' + name)
  }
  const request = async (path, body) => {
    const req = new EventEmitter(); Object.assign(req, { url: '/api/bili-duty' + path, method: body === undefined ? 'GET' : 'POST', headers: {}, destroy() {} })
    const res = { writeHead(status) { this.status = status }, end(text) { this.body = JSON.parse(text) } }
    const pending = handler(req, res)
    if (body !== undefined) { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }
    await pending
    assert.equal(res.status, 200)
    return res.body
  }
  const execute = (row, name, args) => row.tools.get(name).execute(args, { agent: row })
  const prompt = row => String(sections.get('bili:dafeiyu').text({ agent: row }))
  try {
    apply(ctx, {}); await immediate()
    assert.equal((await request('/pet/start', { mode: 'session', sessionId: fish.id, durationMinutes: 0, model: '', tokenBudget: 0 })).ok, true)
    const before = prompt(fish)
    assert.ok(before.length > 0, 'fish prompt must not be empty')

    // ① 系统提示词里不许再有"每次工具调用都变"的东西
    assert.doesNotMatch(before, /【这次刷到哪里】/, 'browse progress must not live in the system prompt')
    assert.doesNotMatch(before, /\d{1,2}:\d{2}/, 'minute-level clock must not live in the system prompt')
    assert.match(before, /【实时配额】/, 'stable quota summary may stay')
    assert.match(before, /说说：开/, 'moment switch summary may stay')

    // ② 连续调工具（进度不断变化）之后，系统提示词必须一字不差
    const found = await execute(fish, 'bili_search', { keyword: '科技' })
    assert.ok(found.browse_progress, 'tool results carry browse progress')
    assert.ok(found.live, 'tool results carry the live snapshot')
    assert.match(found.live, /🕐 \d{2}:\d{2}/, 'minute-level clock lives on tool results')
    const afterSearch = prompt(fish)
    assert.equal(afterSearch, before, 'system prompt unchanged after a search that moves browse progress')

    await execute(fish, 'bili_subtitle', { bvid: A })
    const afterRead = prompt(fish)
    assert.equal(afterRead, before, 'system prompt unchanged after reading a video')

    await execute(fish, 'bili_dm_inbox', {})
    const afterDm = prompt(fish)
    assert.equal(afterDm, before, 'system prompt unchanged after checking the DM inbox')

    // ③ 只有真的发生动作（改配额/开关）才允许它变 —— 而且下一请求立刻生效
    const cfgFile = join(home, 'config.json')
    const current = JSON.parse(readFileSync(cfgFile, 'utf8'))
    writeFileSync(cfgFile, JSON.stringify({ ...current, perDay: 33, _set: [...new Set([...(current._set || []), 'perDay'])] }))
    const afterConfig = prompt(fish)
    assert.notEqual(afterConfig, before, 'a real setting change refreshes the prompt')
    assert.match(afterConfig, /33/, 'the refreshed quota is visible on the next request')
  } finally {
    for (const off of cleanups.reverse()) { try { await off() } catch {} }
    McpClient.prototype.call = original
    rmSync(root, { recursive: true, force: true })
  }
})
