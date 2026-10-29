import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { createModelRelay, RELAY_PROVIDER } from '../../lib/model-relay.mjs'

const { discoverHostArchive, extractHostModules } = createRequire(import.meta.url)('./host-archive.cjs')
const HOST_ASAR = discoverHostArchive()
if (!HOST_ASAR) { console.log('SKIP headless-relay: installed DSH archive was not found; set DSH_HOST_ASAR to run the real-host gate.'); process.exit(0) }
const APP_DIR = dirname(dirname(HOST_ASAR))
const executableCandidates = process.platform === 'win32' ? ['DSH Desktop.exe', 'DeepSeek Harness.exe', 'dsh.exe'] : process.platform === 'darwin' ? ['MacOS/DSH Desktop', 'MacOS/DeepSeek Harness', 'MacOS/DSH'] : ['dsh-desktop', 'DSH Desktop', 'dsh']
const ELECTRON_EXE = process.env.DSH_HOST_EXECUTABLE || executableCandidates.map(name => join(APP_DIR, name)).find(existsSync)
if (!ELECTRON_EXE || !existsSync(ELECTRON_EXE)) throw new Error('Host executable was not found; set DSH_HOST_EXECUTABLE to the installed DSH executable')
const DSH_BIN = `${HOST_ASAR}/node_modules/@deepseek-ai/dsh/lib/bin.js`
const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']
const MODEL = 'fixture/model'
const REPLY = 'FAKELLM_HEADLESS_RELAY_OK'
const TASK = 'Return exactly this text and nothing else: ' + REPLY
const TIMEOUT_MS = 105_000
const TEMP_BASE = resolve(process.env.DSH_QA_TMPDIR || tmpdir())
const scriptDir = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(scriptDir, '..', '..')
const adapterPath = join(pluginDir, 'lib', 'model-relay-adapter.mjs')
const q = value => "'" + String(value).replaceAll("'", "''") + "'"
const posix = value => String(value).replaceAll('\\', '/')
const safeTail = (text, capability) => String(text).replaceAll(capability, '[redacted relay capability]').slice(-20_000)

function offlineGuardSource() {
  return String.raw`'use strict';
const net = require('node:net');
const originalConnect = net.Socket.prototype.connect;
const localOnly = (host) => host === undefined || host === null || host === '' || host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === '::ffff:127.0.0.1';
const blocked = (detail) => { const error = new Error('HEADLESS_OFFLINE_GUARD_BLOCKED ' + detail); process.stderr.write(error.message + '\n'); throw error; };
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  const host = typeof first === 'object' && first !== null ? (first.host ?? first.hostname) : (typeof normalized[1] === 'string' ? normalized[1] : undefined);
  if (!localOnly(host)) blocked('SOCKET ' + String(host));
  if (typeof first === 'object' && first !== null && first.path) blocked('LOCAL_SOCKET');
  return Reflect.apply(originalConnect, this, args);
};
const originalFetch = globalThis.fetch;
if (typeof originalFetch === 'function') globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'http:' || !localOnly(url.hostname)) return Promise.reject(new Error('HEADLESS_OFFLINE_GUARD_BLOCKED_FETCH ' + url.origin));
  return originalFetch(input, init);
};
`
}

async function runCli(args, options) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(ELECTRON_EXE, args, options)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 1_500).unref()
    }, TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => { clearTimeout(timer); rejectRun(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolveRun({ code, signal, timedOut, stdout, stderr })
    })
  })
}

async function main() {
  assert.equal(RELAY_PROVIDER, 'dafeiyu-parent', 'unexpected relay provider id')
  assert(BUNDLES.includes('@deepseek-ai/dsh-base') && BUNDLES.includes('@deepseek-ai/dsh-headless'))

  const calls = { listProviders: 0, resolve: [], prepare: [], streams: 0, streamMessages: [] }
  const fakeLlm = {
    listProviders() {
      calls.listProviders++
      return [{ id: 'fixture', name: 'local fakeLLM' }]
    },
    async resolveModelInfo(provider, model) {
      calls.resolve.push({ provider, model })
      assert.equal(provider, 'fixture')
      assert.equal(model, 'model')
      return { provider, id: model, name: 'local fixture model' }
    },
    async prepareCall(config) {
      calls.prepare.push({ provider: config.provider, model: config.model })
      assert.equal(config.provider, 'fixture')
      assert.equal(config.model, 'model')
      return {
        config: { ...config },
        async *stream(options) {
          calls.streams++
          calls.streamMessages.push(options.messages)
          yield { type: 'text-delta', index: 0, text: REPLY }
          yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }

  const relay = createModelRelay({ getLlm: () => fakeLlm })
  let tempRoot = ''
  let result
  let opened
  try {
    assert.equal(await relay.ready, true, 'local relay failed to listen')
    opened = relay.open(MODEL, { expiresAt: Date.now() + 3 * 60_000 })
    assert.equal(opened.env.BILI_DUTY_RELAY_MODEL, MODEL)

    await mkdir(TEMP_BASE, { recursive: true })
    tempRoot = await mkdtemp(join(TEMP_BASE, 'dsh-headless-relay-'))
    const home = join(tempRoot, 'home')
    const profile = join(home, 'profiles', 'headless')
    const work = join(tempRoot, 'work')
    const dutyHome = join(tempRoot, 'bili-duty')
    const userProfile = join(tempRoot, 'user-profile')
    const appData = join(tempRoot, 'appdata')
    const localAppData = join(tempRoot, 'local-appdata')
    const isolatedTemp = join(tempRoot, 'tmp')
    const extractedModules = join(tempRoot, 'host', 'node_modules')
    const guardPath = join(tempRoot, 'offline-guard.cjs')
    const overlayPath = join(tempRoot, 'headless-overlay.yml')

    await Promise.all([home, profile, work, dutyHome, userProfile, appData, localAppData, isolatedTemp].map(path => mkdir(path, { recursive: true })))
    await mkdir(join(profile, 'node_modules'), { recursive: true })
    await mkdir(join(home, 'profiles'), { recursive: true })
    console.log('Preparing isolated copies of installed host dependencies; no package installation or real profile changes.')
    const extraction = extractHostModules(HOST_ASAR, extractedModules)
    console.log('Copied ' + extraction.files + ' installed host files into the temporary home.')
    await symlink(extractedModules, join(profile, 'node_modules', 'host-dependencies'), process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(join(extractedModules, '@deepseek-ai'), join(profile, 'node_modules', '@deepseek-ai'), process.platform === 'win32' ? 'junction' : 'dir')

    const manifest = {
      name: 'dsh-profile-headless-relay-check',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: BUNDLES } },
    }
    await writeFile(join(profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n', 'utf8')
    await writeFile(join(home, 'cordis.patch.yml'), '[]\n', 'utf8')
    await writeFile(guardPath, offlineGuardSource(), 'utf8')

    // Mirrors ensureOverlay's selected route and absolute-name adapter insert.
    const overlay = [
      '- id: agent-default-model',
      '  config:',
      `    provider: ${q(RELAY_PROVIDER)}`,
      `    model: ${q(MODEL)}`,
      '',
      '- insert:',
      '    - id: dafeiyu-model-relay',
      `      name: ${q(posix(adapterPath))}`,
      '',
    ].join('\n')
    await writeFile(overlayPath, overlay, 'utf8')

    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
    const drive = systemRoot.slice(0, 2)
    const childEnv = {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      SystemDrive: process.env.SystemDrive || drive,
      PATH: process.platform === 'win32' ? `${join(systemRoot, 'System32')};${systemRoot}` : process.env.PATH || '/usr/bin:/bin',
      TEMP: isolatedTemp,
      TMP: isolatedTemp,
      USERPROFILE: userProfile,
      HOME: userProfile,
      HOMEDRIVE: drive,
      HOMEPATH: userProfile.slice(2).replaceAll('/', '\\'),
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: `--require=${JSON.stringify(posix(guardPath))}`,
      BILI_DUTY_ROLE: 'background',
      BILI_DUTY_HOME: dutyHome,
      ...opened.env,
    }

    result = await runCli([DSH_BIN, '--profile', 'headless', '--patch', overlayPath, TASK], {
      cwd: work,
      env: childEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const stdout = safeTail(result.stdout, opened.env.BILI_DUTY_RELAY_CAPABILITY)
    const stderr = safeTail(result.stderr, opened.env.BILI_DUTY_RELAY_CAPABILITY)
    assert.equal(result.timedOut, false, `headless CLI exceeded ${TIMEOUT_MS}ms\n${stderr}`)
    assert.equal(result.code, 0, `headless CLI exited ${result.code} signal=${result.signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    assert(stdout.includes(REPLY), `CLI output missed fakeLLM text ${JSON.stringify(REPLY)}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    assert(calls.listProviders > 0, 'relay.open did not consult fakeLLM listProviders')
    assert(calls.resolve.length > 0, 'real headless CLI never resolved the selected model through fakeLLM')
    assert(calls.prepare.length > 0, 'real headless CLI never prepared a model call through fakeLLM')
    assert(calls.streams > 0, 'real headless CLI never consumed fakeLLM stream chunks')
    assert(calls.resolve.every(call => call.provider === 'fixture' && call.model === 'model'))
    assert(calls.prepare.every(call => call.provider === 'fixture' && call.model === 'model'))
    assert(calls.streamMessages.flat().some(message => JSON.stringify(message).includes(TASK)), 'fakeLLM stream did not receive the CLI task')
    assert(!/HEADLESS_OFFLINE_GUARD_BLOCKED/.test(stderr), `offline guard blocked an attempted network request\n${stderr}`)

    console.log(JSON.stringify({
      ok: true,
      cli: ELECTRON_EXE,
      entry: DSH_BIN,
      profileBundles: BUNDLES,
      adapter: posix(adapterPath),
      provider: RELAY_PROVIDER,
      model: MODEL,
      resolveCalls: calls.resolve.length,
      prepareCalls: calls.prepare.length,
      streamCalls: calls.streams,
      reply: stdout.trim(),
      network: 'loopback-only guard active; no external request observed',
    }, null, 2))
  } finally {
    try { opened?.revoke() } catch {}
    relay.close()
    if (tempRoot && dirname(resolve(tempRoot)) === TEMP_BASE && resolve(tempRoot).startsWith(join(TEMP_BASE, 'dsh-headless-relay-'))) await rm(tempRoot, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error?.stack || String(error))
  process.exitCode = 1
})
