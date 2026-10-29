/** Offline contract check against the installed DSH archive, with isolated services only. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, openSync, readSync, closeSync } from 'node:fs'
import { createToolScopeRegistry } from '../lib/tool-scope.mjs'
import { createRequire } from 'node:module'

const archive = createRequire(import.meta.url)('../scripts/qa/host-archive.cjs').discoverHostArchive()
function sources() {
  const fd = openSync(archive, 'r')
  try {
    const prefix = Buffer.alloc(16); readSync(fd, prefix, 0, 16, 0)
    const bytes = Buffer.alloc(prefix.readUInt32LE(12)); readSync(fd, bytes, 0, bytes.length, 16)
    const header = JSON.parse(bytes.toString())
    const read = name => {
      let entry = header
      for (const part of name.split('/')) entry = entry.files[part]
      assert.ok(entry && !entry.unpacked && entry.offset != null)
      const source = Buffer.alloc(entry.size); readSync(fd, source, 0, source.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset))
      return source.toString()
    }
    return { scope: read('node_modules/@deepseek-ai/dsh-scope/lib/index.js'), tools: read('node_modules/@deepseek-ai/dsh-tools/lib/index.js') }
  } finally { closeSync(fd) }
}
function nativeMethod(source, name) {
  const at = source.indexOf('\n\t' + name + '(')
  assert.ok(at > 0, 'installed host exposes ' + name)
  const end = source.indexOf('\n\t/**', at)
  assert.ok(end > at)
  return source.slice(at, end)
}

test('installed DSH register/view + real ScopedLayers isolate fish schemas and dispose the exact agent layer', { skip: !archive && 'installed DSH archive unavailable on this machine; set DSH_HOST_ASAR to verify the real-host contract' }, () => {
  const code = sources()
  // Only dependencies are injected; source bodies and real scope-layer logic are unchanged.
  const scopeSource = code.scope.replace(/^import[^\n]+\n/gm, '').replace(/^export \{[^\n]+\};?\s*$/m, '')
  const { ScopedLayers, NamedEntries, AnonymousEntries, createScope } = new Function('Context', scopeSource + '\nreturn {ScopedLayers, NamedEntries, AnonymousEntries, createScope}')({ filter: Symbol('fixture-filter') })
  const layerStart = code.tools.indexOf('var ToolLayer = class')
  const layerEnd = code.tools.indexOf('/** Resolve the run_code overlap', layerStart)
  assert.ok(layerStart > 0 && layerEnd > layerStart)
  const ToolLayer = new Function('NamedEntries', 'AnonymousEntries', code.tools.slice(layerStart, layerEnd) + '\nreturn ToolLayer')(NamedEntries, AnonymousEntries)
  const native = new Function('RUN_CODE_NAME', 'assertSupportedJsonSchema', 'return ({' + nativeMethod(code.tools, 'register') + ',' + nativeMethod(code.tools, 'view') + '})')('run_code', schema => assert.ok(schema && typeof schema === 'object'))
  const root = {
    extend(values) { return Object.assign(Object.create(this), values) },
    plugin() { return { ctx: this, dispose() {} } },
    effect(action) {
      const iterator = action(), first = iterator.next(), undo = first.value
      iterator.next()
      assert.equal(typeof undo, 'function')
      return undo
    },
  }
  const layers = new ScopedLayers(scope => new ToolLayer(scope), () => {})
  const service = ctx => ({ register: definition => native.register.call({ ctx, layers }, definition),
    get: name => native.view.call({ layers, modeFor: () => 'native' }, undefined).visible.get(name) })
  const agents = [], rootRegistry = service(root)
  root.tools = rootRegistry
  root.get = key => key === 'agents' ? { list: () => agents } : undefined
  const add = (id, selected) => {
    const key = {}, scoped = createScope(root, key).ctx
    scoped.tools = service(scoped)
    const agent = { id, ctx: scoped, selected, key }; agents.push(agent); return agent
  }
  const fishA = add('A', true), fishB = add('B', true), normal = add('normal', false)
  const registry = createToolScopeRegistry({ ctx: root, enabled: agent => agent.selected })
  const definition = { name: 'bili_fixture', parameters: {}, output: { schema: {}, render: () => [] }, execute() {} }
  registry.register(definition)
  const view = key => native.view.call({ layers, modeFor: () => 'native' }, key).visible
  assert.equal(view(undefined).size, 0, 'no role schema exists in the actual native global layer')
  assert.equal(view(normal.key).size, 0)
  assert.equal(view(fishA.key).get('bili_fixture'), definition)
  assert.equal(view(fishB.key).get('bili_fixture'), definition)
  fishA.selected = false; registry.refresh(fishA)
  assert.equal(view(fishA.key).size, 0)
  assert.equal(view(fishB.key).size, 1)
  registry.dispose()
  assert.equal(view(fishB.key).size, 0)
  assert.equal(layers.scoped.size, 0, 'actual native layers reclaim only the removed exact scopes')
  const badAgent = { id: 'bad-host', ctx: { tools: rootRegistry }, selected: true }
  const badRoot = Object.create(root); badRoot.get = key => key === 'agents' ? { list: () => [badAgent] } : undefined
  const badRegistry = createToolScopeRegistry({ ctx: badRoot, enabled: () => true })
  badRegistry.register(definition)
  assert.equal(view(undefined).size, 0, 'an adapter routing a scoped call into native global registration is rolled back')
  assert.equal(badRegistry.snapshot().supported, false)
  assert.match(badRegistry.snapshot().error, /作用域|全局工具层/)
})
