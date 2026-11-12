import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'
import { learnAdd, learnDecide } from '../lib/learn.mjs'
import { readRecordEvents } from '../lib/records.mjs'
import { McpClient } from '../lib/mcp.mjs'
import { mutateLearningStateSync } from '../lib/learn-store.mjs'
import { DAFEIYU_DEFAULT_PERSONA } from '../lib/persona.mjs'

const immediate = () => new Promise(resolve => setImmediate(resolve))

/** Real scoped wrappers and transactions, isolated state and no platform transport. */
async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'fish-learning-tools-')), home = join(root, 'bili-duty')
  mkdirSync(home)
  writeFileSync(join(home, 'config.json'), JSON.stringify({ idleChatter: false, learnAutoReview: false, reportLevel: 'off',
    autoComment: false, autoMoment: false, autoReplyDm: false, replyToComments: false, pvAuto: false, keywords: ['足球'] }))
  const stateFile = join(home, 'state.json')
  writeFileSync(stateFile, JSON.stringify({ unrelated: 'retain-me' }))
  const tools = new Map(), events = new Map(), sections = new Map(), cleanups = [], agents = []
  const fish = { id: 'learning-fish', status: 'idle', session: { id: 'learning-fish', header: { agentPreset: 'dafeiyu' }, log: [] },
    ctx: { tools: { register(spec) { tools.set(spec.name, spec); return () => tools.delete(spec.name) } } } }
  const normal = { id: 'learning-normal', session: { header: { agentPreset: 'standard' } }, ctx: { tools: { register() { throw new Error('NORMAL_TOOL_LEAK') } } } }
  const otherTools = new Map()
  const otherFish = { id: 'learning-other-fish', status: 'idle', session: { id: 'learning-other-fish', header: { agentPreset: 'dafeiyu' }, log: [] },
    ctx: { tools: { register(spec) { otherTools.set(spec.name, spec); return () => otherTools.delete(spec.name) } } } }
  agents.push(fish, normal, otherFish)
  let handler
  const ctx = { logger: { info() {} }, settings: { describe: () => [] },
    get(key) {
      if (key === 'dshHomePath') return (...parts) => join(root, ...parts)
      if (key === 'agents') return { list: () => agents, get: id => agents.find(row => row.id === id) }
      if (key === 'systemPrompt') return { getSectionOrder: () => 600, section(spec) { sections.set(spec.name, spec); return () => sections.delete(spec.name) } }
    },
    tools: { register() { throw new Error('GLOBAL_TOOL_LEAK') } },
    on(name, fn) { const handlers = events.get(name) || []; handlers.push(fn); events.set(name, handlers); return () => events.set(name, handlers.filter(row => row !== fn)) },
    effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off); return off },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } },
  }
  const transport = McpClient.prototype.call
  McpClient.prototype.call = async (name, args) => {
    if (name === 'bili_search') return { videos: [], total: 0, fixture: true }
    if (name === 'bili_subtitle') return { bvid: args.bvid, text: '隔离测试中的真实合成字幕原文', segments: 1 }
    throw new Error('PLATFORM_IO_FORBIDDEN_IN_LEARNING_FIXTURE')
  }
  const request = async (path, body) => {
    const req = new EventEmitter(); Object.assign(req, { url: '/api/bili-duty' + path, method: body === undefined ? 'GET' : 'POST', headers: {}, destroy() {} })
    const res = { writeHead(status) { this.status = status }, end(text) { this.body = JSON.parse(text) } }
    const pending = handler(req, res)
    if (body !== undefined) { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }
    await pending
    return res
  }
  try {
    apply(ctx, {}); await immediate()
    const spec = tools.get('bili_learn')
    assert.ok(spec)
    await run({ root, home, stateFile, fish, normal, otherFish, spec, request,
      execute: (args, agent = fish) => spec.execute(args, { agent }),
      search: (keyword, agent = fish) => tools.get('bili_search').execute({ keyword }, { agent }),
      read: (bvid, agent = fish) => tools.get('bili_subtitle').execute({ bvid }, { agent }),
      state: () => JSON.parse(readFileSync(stateFile, 'utf8')),
      prompt: agent => String(sections.get('bili:dafeiyu')?.text({ agent }) || ''),
      async select(preset) { fish.session.header.agentPreset = preset; fish.session.log.push({ type: 'agent-preset/selected', data: { agentPreset: preset } }); for (const fn of events.get('agent-preset/selected') || []) await fn(fish.id, preset); await immediate() },
    })
  } finally {
    for (const off of cleanups.reverse()) { try { await off() } catch {} }
    McpClient.prototype.call = transport
    rmSync(root, { recursive: true, force: true })
  }
}

test('learning tool stores applicability pending, recalls by query after human approval, and records separate private practice', async () => fixture(async f => {
  const added = await f.execute({ action: 'add', kind: 'style', text: '认真接住具体问题，句子不用拖太长', when: '别人认真问问题时', example: '合成参考', from: 'fixture-learning' })
  assert.equal(added.ok, true)
  const pending = f.state().learn.items[added.id]
  assert.equal(pending.when, '别人认真问问题时')
  assert.equal(pending.state, 'pending')
  assert.equal((await f.execute({ action: 'inject', query: '认真问题' })).chars, 0)
  assert.equal((await f.execute({ action: 'feedback', id: added.id, outcome: 'helpful', note: '合成实践' })).ok, false)
  assert.equal((await f.execute({ action: 'approve', id: added.id })).review_required, true)
  assert.equal((await f.execute({ action: 'reject', id: added.id })).review_required, true)
  const approval = await f.request('/learn', { decision: 'approve', id: added.id, why: '具体可复用，人工合成批准' })
  assert.equal(approval.status, 200)
  assert.equal(approval.body.ok, true)
  const approved = structuredClone(f.state().learn.items[added.id])
  const beforeInvalidFeedback = readFileSync(f.stateFile, 'utf8')
  for (const args of [{ outcome: 'invented', note: 'bad outcome' }, { outcome: 'helpful', note: '' }, { outcome: 'tried', note: null }, { outcome: 'helpful', note: { text: 'not a note string' } }]) {
    const rejected = await f.execute({ action: 'feedback', id: added.id, ...args })
    assert.equal(rejected.ok, false)
    assert.ok(rejected.error)
    assert.equal(readFileSync(f.stateFile, 'utf8'), beforeInvalidFeedback)
  }
  const recalled = await f.execute({ action: 'inject', query: '认真问题' })
  assert.ok(recalled.selectedIds.includes(added.id))
  assert.match(recalled.text, /别人认真问问题时/)
  const practice = await f.execute({ action: 'feedback', id: added.id, outcome: 'tried', note: '把这次开头缩成一句，SESSDATA=fixture-secret; demo@example.org', state: 'approved', from: 'malicious-new-source', when: 'replace-condition' })
  assert.equal(practice.ok, true)
  const current = f.state().learn.items[added.id]
  for (const field of ['id', 'kind', 'text', 'when', 'from', 'sources', 'version', 'approvedVersion', 'decidedAt', 'why', 'state']) assert.deepEqual(current[field], approved[field], field)
  assert.equal(current.practice.reported, 1)
  assert.equal(current.practice.selfReported, true)
  assert.doesNotMatch(JSON.stringify(current.practice), /fixture-secret|demo@example.org/)
  const revision = f.state().learnRevision
  const auditCount = readRecordEvents(f.home, { type: 'learning', limit: 100 }).length
  const retry = await f.execute({ action: 'feedback', id: added.id, outcome: 'tried', note: '把这次开头缩成一句，SESSDATA=fixture-secret; demo@example.org' })
  assert.equal(retry.ok, true)
  assert.equal(f.state().learnRevision, revision, 'an identical retry does not create a practice or revision')
  assert.equal(readRecordEvents(f.home, { type: 'learning', limit: 100 }).length, auditCount)
  assert.equal(f.state().unrelated, 'retain-me')
  assert.equal(f.prompt(f.normal), '')
  assert.match(f.prompt(f.fish), /认真接住具体问题/)
  await f.request('/learn', { decision: 'reject', id: added.id, why: '人工撤销' })
  assert.equal((await f.execute({ action: 'feedback', id: added.id, outcome: 'helpful', note: '撤销后不可实践' })).ok, false)
  assert.equal((await f.execute({ action: 'inject', query: '认真问题' })).chars, 0)
  assert.doesNotMatch(f.prompt(f.fish), /认真接住具体问题/)
}))

test('a saved custom persona globally replaces the default voice while approved learning remains readable and subordinate', async () => fixture(async f => {
  const config = await f.request('/config')
  assert.equal(config.body.config.persona, '', 'an empty setting uses the install-ready built-in voice')
  assert.ok(f.prompt(f.fish).includes(DAFEIYU_DEFAULT_PERSONA))
  assert.equal(f.prompt(f.normal), '')
  const custom = 'CUSTOM_GLOBAL_PERSONA: 简短、冷面幽默，称呼使用者为朋友。'
  const saved = await f.request('/config', { persona: custom })
  assert.equal(saved.body.ok, true)
  let prompt = f.prompt(f.fish)
  assert.ok(prompt.includes(custom))
  assert.doesNotMatch(prompt, /你是大肥鱼，也叫鲸鱼摸鱼/)
  assert.match(prompt, /完整替代内置人格/)
  assert.match(prompt, /统一用于鱼模式的聊天、评论、回复、私信、动态与后台AI发言/)
  assert.doesNotMatch(prompt, /人格设定（使用者写的，\*\*按这个说话\*\*）/)
  const old = learnAdd({}, { kind: 'style', text: '写作方法参考：先引用一句再分点', when: '仅合成审核情境', example: '不是公开新评论的成品句', from: 'fixture' })
  const approved = learnDecide(old.ledger, old.id, 'approve', '合成人工批准')
  writeFileSync(f.stateFile, JSON.stringify({ ...f.state(), learn: approved.ledger }))
  prompt = f.prompt(f.fish)
  assert.ok(prompt.includes(custom), 'the live session reads the saved global personality')
  assert.match(prompt, /只是参考，不是必须照做/)
  assert.doesNotMatch(prompt, /你是大肥鱼，也叫鲸鱼摸鱼/)
  const learnedList = await f.execute({ action: 'list', state: 'approved', query: '引用 合成审核情境' })
  assert.ok(learnedList.items.some(row => row.id === old.id), 'approved experience can be listed by query')
  assert.equal(f.prompt(f.normal), '', 'ordinary sessions receive neither default voice nor approved examples')
  await f.request('/config', { persona: '' })
  assert.ok(f.prompt(f.fish).includes(DAFEIYU_DEFAULT_PERSONA), 'clearing the supplement restores the same ready-to-use default')
}))

test('contextual query finds old facts and stale learning handles cannot read or write across modes', async () => fixture(async f => {
  let book = {}
  const old = learnAdd(book, { kind: 'fact', text: '纸张动画是逐格拍摄真实纸片', when: '聊纸张动画或定格拍摄', from: 'BV1234567890', at: '2026-01-01T00:00:00Z' })
  book = learnDecide(old.ledger, old.id, 'approve', 'fixture', '2026-01-01T00:00:00Z').ledger
  for (let index = 0; index < 24; index++) {
    const a = learnAdd(book, { kind: 'fact', text: `足球${index}讲阵型与赛场进球`, from: 'fixture' })
    book = learnDecide(a.ledger, a.id, 'approve', 'fixture').ledger
  }
  writeFileSync(f.stateFile, JSON.stringify({ ...f.state(), learn: book }))
  const recalled = await f.execute({ action: 'inject', query: '纸张动画 定格拍摄' })
  assert.deepEqual(recalled.selectedIds, [old.id])
  assert.doesNotMatch(recalled.text, /足球/)
  assert.doesNotMatch(f.prompt(f.fish), /纸张动画是逐格拍摄/)
  await f.search('纸张动画 定格拍摄')
  assert.match(f.prompt(f.fish), /纸张动画是逐格拍摄/)
  assert.doesNotMatch(f.prompt(f.otherFish), /纸张动画是逐格拍摄/, 'a search in one chat cannot set another chat\'s recall topic')
  assert.ok((await f.execute({ action: 'inject' })).selectedIds.includes(old.id), 'implicit tool recall uses its own latest search')
  assert.ok(!(await f.execute({ action: 'inject' }, f.otherFish)).selectedIds.includes(old.id))
  const before = readFileSync(f.stateFile, 'utf8')
  for (const args of [{ action: 'inject', query: '纸张动画' }, { action: 'feedback', id: old.id, outcome: 'tried', note: '普通模式不能写' }, { action: 'add', text: '普通模式不能添' }]) {
    assert.equal((await f.execute(args, f.normal)).reason, 'mode_required')
  }
  await f.select('standard')
  assert.equal(f.prompt(f.fish), '')
  for (const args of [{ action: 'inject', query: '纸张动画' }, { action: 'feedback', id: old.id, outcome: 'tried', note: '旧句柄不能写' }]) assert.equal((await f.execute(args)).reason, 'mode_required')
  assert.equal(readFileSync(f.stateFile, 'utf8'), before)
}))

test('a learning write queued before a rapid mode exit and return cannot commit in the new generation', async () => fixture(async f => {
  const addition = learnAdd({}, { kind: 'style', text: '认真接住具体问题', when: '认真提问时' })
  const approved = learnDecide(addition.ledger, addition.id, 'approve', '合成人工批准')
  writeFileSync(f.stateFile, JSON.stringify({ ...f.state(), learn: approved.ledger }))
  const before = readFileSync(f.stateFile, 'utf8')
  const writes = [
    { action: 'feedback', id: addition.id, outcome: 'helpful', note: '旧请求不能把实践写到新的角色代际' },
    { action: 'add', kind: 'fact', text: '旧请求不能添入新的角色代际' },
    { action: 'forget', id: addition.id },
  ]
  for (const args of writes) {
    const pending = f.execute(args)
    const switched = new Promise(resolve => queueMicrotask(() => {
      // Both selections run synchronously up to their first await, before the state-lock callback.
      const left = f.select('standard'), returned = f.select('dafeiyu')
      Promise.all([left, returned]).then(resolve)
    }))
    const result = await pending
    await switched
    assert.equal(result.ok, false)
    assert.equal(readFileSync(f.stateFile, 'utf8'), before, 'neither practice, revision nor unrelated state may change')
  }
  const approvedAgain = await f.request('/learn', { decision: 'approve', id: addition.id, why: '人工审核仍由独立HTTP入口完成' })
  assert.equal(approvedAgain.body.ok, true)
  const fresh = await f.execute({ action: 'feedback', id: addition.id, outcome: 'tried', note: '新的角色请求可以正常记录' })
  assert.equal(fresh.ok, true)
  assert.equal(f.state().learn.items[addition.id].practice.reported, 1)
}))

test('malformed persisted learning containers cannot be replaced by role, HTTP or shared reviewer writes; missing legacy fields remain valid', async () => fixture(async f => {
  for (const learn of [null, [], 'broken', false, 7, { items: null }, { items: [] },
    { items: [{ id: 'original-record', text: 'keep original bytes' }] }, { items: 'broken' },
    { items: {}, history: null }, { items: {}, history: 'broken' }]) {
    const before = JSON.stringify({ unrelated: 'retain-me', learn })
    writeFileSync(f.stateFile, before)
    let called = false
    assert.throws(() => mutateLearningStateSync(f.stateFile, () => { called = true }), { code: 'LEARN_STATE_INVALID' })
    assert.equal(called, false, 'a shared transaction cannot calculate from a silently emptied ledger')
    assert.equal(readFileSync(f.stateFile, 'utf8'), before)
    await assert.rejects(f.execute({ action: 'add', kind: 'style', text: '不能覆盖异常旧记录' }), { code: 'LEARN_STATE_INVALID' })
    assert.equal(readFileSync(f.stateFile, 'utf8'), before)
    const human = await f.request('/learn', { decision: 'approve', id: 'original-record', why: '合成审核' })
    assert.equal(human.body.ok, false)
    assert.ok(human.status >= 400)
    assert.equal(readFileSync(f.stateFile, 'utf8'), before)
  }
  for (const learn of [undefined, {}, { items: {} }]) {
    writeFileSync(f.stateFile, JSON.stringify({ unrelated: 'retain-me', learn }))
    const added = await f.execute({ action: 'add', kind: 'style', text: '缺省字段的旧账本仍可正常新增' })
    assert.equal(added.ok, true)
    assert.equal(f.state().unrelated, 'retain-me')
  }
}))

test('HTTP and role queries expose approved knowledge, all-state history and real next pages without mutating records', async () => fixture(async f => {
  let book = {}
  for (let index = 0; index < 27; index++) {
    const added = learnAdd(book, { kind: 'fact', text: `定格动画的合成知识${index}`, when: '聊动画制作', from: 'BV' + String(index).padStart(10, '0') })
    book = learnDecide(added.ledger, added.id, 'approve', '隔离人工批准').ledger
  }
  const pending = learnAdd(book, { kind: 'fact', text: '动画的新说法仍待审', from: 'pending-source' })
  const rejected = learnAdd(pending.ledger, { kind: 'fact', text: '动画的错误说法被拒绝', from: 'rejected-source' })
  book = learnDecide(rejected.ledger, rejected.id, 'reject', '不可靠').ledger
  writeFileSync(f.stateFile, JSON.stringify({ ...f.state(), learn: book, learnRevision: 12 }))
  const before = readFileSync(f.stateFile, 'utf8')
  const installed = (await f.request('/learn')).body
  assert.equal(installed.state, 'approved')
  assert.equal(installed.matched, 27)
  assert.equal(installed.total, 29)
  assert.equal(installed.approved, 27)
  assert.equal(installed.pending, 1)
  assert.equal(installed.rejected, 1)
  assert.equal(installed.revision, 12)
  assert.equal(installed.hasMore, true)
  assert.equal(installed.nextOffset, 20)
  assert.ok(installed.items.every(row => row.state === 'approved' && row.availableForRecall))
  const list = await f.execute({ action: 'list', limit: 10 })
  assert.equal(list.state, 'all')
  assert.equal(list.matched, 29)
  assert.equal(list.nextOffset, 10)
  assert.ok(f.spec.parameters.offset && f.spec.parameters.limit)
  const next = await f.execute({ action: 'list', offset: list.nextOffset, limit: 10 })
  assert.equal(next.offset, 10)
  assert.ok(next.items.every(row => !list.items.some(previous => previous.id === row.id)))
  assert.equal((await f.execute({ action: 'review' })).items[0].id, pending.id)
  assert.equal((await f.execute({ action: 'list', state: 'pending' })).items[0].availableForRecall, false)
  assert.equal((await f.execute({ action: 'list', state: 'rejected' })).items[0].availableForRecall, false)
  const query = 'STOP MOTION ＢＶ００００００００２６'
  const tool = await f.execute({ action: 'list', state: 'approved', query })
  const http = (await f.request('/learn?state=approved&query=' + encodeURIComponent(query))).body
  const memory = (await f.request('/memory?source=learning&query=' + encodeURIComponent(query))).body
  assert.equal(tool.matched, 1)
  assert.equal(http.matched, 1)
  assert.equal(memory.matched, 1)
  assert.equal(tool.items[0].id, http.items[0].id)
  assert.equal(memory.items[0].id, tool.items[0].id)
  assert.equal(tool.items[0].sourceLinks[0].url, 'https://www.bilibili.com/video/BV0000000026')
  const recall = await f.execute({ action: 'inject', query })
  assert.deepEqual(recall.selectedIds, [tool.items[0].id])
  assert.equal(recall.contextSource, 'explicit-query')
  const empty = await f.execute({ action: 'inject', query: '不存在的相关话题' })
  assert.equal(empty.reason, 'no-related-learning')
  assert.equal(empty.approvedCount, 27)
  assert.match(empty.text, /不表示学习记录为空/)
  assert.equal(readFileSync(f.stateFile, 'utf8'), before, 'list, memory and recall never claim practice or rewrite approval')
}))

test('implicit fact recall uses only this scope actual read source and corrupt reads report errors without replacing bytes', async () => fixture(async f => {
  const a = learnAdd({}, { kind: 'fact', text: '合成结构由相邻连接点共同支撑', from: 'BV1234567890' })
  const b = learnDecide(a.ledger, a.id, 'approve', '隔离人工批准')
  writeFileSync(f.stateFile, JSON.stringify({ ...f.state(), learn: b.ledger }))
  assert.equal((await f.execute({ action: 'inject' })).selectedIds.length, 0, 'configured football interests do not match this fact')
  await f.read('BV1234567890')
  const recalled = await f.execute({ action: 'inject' })
  assert.deepEqual(recalled.selectedIds, [a.id])
  assert.equal(recalled.contextSource, 'current-video-source')
  assert.equal((await f.execute({ action: 'inject' }, f.otherFish)).selectedIds.length, 0)
  assert.equal((await f.execute({ action: 'inject', query: '足球' })).selectedIds.length, 0, 'an explicit new topic replaces the last read source')
  await f.search('足球')
  assert.equal((await f.execute({ action: 'inject' })).selectedIds.length, 0, 'a new search supersedes the previous video source instead of retaining a stale topic')
  for (const learn of [null, [], { items: [] }, { history: null }]) {
    const before = JSON.stringify({ unrelated: 'retain-me', learn })
    writeFileSync(f.stateFile, before)
    const http = await f.request('/learn')
    assert.equal(http.body.ok, false)
    assert.match(http.body.error, /LEARN_STATE_INVALID/)
    assert.equal((await f.request('/memory?source=learning')).body.ok, false)
    await assert.rejects(f.execute({ action: 'list' }), { code: 'LEARN_STATE_INVALID' })
    await assert.rejects(f.execute({ action: 'inject', query: '结构' }), { code: 'LEARN_STATE_INVALID' })
    assert.equal(readFileSync(f.stateFile, 'utf8'), before)
  }
}))
