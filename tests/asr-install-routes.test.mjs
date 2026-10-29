import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apply } from '../index.js'
import { environmentPython } from '../lib/python-env.mjs'

const REQUIRED = ['faster_whisper', 'yt_dlp', 'ctranslate2', 'av']
const immediate = () => new Promise(resolve => setImmediate(resolve))

/** Only synthetic package directories and child events are used. No Python or model download runs. */
async function fixture(run, { packages = REQUIRED, pipFails = false, importFails = false, modelFails = false, holdPackages = false, linked = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fish-asr-install-')), home = join(root, 'bili-duty'), asr = join(home, '.venv-asr'), py = environmentPython(asr)
  mkdirSync(dirname(py), { recursive: true }); writeFileSync(py, 'synthetic Python; never executed')
  const site = process.platform === 'win32' ? join(asr, 'Lib', 'site-packages') : join(asr, 'lib', 'python3.12', 'site-packages')
  mkdirSync(site, { recursive: true })
  for (const name of packages) mkdirSync(join(site, name))
  const target = join(root, 'external-shared-environment')
  if (linked) {
    renameSync(asr, target)
    writeFileSync(join(target, 'external-sentinel'), 'shared environment must stay unchanged')
    symlinkSync(target, asr, process.platform === 'win32' ? 'junction' : 'dir')
  }
  writeFileSync(join(home, 'config.json'), JSON.stringify({ learnAutoReview: false, reportLevel: 'off', asrModel: 'tiny' }))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ unrelated: 'preserve-asr-neighbour', tokensTotal: 123 }))
  const cleanups = [], calls = [], fetches = [], held = []
  const cp = createRequire(import.meta.url)('node:child_process'), original = { spawn: cp.spawn, fetch: globalThis.fetch }
  const failure = { pipFails, importFails, modelFails, holdPackages }
  let handler
  cp.spawn = (command, args) => {
    calls.push({ command, args })
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true
    const finish = () => {
      let code = 0
      if (command === 'uv' && args[0] === '--version') { /* available local fake uv */ }
      else if (args.includes('faster-whisper') && args.includes('yt-dlp')) {
        // Even a failed pip may leave an import directory behind.
        mkdirSync(join(site, 'faster_whisper'), { recursive: true })
        code = failure.pipFails ? 1 : 0
        if (!code) for (const name of REQUIRED) mkdirSync(join(site, name), { recursive: true })
        child.stdout.emit('data', Buffer.from('synthetic package progress\n'))
      } else if (args[0] === '-c' && args[1].includes('WhisperModel(')) {
        mkdirSync(join(home, '.hf-cache', 'hub'), { recursive: true })
        code = failure.modelFails ? 1 : 0
      } else if (args[0] === '-c' && args[1].includes('ctranslate2')) code = failure.importFails ? 1 : 0
      else throw new Error('UNEXPECTED_ASR_SUBPROCESS: ' + command + ' ' + args[0])
      child.emit('exit', code)
    }
    if (failure.holdPackages && args.includes('faster-whisper')) held.push(finish)
    else queueMicrotask(finish)
    return child
  }; syncBuiltinESMExports()
  globalThis.fetch = async (...args) => { fetches.push(args); throw new Error('real ASR network/model download forbidden in fixture') }
  const ctx = { logger: { info() {} }, settings: { describe: () => [] }, tools: { register() { assert.fail('global tool registration') } },
    get: key => key === 'dshHomePath' ? (...parts) => join(root, ...parts) : key === 'agents' ? { list: () => [] } : undefined,
    on() { return () => {} }, effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } } }
  const request = async (path, body) => {
    const req = new EventEmitter(); Object.assign(req, { method: body === undefined ? 'GET' : 'POST', url: '/api/bili-duty' + path, headers: {} })
    const res = { writeHead(status) { this.status = status }, end(value) { this.body = JSON.parse(value) } }
    const pending = handler(req, res); if (body !== undefined) { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }; await pending; return res.body
  }
  const until = async predicate => {
    for (let n = 0; n < 100; n++) { await immediate(); const status = await request('/status'); if (predicate(status)) return status }
    assert.fail('mock ASR installer did not reach its expected state')
  }
  try {
    apply(ctx, {}); await immediate()
    await run({ root, home, asr, site, py, target, calls, failure, request, until,
      async restart() { for (const off of cleanups.splice(0).reverse()) await off(); apply(ctx, {}); await immediate() },
      release() { for (const finish of held.splice(0)) finish() },
      async install() { const start = await request('/install-asr', {}); assert.equal(start.started, true); return until(status => !status.asrInstalling) } })
    assert.deepEqual(fetches, [], 'no real network or model download is allowed')
    const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    assert.equal(state.unrelated, 'preserve-asr-neighbour'); assert.equal(state.tokensTotal, 123)
  } finally {
    for (const finish of held.splice(0)) finish()
    await immediate()
    for (const off of cleanups.reverse()) try { await off() } catch {}
    cp.spawn = original.spawn; globalThis.fetch = original.fetch; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true })
  }
}

test('ASR readiness requires every runtime package, not just a faster_whisper directory or prefix lookalike', async () => fixture(async f => {
  assert.equal((await f.request('/status')).asrReady, true, 'complete legacy environments remain supported')
  for (const name of REQUIRED) {
    rmSync(join(f.site, name), { recursive: true }); mkdirSync(join(f.site, name + '_unrelated'))
    const status = await f.request('/status')
    assert.equal(status.asrReady, false, name + ' is required')
    mkdirSync(join(f.site, name)); rmSync(join(f.site, name + '_unrelated'), { recursive: true })
  }
  assert.deepEqual(f.calls, [], 'polling readiness never spawns Python')
}))

test('ASR package failure stays failed despite leftover directories and retry can complete successfully', async () => fixture(async f => {
  const failed = await f.install()
  assert.equal(failed.asrReady, false); assert.equal(failed.asrInstall.ok, false); assert.equal(failed.asrInstall.state, 'failed')
  assert.equal(failed.asrInstall.phase, 'packages'); assert.match(failed.asrTail, /装包失败/)
  assert.equal(f.calls.some(call => call.args[0] === '-c'), false, 'failed packages never start import probes or model loading')
  f.failure.pipFails = false
  const success = await f.install()
  assert.equal(success.asrReady, true); assert.equal(success.asrInstall.ok, true); assert.equal(success.asrInstall.state, 'done')
  assert.equal(success.asrModelReady, true); assert.match(success.asrTail, /模型就绪|安装校验完成/)
  assert.ok(f.calls.filter(call => call.args.includes('install')).every(call => call.args.includes('av>=12,<17')), 'legacy av compatibility bound is preserved')
}, { pipFails: true }))

test('a failing runtime import blocks ASR readiness and never starts a model download', async () => fixture(async f => {
  const result = await f.install()
  assert.equal(result.asrReady, false); assert.equal(result.asrInstall.ok, false); assert.equal(result.asrInstall.phase, 'imports')
  assert.equal(f.calls.some(call => call.args[1]?.includes('WhisperModel(')), false)
  assert.match(result.asrTail, /运行依赖.*失败/)
}, { importFails: true }))

test('a failing model stage remains failed even with a hub directory, and status is read-only across restart', async () => fixture(async f => {
  const result = await f.install()
  assert.equal(result.asrReady, false); assert.equal(result.asrModelReady, false)
  assert.equal(result.asrInstall.ok, false); assert.equal(result.asrInstall.phase, 'model')
  await f.restart()
  const file = join(f.home, 'state.json'), before = readFileSync(file, 'utf8')
  const restarted = await f.request('/status')
  assert.equal(restarted.asrReady, false); assert.equal(restarted.asrInstall.ok, false); assert.equal(restarted.asrModelReady, false)
  assert.equal(readFileSync(file, 'utf8'), before)
}, { modelFails: true }))

test('ASR busy requests do not spawn a second installer and successful completion is tied to the selected model', async () => fixture(async f => {
  const start = await f.request('/install-asr', {}); assert.equal(start.started, true)
  const running = await f.until(status => status.asrInstall?.phase === 'packages' && f.calls.some(call => call.args.includes('faster-whisper')))
  assert.equal(running.asrReady, false); assert.equal(running.asrInstall.running, true)
  const count = f.calls.length, busy = await f.request('/install-asr', {})
  assert.equal(busy.busy, true); assert.equal(f.calls.length, count)
  f.release()
  const finished = await f.until(status => !status.asrInstalling)
  assert.equal(finished.asrReady, true); assert.equal(finished.asrInstall.ok, true); assert.equal(finished.asrModelReady, true)
  const changed = await f.request('/status?rev=' + encodeURIComponent(running.rev))
  assert.notEqual(changed.unchanged, true); assert.equal(changed.asrInstall.ok, true)
  await f.request('/config', { asrModel: 'small' })
  assert.equal((await f.request('/status')).asrModelReady, false, 'a different model is not proved ready by the old hub directory')
}, { holdPackages: true }))

test('interrupted ASR receipts stay unready after restart until a new explicit installation completes', async () => fixture(async f => {
  const file = join(f.home, 'state.json'), state = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...state, asrInstall: { state: 'running', phase: 'model', ok: false, running: true, model: 'tiny' } }))
  await f.restart()
  const before = readFileSync(file, 'utf8'), interrupted = await f.request('/status')
  assert.equal(interrupted.asrReady, false); assert.equal(interrupted.asrInstall.state, 'interrupted'); assert.equal(interrupted.asrInstall.running, false)
  assert.equal(readFileSync(file, 'utf8'), before, 'interruption is a read-only projection')
  assert.equal((await f.install()).asrInstall.ok, true)
}))

test('ASR installer refuses a junction or symlink to an external shared environment before any package or model process', async () => fixture(async f => {
  const result = await f.install()
  assert.equal(result.asrInstall.ok, false); assert.equal(result.asrInstall.phase, 'environment'); assert.equal(result.asrReady, false)
  assert.match(result.asrInstall.error, /保护外部环境/)
  assert.deepEqual(f.calls, [], 'even uv probing must occur after the external-environment guard')
  assert.equal(readFileSync(join(f.target, 'external-sentinel'), 'utf8'), 'shared environment must stay unchanged')
  assert.equal(readFileSync(environmentPython(f.target), 'utf8'), 'synthetic Python; never executed')
  assert.equal(existsSync(join(f.home, '.hf-cache')), false)
}, { linked: true }))
