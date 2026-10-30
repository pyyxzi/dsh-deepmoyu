import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { cpSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'fish-update-routes-'))
const builtin = join(root, 'builtin'); mkdirSync(builtin)
const priorBuiltin = process.env.DAFEIYU_STICKER_DIR
process.env.DAFEIYU_STICKER_DIR = builtin
const { apply } = await import('../index.js')
const immediate = () => new Promise(resolve => setImmediate(resolve))

/**
 * Real plugin HTTP routes, isolated home, fake host services.
 * The plugin directory itself is the real source tree, so `detectInstallMode` sees
 * a directory outside any profile ⇒ canUpgrade=false. That is exactly the local-fork
 * situation this route must refuse to auto-upgrade.
 */
async function fixture({ config = {}, dshHome = join(root, 'dsh-home'), applyFn = apply } = {}) {
  // The plugin reads its home via ctx.get('dshHomePath')('bili-duty') — write config THERE, not to a sibling dir.
  const home = join(dshHome, 'bili-duty')
  mkdirSync(home, { recursive: true })
  // _set 名单决定 config.json 里的键是否压过宿主默认值 —— 不写进去这篇夹具的 dshBin 根本不会生效。
  writeFileSync(join(home, 'config.json'), JSON.stringify({ reportLevel: 'off', learnAutoReview: false, _set: Object.keys(config), ...config }))
  let handler = null
  const cleanups = [], spawns = [], fetches = []
  const ctx = {
    logger: { info() {} }, settings: { describe: () => [] },
    get: key => key === 'dshHomePath' ? (...parts) => join(dshHome, ...parts) : undefined,
    tools: { register: spec => spec }, on: () => () => {},
    effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } },
  }
  const cp = createRequire(import.meta.url)('node:child_process')
  const original = { spawn: cp.spawn, fetch: globalThis.fetch }
  cp.spawn = (command, args, options) => {
    spawns.push({ command, args, options })
    const child = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true; child.unref = () => {}
    queueMicrotask(() => { child.emit('close', 0) })
    return child
  }
  syncBuiltinESMExports()
  globalThis.fetch = async (url) => {
    fetches.push(String(url))
    return { ok: true, status: 200, text: async () => JSON.stringify({ 'dist-tags': { latest: '9.9.9' }, time: { '9.9.9': '2026-10-30T00:00:00.000Z' } }) }
  }
  async function request(path, body, method = 'GET') {
    const req = new EventEmitter(); req.url = '/api/bili-duty' + path; req.method = method; req.headers = {}; req.destroy = () => {}
    let ended = false
    const res = {
      writeHead(code, headers) { this.code = code; this.headers = headers },
      end(data) { ended = true; this.raw = data; try { this.body = JSON.parse(data) } catch { this.body = data } },
    }
    const pending = handler(req, res)
    if (method === 'POST') { req.emit('data', Buffer.from(JSON.stringify(body ?? {}))); req.emit('end') }
    await pending
    assert.ok(ended, 'route must always answer')
    return res
  }
  try {
    applyFn(ctx, {}); await immediate()
  } catch (error) { cleanup(); throw error }
  function cleanup() {
    for (const off of cleanups.reverse()) { try { off() } catch {} }
    cp.spawn = original.spawn; globalThis.fetch = original.fetch; syncBuiltinESMExports()
    rmSync(home, { recursive: true, force: true })
  }
  return { home, request, spawns, fetches, cleanup }
}

test.after(() => {
  if (priorBuiltin === undefined) delete process.env.DAFEIYU_STICKER_DIR
  else process.env.DAFEIYU_STICKER_DIR = priorBuiltin
  rmSync(root, { recursive: true, force: true })
})

test('GET /update reports the real current version and refuses to call a local checkout upgradable', async () => {
  const f = await fixture()
  try {
    const r = await f.request('/update', undefined, 'GET')
    assert.equal(r.code, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.current, '2.4.2')
    assert.equal(r.body.latest, '9.9.9')
    assert.equal(r.body.outdated, true, 'a newer version must still be reported')
    assert.equal(r.body.canUpgrade, false, 'the source tree is not a registry install')
    assert.notEqual(r.body.install.mode, 'registry')
    assert.ok(r.body.blocker, 'the UI needs a reason to disable the button')
    assert.match(r.body.install.reason, /手动|源码|profile|目录/)
    assert.equal(f.spawns.length, 0, 'checking must never spawn anything')
    assert.equal(f.fetches.length, 1)
    // Cached: a second poll must not hit the network again.
    const again = await f.request('/update', undefined, 'GET')
    assert.equal(again.code, 200); assert.equal(f.fetches.length, 1)
    // rev= short-circuits when nothing changed.
    const unchanged = await f.request('/update?rev=' + encodeURIComponent(again.body.rev), undefined, 'GET')
    assert.equal(unchanged.body.unchanged, true)
  } finally { f.cleanup() }
})

test('POST /upgrade refuses without explicit confirmation and never spawns dsh', async () => {
  const f = await fixture()
  try {
    for (const body of [{}, { confirm: false }, { confirm: 'yes' }, { latest: '9.9.9' }]) {
      const r = await f.request('/upgrade', body, 'POST')
      assert.equal(r.code, 400, JSON.stringify(body))
      assert.equal(r.body.code, 'UPGRADE_CONFIRM_REQUIRED')
    }
    assert.equal(f.spawns.length, 0)
  } finally { f.cleanup() }
})

test('POST /upgrade refuses an unusable install even with confirm:true', async () => {
  const f = await fixture()
  try {
    const r = await f.request('/upgrade', { confirm: true }, 'POST')
    assert.equal(r.code, 200)
    assert.equal(r.body.ok, false)
    assert.ok(['UPGRADE_BLOCKED', 'NO_DSH_CLI', 'NO_PROFILE'].includes(r.body.code) || r.body.code === undefined)
    assert.equal(f.spawns.length, 0, 'no install may be triggered for a non-registry layout')
    assert.ok(String(r.body.error || '').length > 0)
  } finally { f.cleanup() }
})

test('GET /update survives an unreachable registry without pretending anything', async () => {
  const f = await fixture()
  try {
    globalThis.fetch = async () => { throw new Error('offline') }
    const r = await f.request('/update?force=1', undefined, 'GET')
    assert.equal(r.code, 200)
    assert.equal(r.body.ok, false)
    assert.equal(r.body.outdated, false)
    assert.equal(r.body.canUpgrade, false)
    assert.match(r.body.error, /offline/)
    const upgrade = await f.request('/upgrade', { confirm: true }, 'POST')
    assert.equal(upgrade.body.ok, false)
    assert.equal(f.spawns.length, 0)
  } finally { f.cleanup() }
})

test('a supported registry install really spawns the fixed plugin add and reports it started once', async () => {
  // Honest positive path: copy the real plugin into a fake profile as a *registry-style* install,
  // then import that copy. No production seam is faked.
  const dshHome = join(root, 'fake-home')
  const installed = join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-deepmoyu')
  mkdirSync(installed, { recursive: true })
  const sourceRoot = fileURLToPath(new URL('..', import.meta.url))
  for (const name of ['package.json', 'index.js', 'client.js', 'selfcheck.mjs', 'cordis.patch.yml']) {
    writeFileSync(join(installed, name), readFileSync(join(sourceRoot, name)))
  }
  for (const dir of ['lib', 'presets', 'prompts', 'vendor']) cpSync(join(sourceRoot, dir), join(installed, dir), { recursive: true })
  const cli = join(dshHome, 'dsh-bin.js'); writeFileSync(cli, '// never executed; spawn is mocked\n')
  const { apply: applyInstalled } = await import(pathToFileURL(join(installed, 'index.js')).href)
  const f = await fixture({ dshHome, config: { dshBin: cli }, applyFn: applyInstalled })
  try {
    const check = await f.request('/update?force=1', undefined, 'GET')
    assert.equal(check.body.install.mode, 'registry', JSON.stringify(check.body.install))
    assert.equal(check.body.canUpgrade, true)
    assert.equal(check.body.blocker, '')
    const cfgNow = await f.request('/config', undefined, 'GET')
    assert.equal(cfgNow.body.config.dshBin, cli)
    const started = await f.request('/upgrade', { confirm: true }, 'POST')
    assert.equal(started.code, 200)
    assert.equal(started.body.ok, true, JSON.stringify(started.body).slice(0, 600))
    assert.equal(started.body.started, true)
    assert.equal(started.body.to, '9.9.9')
    assert.equal(f.spawns.length, 1)
    const call = f.spawns[0]
    assert.equal(call.args[0], cli)
    assert.deepEqual(call.args.slice(1), ['plugin', '--profile', 'web', 'add', 'dsh-deepmoyu'])
    assert.equal(call.options.env.npm_config_registry, 'https://registry.npmmirror.com')
    await immediate(); await immediate()
    const after = await f.request('/update', undefined, 'GET')
    assert.equal(after.body.upgrading, false)
  } finally { f.cleanup(); rmSync(dshHome, { recursive: true, force: true }) }
})

test('the update log stays inside the plugin home and only records the attempt', async () => {
  const f = await fixture()
  try {
    await f.request('/update?force=1', undefined, 'GET')
    await f.request('/upgrade', { confirm: true }, 'POST')
    // Nothing was spawned, so no log line is required; but if one exists it must be in the home.
    let text = ''
    try { text = readFileSync(join(f.home, 'update.log'), 'utf8') } catch { text = '' }
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      assert.match(line, /\[update:[a-z]+\]/)
      assert.ok(!/[A-Za-z]:\\Users\\|[\\/]\.ssh[\\/]|token|password/i.test(line), 'never log secrets or user paths')
    }
  } finally { f.cleanup() }
})
