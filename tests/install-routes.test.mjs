import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { apply } from '../index.js'
import { environmentPython, inspectMainEnvironment, MAIN_ENV_PACKAGES, MAIN_PYTHON_RANGE } from '../lib/python-env.mjs'

const populate = (root, python, pillow) => {
  const executable = environmentPython(root); mkdirSync(dirname(executable), { recursive: true }); writeFileSync(executable, 'synthetic executable, never launched')
  writeFileSync(join(root, 'pyvenv.cfg'), `version = ${python}\n`)
  const site = process.platform === 'win32' ? join(root, 'Lib', 'site-packages') : join(root, 'lib', 'python3.12', 'site-packages')
  for (const name of MAIN_ENV_PACKAGES) mkdirSync(join(site, name), { recursive: true })
  writeFileSync(join(site, 'PIL', '_version.py'), `__version__ = '${pillow}'\n`)
}

async function fixture({ python = '3.10.19', pillow = '12.3.0', pipFails = false, runtimeFails = false, linked = false, uvAvailable = true, bootstrapCompatible = false } = {}, run) {
  const root = mkdtempSync(join(tmpdir(), 'fish-install-route-')), home = join(root, 'bili-duty'), venv = join(home, '.venv')
  mkdirSync(home)
  const target = linked ? join(root, 'external-environment') : venv
  populate(target, python, pillow); writeFileSync(join(target, 'old-sentinel'), 'keep this environment')
  if (linked) symlinkSync(target, venv, process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ learnAutoReview: false, reportLevel: 'off', pythonPath: environmentPython(venv) }))
  const cp = createRequire(import.meta.url)('node:child_process'), original = cp.spawn, calls = [], cleanups = []
  const originalFetch = globalThis.fetch
  if (!uvAvailable) globalThis.fetch = async () => { throw new Error('synthetic offline download failure; no network I/O') }
  let handler
  cp.spawn = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true
    queueMicrotask(() => {
      let code = 0
      if (args[0] === 'venv' || args[0] === '-m' && args[1] === 'venv') populate(venv, '3.12.10', '0.0.0')
      else if (args[0] === 'pip' || args[1] === 'pip') {
        code = pipFails ? 1 : 0
        if (!pipFails) populate(venv, inspectMainEnvironment(venv).pythonVersion, '13.0.0')
      } else if (args[0] === '-c') {
        const env = inspectMainEnvironment(venv, { ignoreRuntimeFailure: true })
        const supported = command === environmentPython(venv) ? env.pythonCompatible : bootstrapCompatible
        code = supported && (!args[1].includes('PIL.__version__') || !runtimeFails) ? 0 : 2
      } else if (command !== 'uv' || args[0] !== '--version' || !uvAvailable) code = 1
      child.emit('exit', code)
    })
    return child
  }; syncBuiltinESMExports()
  const ctx = { logger: { info() {} }, settings: { describe: () => [] }, tools: { register() { throw new Error('global forbidden') } },
    get: key => key === 'dshHomePath' ? (...parts) => join(root, ...parts) : key === 'agents' ? { list: () => [] } : undefined,
    on() { return () => {} }, effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } } }
  const request = async (path, method = 'GET') => {
    const req = new EventEmitter(); Object.assign(req, { method, url: '/api/bili-duty' + path, headers: {} })
    const res = { writeHead(status) { this.status = status }, end(value) { this.body = JSON.parse(value) } }
    await handler(req, res); return res.body
  }
  try {
    apply(ctx, {}); await new Promise(resolve => setImmediate(resolve))
    await run({ root, home, venv, target, calls, request, async install() {
      const started = await request('/install', 'POST'); assert.equal(started.started, true); assert.equal(started.pythonRange, MAIN_PYTHON_RANGE)
      for (let n = 0; n < 100; n++) {
        await new Promise(resolve => setImmediate(resolve))
        const status = await request('/status')
        if (!status.installing) return status
      }
      assert.fail('mocked installer did not settle')
    } })
  } finally {
    for (const off of cleanups.reverse()) try { off() } catch {}
    cp.spawn = original; syncBuiltinESMExports(); globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true })
  }
}

test('legacy Python/Pillow cannot report ready and installation backs it up before a bounded Python rebuild', async () => fixture({}, async f => {
  const before = await f.request('/status')
  assert.equal(before.venvReady, false); assert.equal(before.environment.upgradeRequired, true)
  assert.match(before.environment.upgradeHint, /Python 3.11–3.13.*Pillow 13.0/)
  const result = await f.install()
  assert.equal(result.venvReady, true); assert.equal(result.environment.pythonVersion, '3.12.10'); assert.equal(result.environment.pillowVersion, '13.0.0')
  const creation = f.calls.find(call => call.args[0] === 'venv')
  assert.deepEqual(creation.args, ['venv', '--python', '>=3.11,<3.14', '--seed', f.venv])
  const backup = readdirSync(f.home).find(name => name.startsWith('.venv.backup-'))
  assert.ok(backup); assert.equal(readFileSync(join(f.home, backup, 'old-sentinel'), 'utf8'), 'keep this environment')
  assert.equal(existsSync(join(f.venv, 'old-sentinel')), false)
  assert.ok(f.calls.filter(call => call.args.includes('install')).every(call => call.args.includes('--require-hashes')))
  assert.equal(JSON.parse(readFileSync(join(f.home, 'config.json'), 'utf8')).pythonPath, environmentPython(f.venv))
}))

test('a healthy new environment is reused and a Pillow-only upgrade never rebuilds its Python', async () => {
  for (const pillow of ['12.3.0', '13.0.0']) await fixture({ python: '3.12.10', pillow }, async f => {
    assert.equal((await f.install()).venvReady, true)
    assert.equal(f.calls.filter(call => call.args[0] === 'venv').length, 0)
    assert.equal(existsSync(join(f.venv, 'old-sentinel')), true)
    assert.equal(readdirSync(f.home).some(name => name.startsWith('.venv.backup-')), false)
  })
})

test('failed replacement keeps both environments and restores the original without changing configuration', async () => fixture({ pipFails: true }, async f => {
  const before = readFileSync(join(f.home, 'config.json'), 'utf8')
  const result = await f.install()
  assert.equal(result.venvReady, false); assert.equal(result.environment.pythonVersion, '3.10.19')
  assert.equal(readFileSync(join(f.venv, 'old-sentinel'), 'utf8'), 'keep this environment')
  assert.equal(readFileSync(join(f.home, 'config.json'), 'utf8'), before)
  assert.ok(readdirSync(f.home).some(name => name.startsWith('.venv.failed-')))
  assert.match(readFileSync(join(f.home, 'install.log'), 'utf8'), /已恢复原环境/)
}))

test('successful pip with a failing actual import remains unready through its persisted health receipt', async () => fixture({ python: '3.12.10', pillow: '13.0.0', runtimeFails: true }, async f => {
  const result = await f.install()
  assert.equal(result.venvReady, false); assert.equal(result.environment.runtimeFailed, true)
  assert.equal(JSON.parse(readFileSync(join(f.venv, 'deepmoyu-health.json'), 'utf8')).ok, false)
  assert.equal(existsSync(join(f.venv, 'old-sentinel')), true)
}))

test('linked environments are read-only to the installer and never pass a package installation or rebuild command', async () => fixture({ python: '3.12.10', pillow: '13.0.0', linked: true }, async f => {
  await f.install()
  assert.equal(f.calls.length, 0)
  assert.equal(readFileSync(join(f.target, 'old-sentinel'), 'utf8'), 'keep this environment')
  assert.match(readFileSync(join(f.home, 'install.log'), 'utf8'), /保护外部环境/)
}))

test('without uv, an unsupported bootstrap is rejected before the original environment is moved', async () => fixture({ uvAvailable: false }, async f => {
  const before = readFileSync(join(f.home, 'config.json'), 'utf8')
  const result = await f.install()
  assert.equal(result.venvReady, false)
  assert.equal(existsSync(join(f.venv, 'old-sentinel')), true)
  assert.equal(readdirSync(f.home).some(name => name.startsWith('.venv.backup-') || name.startsWith('.venv.failed-')), false)
  assert.equal(readFileSync(join(f.home, 'config.json'), 'utf8'), before)
  assert.match(readFileSync(join(f.home, 'install.log'), 'utf8'), /Python 3.11–3.13.*现有环境未改动/)
}))

test('without uv, only a version-checked bootstrap can create the replacement and pip remains hash-locked', async () => fixture({ uvAvailable: false, bootstrapCompatible: true }, async f => {
  const result = await f.install()
  assert.equal(result.venvReady, true)
  assert.ok(f.calls.some(call => call.command === 'python' && call.args[0] === '-c' && call.args[1].includes('(3,11)')))
  assert.ok(f.calls.some(call => call.command === 'python' && call.args[0] === '-m' && call.args[1] === 'venv'))
  assert.ok(f.calls.filter(call => call.args.includes('install')).every(call => call.args.includes('--require-hashes')))
}))
