import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createModelRelay, RELAY_PROVIDER } from '../../lib/model-relay.mjs'

const { discoverHostArchive, extractHostModules } = createRequire(import.meta.url)('./host-archive.cjs')
const HOST_ASAR = discoverHostArchive()
if (!HOST_ASAR) {
  console.log('SKIP host-bundle-smoke: installed DSH archive was not found; set DSH_HOST_ASAR to run the real-host gate.')
  process.exit(0)
}

const APP_DIR = dirname(dirname(HOST_ASAR))
const executableCandidates = process.platform === 'win32'
  ? ['DSH Desktop.exe', 'DeepSeek Harness.exe', 'dsh.exe']
  : process.platform === 'darwin'
    ? ['MacOS/DSH Desktop', 'MacOS/DeepSeek Harness', 'MacOS/DSH']
    : ['dsh-desktop', 'DSH Desktop', 'dsh']
const ELECTRON_EXE = process.env.DSH_HOST_EXECUTABLE || executableCandidates.map(name => join(APP_DIR, name)).find(existsSync)
if (!ELECTRON_EXE || !existsSync(ELECTRON_EXE)) throw new Error('Host executable was not found; set DSH_HOST_EXECUTABLE to the installed DSH executable')

const DSH_BIN = `${HOST_ASAR}/node_modules/@deepseek-ai/dsh/lib/bin.js`
const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'dsh-deepmoyu']
const MODEL = 'fixture/model'
const REPLY = 'FAKELLM_DEEPMOYU_BUNDLE_OK'
const TASK = 'Return exactly this text and nothing else: ' + REPLY
const TIMEOUT_MS = 120_000
const TEMP_BASE = resolve(process.env.DSH_QA_TMPDIR || process.env.QA_OUTPUT_DIR || tmpdir())
const scriptDir = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(scriptDir, '..', '..')
const adapterPath = join(pluginDir, 'lib', 'model-relay-adapter.mjs')
const q = value => "'" + String(value).replaceAll("'", "''") + "'"
const posix = value => String(value).replaceAll('\\', '/')
const safeTail = (text, capability) => String(text).replaceAll(capability, '[redacted relay capability]').slice(-30_000)

function offlineGuardSource() {
  return String.raw`'use strict';
const net = require('node:net');
const originalConnect = net.Socket.prototype.connect;
const localOnly = (host) => host === undefined || host === null || host === '' || host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === '::ffff:127.0.0.1';
const blocked = (detail) => { const error = new Error('HOST_BUNDLE_OFFLINE_GUARD_BLOCKED ' + detail); process.stderr.write(error.message + '\n'); throw error; };
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
  if (url.protocol !== 'http:' || !localOnly(url.hostname)) return Promise.reject(new Error('HOST_BUNDLE_OFFLINE_GUARD_BLOCKED_FETCH ' + url.origin));
  return originalFetch(input, init);
};
`
}

async function runCli(args, options) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(ELECTRON_EXE, args, options)
    let stdout = '', stderr = '', timedOut = false
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

function toolNames(tools) {
  return (Array.isArray(tools) ? tools : []).map(tool => String(tool?.name || tool?.function?.name || '')).filter(Boolean)
}

async function main() {
  assert.equal(RELAY_PROVIDER, 'dafeiyu-parent')
  await mkdir(TEMP_BASE, { recursive: true })
  const tempRoot = await mkdtemp(join(TEMP_BASE, 'dsh-host-bundle-'))
  const home = join(tempRoot, 'home')
  const profile = join(home, 'profiles', 'bundle-smoke')
  const work = join(tempRoot, 'work')
  const dutyHome = join(tempRoot, 'bili-duty')
  const userProfile = join(tempRoot, 'user-profile')
  const appData = join(tempRoot, 'appdata')
  const localAppData = join(tempRoot, 'local-appdata')
  const isolatedTemp = join(tempRoot, 'tmp')
  const extractedModules = join(tempRoot, 'host', 'node_modules')
  const guardPath = join(tempRoot, 'offline-guard.cjs')
  const overlayPath = join(tempRoot, 'headless-overlay.yml')
  let opened
  let relay
  try {
    await Promise.all([home, profile, work, dutyHome, userProfile, appData, localAppData, isolatedTemp].map(path => mkdir(path, { recursive: true })))
    await mkdir(join(profile, 'node_modules'), { recursive: true })
    await mkdir(join(home, 'profiles'), { recursive: true })
    console.log('Preparing isolated copies of installed host dependencies and linking the current plugin checkout; no package installation or real profile changes.')
    const extraction = extractHostModules(HOST_ASAR, extractedModules)
    await symlink(extractedModules, join(profile, 'node_modules', 'host-dependencies'), process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(join(extractedModules, '@deepseek-ai'), join(profile, 'node_modules', '@deepseek-ai'), process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(pluginDir, join(profile, 'node_modules', 'dsh-deepmoyu'), process.platform === 'win32' ? 'junction' : 'dir')

    const manifest = {
      name: 'dsh-profile-deepmoyu-bundle-smoke',
      private: true,
      dependencies: { 'dsh-deepmoyu': 'link:' + posix(pluginDir) },
      dsh: { profile: { bundles: BUNDLES } },
    }
    await writeFile(join(profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n', 'utf8')
    await writeFile(join(home, 'cordis.patch.yml'), '[]\n', 'utf8')
    await writeFile(guardPath, offlineGuardSource(), 'utf8')

    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
    const drive = systemRoot.slice(0, 2)
    const baseEnv = {
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
    }

    const dump = await runCli([DSH_BIN, '--profile', 'bundle-smoke', '--dump-config'], {
      cwd: work, env: baseEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.equal(dump.timedOut, false, `config dump exceeded ${TIMEOUT_MS}ms\n${dump.stderr}`)
    assert.equal(dump.code, 0, `config dump exited ${dump.code}\nstdout:\n${dump.stdout}\nstderr:\n${dump.stderr}`)
    assert.match(dump.stdout, /id:\s*dafeiyu[\s\S]*name:\s*dsh-deepmoyu/, 'plugin bundle patch was not composed')
    assert.match(dump.stdout, /id:\s*preset-dafeiyu[\s\S]*name:\s*['"]?@deepseek-ai\/dsh-agent-preset/, 'preset bundle patch was not composed')
    assert.match(dump.stdout, /id:\s*dafeiyu[\s\S]*name:\s*[^\n]*鲸鱼摸鱼模式/, 'dafeiyu preset declaration was not present')
    assert(!/HOST_BUNDLE_OFFLINE_GUARD_BLOCKED/.test(dump.stderr), `offline guard blocked config composition\n${dump.stderr}`)

    const calls = { resolve: [], prepare: [], streams: [] }
    const fakeLlm = {
      listProviders: () => [{ id: 'fixture', name: 'local fakeLLM' }],
      async resolveModelInfo(provider, model) {
        calls.resolve.push({ provider, model })
        assert.equal(provider, 'fixture'); assert.equal(model, 'model')
        return { provider, id: model, name: 'local fixture model' }
      },
      async prepareCall(config) {
        calls.prepare.push({ provider: config.provider, model: config.model })
        return {
          config: { ...config },
          async *stream(options) {
            calls.streams.push({
              messages: options.messages,
              systemPrompt: options.systemPrompt,
              tools: options.tools,
              toolChoice: options.toolChoice,
            })
            yield { type: 'text-delta', index: 0, text: REPLY }
            yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    }
    relay = createModelRelay({ getLlm: () => fakeLlm })
    assert.equal(await relay.ready, true, 'local relay failed to listen')
    opened = relay.open(MODEL, { expiresAt: Date.now() + 3 * 60_000 })
    const overlay = [
      '- id: agent-default-model',
      '  config:',
      `    provider: ${q(RELAY_PROVIDER)}`,
      `    model: ${q(MODEL)}`,
      '',
      '- insert:',
      '    - id: bundle-smoke-webserver',
      "      name: '@deepseek-ai/dsh-host-webserver'",
      '      config:',
      "        host: '127.0.0.1'",
      '        port: 0',
      '    - id: bundle-smoke-agent-presets',
      "      name: '@deepseek-ai/dsh-agent-preset-registry'",
      '      config:',
      '        default: standard',
      '    - id: dafeiyu-model-relay',
      `      name: ${q(posix(adapterPath))}`,
      '',
    ].join('\n')
    await writeFile(overlayPath, overlay, 'utf8')
    const result = await runCli([DSH_BIN, '--profile', 'bundle-smoke', '--patch', overlayPath, TASK], {
      cwd: work,
      env: { ...baseEnv, ...opened.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = safeTail(result.stdout, opened.env.BILI_DUTY_RELAY_CAPABILITY)
    const stderr = safeTail(result.stderr, opened.env.BILI_DUTY_RELAY_CAPABILITY)
    assert.equal(result.timedOut, false, `headless CLI exceeded ${TIMEOUT_MS}ms\n${stderr}`)
    assert.equal(result.code, 0, `headless CLI exited ${result.code} signal=${result.signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    assert(stdout.includes(REPLY), `CLI output missed fakeLLM reply\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    assert(calls.resolve.length > 0 && calls.prepare.length > 0 && calls.streams.length > 0, 'real host did not reach the loopback fakeLLM')
    const seenTools = [...new Set(calls.streams.flatMap(call => toolNames(call.tools)))]
    const promptPayload = JSON.stringify(calls.streams.map(call => ({ messages: call.messages, systemPrompt: call.systemPrompt })))
    assert(!seenTools.some(name => name.startsWith('bili_')), `ordinary headless request received fish tools: ${seenTools.filter(name => name.startsWith('bili_')).join(', ')}`)
    for (const marker of ['鲸鱼摸鱼', '你是一只软乎乎', 'sk-KfcCrazyDay4VMe50Quickly', '【实时配额】', '你自己那本账']) {
      assert(!promptPayload.includes(marker), `ordinary headless request leaked fish prompt marker: ${marker}`)
    }
    assert(!/HOST_BUNDLE_OFFLINE_GUARD_BLOCKED/.test(stderr), `offline guard blocked an attempted network request\n${stderr}`)

    const hostPackage = JSON.parse(readFileSync(join(extractedModules, '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
    console.log(JSON.stringify({
      ok: true,
      hostVersion: hostPackage.version,
      cli: ELECTRON_EXE,
      entry: DSH_BIN,
      profileBundles: BUNDLES,
      pluginLink: posix(pluginDir),
      dumpConfig: { pluginPatch: true, presetPatch: true },
      ordinaryRequest: { reply: stdout.trim(), modelCalls: calls.streams.length, toolCount: seenTools.length, fishTools: [], fishPromptMarkers: [] },
      network: 'loopback-only guard active; no external request observed',
      limitations: ['The real headless one-shot runner does not compose an agent preset, so this gate proves the full bundle and preset declaration compose, then proves ordinary-mode isolation. Fish-preset runtime behavior remains covered by the dedicated isolation tests and interactive host/browser gates.'],
      extractedHostFiles: extraction.files,
    }, null, 2))
  } finally {
    try { opened?.revoke() } catch {}
    try { relay?.close() } catch {}
    if (dirname(resolve(tempRoot)) === TEMP_BASE && resolve(tempRoot).startsWith(join(TEMP_BASE, 'dsh-host-bundle-'))) await rm(tempRoot, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error?.stack || String(error))
  process.exitCode = 1
})
