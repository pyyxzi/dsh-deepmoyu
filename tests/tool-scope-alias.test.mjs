import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolScopeRegistry } from '../lib/tool-scope.mjs'

const definition = { name: 'bili_scope_fixture', parameters: {}, execute() { return { ok: true } } }

test('a distinct agent context aliasing the root registry without a get probe is rejected before any global register', () => {
  const global = new Map(), calls = []
  const rootRegistry = { register(spec) { calls.push(spec.name); global.set(spec.name, spec); return () => global.delete(spec.name) } }
  assert.equal(rootRegistry.get, undefined)
  const agent = { id: 'aliased-agent', selected: true, ctx: { tools: rootRegistry } }
  const ctx = { tools: rootRegistry, get: key => key === 'agents' ? { list: () => [agent] } : undefined }
  assert.notEqual(agent.ctx, ctx, 'the counterexample is not caught by agent.ctx === ctx')
  const scopes = createToolScopeRegistry({ ctx, enabled: value => value.selected })
  scopes.register(definition)
  assert.deepEqual(calls, [], 'identity alias must be rejected before its first root registration')
  assert.equal(global.size, 0)
  assert.equal(scopes.refresh(agent), false)
  assert.equal(scopes.snapshot().supported, false)
  assert.equal(scopes.snapshot().mountedSessions, 0)
  assert.equal(scopes.snapshot().globalFallback, false)
  assert.match(scopes.snapshot().error, /作用域|全局/)
  scopes.dispose()
})

test('independent session registries still work without a root get probe and detach only the selected session', () => {
  const calls = [], global = new Map(), agents = []
  const ctx = { tools: { register(spec) { global.set(spec.name, spec); assert.fail('root registration is forbidden') } }, get: key => key === 'agents' ? { list: () => agents } : undefined }
  const add = (id, selected) => {
    const entries = new Map()
    const agent = { id, selected, entries, ctx: { tools: { register(spec) { calls.push(id); entries.set(spec.name, spec); return () => entries.delete(spec.name) } } } }
    agents.push(agent); return agent
  }
  const first = add('first', true), second = add('second', true), normal = add('normal', false)
  const scopes = createToolScopeRegistry({ ctx, enabled: value => value.selected })
  scopes.register(definition)
  assert.deepEqual(calls, ['first', 'second']); assert.equal(global.size, 0); assert.equal(normal.entries.size, 0)
  assert.equal(scopes.snapshot().supported, true); assert.equal(scopes.snapshot().mountedSessions, 2)
  first.selected = false; scopes.refresh(first)
  assert.equal(first.entries.size, 0); assert.equal(second.entries.get(definition.name), definition)
  scopes.dispose(); assert.equal(second.entries.size, 0)
})

test('supported uses the same alias check before definitions mount and recovers when the adapter supplies a real scoped registry', () => {
  const rootRegistry = { register() { assert.fail('root alias must never be called') } }, entries = new Map()
  const agent = { selected: true, ctx: { tools: rootRegistry } }
  const ctx = { tools: rootRegistry, get: key => key === 'agents' ? { list: () => [agent] } : undefined }
  const scopes = createToolScopeRegistry({ ctx, enabled: () => true })
  assert.equal(scopes.snapshot().supported, false)
  agent.ctx.tools = { register(spec) { entries.set(spec.name, spec); return () => entries.delete(spec.name) } }
  assert.equal(scopes.snapshot().supported, true)
  scopes.register(definition); assert.equal(entries.get(definition.name), definition)
  scopes.dispose(); assert.equal(entries.size, 0)
})
