import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { openDirectory } from '../lib/open-directory.mjs'

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'deepmoyu-open-directory-'))
  const folder = join(root, "中文 space 'single quote' & (folder)")
  mkdirSync(folder)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, folder }
}
function stub(action = (child) => child.emit('exit', 0, null)) {
  const calls = [], children = []
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter()
    child.killCalls = []; child.unrefs = 0
    child.kill = (signal) => { child.killCalls.push(signal); child.emit('exit', null, signal); return true }
    child.unref = () => { child.unrefs++ }
    calls.push({ command, args, options }); children.push(child)
    if (action) queueMicrotask(() => action(child))
    return child
  }
  return { spawnImpl, calls, children }
}
function cleaned(child) {
  for (const event of ['error', 'exit', 'close']) assert.equal(child.listenerCount(event), 0, event + ' listener released')
  assert.equal(child.unrefs, 1)
}

function windowsPayload(call) {
  assert.deepEqual(call.args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-NoLogo', '-WindowStyle', 'Hidden', '-EncodedCommand'])
  const script = Buffer.from(call.args.at(-1), 'base64').toString('utf16le')
  const match = script.match(/\$encodedDirectory = '([A-Za-z0-9+/=]+)'/)
  assert(match, 'directory is a literal base64 data value')
  assert(script.includes('$startInfo.UseShellExecute = $true'))
  assert(script.includes('$null = [System.Diagnostics.Process]::Start($startInfo)'))
  assert(script.includes('[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($encodedDirectory))'))
  assert(!/WaitForExit|\.Kill\s*\(|Stop-Process|taskkill|explorer\.exe/i.test(script), 'helper never waits for or kills the visible application')
  return { script, directory: Buffer.from(match[1], 'base64').toString('utf8'), shape: script.replace(match[1], '<DIRECTORY_DATA>') }
}

for (const [platform, command] of [['win32', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'], ['darwin', 'open'], ['linux', 'xdg-open']]) {
  test(platform + ' chooses its launcher/helper, passes an opaque directory and waits for acknowledgement', async (t) => {
    const { folder } = directory(t), io = stub()
    const result = await openDirectory(folder, { platform, spawnImpl: io.spawnImpl, env: { SystemRoot: 'C:\\Windows' } })
    assert.equal(result.ok, true)
    assert.equal(result.opened, resolve(folder))
    assert.equal(result.acknowledged, true)
    assert.equal(io.calls.length, 1)
    assert.equal(io.calls[0].command, command)
    if (platform === 'win32') assert.equal(windowsPayload(io.calls[0]).directory, resolve(folder))
    else assert.deepEqual(io.calls[0].args, platform === 'darwin' ? ['--', resolve(folder)] : [resolve(folder)])
    assert.equal(io.calls[0].options.shell, false)
    assert.equal(io.calls[0].options.stdio, 'ignore')
    assert.equal(io.calls[0].options.detached, false)
    assert.equal(io.calls[0].options.windowsVerbatimArguments, false)
    assert.equal(io.calls[0].options.windowsHide, true)
    cleaned(io.children[0])
  })
}

test('spaces, Unicode, both quote types and shell metacharacters are data rather than generated commands', async () => {
  const value = '中文 folder "double quote" \'single quote\' ; $(invalid-command) & trailing'
  for (const platform of ['win32', 'darwin', 'linux']) {
    const io = stub()
    const result = await openDirectory(value, { platform, spawnImpl: io.spawnImpl, statImpl: () => ({ isDirectory: () => true }) })
    assert.equal(result.ok, true)
    if (platform === 'win32') {
      const decoded = windowsPayload(io.calls[0])
      assert.equal(decoded.directory, resolve(value))
      assert(!decoded.script.includes(value), 'raw directory text never enters executable PowerShell')
    } else assert.equal(io.calls[0].args.at(-1), resolve(value))
    assert(!io.calls[0].command.includes(value))
    assert.equal(io.calls[0].options.shell, false)
  }
})

test('Windows helper code is identical for benign and injection-shaped directory data', async () => {
  const values = ["plain folder", "中文 空格 'single' \"double\"", "'; Stop-Process -Name explorer; #",
    '`"; $(Start-Process invalid-command); & invalid-command #', "emoji 🐟 and trailing slash\\"]
  const shapes = new Set()
  for (const value of values) {
    const io = stub()
    assert.equal((await openDirectory(value, { platform: 'win32', spawnImpl: io.spawnImpl,
      statImpl: () => ({ isDirectory: () => true }) })).ok, true)
    const payload = windowsPayload(io.calls[0])
    assert.equal(payload.directory, resolve(value))
    shapes.add(payload.shape)
    assert(io.calls[0].command.endsWith('\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'))
    assert(!io.calls[0].args.includes(value))
  }
  assert.equal(shapes.size, 1, 'only the base64 data changes, not the executable script')
})

test('unsupported platforms and invalid/missing/file targets never spawn a launcher', async (t) => {
  const { root, folder } = directory(t), io = stub()
  const unsupported = await openDirectory(folder, { platform: 'freebsd', spawnImpl: io.spawnImpl })
  assert.equal(unsupported.code, 'OPEN_PLATFORM_UNSUPPORTED')
  for (const value of [null, {}, 1, '', ' ', 'bad\0path']) {
    assert.equal((await openDirectory(value, { spawnImpl: io.spawnImpl })).code, 'OPEN_DIRECTORY_INVALID')
  }
  assert.equal((await openDirectory(join(root, 'missing'), { spawnImpl: io.spawnImpl })).code, 'OPEN_DIRECTORY_UNAVAILABLE')
  const file = join(root, 'ordinary.txt'); writeFileSync(file, 'fixture')
  assert.equal((await openDirectory(file, { spawnImpl: io.spawnImpl })).code, 'OPEN_NOT_DIRECTORY')
  assert.equal(io.calls.length, 0)
})

test('a successful spawn alone is not a successful open request', async (t) => {
  const { folder } = directory(t), io = stub(null)
  let settled = false
  const pending = openDirectory(folder, { spawnImpl: io.spawnImpl }).then((result) => { settled = true; return result })
  io.children[0].emit('spawn')
  await new Promise((done) => setImmediate(done))
  assert.equal(settled, false)
  io.children[0].emit('close', 0, null)
  assert.equal((await pending).ok, true)
  cleaned(io.children[0])
})

test('synchronous and asynchronous spawn failures return errors instead of escaping to the host', async (t) => {
  const { folder } = directory(t)
  const sync = await openDirectory(folder, { spawnImpl() { throw Object.assign(new Error('unavailable'), { code: 'ENOENT' }) } })
  assert.equal(sync.ok, false); assert.equal(sync.code, 'OPEN_SPAWN_FAILED'); assert.equal(sync.causeCode, 'ENOENT')
  const io = stub((child) => child.emit('error', Object.assign(new Error('denied'), { code: 'EACCES' })))
  const asyncResult = await openDirectory(folder, { spawnImpl: io.spawnImpl })
  assert.equal(asyncResult.ok, false); assert.equal(asyncResult.causeCode, 'EACCES')
  cleaned(io.children[0])
  assert.equal((await openDirectory(folder, { spawnImpl: () => null })).code, 'OPEN_SPAWN_FAILED')
})

test('nonzero exits and signal exits fail, with exactly one terminal result', async (t) => {
  const { folder } = directory(t)
  for (const [code, signal] of [[1, null], [null, 'SIGTERM']]) {
    const io = stub((child) => { child.emit('exit', code, signal); child.emit('close', 0, null) })
    const result = await openDirectory(folder, { spawnImpl: io.spawnImpl })
    assert.equal(result.ok, false); assert.equal(result.code, 'OPEN_EXIT_FAILED')
    assert.equal(result.exitCode, code); assert.equal(result.signal, signal)
    cleaned(io.children[0]); assert.deepEqual(io.children[0].killCalls, [])
  }
})

test('Windows timeout terminates only its hidden ShellExecute helper, never a visible Explorer process', async (t) => {
  const { folder } = directory(t), io = stub(null)
  const result = await openDirectory(folder, { platform: 'win32', spawnImpl: io.spawnImpl, timeoutMs: 8 })
  assert.equal(result.ok, false); assert.equal(result.code, 'OPEN_TIMEOUT'); assert.equal(result.timeoutMs, 8)
  assert.equal(io.calls.length, 1, 'only one child is owned by the launcher')
  assert(io.calls[0].command.endsWith('\\powershell.exe'))
  assert.equal(io.calls[0].options.windowsHide, true)
  assert.equal(windowsPayload(io.calls[0]).directory, resolve(folder))
  assert.deepEqual(io.children[0].killCalls, ['SIGKILL'])
  cleaned(io.children[0])
})

test('success clears its deadline, and a failed timeout kill still produces an honest timeout', async (t) => {
  const { folder } = directory(t), success = stub()
  assert.equal((await openDirectory(folder, { spawnImpl: success.spawnImpl, timeoutMs: 10 })).ok, true)
  await new Promise((done) => setTimeout(done, 25))
  assert.deepEqual(success.children[0].killCalls, [], 'completed request is not killed by a leaked timeout')
  const io = stub(null)
  const pending = openDirectory(folder, { spawnImpl: io.spawnImpl, timeoutMs: 5 })
  io.children[0].kill = () => { throw new Error('kill failed') }
  assert.equal((await pending).code, 'OPEN_TIMEOUT')
  cleaned(io.children[0])
})
