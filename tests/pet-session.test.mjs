import test from 'node:test'
import assert from 'node:assert/strict'
import { createPetSession } from '../lib/pet-session.mjs'

const cwd = 'D:\\鱼的工作区', otherCwd = 'D:\\另一个工作区'
function fixture({ sourceMode = 'danger-full-access', sourceApproval = 'never', sourcePreset = 'danger-full-access', attached = true } = {}) {
  const calls = [], setCalls = [], sessions = new Map(), agents = new Map()
  const specs = { 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' }, 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' }, auto: { sandbox: 'danger-full-access', approval: 'ask' } }
  const makeSession = (id, path, sandbox, approval, preset) => {
    const events = [], state = { sandbox, approval, preset }
    const session = { id, header: { cwd: path }, events, state,
      append(type, data) { events.push({ type, data }); if (type === 'sandbox/mode') state.sandbox = data.mode; if (type === 'approval/policy') state.approval = data.policy; if (type === 'permission/preset') state.preset = data.preset } }
    sessions.set(id, session); agents.set(id, { id, session }); return session
  }
  const source = makeSession('source', cwd, sourceMode, sourceApproval, sourcePreset)
  const workspace = { id: 'fish-workspace', path: cwd, sessionIds: attached ? ['source'] : [] }
  const other = { id: 'other-workspace', path: otherCwd, sessionIds: [] }, workspaces = [workspace, other]
  const services = {
    agents: { get: id => agents.get(id) }, sessions: { get: id => sessions.get(id) },
    workspaceRegistry: { get: id => workspaces.find(x => x.id === id), list: () => workspaces,
      resolveByPath: async path => workspaces.find(x => x.path === path) },
    sandboxPolicy: { resolve: ({ session }) => ({ mode: session.state.sandbox, workspaceRoot: session.header.cwd }) },
    approval: { effectivePolicy: session => session.state.approval },
    sessionProjections: { stateOf: session => session.state },
    permissionPresets: {
      current(session) { const state = session.state, spec = specs[state.preset]; return spec?.sandbox === state.sandbox && (spec.approval === state.approval || state.preset === 'auto' && state.approval === 'never') ? state.preset : Object.keys(specs).find(key => specs[key].sandbox === state.sandbox && specs[key].approval === state.approval) ?? 'custom' },
      resolve: key => { if (!specs[key]) throw new Error('unknown preset'); return specs[key] },
      set(session, preset) { setCalls.push({ session: session.id, preset }); const spec = specs[preset]; session.append('permission/preset', { preset }); session.append('sandbox/mode', { mode: spec.sandbox }); session.append('approval/policy', { policy: spec.approval }) },
    },
  }
  const ctx = { get: key => services[key] }
  const controller = {
    async create(request) {
      calls.push(request)
      assert.deepEqual(Object.keys(request).sort(), ['agentPreset', request.workspaceId ? 'workspaceId' : 'cwd'].sort(), 'only actual Host SessionCreateRequest fields are forwarded')
      assert.equal(request.agentPreset, 'dafeiyu')
      const owner = services.workspaceRegistry?.get(request.workspaceId), path = owner?.path ?? request.cwd
      const session = makeSession('created-' + calls.length, path, 'workspace-write', 'ask', 'workspace-write')
      if (owner) owner.sessionIds.push(session.id)
      return { sessionId: session.id, agentPreset: 'dafeiyu' }
    },
  }
  return { ctx, controller, calls, setCalls, sessions, agents, services, source, workspace, workspaces }
}

test('pet session belongs to selected Workspace and inherits full access without changing defaults', async () => {
  const f = fixture()
  const result = await createPetSession(f.ctx, f.controller, { sourceSessionId: 'source', workspaceId: 'fish-workspace' }, { fallbackCwd: otherCwd })
  assert.deepEqual(f.calls, [{ agentPreset: 'dafeiyu', workspaceId: 'fish-workspace' }])
  assert.ok(f.workspace.sessionIds.includes(result.sessionId))
  assert.equal(f.sessions.get(result.sessionId).header.cwd, cwd)
  assert.deepEqual(result.permissions, { preset: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never', inherited: true })
  assert.deepEqual(f.setCalls, [{ session: result.sessionId, preset: 'danger-full-access' }])
  assert.deepEqual(f.source.events, [], 'inheritance never modifies the source')
})

test('pet session infers ownership from source membership or canonical cwd, keeping restrictive permissions', async () => {
  for (const attached of [true, false]) {
    const f = fixture({ attached, sourceMode: 'workspace-write', sourceApproval: 'ask', sourcePreset: 'workspace-write' })
    const result = await createPetSession(f.ctx, f.controller, { sourceSessionId: 'source', sandbox: 'danger-full-access', approval: 'never' })
    assert.equal(f.calls[0].workspaceId, 'fish-workspace')
    assert.equal(result.permissions.sandbox, 'workspace-write'); assert.equal(result.permissions.approval, 'ask')
  }
})

test('pet session inherits custom sandbox/approval combination and delegated Auto never exactly', async () => {
  for (const options of [
    { sourceMode: 'read-only', sourceApproval: 'never', sourcePreset: 'custom' },
    { sourceMode: 'danger-full-access', sourceApproval: 'never', sourcePreset: 'auto' },
  ]) {
    const f = fixture(options)
    const result = await createPetSession(f.ctx, f.controller, { sourceSessionId: 'source' })
    const target = f.sessions.get(result.sessionId)
    assert.equal(result.permissions.sandbox, options.sourceMode); assert.equal(result.permissions.approval, options.sourceApproval)
    assert.equal(f.setCalls.length, options.sourcePreset === 'auto' ? 1 : 0, 'Auto retains its identity and admission check; custom knobs have no selectable preset')
    if (options.sourcePreset === 'auto') assert.equal(result.permissions.preset, 'auto')
    assert.ok(target.events.some(x => x.type === 'sandbox/mode' && x.data.mode === options.sourceMode))
    assert.ok(target.events.some(x => x.type === 'approval/policy' && x.data.policy === 'never'))
    assert.ok(target.events.every(x => x.type !== 'permission/preset' || x.data.preset !== 'custom'))
  }
})

test('pet session reads scoped effective permissions and can resolve a cold selected session', async () => {
  const f = fixture({ sourceMode: 'read-only', sourceApproval: 'ask', sourcePreset: 'custom' })
  const scoped = { ...f.services, sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) }, approval: { effectivePolicy: () => 'never' }, permissionPresets: { current: () => 'custom' } }
  const agent = f.agents.get('source'); agent.ctx = { get: key => scoped[key] }
  f.agents.delete('source'); f.sessions.delete('source')
  f.controller.resolveAgent = async id => { assert.equal(id, 'source'); return { agent } }
  const result = await createPetSession(f.ctx, f.controller, { sourceSessionId: 'source' })
  assert.equal(result.permissions.sandbox, 'danger-full-access'); assert.equal(result.permissions.approval, 'never')
})

test('pet session context errors do not silently create a stray session', async () => {
  for (const body of [{ sourceSessionId: 'missing' }, { workspaceId: 'missing' }, { sourceSessionId: 'source', workspaceId: 'other-workspace' }, { sourceSessionId: {} }]) {
    const f = fixture()
    await assert.rejects(createPetSession(f.ctx, f.controller, body))
    assert.equal(f.calls.length, 0)
  }
  const f = fixture()
  await assert.rejects(createPetSession(f.ctx, f.controller, {}, { fallbackCwd: 'D:\\unowned' }), /无法确定当前工作区/)
  assert.equal(f.calls.length, 0)
})

test('legacy pet request uses matching directory or sole Workspace and retains Host defaults', async () => {
  const f = fixture()
  const matched = await createPetSession(f.ctx, f.controller, {}, { fallbackCwd: cwd })
  assert.equal(matched.workspaceId, 'fish-workspace'); assert.equal(matched.permissions.inherited, false)
  assert.equal(matched.permissions.sandbox, 'workspace-write')
  f.workspaces.splice(1)
  const single = await createPetSession(f.ctx, f.controller, {}, { fallbackCwd: otherCwd })
  assert.equal(single.workspaceId, 'fish-workspace')
  f.services.workspaceRegistry = undefined
  const withoutRegistry = await createPetSession(f.ctx, f.controller, { sourceSessionId: 'source' })
  assert.deepEqual(f.calls.at(-1), { agentPreset: 'dafeiyu', cwd })
  assert.equal(withoutRegistry.permissions.sandbox, 'danger-full-access')
})

test('permission inheritance failure returns created identity and cannot be mistaken for a startable success', async () => {
  const f = fixture()
  f.services.permissionPresets.set = () => {}
  f.services.sandboxPolicy = { resolve: ({ session }) => ({ mode: session.id === 'source' ? 'danger-full-access' : 'workspace-write' }) }
  await assert.rejects(createPetSession(f.ctx, f.controller, { sourceSessionId: 'source' }), error => {
    assert.equal(error.sessionId, 'created-1'); assert.match(error.message, /权限继承未生效/); return true
  })
})
