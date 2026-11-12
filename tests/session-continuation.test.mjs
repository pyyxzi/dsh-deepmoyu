import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, openSync, readSync, closeSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { isDeepStrictEqual } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'
import { McpClient } from '../lib/mcp.mjs'
import { MAX_CONSECUTIVE_TRUNCATIONS, sessionContinuationDecision } from '../lib/session-continuation.mjs'

const { discoverHostArchive } = createRequire(import.meta.url)('../scripts/qa/host-archive.cjs')
const HOST_ARCHIVE = discoverHostArchive()
const immediate = () => new Promise(resolve => setImmediate(resolve))
const settle = async () => { for (let i = 0; i < 8; i++) await immediate() }
const input = (patch = {}) => ({
  goal: { id: 'goal-owned', phase: 'active', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 64 },
  run: { goalId: 'goal-owned', stoppedAt: 0, deadlineAt: 2_000, tokenBudget: 100, tokensUsed: 20,
    totalTokenBudget: 1000, totalTokensUsed: 30 },
  selected: true, endReason: 'max-tokens', turnId: 1, madeProgress: true, now: 1000, ...patch,
})

test('truncation recovery is bounded, turn-idempotent, and resets only with observed progress', () => {
  assert.equal(MAX_CONSECUTIVE_TRUNCATIONS, 2)
  const first = sessionContinuationDecision(input())
  assert.equal(first.recover, true)
  const duplicate = sessionContinuationDecision(input({ state: first.state }))
  assert.equal(duplicate.reason, 'already-handled')
  assert.equal(duplicate.recover, false)
  const second = sessionContinuationDecision(input({ turnId: 2, state: first.state }))
  assert.equal(second.recover, true)
  const third = sessionContinuationDecision(input({ turnId: 3, state: second.state }))
  assert.equal(third.reason, 'truncation-limit')
  assert.equal(third.recover, false)
  const progress = sessionContinuationDecision(input({ turnId: 4, state: third.state, madeProgress: true }))
  assert.equal(progress.recover, false, 'progress in another truncated turn cannot defeat the consecutive-truncation fuse')
  const completed = sessionContinuationDecision(input({ turnId: 5, state: progress.state, madeProgress: true, endReason: 'completed' }))
  assert.equal(completed.recover, false)
  assert.equal(completed.state.consecutiveTruncations, 0)
  assert.equal(sessionContinuationDecision(input({ turnId: 6, state: completed.state })).recover, true)
})

test('recovery never overrides interruption, ownership, limits, unknown usage, or non-truncation outcomes', () => {
  const base = input()
  const cases = [
    [{ selected: false }, 'mode-exit'], [{ intervened: true }, 'interrupted'],
    [{ madeProgress: false }, 'no-progress'],
    [{ run: { ...base.run, stoppedAt: 1 } }, 'interrupted'],
    [{ run: { ...base.run, goalId: 'someone-else' } }, 'goal-not-owned'],
    [{ goal: { ...base.goal, phase: 'paused' } }, 'goal-not-disarmed'],
    [{ goal: { ...base.goal, activation: 'armed' } }, 'goal-not-disarmed'],
    [{ goal: { ...base.goal, roundsStarted: 64 } }, 'round-limit'],
    [{ now: 2000 }, 'time-limit'], [{ run: { ...base.run, tokensUsed: 100 } }, 'token-budget'],
    [{ run: { ...base.run, totalTokensUsed: 1000 } }, 'total-budget'],
    [{ run: { ...base.run, tokensUsed: null } }, 'usage-unknown'],
    [{ run: { ...base.run, totalTokensUsed: undefined } }, 'usage-unknown'],
    [{ run: { ...base.run, tokenBudget: NaN } }, 'budget-invalid'],
    [{ endReason: 'aborted' }, 'turn-not-truncated'], [{ endReason: 'error' }, 'turn-not-truncated'],
    [{ turnId: undefined }, 'turn-unknown'],
  ]
  for (const [patch, reason] of cases) {
    const decision = sessionContinuationDecision(input(patch))
    assert.equal(decision.recover, false, reason)
    assert.equal(decision.reason, reason)
  }
  assert.equal(sessionContinuationDecision(input({ run: { goalId: base.goal.id, deadlineAt: 0, tokenBudget: 0, totalTokenBudget: 0 } })).recover, true)
})

function installedDriver(archive) {
  const fd = openSync(archive, 'r')
  try {
    const prefix = Buffer.alloc(16); readSync(fd, prefix, 0, 16, 0)
    const bytes = Buffer.alloc(prefix.readUInt32LE(12)); readSync(fd, bytes, 0, bytes.length, 16)
    let entry = JSON.parse(bytes)
    for (const part of 'node_modules/@deepseek-ai/dsh-goal-round-driver/lib/index.js'.split('/')) entry = entry.files[part]
    assert.equal(entry.unpacked, undefined)
    const code = Buffer.alloc(entry.size); readSync(fd, code, 0, code.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset))
    const source = code.toString().replace(/^import .*;\r?\n/gm, '').replace(/^export \{[^\n]*\};?\s*$/m, '')
    let nextId = 0
    return new Function('isDeepStrictEqual', 'createUserMessage', source + '\nreturn { apply };')(
      isDeepStrictEqual, spec => ({ id: 'offline-round-' + ++nextId, ...spec }))
  } finally { closeSync(fd) }
}

async function withHostDriver(testFn, { driverFirst = false, config = {}, run = {} } = {}) {
  const archive = HOST_ARCHIVE
  if (!archive) return false
  const directory = mkdtempSync(join(tmpdir(), 'fish-session-continuation-')), home = join(directory, 'bili-duty')
  mkdirSync(home)
  const cli = join(directory, 'offline-cli.js'); writeFileSync(cli, '// never executed')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ idleChatter: false, learnAutoReview: false, pvAuto: false,
    dshBin: cli, backgroundModelId: 'fixture/model', backgroundMinutes: 1,
    sessionTokenBudget: 0, totalTokenBudget: 0, sessionMinutes: 0, sessionModelId: '', sessionMaxRounds: 64,
    reportLevel: 'off', autoComment: false, autoMoment: false, autoReplyDm: false, replyToComments: false, ...config }))
  const events = new Map(), agents = new Map(), goalsByAgent = new Map(), cleanups = [], queued = [], mutations = [], warnings = []
  const tokenTotals = { inputTokens: 0, outputTokens: 0 }
  const cp = createRequire(import.meta.url)('node:child_process')
  const original = { call: McpClient.prototype.call, spawn: cp.spawn, setTimeout, clearTimeout }
  const children = []
  cp.spawn = (command, args, options) => {
    assert.ok(options?.env?.BILI_DUTY_RELAY_CAPABILITY, 'the only allowed spawn is an isolated background child')
    const child = new EventEmitter()
    Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, kill: () => true })
    children.push(child); return child
  }
  syncBuiltinESMExports()
  const retryTimers = []
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms !== 350) return original.setTimeout(fn, ms, ...args)
    const timer = { fn, cancelled: false, unref() {}, fire() { if (!this.cancelled) fn() } }
    retryTimers.push(timer); return timer
  }
  globalThis.clearTimeout = timer => { if (retryTimers.includes(timer)) timer.cancelled = true; else original.clearTimeout(timer) }
  let videoSequence = 0, goalSequence = 0, turnSequence = 0
  McpClient.prototype.call = async name => {
    if (name === 'bili_guard_status') return { ok: true, seenVideos: {} }
    if (name === 'bili_search') return { videos: [{ bvid: 'BV' + String(++videoSequence).padStart(10, '0'), title: '离线测试视频',
      duration: 600, pubdate: Math.floor(Date.now() / 1000), play: 100_000 }] }
    throw new Error('UNEXPECTED_ACCOUNT_TRANSPORT: ' + name)
  }
  const emit = (name, ...args) => { for (const fn of [...(events.get(name) || [])]) fn(...args) }
  let requestHandler
  const registry = { list: () => [...agents.values()], get: id => agents.get(id), currentInitiator: () => undefined, withoutInitiator: fn => fn() }
  const mutate = (agent, operation, patch) => {
    const previous = goalsByAgent.get(agent)
    const goal = { ...previous, ...patch, revision: (previous?.revision || 0) + 1 }
    goalsByAgent.set(agent, goal); mutations.push(operation)
    emit('goal/changed', { agent, change: { operation, goal } }); return { ...goal }
  }
  const goals = {
    get: agent => { const goal = goalsByAgent.get(agent); return goal ? { ...goal } : undefined },
    create: (agent, spec) => mutate(agent, 'create', { ...spec, id: 'goal-owned-' + ++goalSequence, phase: 'active', activation: 'armed', roundsStarted: 0 }),
    pause: (agent, ref) => { assert.equal(ref.revision, goals.get(agent).revision); return mutate(agent, 'pause', { phase: 'paused', activation: 'disarmed' }) },
    resume: (agent, ref) => { assert.equal(ref.revision, goals.get(agent).revision); return mutate(agent, 'resume', { phase: 'active', activation: 'armed' }) },
    block: (agent, ref, blockedReason) => mutate(agent, 'block', { phase: 'blocked', activation: 'disarmed', blockedReason }),
    disarm(agent) { const goal = goalsByAgent.get(agent); if (goal) { goal.activation = 'disarmed'; mutations.push('disarm') }; return goals.get(agent) },
    clear(agent, ref) { assert.equal(ref.revision, goals.get(agent).revision); const goal = goals.get(agent); goalsByAgent.delete(agent); return goal },
  }
  const ctx = { fiber: { state: 2 }, agents: registry, goals, sessions: { flush: async () => {} },
    logger: { info() {}, warn(text) { warnings.push(String(text)) } }, settings: { describe: () => [] },
    get(key) { return key === 'agents' ? registry : key === 'goals' ? goals : key === 'dshHomePath' ? (...parts) => join(directory, ...parts)
      : key === 'sessionProjections' && config.measuredUsage === true ? { stateOf: (session, field) => field === 'tokenUsage' ? { totals: tokenTotals } : undefined }
      : key === 'llm' ? { listProviders: () => [{ id: 'fixture' }] } : undefined },
    on(name, fn) { const handlers = events.get(name) || []; handlers.push(fn); events.set(name, handlers); return () => events.set(name, handlers.filter(item => item !== fn)) },
    effect(fn) { const value = fn(); if (typeof value === 'function') cleanups.push(value); else if (value?.next) { const row = value.next(); if (typeof row.value === 'function') cleanups.push(row.value) } },
    tools: { register() { throw new Error('GLOBAL_TOOLS_FORBIDDEN') } },
    webServer: { register(route) { requestHandler = route.handler; return { dispose() {} } } },
  }
  if (driverFirst) installedDriver(archive).apply(ctx)
  apply(ctx, {})
  if (!driverFirst) installedDriver(archive).apply(ctx)
  const tools = new Map()
  const session = { id: 'continuation-agent', header: { agentPreset: 'dafeiyu', cwd: directory }, log: [], append(type, data) {
    const event = { type, data }; this.log.push(event)
    if (type === 'user/message' && data.source?.kind === 'goal') goalsByAgent.get(agent).roundsStarted = data.source.round
    emit('session/event', this, event); return event
  } }
  const agent = { id: session.id, session, status: 'idle', ctx: { tools: { register(spec) { tools.set(spec.name, spec); return () => tools.delete(spec.name) } } },
    inbox: { nextStep: [], nextTurn: [], remove(id) { this.nextTurn = this.nextTurn.filter(row => row.id !== id) }, prepend(target, message) { this.nextStep.unshift(message) } },
    followup(message) { queued.push(message); this.inbox.nextTurn.push(message); this.status = 'running'; emit('agent/inbox/inserted', { agent: this, message }); emit('agent/status', { agent: this, status: 'running' }) },
    cancel() { this.status = 'idle' }, whenIdle: async () => {},
  }
  agents.set(agent.id, agent); emit('agent/created', { agent }); await settle()
  const request = async (path, body) => {
    const { EventEmitter } = await import('node:events')
    const req = new EventEmitter(); Object.assign(req, { url: '/api/bili-duty' + path, method: body === undefined ? 'GET' : 'POST', headers: {}, destroy() {} })
    const res = { writeHead(code) { this.code = code }, end(text) { this.body = JSON.parse(text) } }
    const pending = requestHandler(req, res); if (body !== undefined) { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }; await pending
    assert.equal(res.code, 200); return res.body
  }
  const admit = async () => {
    const message = agent.inbox.nextTurn.shift(); assert.ok(message, 'a real driver round must be queued')
    emit('agent/inbox/claimed', { agent, message })
    const handlers = events.get('agent/pre-step') || []
    const context = { agent, messages: [message], signal: new AbortController().signal }
    const dispatch = index => index < handlers.length ? handlers[index](context, () => dispatch(index + 1)) : Promise.resolve({ kind: 'enter', messages: [message] })
    const decision = await dispatch(0); assert.equal(decision.kind, 'enter')
    session.append('turn/start', { turn: ++turnSequence })
    session.append('user/message', message)
    return message
  }
  const finish = async kind => {
    if (kind === 'error') emit('agent/error', { agent, error: new Error('offline failure') })
    session.append('turn/end', { turn: turnSequence, reason: { kind } })
    agent.status = 'idle'; emit('agent/status', { agent, status: 'idle' }); await settle()
  }
  const work = async () => { const value = await tools.get('bili_search').execute({ keyword: '离线测试' }, { agent }); assert.ok(value.fresh?.length, JSON.stringify(value)); return value }
  const retry = async () => { retryTimers.at(-1)?.fire(); await settle() }
  try {
    const started = await request('/pet/start', { mode: 'session', sessionId: agent.id, durationMinutes: 0, tokenBudget: 0, maxRounds: 64, model: '', ...run })
    assert.equal(started.ok, true, JSON.stringify(started)); await settle()
    await testFn({ agent, goals, queued, mutations, warnings, admit, finish, request, settle, work, retry, retryTimers, emit, agents, goalsByAgent,
      home, tokenTotals, children, status: async () => (await request('/status')).feiyu })
  } finally {
    ctx.fiber.state = 5
    for (const child of children) child.exitCode = 0
    for (const cleanup of cleanups.reverse()) { try { await cleanup() } catch {} }
    McpClient.prototype.call = original.call; cp.spawn = original.spawn; syncBuiltinESMExports()
    globalThis.setTimeout = original.setTimeout; globalThis.clearTimeout = original.clearTimeout
    await settle(); rmSync(directory, { recursive: true, force: true })
  }
  return true
}

test('actual wrapper work resumes a truncated host round in either listener order, with a two-truncation fuse', async t => {
  for (const driverFirst of [false, true]) {
    const ran = await withHostDriver(async ({ agent, goals, queued, mutations, admit, finish, work, retry, status }) => {
      assert.equal(queued.length, 1)
      await admit(); await work(); await finish('completed')
      assert.equal(queued.length, 2, 'ordinary completion queues the next goal round')
      for (let index = 0; index < 3; index++) {
        await admit(); await work(); await finish('max-tokens')
        assert.equal(goals.get(agent).activation, 'disarmed')
        assert.equal((await status()).continuation.state, 'waiting-retry')
        await retry()
        if (index < 2) {
          assert.equal(goals.get(agent).activation, 'armed')
          assert.equal(queued.length, index + 3)
        } else {
          const ended = await status()
          assert.equal(ended.continuation.state, 'needs-attention')
          assert.equal(ended.continuation.reason, 'truncation-limit')
          assert.equal(queued.length, 4)
        }
      }
      assert.equal(mutations.filter(name => name === 'resume').length, 2)
    }, { driverFirst })
    if (!ran) { t.skip('installed DSH archive unavailable; pure policy still ran'); break }
  }
})

test('no work, errors and aborts never produce automatic host resumes', async t => {
  for (const kind of ['max-tokens', 'error', 'aborted']) {
    const ran = await withHostDriver(async ({ goals, agent, queued, mutations, admit, finish, work, retry, status }) => {
      await admit(); if (kind !== 'max-tokens') await work()
      await finish(kind); await retry()
      assert.equal(mutations.filter(name => name === 'resume').length, 0, kind)
      assert.equal(queued.length, 1)
      const ended = await status()
      assert.equal(ended.continuation.state, 'needs-attention')
      assert.equal(ended.continuation.reason, kind === 'max-tokens' ? 'no-progress' : kind)
      if (kind === 'max-tokens') assert.equal(goals.get(agent).activation, 'disarmed')
    })
    if (!ran) { t.skip('installed DSH archive unavailable'); break }
  }
})

test('manual stop, preset exit and user intervention invalidate the queued recovery', async t => {
  for (const intervention of ['stop', 'mode-exit', 'user']) {
    const ran = await withHostDriver(async ({ agent, goals, queued, mutations, admit, finish, work, retry, retryTimers, request, emit, status }) => {
      await admit(); await work(); await finish('max-tokens')
      const staleTimer = retryTimers.at(-1)
      if (intervention === 'stop') await request('/feiyu', { action: 'stop', sessionId: agent.id })
      else if (intervention === 'mode-exit') {
        agent.session.header.agentPreset = 'standard'
        agent.session.log.push({ type: 'agent-preset/selected', data: { agentPreset: 'standard' } })
        emit('agent-preset/selected', agent.id, 'standard')
      } else {
        const message = { id: 'human-message', source: { kind: 'user' }, content: [{ type: 'text', text: '先等等' }] }
        agent.inbox.nextTurn.push(message); emit('agent/inbox/inserted', { agent, message })
      }
      await retry(); staleTimer.fn(); await settle()
      assert.equal(mutations.filter(name => name === 'resume').length, 0, intervention)
      assert.equal(queued.length, 1)
      if (intervention === 'user') assert.equal((await status()).continuation.reason, 'user-intervened')
      else assert.equal(goals.get(agent).activation, 'disarmed')
    })
    if (!ran) { t.skip('installed DSH archive unavailable'); break }
  }
})

test('saved limits and exact lifecycle checks block queued recovery without touching a replacement', async t => {
  for (const condition of ['budget', 'total-budget', 'round-limit', 'new-goal', 'new-session', 'new-revision']) {
    const ran = await withHostDriver(async ({ agent, goals, goalsByAgent, queued, mutations, admit, finish, work, retryTimers, retry, request, home, agents, status }) => {
      await admit(); await work(); await finish('max-tokens')
      const staleTimer = retryTimers.at(-1), oldGoal = goals.get(agent)
      if (condition === 'budget') await request('/config', { totalTokenBudget: 1 })
      if (condition === 'total-budget') {
        const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')); state.tokensTotal = 5
        writeFileSync(join(home, 'state.json'), JSON.stringify(state)); await request('/config', { totalTokenBudget: 5 })
      }
      if (condition === 'round-limit') {
        const current = goalsByAgent.get(agent); current.roundsStarted = current.maxGoalRounds
      }
      if (condition === 'new-goal') {
        await request('/feiyu', { action: 'clear', sessionId: agent.id })
        const started = await request('/pet/start', { mode: 'session', sessionId: agent.id, durationMinutes: 0, tokenBudget: 0, maxRounds: 64, model: '' })
        assert.equal(started.ok, true); assert.notEqual(started.goalId, oldGoal.id)
      }
      if (condition === 'new-session') agents.set(agent.id, { ...agent, session: { ...agent.session, log: [] } })
      if (condition === 'new-revision') goalsByAgent.get(agent).revision++
      await retry(); staleTimer.fn(); await settle()
      assert.equal(mutations.filter(name => name === 'resume').length, 0, condition)
      if (condition === 'new-goal') assert.equal(queued.length, 2)
      else assert.equal(queued.length, 1)
      if (condition === 'budget') assert.equal((await status()).continuation.reason, 'usage-unknown')
      if (condition === 'total-budget') assert.equal((await status()).continuation.reason, 'total-budget')
      if (condition === 'round-limit') assert.equal((await status()).continuation.reason, 'round-limit')
    })
    if (!ran) { t.skip('installed DSH archive unavailable'); break }
  }
})

test('wall-clock expiry and measured run budget still stop a queued truncation retry', async t => {
  for (const condition of ['deadline', 'run-budget']) {
    const ran = await withHostDriver(async ({ agent, queued, mutations, admit, work, finish, retry, tokenTotals, request, status }) => {
      await admit(); await work()
      if (condition === 'run-budget') tokenTotals.inputTokens = 100
      const realNow = Date.now
      try {
        if (condition === 'deadline') {
          const state = await status()
          Date.now = () => state.deadlineAt + 1
        }
        await finish('max-tokens'); await retry()
        assert.equal(mutations.filter(name => name === 'resume').length, 0, condition)
        assert.equal(queued.length, 1)
        const state = await status()
        if (condition === 'deadline') assert.equal(state.continuation.reason, 'time-limit')
        else assert.equal(state.stopReason, 'token-budget')
        await request('/feiyu', { action: 'stop', sessionId: agent.id })
      } finally { Date.now = realNow }
    }, { config: { measuredUsage: condition === 'run-budget' }, run: { durationMinutes: condition === 'deadline' ? 1 : 0, tokenBudget: condition === 'run-budget' ? 100 : 0 } })
    if (!ran) { t.skip('installed DSH archive unavailable'); break }
  }
})

test('a queued max-token continuation owns the session lane before a background launch can spawn', async t => {
  for (const driverFirst of [false, true]) {
    const ran = await withHostDriver(async ({ agent, goals, admit, work, finish, request, children, retry, mutations, status }) => {
      await admit(); await work(); await finish('max-tokens')
      assert.equal(goals.get(agent).activation, 'disarmed')
      assert.equal((await status()).continuation.state, 'waiting-retry')
      const launched = await request('/pet/start', { mode: 'background', model: 'fixture/model', durationMinutes: 1 })
      assert.equal(launched.started, false)
      assert.equal(launched.busy, 'session')
      assert.equal(children.length, 0, 'queued session continuation prevents any background process')
      await retry()
      assert.equal(mutations.filter(name => name === 'resume').length, 1)
      assert.equal(goals.get(agent).activation, 'armed')
    }, { driverFirst })
    if (!ran) { t.skip('installed DSH archive unavailable'); break }
  }
})

test('settled no-progress and error outcomes release the lane for an explicitly requested background run', async t => {
  for (const reason of ['max-tokens', 'error']) {
    const ran = await withHostDriver(async ({ admit, finish, retry, status, request, children, mutations }) => {
      await admit(); await finish(reason); await retry()
      assert.equal((await status()).continuation.state, 'needs-attention')
      const launched = await request('/pet/start', { mode: 'background', model: 'fixture/model', durationMinutes: 1 })
      assert.equal(launched.started, true, JSON.stringify(launched))
      assert.equal(children.length, 1, 'a settled failure does not reserve the lane forever')
      assert.equal(mutations.filter(name => name === 'resume').length, 0)
      await request('/pet/stop', {})
    })
    if (!ran) { t.skip('installed DSH archive unavailable'); break }
  }
})

test('a background that already acquired the lane is not disturbed by an old session retry', async t => {
  const ran = await withHostDriver(async ({ agent, goalsByAgent, admit, work, finish, request, children, retry, status, mutations }) => {
    await admit(); await work(); await finish('max-tokens')
    const current = goalsByAgent.get(agent)
    // Simulate another owner acquiring the lane after the old reservation became invalid.
    current.revision++
    const launched = await request('/pet/start', { mode: 'background', model: 'fixture/model', durationMinutes: 1 })
    assert.equal(launched.started, true, JSON.stringify(launched))
    current.revision--
    await retry()
    const ended = await status()
    assert.equal(ended.continuation.state, 'needs-attention')
    assert.match(ended.continuation.reason, /后台.*未自动恢复/)
    assert.equal(mutations.filter(name => name === 'resume').length, 0)
    assert.equal(children.length, 1)
    assert.equal(children[0].exitCode, null, 'the new background child remains untouched')
    await request('/pet/stop', {})
  })
  if (!ran) t.skip('installed DSH archive unavailable')
})
