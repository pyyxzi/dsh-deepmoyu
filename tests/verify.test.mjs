import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { parseSeen, loadCredential, verifyOne, verifyRecent, appendVerifyToReport } from '../lib/verify.mjs'
import { dayKey } from '../lib/state.mjs'

// All credentials, platform responses and records are synthetic; fetch is always injected.
const bv = 'BV1234567890', big = '1234567890123456789', root = '9876543210987654321'
const noSleep = async () => {}
const response = value => ({ ok: true, text: async () => typeof value === 'string' ? value : JSON.stringify(value) })
const options = replies => ({ sleepImpl: noSleep, fetchImpl: async url => response(url.includes('/view?') ? { code: 0, data: { aid: 4242 } } : { code: 0, data: { replies } }) })
async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'fish-verify-'))
  writeFileSync(join(dir, 'bili_credential.json'), JSON.stringify({ sessdata: 'synthetic-session' }))
  writeFileSync(join(dir, 'seen.md'), `| ${bv} | ${big} |`)
  try { await run(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('Markdown parser preserves long IDs, roots and canonical decimal identity', () => {
  assert.deepEqual(parseSeen(`ignored\n| ${bv} | ${big} | ${root} |\n${bv} 0001234567890`)
    .map(({ bv, rpid, root }) => ({ bv, rpid, root })), [
    { bv, rpid: big, root }, { bv, rpid: '1234567890', root: '0' },
  ])
  assert.deepEqual(parseSeen(`${bv} 0000000000\nBVshort 1234567890`), [])
})

test('credential helper handles missing, malformed and incomplete files without exposing their bytes', async () => fixture(async dir => {
  const file = join(dir, 'bili_credential.json')
  assert.equal(loadCredential(dir).sessdata, 'synthetic-session')
  for (const value of ['{broken', '{}', '[]', '{"sessdata":123}']) {
    writeFileSync(file, value); assert.equal(loadCredential(dir), null); assert.equal(readFileSync(file, 'utf8'), value)
  }
  rmSync(file); assert.equal(loadCredential(dir), null)
}))

test('numeric API JSON tokens retain exact 19-digit IDs before parse and comparison', async () => {
  const calls = []
  const result = await verifyOne({ bv, rpid: big }, { sleepImpl: noSleep, fetchImpl: async (url, init) => {
    calls.push(url); assert.ok(init.signal instanceof AbortSignal)
    return response(url.includes('/view?')
      ? '{"code":0,"data":{"aid":1234567890123456780,"title":"quoted 1234567890123456789"}}'
      : `{"code":0,"data":{"replies":[{"rpid":${big},"like":12}]}}`)
  } })
  assert.equal(result.rpid, big); assert.equal(result.visible, true); assert.equal(result.likes, 12)
  assert.match(result.note, /不代表所有访客/); assert.match(calls[1], /oid=1234567890123456780/)
  await assert.rejects(verifyOne({ bv, rpid: Number(big) }, options([])), /safe integer/)
  await assert.rejects(verifyOne({ bv: '../bad', rpid: big }, options([])), /INVALID_BVID/)
})

test('rpid_str takes precedence and invisible hits never claim public visibility', async () => {
  for (const flag of [true, 1, '1']) {
    const result = await verifyOne({ bv, rpid: big, root }, options([{ rpid: Number(big), rpid_str: big, like: 2, invisible: flag }]))
    assert.equal(result.visible, false); assert.match(result.note, /不能认定公开可见/); assert.match(result.how, new RegExp(root))
  }
  const result = await verifyOne({ bv, rpid: big }, options([{ rpid: Number(big), rpid_str: '1234567890123456790' }]))
  assert.equal(result.visible, null)
})

test('top-level cursor pagination reaches later pages and repeated cursors are bounded', async () => {
  const urls = []
  const result = await verifyOne({ bv, rpid: big }, { sleepImpl: noSleep, fetchImpl: async url => {
    urls.push(url)
    return response(url.includes('/view?') ? { code: 0, data: { aid: 42 } }
      : url.includes('next=0&') ? { code: 0, data: { replies: [], cursor: { next: 77, is_end: false } } }
        : { code: 0, data: { replies: [{ rpid_str: big }], cursor: { is_end: true } } })
  } })
  assert.equal(result.visible, true); assert.match(result.how, /2 页/); assert.match(urls[2], /next=77/)
  let count = 0
  const miss = await verifyOne({ bv, rpid: big }, { sleepImpl: noSleep, aidCache: new Map([[bv, { aid: '42' }]]), fetchImpl: async () => {
    count++; return response({ code: 0, data: { replies: [], cursor: { next: 77 } } })
  } })
  assert.equal(count, 2); assert.equal(miss.visible, null); assert.match(miss.note, /不等于没发出去/)
})

test('nested replies paginate within the ceiling and stop on the reported final page', async () => {
  let count = 0
  const result = await verifyOne({ bv, rpid: big, root }, { sleepImpl: noSleep, aidCache: new Map([[bv, { aid: '42' }]]), fetchImpl: async url => {
    count++
    assert.match(url, new RegExp(`root=${root}`))
    return response({ code: 0, data: { replies: url.includes('pn=2') ? [{ rpid: big }] : Array.from({ length: 20 }, (_, i) => ({ rpid: String(i + 1) })), page: { count: 21 } } })
  } })
  assert.equal(result.visible, true); assert.equal(count, 2)
  count = 0
  await verifyOne({ bv, rpid: big, root }, { sleepImpl: noSleep, maxPages: 2, aidCache: new Map([[bv, { aid: '42' }]]), fetchImpl: async () => {
    count++; return response({ code: 0, data: { replies: Array.from({ length: 20 }, () => ({ rpid: '1' })) } })
  } })
  assert.equal(count, 2)
})

test('HTTP, API, JSON and network failures remain unknown and do not expose raw response messages', async () => {
  for (const fetchImpl of [async () => ({ ok: false }), async () => response('not json'), async () => response({ code: -1, message: 'synthetic-secret' }), async () => { throw new Error('synthetic-secret') }]) {
    const result = await verifyOne({ bv, rpid: big }, { sleepImpl: noSleep, aidCache: new Map([[bv, { aid: '42' }]]), fetchImpl })
    assert.equal(result.visible, null); assert.match(result.note, /无法判断/); assert.ok(!JSON.stringify(result).includes('synthetic-secret'))
  }
  const missing = await verifyOne({ bv, rpid: big }, { sleepImpl: noSleep, fetchImpl: async () => response({ code: 0, data: {} }) })
  assert.match(missing.how, /取视频信息失败/)
})

test('recent verification deduplicates seen rows and only skips a fresh matching positive result', async () => fixture(async dir => {
  writeFileSync(join(dir, 'seen.md'), `${bv} ${big}\n${bv} ${big}\n${bv} 1234567890123456788`)
  writeFileSync(join(dir, 'verify-state.json'), JSON.stringify({ '1234567890123456788': { bv, visible: true, at: Date.now() } }))
  let calls = 0; const io = options([{ rpid: big, invisible: true }]), fetch = io.fetchImpl
  const result = await verifyRecent(dir, { ...io, fetchImpl: async (...args) => { calls++; return fetch(...args) }, log() { throw new Error('optional log fails') } })
  assert.equal(calls, 2); assert.equal(result.checked.length, 1); assert.equal(result.skipped, 2)
  assert.match(result.text, /接口标记不可见/); assert.doesNotMatch(result.text, /—— 公开可见/)
  const state = JSON.parse(readFileSync(join(dir, 'verify-state.json'), 'utf8'))
  assert.equal(state[big].visible, false); assert.equal(state['1234567890123456788'].visible, true)
  const again = await verifyRecent(dir, options([{ rpid: big }]))
  assert.equal(again.checked.length, 1, 'invisible evidence must not be cached as a public success')
}))

test('corrupt or invalid verification history fails before network and remains byte-for-byte intact', async () => fixture(async dir => {
  const file = join(dir, 'verify-state.json')
  for (const source of ['{corrupt-history', 'null', '[]']) {
    writeFileSync(file, source)
    await assert.rejects(verifyRecent(dir, { sleepImpl: noSleep, fetchImpl: async () => assert.fail('must not request') }))
    assert.equal(readFileSync(file, 'utf8'), source)
  }
}))

test('an in-flight check merges new persisted state and refuses corruption introduced before commit', async () => fixture(async dir => {
  const file = join(dir, 'verify-state.json'), io = options([{ rpid: big }]), request = io.fetchImpl
  const result = await verifyRecent(dir, { ...io, fetchImpl: async (...args) => {
    writeFileSync(file, JSON.stringify({ other: { bv, at: 5 } })); return request(...args)
  } })
  assert.equal(result.checked.length, 1); assert.equal(JSON.parse(readFileSync(file, 'utf8')).other.at, 5)
  writeFileSync(file, '{}')
  await assert.rejects(verifyRecent(dir, { ...options([{ rpid: big, invisible: 1 }]), fetchImpl: async url => {
    writeFileSync(file, '{now-corrupt')
    return response(url.includes('/view?') ? { code: 0, data: { aid: 42 } } : { code: 0, data: { replies: [] } })
  } }), /JSON/)
  assert.equal(readFileSync(file, 'utf8'), '{now-corrupt')
}))

test('no seen ledger, no credential, no usable records and fresh cache exit without network', async () => fixture(async dir => {
  const forbid = { fetchImpl: async () => assert.fail('must not request') }
  writeFileSync(join(dir, 'verify-state.json'), JSON.stringify({ [big]: { bv, at: Date.now(), visible: true } }))
  assert.equal((await verifyRecent(dir, forbid)).checked.length, 0)
  writeFileSync(join(dir, 'seen.md'), 'empty')
  assert.match((await verifyRecent(dir, forbid)).text, /没有可复核/)
  rmSync(join(dir, 'bili_credential.json'))
  assert.match((await verifyRecent(dir, forbid)).text, /扫码登录/)
  rmSync(join(dir, 'seen.md'))
  assert.match((await verifyRecent(dir, forbid)).text, /判重表还没生成/)
}))

test('report appends neither fabricate missing reports nor lose concurrent appends', async () => fixture(async dir => {
  assert.equal(appendVerifyToReport(dir, 'missing'), null)
  const out = join(dir, 'out'); mkdirSync(out)
  const file = join(out, `${dayKey()}.md`)
  assert.equal(existsSync(file), false)
  writeFileSync(file, '# existing report\n')
  const module = new URL('../lib/verify.mjs', import.meta.url).href
  const source = `import {appendVerifyToReport} from ${JSON.stringify(module)};for(let n=0;n<15;n++)if(!appendVerifyToReport(process.argv[1],process.argv[2]+':'+n))process.exit(1);`
  await Promise.all(Array.from({ length: 3 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, dir, String(i)], { stdio: 'pipe' })
    let error = ''; child.stderr.on('data', data => { error += data })
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(error || `child exited ${code}`)))
  })))
  const text = readFileSync(file, 'utf8')
  assert.ok(text.startsWith('# existing report\n'))
  for (let i = 0; i < 3; i++) for (let n = 0; n < 15; n++) assert.ok(text.includes(`\n${i}:${n}\n`))
}))
