import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLoginSession } from '../lib/login-session.mjs'
import { loginStart, loginPoll, saveCredential, renderQrPng } from '../lib/login.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const credential = marker => ({ sessdata: 'session-' + marker, bili_jct: 'csrf-' + marker, buvid3: 'device-' + marker, dedeuserid: '123' })

test('late login polls cannot replace a newer generation or expose credentials in a response', async () => {
  let n = 0; const oldPoll = deferred(), saved = []
  const controller = createLoginSession({ start: async () => ({ key: 'key-' + ++n, url: 'https://passport.bilibili.com/' }),
    poll: key => key === 'key-1' ? oldPoll.promise : Promise.resolve({ state: 'ok', credential: credential('new') }), save: value => { saved.push(value); return 'private-local-file' } })
  const first = await controller.start(), pending = controller.poll(first.key)
  const second = await controller.start()
  const success = await controller.poll(second.key)
  assert.deepEqual(success, { state: 'ok', file: 'private-local-file' }); assert.ok(!JSON.stringify(success).includes('session-new'))
  oldPoll.resolve({ state: 'ok', credential: credential('old') })
  assert.equal((await pending).state, 'expired'); assert.deepEqual(saved, [credential('new')])
  assert.equal((await controller.poll(second.key)).state, 'expired', 'a completed generation is not replayable')
})

test('late QR creation, expired keys, disposal and incomplete credentials never write the active account', async () => {
  const early = deferred(); let n = 0, time = 10, calls = 0, saves = 0
  const controller = createLoginSession({ start: () => ++n === 1 ? early.promise : Promise.resolve({ key: 'latest', url: 'https://passport.bilibili.com/' }),
    poll: async () => { calls++; return { state: 'ok', credential: { sessdata: 'incomplete' } } }, save: () => saves++, now: () => time, ttlMs: 30 })
  const obsolete = controller.start().then(value => value, error => error)
  const current = await controller.start(); early.resolve({ key: 'obsolete', url: 'https://passport.bilibili.com/' })
  assert.match((await obsolete).message, /替代/)
  assert.equal((await controller.poll('obsolete')).state, 'expired'); assert.equal(calls, 0)
  assert.equal((await controller.poll(current.key)).state, 'unknown'); assert.equal(saves, 0)
  time = 50; assert.equal((await controller.poll(current.key)).state, 'expired'); assert.equal(calls, 1)
  controller.dispose(); assert.equal(controller.current(current), false); await assert.rejects(controller.start(), /已关闭/)
})

test('passport transport maps waiting/scanned/expired/success and uses bounded abortable requests', async () => {
  const original = globalThis.fetch, requests = []; let code = 86101
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options })
    assert.ok(options.signal instanceof AbortSignal)
    if (String(url).includes('/generate')) return { json: async () => ({ data: { qrcode_key: 'fixture-key', url: 'https://passport.bilibili.com/fixture-qr' } }) }
    return { headers: { getSetCookie: () => ['SESSDATA=encoded%2Ftoken; HttpOnly', 'bili_jct=fixture-csrf; Secure', 'DedeUserID=123; Path=/', 'buvid3=fixture-device; Path=/'] }, json: async () => ({ data: { code } }) }
  }
  try {
    assert.equal((await loginStart()).key, 'fixture-key')
    for (const [value, state] of [[86101, 'waiting'], [86090, 'scanned'], [86038, 'expired']]) { code = value; assert.equal((await loginPoll('a&b')).state, state) }
    code = 0; const success = await loginPoll('a&b'); assert.equal(success.state, 'ok'); assert.equal(success.credential.sessdata, 'encoded%2Ftoken')
    assert.match(requests.at(-1).url, /qrcode_key=a%26b/); assert.equal(requests.at(-1).options.redirect, 'manual')
  } finally { globalThis.fetch = original }
})

test('credential persistence is atomic, stores only the supported fields and is private on POSIX', () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-login-credential-'))
  try {
    const file = saveCredential(root, { ...credential('new'), unexpected: 'never persisted' })
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), credential('new'))
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('simultaneous QR renders use distinct files and a stalled renderer is killed without hanging login', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-login-qr-')), cp = createRequire(import.meta.url)('node:child_process'), original = cp.spawn
  const paths = []; let stalled, kills = 0
  cp.spawn = (_command, args) => {
    const child = new EventEmitter(); child.kill = () => { kills++; return true }
    paths.push(args.at(-1))
    if (args.includes('stalled')) stalled = child
    else queueMicrotask(() => { writeFileSync(args.at(-1), Buffer.from('fixture PNG')); child.emit('exit', 0) })
    return child
  }; syncBuiltinESMExports()
  try {
    const [a, b] = await Promise.all([renderQrPng('fixture', root, 'A'), renderQrPng('fixture', root, 'B')])
    assert.ok(a && b); assert.notEqual(a, b); assert.notEqual(paths[0], paths[1])
    const pending = renderQrPng('fixture', root, 'stalled', { timeoutMs: 5 })
    await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(await pending, null); assert.ok(stalled); assert.equal(kills, 1)
  } finally { cp.spawn = original; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }) }
})
