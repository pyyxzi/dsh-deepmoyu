import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'
import { McpClient } from '../lib/mcp.mjs'

const immediate = () => new Promise(resolve => setImmediate(resolve))
const A = 'BV1234567890', B = 'BV1234567891', SPOILER = 'BV1234567892', OLD = 'BV1234567893', AVOID = 'BV1234567894'
const progressOf = prompt => JSON.parse(prompt.split('\n').find(line => line.startsWith('【这次刷到哪里】')).slice('【这次刷到哪里】'.length))

test('real run wrappers freeze preferences, retain candidates across rounds, isolate chats and reset on restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-browsing-run-context-')), home = join(root, 'bili-duty')
  mkdirSync(home)
  writeFileSync(join(home, 'config.json'), JSON.stringify({ idleChatter: false, learnAutoReview: false, reportLevel: 'off', pvAuto: false,
    autoComment: false, replyToComments: false, autoMoment: false, autoReplyDm: false, sessionModelId: '', sessionMinutes: 0,
    browseRecentDays: 7, browseSort: 'click', browseMinViews: 0, browseMinMinutes: 5, browseMaxMinutes: 30, browseAvoidKeywords: ['剧透'], keywords: ['科技'] }))
  const events = new Map(), sections = new Map(), goalsByAgent = new Map(), cleanups = [], calls = []
  let handler, sequence = 0
  const agent = id => {
    const tools = new Map()
    return { id, status: 'idle', session: { id, header: { agentPreset: 'dafeiyu', cwd: root }, log: [] }, tools,
      ctx: { tools: { register(spec) { tools.set(spec.name, spec); return () => tools.delete(spec.name) } } } }
  }
  const first = agent('browsing-first'), second = agent('browsing-second'), agents = [first, second]
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
  const videos = [video(A, '科技日常', 48, 50), video(B, '科技新片', 24, 100), video(SPOILER, '剧透解析', 3, 200), video(OLD, '旧知识', 288, 300), video(AVOID, '新避雷', 24, 400)]
  const original = McpClient.prototype.call
  McpClient.prototype.call = async (name, args) => {
    calls.push({ name, args: structuredClone(args) })
    if (name === 'bili_search') return { videos: structuredClone(videos), total: videos.length }
    if (name === 'bili_guard_status') return { ok: true, seenVideos: {} }
    if (name === 'bili_subtitle') return { bvid: args.bvid, text: '这是合成字幕，只用于验证候选队列。', segments: 1 }
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
  const select = async (row, preset) => {
    row.session.header.agentPreset = preset
    row.session.log.push({ type: 'agent-preset/selected', data: { agentPreset: preset } })
    for (const fn of events.get('agent-preset/selected') || []) await fn(row.id, preset)
    await immediate()
  }
  try {
    apply(ctx, {}); await immediate()
    const started = await request('/pet/start', { mode: 'session', sessionId: first.id, durationMinutes: 0, model: '', tokenBudget: 0 })
    assert.equal(started.ok, true)
    assert.equal(started.browsePreferences.browseRecentDays, 7)
    assert.deepEqual(started.browsePreferences.browseAvoidKeywords, ['剧透'])
    const changed = await request('/config', { browseRecentDays: 0, browseSort: 'pubdate', browseMinMinutes: 0, browseMaxMinutes: 0, browseAvoidKeywords: ['新避雷'], keywords: ['旅行'] })
    assert.equal(changed.ok, true)
    const found = await execute(first, 'bili_search', { keyword: '科技' })
    assert.deepEqual(calls.find(row => row.name === 'bili_search').args, { keyword: '科技', num: 10, order: 'click', days: 7 })
    assert.deepEqual(found.fresh.map(row => row.bvid), [AVOID, B, A])
    assert.equal(found.preference_summary.settings.browseRecentDays, 7)
    assert.deepEqual(found.preference_summary.settings.browseAvoidKeywords, ['剧透'])
    assert.deepEqual(found.browse_progress.pendingBvids, [AVOID, B, A])
    const secondPage = await execute(first, 'bili_search', { keyword: '科技', page: 2 })
    assert.equal(calls.filter(row => row.name === 'bili_search').at(-1).args.page, 2, 'paging reaches the platform instead of repeating the first request')
    assert.equal(secondPage.browse_progress, undefined, 'unchanged candidate guidance is not repeated in tool context')
    assert.deepEqual(progressOf(prompt(first)).pendingBvids, [AVOID, B, A], 'overlapping pages preserve the unfinished candidates')
    const beforeInvalidPages = calls.length
    for (const page of [true, '2', 0, 51, 1.5]) assert.equal((await execute(first, 'bili_search', { keyword: '科技', page })).ok, false)
    assert.equal(calls.length, beforeInvalidPages, 'malformed page inputs perform no account request')
    const read = await execute(first, 'bili_subtitle', { bvid: B })
    assert.deepEqual(read.browse_progress.pendingBvids, [AVOID, A])
    assert.equal(read.browse_progress.recentReadCount, 1)
    goals.get(first).roundsStarted++
    assert.deepEqual(progressOf(prompt(first)).pendingBvids, [AVOID, A], 'next request retains unprocessed candidates')
    const another = await request('/pet/start', { mode: 'session', sessionId: second.id, durationMinutes: 0, model: '', tokenBudget: 0 })
    assert.equal(another.ok, true)
    assert.equal(another.browsePreferences.browseRecentDays, 0)
    const otherFound = await execute(second, 'bili_search', { keyword: '旅行' })
    assert.deepEqual(calls.filter(row => row.name === 'bili_search').at(-1).args, { keyword: '旅行', num: 10, order: 'pubdate', days: 0 })
    assert.deepEqual(otherFound.fresh.map(row => row.bvid), [SPOILER, A, OLD], 'second run uses new preferences while respecting shared seen history')
    assert.equal(otherFound.browse_progress.recentReadCount, 0)
    assert.deepEqual(progressOf(prompt(first)).pendingBvids, [AVOID, A], 'second chat never overwrites first chat progress')
    assert.deepEqual(progressOf(prompt(second)).pendingBvids, [SPOILER, A, OLD])
    const stale = first.tools.get('bili_search'), countBeforeExit = calls.length
    await select(first, 'standard')
    assert.equal((await stale.execute({ keyword: 'must not execute' }, { agent: first })).reason, 'mode_required')
    assert.equal(calls.length, countBeforeExit)
    assert.equal(prompt(first), '')
    assert.equal(goals.get(first).phase, 'paused')
    assert.equal(goals.get(second).phase, 'active')
    await select(first, 'dafeiyu')
    assert.equal((await request('/feiyu', { action: 'clear', sessionId: first.id })).cleared, true)
    const restarted = await request('/pet/start', { mode: 'session', sessionId: first.id, durationMinutes: 0, model: '', tokenBudget: 0 })
    assert.equal(restarted.ok, true)
    assert.deepEqual(restarted.browsePreferences.browseAvoidKeywords, ['新避雷'])
    assert.deepEqual(progressOf(prompt(first)).pendingBvids, [])
    const newFound = await execute(first, 'bili_search', { keyword: '旅行' })
    assert.deepEqual(newFound.fresh.map(row => row.bvid), [SPOILER, A, OLD])
    assert.equal(newFound.browse_progress.recentReadCount, 0, 'fresh run has a fresh progress summary')
    const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    assert.ok(state.seenVideos[B], 'resetting a run never deletes permanent browsing evidence')
    assert.ok(calls.every(row => ['bili_search', 'bili_guard_status', 'bili_subtitle'].includes(row.name)))
  } finally {
    for (const off of cleanups.reverse()) { try { await off() } catch {} }
    McpClient.prototype.call = original
    rmSync(root, { recursive: true, force: true })
  }
})
