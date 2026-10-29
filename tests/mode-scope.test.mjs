import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'
import { resolveSessionPreset, personaScope } from '../lib/mode.mjs'
import { soulTemplate, soulSetSection } from '../lib/persona.mjs'
import { learnAdd, learnDecide } from '../lib/learn.mjs'
import { McpClient } from '../lib/mcp.mjs'

const immediate = () => new Promise(resolve => setImmediate(resolve))
const fishGoal = id => ({ id: 'goal-' + id, objective: '🐟 鲸鱼摸鱼模式：isolated fixture', phase: 'active', activation: 'armed', revision: 1, roundsStarted: 1, maxGoalRounds: 4 })

async function fixture({ scoped = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fish-mode-scope-')), home = join(root, 'bili-duty')
  mkdirSync(home)
  writeFileSync(join(home, 'config.json'), JSON.stringify({ persona: 'PERSONA_SCOPE_SENTINEL', learnAutoReview: false,
    reportLevel: 'off', pvAuto: false, autoReplyDm: true, dmReplyFollowedOnly: false, autoComment: true }))
  const learned = learnAdd({}, { text: 'LEARNING_SCOPE_SENTINEL 先理解细节，再判断表达。', from: 'fixture' })
  const approved = learnDecide(learned.ledger, learned.id, 'approve', 'fixture human approval')
  writeFileSync(join(home, 'state.json'), JSON.stringify({ learn: approved.ledger }))
  writeFileSync(join(home, 'soul.md'), soulSetSection(soulTemplate(), 'mood', '- SOUL_SCOPE_SENTINEL 好奇但不必每次开口。'))
  const agents = [], presets = new Map(), goals = new Map(), events = new Map(), sections = new Map(), cleanups = [], changes = [], calls = []
  let http, rootRegistrations = 0, reply = () => ({ success: true })
  const ctx = {
    logger: { info() {} }, settings: { describe: () => [] },
    get(key) {
      if (key === 'dshHomePath') return (...parts) => join(root, ...parts)
      if (key === 'agents') return { list: () => agents, get: id => agents.find(agent => agent.id === id) }
      if (key === 'sessionProjections') return { stateOf: (session, name) => name === 'agentPreset' ? presets.get(session.id) : undefined }
      if (key === 'goals') return goalService
      if (key === 'systemPrompt') return { getSectionOrder: () => 600, section(spec) { sections.set(spec.name, spec); return () => sections.delete(spec.name) } }
    },
    tools: { register() { rootRegistrations++; throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } },
    on(name, fn) { const list = events.get(name) || []; list.push(fn); events.set(name, list); return () => events.set(name, list.filter(item => item !== fn)) },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup },
    webServer: { register(route) { http = route.handler; return { dispose() {} } } },
  }
  const goalService = {
    get: agent => goals.get(agent.id),
    pause(agent, ref) { const goal = goals.get(agent.id); assert.deepEqual(ref, { id: goal.id, revision: goal.revision }); changes.push({ action: 'pause', agent: agent.id }); Object.assign(goal, { phase: 'paused', activation: 'disarmed', revision: goal.revision + 1 }); return goal },
    create(agent, spec) { changes.push({ action: 'create', agent: agent.id }); const goal = { ...fishGoal(agent.id), objective: spec.objective }; goals.set(agent.id, goal); return goal },
    resume(agent) { changes.push({ action: 'resume', agent: agent.id }); const goal = goals.get(agent.id); Object.assign(goal, { phase: 'active', activation: 'armed' }); return goal },
    clear(agent) { changes.push({ action: 'clear', agent: agent.id }); goals.delete(agent.id) },
  }
  const original = McpClient.prototype.call
  McpClient.prototype.call = async function(name, args) { calls.push({ name, args }); return reply(name, args) }
  const emit = async (name, ...args) => { for (const fn of [...(events.get(name) || [])]) await fn(...args); await immediate() }
  const add = async (id, preset, goal) => {
    const tools = new Map()
    const agent = { id, status: 'idle', session: { id, header: preset === undefined ? {} : { agentPreset: preset }, log: [] },
      ctx: scoped ? { tools: { register(spec) { tools.set(spec.name, spec); return () => { if (tools.get(spec.name) === spec) tools.delete(spec.name) } } } } : undefined, tools,
      cancel() {} }
    agents.push(agent); presets.set(id, preset); if (goal) goals.set(id, goal)
    await emit('agent/created', { agent })
    return agent
  }
  const select = async (agent, preset) => {
    presets.set(agent.id, preset)
    agent.session.log.push({ type: 'agent-preset/selected', data: { agentPreset: preset } })
    await emit('agent-preset/selected', agent.id, preset)
  }
  const request = async (path, body) => {
    const req = new EventEmitter(); Object.assign(req, { url: '/api/bili-duty' + path, method: body === undefined ? 'GET' : 'POST', headers: {}, destroy() {} })
    const res = { writeHead(code) { this.code = code }, end(text) { this.body = JSON.parse(text) } }
    const pending = http(req, res); if (body !== undefined) { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }; await pending; return res.body
  }
  apply(ctx, {}); await immediate()
  return { ctx, add, select, emit, request, events, goals, changes, calls, presets,
    prompt: agent => String(sections.get('bili:dafeiyu')?.text({ agent }) || ''),
    setReply(value) { reply = value },
    rootRegistrations: () => rootRegistrations,
    async close() { for (const cleanup of cleanups.reverse()) try { await cleanup() } catch {}; McpClient.prototype.call = original; rmSync(root, { recursive: true, force: true }) },
  }
}

test('role tools are physically scoped, switch out disposes only that session, and stale tool handles fail closed', async () => {
  const f = await fixture()
  try {
    const fishA = await f.add('fish-A', 'dafeiyu'), fishB = await f.add('fish-B', 'dafeiyu'), normal = await f.add('normal', 'standard')
    assert.equal(f.rootRegistrations(), 0); assert.ok(fishA.tools.size >= 38); assert.equal(normal.tools.size, 0)
    const stale = fishA.tools.get('bili_search'), staleMemory = fishA.tools.get('bili_soul')
    assert.match(f.prompt(fishA), /PERSONA_SCOPE_SENTINEL/); assert.match(f.prompt(fishA), /SOUL_SCOPE_SENTINEL/); assert.match(f.prompt(fishA), /LEARNING_SCOPE_SENTINEL/)
    assert.equal(f.prompt(normal), '')
    assert.equal((await stale.execute({ keyword: 'wrong context' }, { agent: normal, role: 'background' })).reason, 'mode_required')
    await f.select(fishA, 'standard')
    assert.equal(fishA.tools.size, 0); assert.ok(fishB.tools.size >= 38); assert.equal(f.prompt(fishA), '')
    assert.equal((await stale.execute({ keyword: 'after exit' }, { agent: fishA })).reason, 'mode_required')
    assert.equal((await staleMemory.execute({ action: 'read' }, { agent: fishA })).reason, 'mode_required')
    assert.equal((await stale.execute({}, {})).reason, 'mode_required'); assert.deepEqual(f.calls, [])
    await f.select(fishA, 'dafeiyu'); assert.ok(fishA.tools.size >= 38); assert.deepEqual(f.changes, [])
  } finally { await f.close() }
})

test('unknown selection and stale fish goals cannot enable identity or tools; other goals stay untouched', async () => {
  const f = await fixture()
  try {
    const unknown = await f.add('unknown', undefined, fishGoal('unknown'))
    const normalGoal = { ...fishGoal('ordinary-work'), objective: 'Fix the unrelated project' }
    const ordinary = await f.add('ordinary-work', 'standard', normalGoal)
    assert.equal(unknown.tools.size, 0); assert.equal(f.prompt(unknown), '')
    assert.equal(f.goals.get(unknown.id).phase, 'paused')
    assert.equal(f.goals.get(ordinary.id).phase, 'active')
    assert.deepEqual(f.changes, [{ action: 'pause', agent: unknown.id }])
    f.goals.set(ordinary.id, fishGoal(ordinary.id))
    const middleware = f.events.get('agent/pre-step')
    assert.equal(middleware.length, 1)
    const result = await middleware[0]({ agent: ordinary }, () => ({ kind: 'enter' }))
    assert.equal(result.kind, 'enter'); assert.equal(f.goals.get(ordinary.id).phase, 'paused')
    assert.equal(f.prompt(ordinary), '')
  } finally { await f.close() }
})

test('mode exit during an awaited read fences later sends without touching another active fish goal', async () => {
  const f = await fixture()
  try {
    const fish = await f.add('pending-dm', 'dafeiyu'), other = await f.add('other-fish', 'dafeiyu', fishGoal('other-fish'))
    let release, entered
    const began = new Promise(resolve => { entered = resolve })
    f.setReply(async name => {
      if (name === 'bili_dm_list') { entered(); await new Promise(resolve => { release = resolve }); return { items: [{ uid: '123', msg_seqno: '456', is_follow: true, days_ago: 0 }] } }
      return { success: true }
    })
    const call = fish.tools.get('bili_dm_reply').execute({ uid: '123', msg_seqno: '456', text: '倒影那段确实有意思。' }, { agent: fish })
    const settled = call.then(value => value, error => ({ code: error.code }))
    await began; await f.select(fish, null); release()
    assert.equal((await settled).code, 'MODE_REQUIRED')
    assert.equal(f.calls.filter(item => item.name === 'bili_send_message').length, 0)
    assert.equal(f.goals.get(other.id).phase, 'active'); assert.equal(f.prompt(fish), '')
  } finally { await f.close() }
})

test('a host without verified agent scopes gets an explicit capability error and no global tool schemas', async () => {
  const f = await fixture({ scoped: false })
  try {
    await f.add('old-host', 'dafeiyu')
    const status = await f.request('/status')
    assert.equal(status.toolScope.checked, true); assert.equal(status.toolScope.supported, false)
    assert.equal(status.toolScope.globalFallback, false); assert.match(status.toolScope.error, /agent.ctx.tools/)
    assert.equal(f.rootRegistrations(), 0)
    const start = await f.request('/pet/start', { mode: 'session', sessionId: 'old-host' })
    assert.equal(start.scope_unavailable, true); assert.deepEqual(f.changes, [])
    assert.equal((await f.request('/config', { idleChatter: false })).ok, true, 'manual HTTP settings remain available')
  } finally { await f.close() }
})

test('preset resolution uses the exact agent context and never a global default, arbitrary field or malformed authority', () => {
  const agentCtx = {}, agent = { ctx: agentCtx, session: { header: { agentPreset: 'dafeiyu' } } }
  const queried = []
  const ctx = { get: key => key === 'agentPresets' ? { composedPreset(value) { queried.push(value); return null } } : undefined }
  assert.equal(resolveSessionPreset(ctx, agent).id, ''); assert.deepEqual(queried, [agentCtx])
  queried.length = 0
  assert.equal(resolveSessionPreset(ctx, { agentPreset: 'dafeiyu' }).known, false); assert.deepEqual(queried, [])
  const malformed = resolveSessionPreset({ get: key => key === 'sessionProjections' ? { stateOf: () => ({ id: 'dafeiyu' }) } : undefined }, agent)
  assert.equal(malformed.id, ''); assert.equal(malformed.malformed, true)
  assert.equal(personaScope({ id: '', known: false }, fishGoal('unknown')).enabled, false)
})
