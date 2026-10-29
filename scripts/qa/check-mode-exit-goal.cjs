/** Offline integration: plugin mode-exit hook + actual installed host goal-round driver.
 * Every goal/agent is fake; files live only in one owned mkdtemp directory.
 * Run: node devtools/check-mode-exit-goal.cjs
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { isDeepStrictEqual } = require('node:util')
const archiveFS = (() => { try { return require('original-fs') } catch { return fs } })()

const ROOT = path.resolve(__dirname, '..', '..')
const PLUGIN = path.resolve(process.env.BILI_PLUGIN_DIR || ROOT)
const HOST_ASAR = require('./host-archive.cjs').discoverHostArchive()
if (!HOST_ASAR) { console.log('SKIP mode-exit-goal: installed DSH archive was not found; set DSH_HOST_ASAR to run the real-host gate.'); process.exit(0) }
const HOST_DRIVER = 'node_modules/@deepseek-ai/dsh-goal-round-driver/lib/index.js'
let messageId = 0
let assertions = 0
const check = (condition, label) => { assert.ok(condition, label); assertions++ }

function loadHostDriver() {
  const fd = archiveFS.openSync(HOST_ASAR, 'r')
  let source
  try {
    const prefix = Buffer.alloc(16)
    archiveFS.readSync(fd, prefix, 0, 16, 0)
    const headerSize = prefix.readUInt32LE(4)
    const jsonSize = prefix.readUInt32LE(12)
    const packed = Buffer.alloc(jsonSize)
    archiveFS.readSync(fd, packed, 0, jsonSize, 16)
    let entry = JSON.parse(packed.toString('utf8'))
    for (const part of HOST_DRIVER.split('/')) entry = entry.files[part]
    assert.ok(!entry.unpacked && entry.offset != null, 'host driver must be packed')
    const bytes = Buffer.alloc(entry.size)
    archiveFS.readSync(fd, bytes, 0, bytes.length, 8 + headerSize + Number(entry.offset))
    source = bytes.toString('utf8')
  } finally { archiveFS.closeSync(fd) }
  // Use the installed driver unchanged except dependency injection; never import live services.
  source = source.replace(/^import .*;\r?\n/gm, '').replace(/^export \{[^\n]*\};?\s*$/m, '')
  return new Function('isDeepStrictEqual', 'createUserMessage', source + '\nreturn { apply, renderGoalRoundPrompt }')(
    isDeepStrictEqual,
    (spec) => ({ id: `fake-message-${++messageId}`, ...spec }),
  )
}

async function makeHarness(plugin, driver, { driverFirst = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-deepmoyu-mode-exit-'))
  const hooks = new Map()
  const live = new Map()
  const goals = new Map()
  const sections = new Map()
  const cleanup = []
  const pauses = []
  const reads = []
  const resumes = []
  const queued = []
  const warnings = []
  const emit = (event, ...args) => {
    for (const fn of [...(hooks.get(event) || [])]) fn(...args)
  }
  const registry = {
    get: (id) => live.get(id),
    list: () => [...live.values()],
    currentInitiator: () => undefined,
    withoutInitiator: (fn) => fn(),
  }
  const requireOwner = (agent) => {
    assert.equal(live.get(agent.id), agent, 'goal owner must be exact registered instance')
    assert.equal(agent.id, agent.session.id, 'agent id must match session id')
  }
  const goalService = {
    get(agent) { requireOwner(agent); reads.push(agent.id); const g = goals.get(agent); return g ? { ...g } : undefined },
    pause(agent, ref) {
      requireOwner(agent)
      const g = goals.get(agent)
      assert.ok(g && g.phase === 'active', 'only active current goal may pause')
      assert.deepEqual(ref, { id: g.id, revision: g.revision }, 'pause requires exact current ref')
      pauses.push({ agent, ref })
      const next = { ...g, revision: g.revision + 1, phase: 'paused', activation: 'disarmed' }
      goals.set(agent, next)
      emit('goal/changed', { agent, change: { operation: 'pause' } })
      return { ...next }
    },
    disarm(agent) {
      requireOwner(agent)
      const g = goals.get(agent)
      if (!g) return undefined
      const next = { ...g, activation: 'disarmed' }
      goals.set(agent, next)
      return { ...next }
    },
    resume(agent, ref) { resumes.push({ agent, ref }); throw new Error('unexpected automatic resume') },
  }
  const ctx = {
    fiber: { state: 2 },
    agents: registry, goals: goalService,
    sessions: { flush: async () => undefined },
    logger: { info() {}, warn(message) { warnings.push(String(message)) }, error(message) { warnings.push(String(message)) } },
    get(key) {
      if (key === 'dshHomePath') return (...parts) => path.join(home, ...parts)
      if (key === 'goals') return goalService
      if (key === 'agents') return registry
      if (key === 'systemPrompt') return {
        getSectionOrder: () => 600,
        section: (spec) => { sections.set(spec.name, spec); return { dispose() {} } },
      }
      return undefined
    },
    on(event, callback) {
      const listeners = hooks.get(event) || []
      listeners.push(callback)
      hooks.set(event, listeners)
      return { dispose() {} }
    },
    effect(fn) {
      const result = fn()
      if (result && typeof result.next === 'function') {
        const yielded = result.next()
        if (typeof yielded.value === 'function') cleanup.push(yielded.value)
      }
      return result
    },
    tools: { register: (spec) => spec },
    settings: { register: () => ({}) },
    slots: { inject() {}, register: () => ({}) },
    webServer: { register: () => ({ dispose() {} }) },
  }
  // Actual preset-registry bridge: session append emits the resolved shared session id synchronously.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'agent-preset/selected') emit('agent-preset/selected', session.id, event.data.agentPreset)
  })
  if (driverFirst) driver.apply(ctx)
  plugin.apply(ctx, {})
  if (!driverFirst) driver.apply(ctx)
  const add = (id, objective = '🐟 鲸鱼摸鱼模式：OFFLINE_ONLY_OBJECTIVE', phase = 'active') => {
    const session = { id, header: { agentPreset: 'dafeiyu' }, log: [], append(type, data) {
      const event = { type, data }
      this.log.push(event)
      emit('session/event', this, event)
      return event
    } }
    const agent = {
      id, session, status: 'idle',
      inbox: { nextStep: [], nextTurn: [], prepend(target, message) { this.nextStep.unshift(message) } },
      followup(message) { queued.push({ agent, message }); this.inbox.nextTurn.push(message); this.status = 'running' },
      cancel() { this.status = 'idle' },
      whenIdle: async () => undefined,
    }
    live.set(id, agent)
    if (objective != null) goals.set(agent, {
      id: `goal-${id}`, revision: 7, objective, phase,
      activation: phase === 'active' ? 'armed' : 'disarmed', roundsStarted: 0, maxGoalRounds: 64,
    })
    emit('agent/created', { agent })
    return agent
  }
  const select = (agent, preset) => agent.session.append('agent-preset/selected', { agentPreset: preset })
  const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(setImmediate) }
  const idle = async (agent) => { agent.status = 'idle'; emit('agent/status', { agent, status: 'idle' }); await settle() }
  const prompt = (agent) => String(sections.get('bili:dafeiyu').text({ agent }) ?? '')
  const dispose = async () => {
    ctx.fiber.state = 5
    for (const fn of cleanup.reverse()) await fn()
    await settle()
    const resolved = path.resolve(home)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('dsh-deepmoyu-mode-exit-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  }
  return { ctx, hooks, add, select, idle, settle, prompt, emit, pauses, resumes, queued, goals: goalService, reads, warnings, dispose }
}

;(async () => {
  const plugin = await import(pathToFileURL(path.join(PLUGIN, 'index.js')).href)
  const driver = loadHostDriver()
  let scenarios = 0
  for (const driverFirst of [false, true]) {
    for (const preset of ['standard', null, '']) {
      const h = await makeHarness(plugin, driver, { driverFirst })
      try {
        const agent = h.add(`exit-${driverFirst}-${String(preset) || 'empty'}`)
        h.select(agent, preset)
        const g = h.goals.get(agent) // Must already be paused before any Promise turn.
        check(g.phase === 'paused' && g.activation === 'disarmed', `synchronous ${String(preset)} exit pauses and disarms`)
        check(g.revision === 8 && h.pauses.length === 1, 'one exact revision transition')
        check(h.pauses[0].agent === agent && h.pauses[0].ref.id === `goal-${agent.session.id}`, 'correct session-owned agent/ref')
        check(h.prompt(agent) === '', 'standard/none combined with paused goal has empty persona section')
        await h.idle(agent)
        check(h.queued.length === 0, 'real host driver does not queue new objective after exit')
        h.select(agent, 'dafeiyu')
        await h.idle(agent)
        check(h.goals.get(agent).phase === 'paused' && h.resumes.length === 0 && h.queued.length === 0, 'return to fish does not resume automatically')
        scenarios++
      } finally { await h.dispose() }
    }
  }
  {
    const h = await makeHarness(plugin, driver)
    try {
      const target = h.add('owner-A')
      const other = h.add('owner-B')
      const unrelated = h.add('work', 'Fix the unrelated project')
      const noGoal = h.add('no-goal', null)
      const alreadyPaused = h.add('paused', undefined, 'paused')
      h.select(target, 'standard')
      check(h.pauses.length === 1 && h.pauses[0].agent === target, 'only exact event session owner is paused')
      check(h.goals.get(other).phase === 'active', 'another session fish goal remains active')
      h.select(unrelated, 'standard')
      h.select(noGoal, null)
      h.select(alreadyPaused, 'standard')
      check(h.pauses.length === 1, 'unrelated/absent/already-paused goals are untouched')
      await h.idle(unrelated)
      check(h.queued.length === 1 && h.queued[0].agent === unrelated, 'unrelated normal goal still follows real driver')
      check(h.queued[0].message.content[0].text.includes('Fix the unrelated project'), 'normal objective is preserved')
      const readsBefore = h.reads.length
      h.emit('agent-preset/selected', 'missing-session', 'standard')
      h.emit('agent-preset/selected', null, 'standard')
      h.emit('agent-preset/selected', '', 'standard')
      h.emit('agent-preset/selected', { id: target.id }, 'standard')
      check(h.reads.length === readsBefore && h.pauses.length === 1, 'unknown/malformed owner does not get or mutate any goal')
      scenarios++
    } finally { await h.dispose() }
  }
  for (const driverFirst of [false, true]) {
    const h = await makeHarness(plugin, driver, { driverFirst })
    try {
      const agent = h.add('already-queued')
      await h.idle(agent)
      check(h.queued.length === 1, 'real driver initially queues active armed fish goal')
      const queued = h.queued[0].message
      check(queued.content[0].text.includes('OFFLINE_ONLY_OBJECTIVE'), 'host continuation really contains complete fish objective')
      h.emit('agent/inbox/claimed', { agent, message: queued })
      h.select(agent, 'standard')
      check(h.goals.get(agent).phase === 'paused', 'preset exit synchronously invalidates queued revision')
      const preSteps = h.hooks.get('agent/pre-step')
      check(preSteps.length === 2, 'actual host pre-step race fence and plugin scope fence are both installed')
      const step = { agent, messages: [queued], signal: new AbortController().signal }
      const dispatch = index => index < preSteps.length ? preSteps[index](step, () => dispatch(index + 1)) : Promise.resolve({ kind: 'enter', messages: [queued] })
      const decision = await dispatch(0)
      check(decision.kind === 'reject', 'actual driver rejects already-queued fish turn after exit')
      await h.idle(agent)
      check(h.queued.length === 1 && h.resumes.length === 0, 'no replacement fish round or automatic resume follows rejection')
      scenarios++
    } finally { await h.dispose() }
  }
  console.log(`PASS ${assertions} assertions across ${scenarios} scenarios: mode exit + actual host driver; offline temporary homes only`)
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1 })
