import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'
import { McpClient } from '../lib/mcp.mjs'

const BV = 'BV1234567890', OTHER = 'BV1234567891'
const immediate = () => new Promise(resolve => setImmediate(resolve))

async function curiosityHome(run) {
  const root = mkdtempSync(join(tmpdir(), 'fish-curiosity-routes-')), home = join(root, 'bili-duty')
  mkdirSync(home)
  writeFileSync(join(home, 'config.json'), JSON.stringify({ idleChatter: false, learnAutoReview: false, reportLevel: 'off',
    autoComment: false, replyToComments: false, autoMoment: false, autoReplyDm: false, pvAuto: false }))
  const stateFile = join(home, 'state.json')
  writeFileSync(stateFile, JSON.stringify({ unrelated: { keep: 73 }, seenVideos: {} }))
  const fixtures = [], calls = [], transport = McpClient.prototype.call
  let subtitleReply = () => ({ text: '纸片一张一张移动，定格拍摄才形成连续画面。', segments: 1,
    segments_detail: [{ from: 12, to: 15, content: '纸片一张一张移动，定格拍摄才形成连续画面。' }] })
  McpClient.prototype.call = async (name, args) => {
    calls.push({ name, args: structuredClone(args) })
    if (name === 'bili_subtitle') return await subtitleReply(args)
    throw new Error('UNEXPECTED_PLATFORM_IO: ' + name)
  }
  const addHost = async ({ goalStore = new Map() } = {}) => {
    const tools = new Map(), otherTools = new Map(), events = new Map(), sections = new Map(), cleanups = [], goalsByAgent = goalStore
    let goalSequence = 0
    const fish = { id: 'curiosity-fish', status: 'idle', session: { id: 'curiosity-fish', header: { agentPreset: 'dafeiyu' }, log: [] },
      ctx: { tools: { register(spec) { tools.set(spec.name, spec); return () => tools.delete(spec.name) } } } }
    const otherFish = { id: 'curiosity-other-fish', status: 'idle', session: { id: 'curiosity-other-fish', header: { agentPreset: 'dafeiyu' }, log: [] },
      ctx: { tools: { register(spec) { otherTools.set(spec.name, spec); return () => otherTools.delete(spec.name) } } } }
    const normal = { id: 'curiosity-normal', session: { header: { agentPreset: 'standard' } }, ctx: { tools: { register() { throw new Error('NORMAL_TOOL_LEAK') } } } }
    let handler
    const goals = {
      get: agent => goalsByAgent.get(agent.id),
      create(agent, spec) { const goal = { ...spec, id: 'curiosity-goal-' + ++goalSequence, revision: 1, phase: 'active', activation: 'armed', roundsStarted: 1 }; goalsByAgent.set(agent.id, goal); return goal },
      pause(agent) { const goal = goalsByAgent.get(agent.id); goal.phase = 'paused'; goal.activation = 'disarmed'; goal.revision++; return goal },
      resume(agent) { const goal = goalsByAgent.get(agent.id); goal.phase = 'active'; goal.activation = 'armed'; goal.revision++; return goal },
      clear(agent) { const goal = goalsByAgent.get(agent.id); goalsByAgent.delete(agent.id); return goal },
    }
    const ctx = { logger: { info() {} }, settings: { describe: () => [] },
      get(key) {
        if (key === 'dshHomePath') return (...parts) => join(root, ...parts)
        if (key === 'agents') return { list: () => [fish, otherFish, normal], get: id => [fish, otherFish, normal].find(row => row.id === id) }
        if (key === 'goals') return goals
        if (key === 'systemPrompt') return { getSectionOrder: () => 600, section(spec) { sections.set(spec.name, spec); return () => sections.delete(spec.name) } }
      },
      tools: { register() { throw new Error('GLOBAL_TOOL_LEAK') } },
      on(name, fn) { const rows = events.get(name) || []; rows.push(fn); events.set(name, rows); return () => events.set(name, rows.filter(row => row !== fn)) },
      effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off); return off },
      webServer: { register(route) { handler = route.handler; return { dispose() {} } } },
    }
    const begin = (path, body, headers = {}) => {
      const req = new EventEmitter(); Object.assign(req, { url: '/api/bili-duty' + path, method: body === undefined ? 'GET' : 'POST', headers, destroy() {} })
      const res = { writeHead(code) { this.code = code }, end(text) { this.body = JSON.parse(text) } }
      const pending = handler(req, res).then(() => res)
      return { pending, finish(value = body) { if (value !== undefined) { req.emit('data', Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))); req.emit('end') }; return pending } }
    }
    apply(ctx, {}); await immediate()
    const captured = tools.get('bili_curiosity')
    assert.ok(captured, 'the curiosity tool must actually be registered in a fish session')
    const select = async preset => {
      fish.session.header.agentPreset = preset
      fish.session.log.push({ type: 'agent-preset/selected', data: { agentPreset: preset } })
      for (const fn of events.get('agent-preset/selected') || []) await fn(fish.id, preset)
      await immediate()
    }
    const f = { fish, otherFish, normal, tools, begin, select, goals,
      request: async (path, body, headers) => begin(path, body, headers).finish(),
      execute: (args, agent = fish) => captured.execute(args, { agent }),
      read: (bvid = BV, agent = fish) => tools.get('bili_subtitle').execute({ bvid, with_time: true }, { agent }),
      mark: (bvid = BV) => tools.get('bili_seen').execute({ action: 'mark', bvid, note: '只标记，不能作为内容证据' }, { agent: fish }),
      prompt: agent => String(sections.get('bili:dafeiyu')?.text({ agent }) || ''),
      async reload() { await f.close(); return addHost({ goalStore: goalsByAgent }) },
      async close() { for (const off of cleanups.reverse()) { try { await off() } catch {} } },
    }
    fixtures.push(f)
    return f
  }
  try {
    await run({ root, home, stateFile, calls, addHost,
      state: () => JSON.parse(readFileSync(stateFile, 'utf8')),
      subtitle(value) { subtitleReply = typeof value === 'function' ? value : () => value },
    })
  } finally {
    for (const f of fixtures.reverse()) await f.close()
    McpClient.prototype.call = transport
    rmSync(root, { recursive: true, force: true })
  }
}

test('a user can suggest an open question, while fish findings require scoped subtitle evidence and preserve sources', async () => curiosityHome(async e => {
  const f = await e.addHost()
  const userOpen = await f.request('/curiosity', { action: 'open', question: '定格动画为什么看起来像在动', query: '定格动画原理' })
  assert.equal(userOpen.code, 200)
  assert.equal(userOpen.body.ok, true)
  const userTopic = userOpen.body.items.find(row => row.origin === 'user')
  assert.ok(userTopic)
  assert.equal(userTopic.bvid, '')
  assert.deepEqual(userTopic.notes, [])
  const beforeUnknownInputs = readFileSync(e.stateFile, 'utf8')
  const forgedActor = await f.request('/curiosity', { action: 'open', question: '伪造角色来源', origin: 'fish', bvid: BV })
  assert.equal(forgedActor.code, 400)
  const forgedNote = await f.request('/curiosity', { action: 'note', id: userTopic.id, bvid: BV, text: '人工请求不能伪造已读收获' })
  assert.equal(forgedNote.code, 400)
  assert.equal(readFileSync(e.stateFile, 'utf8'), beforeUnknownInputs)
  const beforeUnproved = readFileSync(e.stateFile, 'utf8')
  const fishArgs = { action: 'open', question: '纸片的移动间隔会改变观感吗', query: '纸片定格移动', bvid: BV }
  assert.equal((await f.execute(fishArgs)).ok, false)
  assert.equal((await f.execute({ ...fishArgs, readBvids: [BV] })).ok, false, 'tool arguments cannot grant trusted reading evidence')
  await f.mark(BV)
  assert.equal((await f.execute(fishArgs)).ok, false, 'permanent seen marking cannot fabricate present content evidence')
  assert.equal(e.state().curiosity.items.length, 1)
  e.subtitle({ ok: true, text: ' ', segments: 10 })
  await f.read(BV)
  assert.equal((await f.execute(fishArgs)).ok, false, 'segment counts without actual content are not reading evidence')
  e.subtitle({ text: '纸片一张一张移动，定格拍摄形成连续画面。', segments: 1 })
  await f.read(BV)
  const fishOpen = await f.execute(fishArgs)
  assert.equal(fishOpen.ok, true)
  const fishTopic = fishOpen.items.find(row => row.origin === 'fish')
  assert.ok(fishTopic)
  assert.equal(fishTopic.bvid, BV)
  assert.equal((await f.execute({ action: 'note', id: userTopic.id, bvid: BV, text: '别的会话没有读过' }, f.otherFish)).ok, false)
  const note = await f.execute({ action: 'note', id: userTopic.id, bvid: BV, text: '这里是通过连续展示不同纸片位置产生运动感。', seconds: 12 })
  assert.equal(note.ok, true)
  const viewed = await f.request('/curiosity')
  assert.equal(viewed.body.finds.length, 1)
  assert.equal(viewed.body.finds[0].topicId, userTopic.id)
  assert.match(viewed.body.finds[0].url, new RegExp(BV))
  assert.match(viewed.body.finds[0].url, /t=12/)
  assert.equal(viewed.body.finds[0].text, '这里是通过连续展示不同纸片位置产生运动感。')
  assert.deepEqual(e.state().unrelated, { keep: 73 })
  assert.ok(e.calls.every(row => row.name === 'bili_subtitle'))
  assert.notEqual(readFileSync(e.stateFile, 'utf8'), beforeUnproved)
}))

test('manual state changes use optimistic versions and scoped stale handles cannot read or mutate the board', async () => curiosityHome(async e => {
  const f = await e.addHost()
  const made = await f.request('/curiosity', { action: 'open', question: '想看看不同的定格动画', query: '定格动画' })
  const topic = made.body.items[0]
  const missingVersion = await f.request('/curiosity', { action: 'pause', id: topic.id })
  assert.equal(missingVersion.code, 400)
  const paused = await f.request('/curiosity', { action: 'pause', id: topic.id, version: topic.version })
  assert.equal(paused.body.ok, true)
  assert.equal(paused.body.items.find(row => row.id === topic.id).status, 'paused')
  const beforeStale = readFileSync(e.stateFile, 'utf8')
  const stale = await f.request('/curiosity', { action: 'resume', id: topic.id, version: topic.version })
  assert.equal(stale.code, 409)
  assert.equal(readFileSync(e.stateFile, 'utf8'), beforeStale)
  assert.equal((await f.request('/curiosity', { action: 'resume', id: topic.id, version: paused.body.items[0].version })).body.ok, true)
  const beforeMode = readFileSync(e.stateFile, 'utf8')
  for (const args of [{ action: 'list' }, { action: 'open', question: '普通会话不能开题', bvid: BV }, { action: 'pause', id: topic.id }]) assert.equal((await f.execute(args, f.normal)).reason, 'mode_required')
  await f.select('standard')
  for (const args of [{ action: 'list' }, { action: 'pause', id: topic.id }]) assert.equal((await f.execute(args)).reason, 'mode_required')
  assert.equal(f.prompt(f.fish), '')
  assert.equal(readFileSync(e.stateFile, 'utf8'), beforeMode)
  const crossSite = await f.request('/curiosity', { action: 'open', question: '跨源请求不能创建' }, { origin: 'https://untrusted.invalid' })
  assert.equal(crossSite.code, 403)
}))

test('switching out during subtitle IO never grants late curiosity evidence to a new mode', async () => curiosityHome(async e => {
  const f = await e.addHost()
  let release, entered
  const began = new Promise(resolve => { entered = resolve })
  e.subtitle(async () => { entered(); await new Promise(resolve => { release = resolve }); return { text: '晚到的合成字幕', segments: 1 } })
  const reading = f.read(OTHER)
  const settled = reading.then(value => value, error => ({ error: error.code || error.message }))
  await began
  await f.select('standard')
  release()
  await settled
  await f.select('dafeiyu')
  const result = await f.execute({ action: 'open', question: '晚到的字幕不能算新模式读到', bvid: OTHER })
  assert.equal(result.ok, false)
  assert.equal((await f.request('/curiosity')).body.items.length, 0)
}))

test('a fish-to-standard-to-fish round trip cannot revive an old pending subtitle request or its evidence', async () => curiosityHome(async e => {
  const f = await e.addHost()
  let release, entered
  const began = new Promise(resolve => { entered = resolve })
  e.subtitle(async () => { entered(); await new Promise(resolve => { release = resolve }); return { text: '这是退出前开始读取的旧作用域字幕', segments: 1 } })
  const oldRead = f.read(OTHER)
  const settled = oldRead.then(value => value, error => ({ error: error.code || error.message }))
  await began
  await f.select('standard')
  await f.select('dafeiyu')
  release()
  const result = await settled
  assert.ok(result.error || result.blocked || result.ok === false, 'returning to fish mode must not authorize a request started in the old scope')
  assert.equal(e.state().seenVideos?.[OTHER], undefined, 'a revoked request must not commit global browsing history')
  assert.equal((await f.execute({ action: 'open', question: '旧请求不能给新作用域提供已读证据', bvid: OTHER })).ok, false)
  const user = await f.request('/curiosity', { action: 'open', question: '新作用域留题', query: '纸张动画' })
  assert.equal(user.body.ok, true)
  const topic = user.body.items[0]
  assert.equal((await f.execute({ action: 'note', id: topic.id, bvid: OTHER, text: '不能凭旧请求记新收获' })).ok, false)
  e.subtitle({ text: '现在在新作用域真正读取一份合成字幕', segments: 1 })
  await f.read(OTHER)
  assert.equal((await f.execute({ action: 'note', id: topic.id, bvid: OTHER, text: '新请求实际读到内容后可以记收获' })).ok, true)
}))

test('two host instances merge independent openings under one state lock and preserve damaged boards', async () => curiosityHome(async e => {
  const first = await e.addHost(), second = await e.addHost()
  const a = first.begin('/curiosity', {}), b = second.begin('/curiosity', {})
  const openedA = await a.finish({ action: 'open', question: '纸张动画是怎么制作的', query: '纸张动画制作' })
  const openedB = await b.finish({ action: 'open', question: '老电影的逐格技巧', query: '老电影定格' })
  assert.equal(openedA.body.ok, true)
  assert.equal(openedB.body.ok, true)
  assert.equal((await first.request('/curiosity')).body.items.length, 2)
  assert.deepEqual(e.state().unrelated, { keep: 73 })
  const malformed = { schema: 1, revision: 2, items: 'this-is-not-a-board' }
  writeFileSync(e.stateFile, JSON.stringify({ ...e.state(), curiosity: malformed }))
  const before = readFileSync(e.stateFile, 'utf8')
  assert.equal((await first.request('/curiosity')).body.ok, false)
  assert.match(first.prompt(first.fish), /鲸鱼摸鱼/, 'unreadable optional board cannot erase the whole fish prompt')
  assert.equal((await second.request('/curiosity', { action: 'open', question: '损坏记录不能覆盖' })).body.ok, false)
  assert.equal(readFileSync(e.stateFile, 'utf8'), before)
  writeFileSync(e.stateFile, '{broken-whole-state')
  const broken = readFileSync(e.stateFile, 'utf8')
  assert.equal((await first.request('/curiosity', { action: 'open', question: '坏文件不能覆盖' })).body.ok, false)
  assert.equal(readFileSync(e.stateFile, 'utf8'), broken)
}))

test('exploring a selected curiosity freezes server data into its own goal and never silently resumes another topic', async () => curiosityHome(async e => {
  const f = await e.addHost()
  const first = (await f.request('/curiosity', { action: 'open', question: '定格动画为什么会有独特的节奏', query: '定格动画 帧率 节奏' })).body.items[0]
  await f.read(BV)
  const noted = await f.execute({ action: 'note', id: first.id, bvid: BV, text: '这一条通过逐格调整纸片位置形成运动。', seconds: 12 })
  assert.equal(noted.ok, true)
  const withNote = noted.items.find(row => row.id === first.id)
  const configBefore = readFileSync(join(e.home, 'config.json'), 'utf8')
  const started = await f.request('/pet/start', { mode: 'session', sessionId: f.fish.id, curiosityId: first.id, durationMinutes: 0, tokenBudget: 0, model: '' })
  assert.equal(started.body.ok, true, JSON.stringify(started.body))
  assert.equal(started.body.curiosity.id, first.id)
  assert.equal(started.body.curiosity.noteCount, 1)
  assert.equal(started.body.curiosity.lastFind.bvid, BV)
  const objective = f.goals.get(f.fish).objective
  assert.ok(objective.includes(first.id))
  assert.ok(objective.includes(first.query))
  assert.match(objective, /这一条通过逐格调整纸片位置/)
  const paused = await f.request('/curiosity', { action: 'pause', id: first.id, version: withNote.version })
  assert.equal(paused.body.ok, true)
  assert.equal(f.goals.get(f.fish).objective, objective, 'editing saved interests does not mutate the running goal')
  assert.equal((await f.request('/feiyu', { action: 'stop', sessionId: f.fish.id })).body.ok, true)
  const otherMade = await f.request('/curiosity', { action: 'open', question: '胶片颗粒为什么好看', query: '胶片颗粒' })
  const other = otherMade.body.items.find(row => row.question === '胶片颗粒为什么好看')
  const oldGoal = f.goals.get(f.fish).id
  const refused = await f.request('/pet/start', { mode: 'session', sessionId: f.fish.id, curiosityId: other.id, durationMinutes: 0, tokenBudget: 0, model: '' })
  assert.equal(refused.body.ok, false)
  assert.equal(refused.body.needsGoalSlot, true)
  assert.equal(f.goals.get(f.fish).id, oldGoal)
  assert.equal(f.goals.get(f.fish).phase, 'paused')
  assert.equal(f.goals.get(f.fish).objective, objective)
  assert.equal((await f.request('/feiyu', { action: 'clear', sessionId: f.fish.id })).body.cleared, true)
  const pausedStart = await f.request('/pet/start', { mode: 'session', sessionId: f.fish.id, curiosityId: first.id, durationMinutes: 0, tokenBudget: 0, model: '' })
  assert.equal(pausedStart.body.ok, false, 'server lookup refuses an interest paused after its UI snapshot')
  assert.equal(f.goals.get(f.fish), undefined)
  const secondStart = await f.request('/pet/start', { mode: 'session', sessionId: f.fish.id, curiosityId: other.id, durationMinutes: 0, tokenBudget: 0, model: '' })
  assert.equal(secondStart.body.ok, true)
  assert.ok(f.goals.get(f.fish).objective.includes(other.query))
  assert.equal(readFileSync(join(e.home, 'config.json'), 'utf8'), configBefore, 'local exploration cannot enable any send permission')
  assert.ok(e.calls.every(row => row.name === 'bili_subtitle'))
}))

test('restoring a selected exploration keeps its frozen topic even when the saved board has moved on', async () => curiosityHome(async e => {
  const f = await e.addHost()
  const selected = (await f.request('/curiosity', { action: 'open', question: '最初选定的动画问题', query: '已冻结的动画选题' })).body.items[0]
  await f.read(BV)
  const noted = await f.execute({ action: 'note', id: selected.id, bvid: BV, text: '启动之前已保存的纸片运动理解', seconds: 12 })
  const withNote = noted.item
  const started = await f.request('/pet/start', { mode: 'session', sessionId: f.fish.id, curiosityId: selected.id, model: '', durationMinutes: 0, tokenBudget: 0 })
  assert.equal(started.body.ok, true)
  const frozenSelection = structuredClone(started.body.curiosity)
  const objective = f.goals.get(f.fish).objective
  await f.execute({ action: 'note', id: selected.id, bvid: BV, text: '启动后手帐才新增的理解', seconds: 20 })
  const latest = (await f.request('/curiosity')).body.items.find(row => row.id === selected.id)
  assert.equal((await f.request('/curiosity', { action: 'pause', id: selected.id, version: latest.version })).body.ok, true)
  const another = (await f.request('/curiosity', { action: 'open', question: '后来惦记的胶片问题', query: '另一个仍活跃的选题' })).body.item
  assert.equal(another.status, 'active')
  assert.ok(!f.prompt(f.fish).includes(another.query))
  const restored = await f.reload()
  const restoredPrompt = restored.prompt(restored.fish)
  assert.equal(f.goals.get(f.fish).objective, objective)
  assert.equal(restored.goals.get(restored.fish).objective, objective)
  assert.ok(!restoredPrompt.includes(another.query), 'an adopted selected run must not add a different generic interest')
  const saved = JSON.parse(readFileSync(join(e.home, 'feiyu.json'), 'utf8')).sessions.find(row => row.event === 'start')
  assert.deepEqual(saved.curiosity, frozenSelection)
  assert.equal(saved.curiosity.lastFind.text, '启动之前已保存的纸片运动理解')
  assert.equal(saved.curiosity.noteCount, 1)
  assert.equal(saved.curiosity.version, withNote.version)
  assert.ok(objective.includes(saved.curiosity.lastFind.text))
  assert.ok(!objective.includes('启动后手帐才新增的理解'))
  assert.equal((await restored.request('/feiyu')).body.active, true)
}))

test('legacy runs without a saved curiosity field still adopt and retain optional current interests', async () => curiosityHome(async e => {
  const f = await e.addHost()
  const topic = (await f.request('/curiosity', { action: 'open', question: '旧任务可选的当前线索', query: '旧任务可选关键词' })).body.item
  const started = await f.request('/pet/start', { mode: 'session', sessionId: f.fish.id, model: '', durationMinutes: 0, tokenBudget: 0 })
  assert.equal(started.body.ok, true)
  assert.equal(Object.hasOwn(started.body, 'curiosity'), false)
  const savedBefore = JSON.parse(readFileSync(join(e.home, 'feiyu.json'), 'utf8')).sessions.find(row => row.event === 'start')
  assert.equal(Object.hasOwn(savedBefore, 'curiosity'), false)
  const restored = await f.reload()
  assert.equal((await restored.request('/feiyu')).body.active, true)
  assert.ok(restored.prompt(restored.fish).includes(topic.query))
  const savedAfter = JSON.parse(readFileSync(join(e.home, 'feiyu.json'), 'utf8')).sessions.find(row => row.event === 'start')
  assert.equal(Object.hasOwn(savedAfter, 'curiosity'), false, 'restoring an old run cannot invent a selected topic')
}))
