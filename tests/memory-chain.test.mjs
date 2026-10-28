import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, utimesSync, readdirSync, unlinkSync, openSync, closeSync, truncateSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { atomicWriteFileSync, readJsonFileSync, withFileLockSync } from '../lib/record-storage.mjs'
import { redactRecordText, sanitizeRecord } from '../lib/record-privacy.mjs'
import { appendActivityRecord, importActivityFile, importArchivedActivityChunk, rotateActivityLog, readActivityTail, captureMemorySnapshot, readRecordEvents, appendLearningRecord } from '../lib/records.mjs'
import { mirrorOnce, readMirrorManifest } from '../lib/mirror.mjs'
import { learnAdd, learnDecide, learnForget, learnInject, learnStats, learnList, LEARN_PENDING_MAX, LEARN_APPROVED_MAX } from '../lib/learn.mjs'
import { seenRemember, seenRememberMany, markSeen, seenStats, bvidOf } from '../lib/ledger.mjs'
import { tasteRemember, tasteApplyLikes, tasteTop, tasteMirror, tasteStats, tasteDigest } from '../lib/taste.mjs'

const temp = () => mkdtempSync(join(tmpdir(), 'dafeiyu-memory-test-'))
/** 插件根目录（本文件在 <plugin>/tests/ 下）—— 测试从哪个 cwd 跑都能找到模块 */
const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const write = (dir, name, content) => writeFileSync(join(dir, name), content, 'utf8')
const row = (uid, text = '读字幕并记录选择理由') => ({ uid, t: 1792540800000, kind: 'read', text })
const digest = (text) => createHash('sha256').update(text).digest('hex')

// All fixtures are synthetic. No runtime home, B站 account, network, or host restart is involved.
test('atomic writes preserve unrelated files and refuse corrupted JSON rather than replacing it', () => {
  const dir = temp(); const file = join(dir, 'state.json')
  atomicWriteFileSync(file, '{"n":1}')
  assert.deepEqual(readJsonFileSync(file, {}), { n: 1 })
  write(dir, 'state.json', '{broken')
  assert.throws(() => readJsonFileSync(file, {}), SyntaxError)
  assert.equal(readFileSync(file, 'utf8'), '{broken')
  assert.throws(() => readJsonFileSync(file, {}, { maxBytes: 2 }), /RECORD_FILE_TOO_LARGE/)
  assert.deepEqual(readJsonFileSync(join(dir, 'missing.json'), { ok: true }), { ok: true })
  assert.equal(readdirSync(dir).filter((s) => s.endsWith('.tmp')).length, 0)
})

test('active locks fail closed; dead owners are recoverable and exceptions release locks', () => {
  const dir = temp(); const file = join(dir, 'transaction')
  write(dir, 'transaction.lock', JSON.stringify({ pid: process.pid, token: 'owner' }))
  assert.throws(() => withFileLockSync(file, () => assert.fail('stolen lock'), { timeoutMs: 20 }), /RECORD_LOCK_BUSY/)
  assert.equal(JSON.parse(readFileSync(file + '.lock', 'utf8')).token, 'owner')
  write(dir, 'transaction.lock', JSON.stringify({ pid: 2147483647, token: 'dead' }))
  assert.equal(withFileLockSync(file, () => 42), 42)
  assert.throws(() => withFileLockSync(file, () => { throw new Error('sentinel') }), /sentinel/)
  assert.equal(existsSync(file + '.lock'), false)
})

test('cross-process read-modify-write transactions do not lose increments', async () => {
  const dir = temp(); const file = join(dir, 'counter.json')
  atomicWriteFileSync(file, '{"n":0}')
  const module = pathToFileURL(join(PLUGIN_DIR, 'lib', 'record-storage.mjs')).href
  const source = `import {withFileLockSync,readJsonFileSync,atomicWriteFileSync} from ${JSON.stringify(module)}; const file=${JSON.stringify(file)}; for(let i=0;i<15;i++) withFileLockSync(file,()=>{ const s=readJsonFileSync(file,{}); s.n++; atomicWriteFileSync(file,JSON.stringify(s)); },{timeoutMs:10000});`
  const jobs = Array.from({ length: 4 }, () => new Promise((resolveJob, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'inherit' })
    child.once('error', reject); child.once('exit', (code) => code === 0 ? resolveJob() : reject(new Error(`child exit ${code}`)))
  }))
  await Promise.all(jobs)
  assert.equal(readJsonFileSync(file, {}).n, 60)
})

test('privacy boundary removes credential fields, nested secrets, contacts and bearer tokens', () => {
  const data = sanitizeRecord({ cookie: 'session-fixture', nested: { api_key: 'key-fixture' }, phone: '13800138000', text: '邮箱 demo@example.org 电话13800138000 Authorization: Bearer abcdefghijklmnopqrstuvwxyz' })
  const json = JSON.stringify(data)
  for (const secret of ['session-fixture', 'key-fixture', '13800138000', 'demo@example.org', 'abcdefghijklmnopqrstuvwxyz']) assert.ok(!json.includes(secret))
  assert.ok(redactRecordText('SESSDATA=fixture-secret;').includes('[已隐去]'))
})

test('append, source import and projection re-import share stable identity; uid conflict is explicit', () => {
  const dir = temp()
  const a = appendActivityRecord(dir, row('fixture-1'))
  assert.equal(a.duplicate, false)
  assert.equal(appendActivityRecord(dir, row('fixture-1')).duplicate, true)
  const conflict = appendActivityRecord(dir, row('fixture-1', '另一件确实不同的事'))
  assert.equal(conflict.conflict, true)
  const r = importActivityFile(dir, join(dir, 'activity.jsonl'))
  assert.equal(r.imported, 0); assert.equal(r.duplicates, 1)
  assert.equal(readRecordEvents(dir, { type: 'activity' }).length, 1)
  assert.equal(readActivityTail(dir).rows.length, 1)
})

test('legacy rows without uid remain idempotent after normalized projection reuse', () => {
  const dir = temp(); const source = join(dir, 'old.jsonl')
  const legacy = { t: 1792540800000, kind: 'read', text: '旧版真实结构的合成样本' }
  write(dir, 'old.jsonl', JSON.stringify(legacy) + '\n')
  assert.equal(importActivityFile(dir, source).imported, 1)
  const ev = readRecordEvents(dir, { type: 'activity' })[0]
  write(dir, 'projected.jsonl', JSON.stringify(ev.data) + '\n')
  const again = importActivityFile(dir, join(dir, 'projected.jsonl'))
  assert.equal(again.imported, 0); assert.equal(again.duplicates, 1)
})

test('resumable imports bound I/O, count damaged rows and wait for a partial line', () => {
  const dir = temp(); const file = join(dir, 'legacy.jsonl')
  const good = Array.from({ length: 25 }, (_, i) => JSON.stringify(row(`old-${i}`, '合成记录'.repeat(20))))
  write(dir, 'legacy.jsonl', good.join('\n') + '\nnot-json\n' + JSON.stringify(row('partial')).slice(0, 30))
  let count = 0; let invalid = 0; let attempts = 0; let result
  do { result = importActivityFile(dir, file, { maxBytes: 1024 }); count += result.imported; invalid += result.invalid; assert.ok((result.bytesRead || 0) <= 1024); attempts++ } while (result.ok && result.more && attempts < 100)
  assert.equal(count, 25); assert.equal(invalid, 1); assert.equal(result.error, 'ACTIVITY_PARTIAL_LINE')
  assert.equal(readRecordEvents(dir, { type: 'activity', limit: 100 }).length, 25)
})

test('corrupt import cursor fails closed and the source survives untouched', () => {
  const dir = temp(); const file = join(dir, 'legacy.jsonl')
  write(dir, 'legacy.jsonl', JSON.stringify(row('cursor')) + '\n')
  importActivityFile(dir, file)
  const folder = join(dir, 'records', 'imports'); const cursor = join(folder, readdirSync(folder)[0])
  writeFileSync(cursor, '{broken')
  const before = digest(readFileSync(file))
  assert.throws(() => importActivityFile(dir, file), SyntaxError)
  assert.equal(digest(readFileSync(file)), before)
})

test('clear and repeated rotation keep unique archives and immutable replayable events', () => {
  const dir = temp(); appendActivityRecord(dir, row('before-clear'))
  const one = rotateActivityLog(dir, { force: true }); assert.equal(one.rotated, true)
  appendActivityRecord(dir, row('after-clear'))
  const two = rotateActivityLog(dir, { force: true }); assert.notEqual(one.archive, two.archive)
  assert.ok(existsSync(one.archive)); assert.ok(existsSync(two.archive))
  assert.equal(readRecordEvents(dir, { type: 'activity' }).length, 2)
  assert.equal(readFileSync(join(dir, 'activity.jsonl'), 'utf8'), '')
})

test('private activity keeps only outcome/identity and strips nested inbox bodies', () => {
  const dir = temp()
  const r = appendActivityRecord(dir, { ...row('dm-1', '给人回私信，含隐私样本'), tool: 'bili_dm_reply', payload: { content: 'PRIVATE-FIXTURE', email: 'demo@example.org' }, recipient: 'private-person' })
  const json = JSON.stringify(r)
  assert.ok(!json.includes('PRIVATE-FIXTURE')); assert.ok(!json.includes('private-person')); assert.ok(!json.includes('demo@example.org'))
  assert.equal(importActivityFile(dir, join(dir, 'activity.jsonl')).duplicates, 1)
})

test('large log tail does not read all bytes and deduplicates legacy entries', () => {
  const dir = temp(); const file = join(dir, 'activity.jsonl')
  const fd = openSync(file, 'w'); closeSync(fd); truncateSync(file, 12 * 1024 * 1024)
  writeFileSync(file, '\n' + JSON.stringify(row('tail')) + '\n' + JSON.stringify(row('tail')) + '\n', { flag: 'a' })
  const tail = readActivityTail(dir, { maxBytes: 2048 })
  assert.ok(tail.bytesRead <= 2048); assert.equal(tail.truncated, true); assert.equal(tail.rows.length, 1)
})

test('mode scoped memory snapshots preserve a reversible source chain and redact credentials', () => {
  const dir = temp()
  assert.equal(captureMemorySnapshot(dir, 'soul.md', 'not stored').reason, 'mode_required')
  assert.equal(existsSync(join(dir, 'records')), false)
  const a = captureMemorySnapshot(dir, 'soul.md', '我的想法 SESSDATA=fixture-secret;', { mode: 'dafeiyu', operation: 'write' })
  const duplicate = captureMemorySnapshot(dir, 'soul.md', '我的想法 SESSDATA=fixture-secret;', { mode: 'dafeiyu' })
  assert.equal(duplicate.duplicate, true); assert.equal(a.eventId, duplicate.eventId)
  const b = captureMemorySnapshot(dir, 'soul.md', '第二个想法', { mode: 'dafeiyu' })
  assert.equal(b.event.data.previousEventId, a.eventId)
  assert.ok(!readFileSync(a.path, 'utf8').includes('fixture-secret'))
  const c = captureMemorySnapshot(dir, 'soul.md', '我的想法 SESSDATA=fixture-secret;', { mode: 'dafeiyu', operation: 'restore' })
  assert.equal(c.event.data.previousEventId, b.eventId); assert.notEqual(c.eventId, a.eventId)
  assert.equal(captureMemorySnapshot(dir, '../credential', '', { mode: 'dafeiyu' }).error, 'MEMORY_NAME_NOT_ALLOWED')
})

test('learning requires explicit valid approval and injects only inside mode', () => {
  const a = learnAdd({}, { kind: 'style', text: '先说具体哪一下触动自己', from: 'BV1234567890', state: 'approved' })
  assert.equal(a.ledger.items[a.id].state, 'pending')
  assert.equal(learnInject(a.ledger, { mode: 'dafeiyu' }).used, 0)
  assert.equal(learnDecide(a.ledger, a.id, 'surprise').ok, false)
  const b = learnDecide(a.ledger, a.id, 'approve', '合成测试审批')
  assert.equal(learnInject(b.ledger).reason, 'mode_required')
  const injected = learnInject(b.ledger, { mode: 'dafeiyu', budget: 1200 })
  assert.ok(injected.text.includes(a.id)); assert.equal(injected.used, injected.text.length)
  assert.equal(learnInject(b.ledger, { mode: 'dafeiyu', budget: 0 }).used, 0)
  assert.equal(learnInject(b.ledger, { mode: 'dafeiyu', budget: 400.9 }).used <= 400, true)
})

test('duplicate learning merges provenance without promoting rejected content; revoke is audited', () => {
  const a = learnAdd({}, { kind: 'jargon', text: '解释词义以后再决定要不要学', from: '来源A' })
  const b = learnDecide(a.ledger, a.id, 'reject')
  const c = learnAdd(b.ledger, { kind: 'jargon', text: '解释词义以后再决定要不要学', from: '来源B' })
  assert.equal(c.added, false); assert.equal(c.ledger.items[a.id].state, 'rejected')
  assert.deepEqual(c.ledger.items[a.id].sources, ['来源A', '来源B'])
  const d = learnForget(c.ledger, { from: '来源B' })
  assert.equal(d.removed, 1); assert.equal(learnStats(d.ledger).total, 0)
  assert.equal(d.auditEvent.action, 'forget'); assert.equal(d.auditEvent.revoked[0].id, a.id)
  const dir = temp(); assert.equal(appendLearningRecord(dir, d.auditEvent).duplicate, false)
  assert.equal(appendLearningRecord(dir, d.auditEvent).duplicate, true)
  assert.equal(readRecordEvents(dir, { type: 'learning' }).length, 1)
})

test('learning capacity does not delete pending or previously approved evidence', () => {
  let book = {}
  for (let i = 0; i < LEARN_PENDING_MAX; i++) book = learnAdd(book, { text: `待审合成记录${i}` }).ledger
  const overflow = learnAdd(book, { text: '满队列以后的一条' })
  assert.equal(overflow.added, false); assert.equal(learnStats(overflow.ledger).pending, LEARN_PENDING_MAX)
  const items = Object.fromEntries(Array.from({ length: LEARN_APPROVED_MAX }, (_, i) => [`style:a${i}`, { id: `style:a${i}`, kind: 'style', text: `已批准${i}`, state: 'approved' }]))
  const a = learnAdd({ items }, { kind: 'style', text: '另一条待审' })
  assert.equal(learnDecide(a.ledger, a.id, 'approve').ok, false)
  assert.equal(learnStats(a.ledger).approved, LEARN_APPROVED_MAX)
})

test('learning rendering is bounded, source aware, privacy safe and does not mutate its input', () => {
  const a = learnAdd({}, { text: 'SESSDATA=fixture-secret; 别抄句子', example: '联系 demo@example.org', from: '13800138000' })
  const before = JSON.stringify(a.ledger)
  const b = learnDecide(a.ledger, a.id, 'approve')
  assert.equal(JSON.stringify(a.ledger), before)
  const page = learnList(b.ledger, { state: 'approved' })
  const injected = learnInject(b.ledger, { mode: 'dafeiyu' })
  for (const secret of ['fixture-secret', 'demo@example.org', '13800138000']) assert.ok(!(JSON.stringify(page) + injected.text).includes(secret))
})

test('ledger rejects longer BV lookalikes, corrupt keys and remains immutable', () => {
  assert.equal(bvidOf('BV1234567890EXTRA'), '')
  assert.equal(bvidOf('https://www.bilibili.com/video/BV1234567890?t=2'), 'BV1234567890')
  const input = { junk: { at: 'bad' }, BV1234567890: { at: '2026-01-01T00:00:00.000Z', note: '旧备注' } }
  const before = JSON.stringify(input)
  const next = seenRemember(input, 'BV1234567890', { at: '2026-10-21T00:00:00Z', note: 'SESSDATA=fixture-secret;', source: 'subtitle' })
  assert.equal(next.BV1234567890.at, input.BV1234567890.at)
  assert.ok(!next.BV1234567890.note.includes('fixture-secret'))
  assert.equal(seenStats(next).total, 1); assert.equal(JSON.stringify(input), before)
  assert.equal(markSeen([{ bvid: 'BV1234567890' }], next).seenCount, 1)
  assert.equal(seenStats(seenRememberMany({}, ['BV1234567890', 'BV1234567890'])).total, 1)
})

test('taste preserves 19 digit strings, refuses rounded numeric ids and merges all notification maxima', () => {
  const id = '3198765432109876543'
  const a = tasteRemember({}, id, { text: '本鱼在03:20听见那句话', likes: 7 })
  assert.ok(a[id]); assert.equal(Object.keys(tasteRemember({}, Number(id), { text: 'rounded' })).length, 0)
  const before = JSON.stringify(a)
  const b = tasteApplyLikes(a, [{ item_id: id, count: 2 }, { item_id: id, count: 19 }, { item_id: id, count: 0 }])
  assert.equal(b.ledger[id].likes, 19); assert.equal(b.matched, 1); assert.equal(b.updated, 1)
  assert.equal(JSON.stringify(a), before)
  assert.equal(tasteApplyLikes(b.ledger, [{ item_id: id, count: 0 }]).ledger[id].likes, 19)
  assert.equal(tasteApplyLikes(b.ledger, [{ item_id: id }]).matched, 0)
})

test('taste output does not reproduce secrets from current or legacy comment text', () => {
  const a = tasteRemember({}, '99', { text: 'SESSDATA=fixture-secret; demo@example.org', likes: 2 })
  const legacy = { ...a, '100': { text: 'SESSDATA=old-fixture-secret;', likes: 3, at: '2026-10-22' } }
  const text = JSON.stringify(tasteTop(legacy)) + JSON.stringify(tasteMirror(legacy))
  assert.ok(!text.includes('fixture-secret')); assert.ok(!text.includes('demo@example.org'))
})

test('mirror rejects credential/traversal names and self targets, preserves originals', () => {
  const from = temp(); const to = temp()
  write(from, 'bili_credential.json', '{"SESSDATA":"fixture-secret"}')
  write(from, 'soul.md', '我的原始想法 SESSDATA=fixture-secret;')
  const original = digest(readFileSync(join(from, 'soul.md')))
  const r = mirrorOnce(from, to, { names: ['soul.md', 'bili_credential.json', '../escape'] })
  assert.equal(r.ok, false); assert.equal(r.copied.length, 1); assert.equal(r.failed.length, 2)
  assert.equal(existsSync(join(to, 'bili_credential.json')), false)
  assert.ok(!readFileSync(join(to, 'soul.md'), 'utf8').includes('fixture-secret'))
  assert.equal(digest(readFileSync(join(from, 'soul.md'))), original)
  assert.equal(mirrorOnce(from, from).failed[0].error, 'MIRROR_SAME_DIRECTORY')
})

test('mirror detects same-size same-mtime edits and repairs a modified target', () => {
  const from = temp(); const to = temp(); write(from, 'voice.md', '甲甲甲')
  assert.equal(mirrorOnce(from, to, { names: ['voice.md'] }).copied.length, 1)
  const first = statSync(join(from, 'voice.md'))
  write(from, 'voice.md', '乙乙乙'); utimesSync(join(from, 'voice.md'), first.atime, first.mtime)
  assert.equal(mirrorOnce(from, to, { names: ['voice.md'] }).copied.length, 1)
  assert.equal(readFileSync(join(to, 'voice.md'), 'utf8'), '乙乙乙')
  assert.equal(mirrorOnce(from, to, { names: ['voice.md'] }).skipped.length, 1)
  write(to, 'voice.md', '被人改过')
  assert.equal(mirrorOnce(from, to, { names: ['voice.md'] }).copied.length, 1)
  assert.ok(readMirrorManifest(to).files['voice.md'].sha256)
})

test('mirror corrupted/oversized source fails visibly and does not destroy a prior valid mirror', () => {
  const from = temp(); const to = temp(); write(from, 'state.json', '{"seenVideos":{}}')
  assert.equal(mirrorOnce(from, to, { names: ['state.json'] }).ok, true)
  const before = readFileSync(join(to, 'state.json'), 'utf8')
  write(from, 'state.json', '{broken')
  assert.equal(mirrorOnce(from, to, { names: ['state.json'] }).ok, false)
  assert.equal(readFileSync(join(to, 'state.json'), 'utf8'), before)
  const fd = openSync(join(from, 'soul.md'), 'w'); closeSync(fd); truncateSync(join(from, 'soul.md'), 3 * 1024 * 1024)
  assert.equal(mirrorOnce(from, to, { names: ['soul.md'] }).failed[0].error, 'MIRROR_SOURCE_TOO_LARGE')
})

test('mirror state preserves over 500 valid ledger keys while excluding nested credential data', () => {
  const from = temp(); const to = temp()
  const seenVideos = Object.fromEntries(Array.from({ length: 800 }, (_, i) => [`BV${String(i).padStart(10, '0')}`, { note: '已看' }]))
  write(from, 'state.json', JSON.stringify({ seenVideos, credential: { SESSDATA: 'fixture-secret' } }))
  assert.equal(mirrorOnce(from, to, { names: ['state.json'] }).ok, true)
  const output = JSON.parse(readFileSync(join(to, 'state.json'), 'utf8'))
  assert.equal(Object.keys(output.seenVideos).length, 800)
  assert.ok(!JSON.stringify(output).includes('fixture-secret'))
})

test('async lock callbacks are rejected before execution and orphan recovery gates fail closed', () => {
  const dir = temp(); const file = join(dir, 'transaction'); let called = false
  assert.throws(() => withFileLockSync(file, async () => { called = true }), /RECORD_LOCK_CALLBACK_MUST_BE_SYNC/)
  assert.equal(called, false); assert.equal(existsSync(file + '.lock'), false)
  write(dir, 'transaction.lock', JSON.stringify({ pid: 2147483647, token: 'dead' }))
  write(dir, 'transaction.lock.recover', 'orphaned recovery must be investigated')
  assert.throws(() => withFileLockSync(file, () => {}, { timeoutMs: 0 }), /RECORD_LOCK_BUSY/)
  assert.equal(JSON.parse(readFileSync(file + '.lock', 'utf8')).token, 'dead')
})

test('concurrent activity writers reconcile one identity to one durable event and projection', async () => {
  const dir = temp()
  const module = pathToFileURL(join(PLUGIN_DIR, 'lib', 'records.mjs')).href
  const jobs = Array.from({ length: 3 }, (_, worker) => new Promise((resolveJob, reject) => {
    const source = `import {appendActivityRecord} from ${JSON.stringify(module)}; for(let i=0;i<6;i++){ const r=appendActivityRecord(${JSON.stringify(dir)},{uid:'concurrent-'+i,t:1792540800000,kind:'read',text:'同一事件的合成样本'},{timeoutMs:10000}); if(!r.ok) throw new Error(r.error); }`
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'inherit' })
    child.once('error', reject); child.once('exit', (code) => code === 0 ? resolveJob(worker) : reject(new Error(`child exit ${code}`)))
  }))
  await Promise.all(jobs)
  assert.equal(readRecordEvents(dir, { type: 'activity' }).length, 6)
  assert.equal(readFileSync(join(dir, 'activity.jsonl'), 'utf8').trim().split('\n').length, 6)
})

test('clear during legacy migration transfers the cursor and finishes the archive exactly once', () => {
  const dir = temp(); const file = join(dir, 'activity.jsonl')
  write(dir, 'activity.jsonl', Array.from({ length: 40 }, (_, i) => JSON.stringify(row(`clear-${i}`))).join('\n') + '\n')
  assert.equal(importActivityFile(dir, file, { maxRows: 3 }).imported, 3)
  const rotated = rotateActivityLog(dir, { force: true })
  assert.ok(existsSync(rotated.archive)); assert.equal(readFileSync(file, 'utf8'), '')
  let imported = 0; let duplicates = 0; let more = true; let rounds = 0
  while (more && rounds++ < 30) {
    const r = importArchivedActivityChunk(dir, { maxRows: 4, maxBytes: 1024 })
    assert.equal(r.ok, true); assert.ok((r.bytesRead || 0) <= 1024)
    imported += r.imported; duplicates += r.duplicates; more = r.more
  }
  assert.equal(more, false); assert.equal(imported, 37); assert.equal(duplicates, 0)
  assert.equal(readRecordEvents(dir, { type: 'activity', limit: 100 }).length, 40)
  assert.equal(importArchivedActivityChunk(dir).processed, false)
})

test('preexisting raw archives are discovered one day at a time, not scanned every idle turn', () => {
  const dir = temp()
  for (const [day, id] of [['2026-01-01', 'archived-old-1'], ['2026-01-02', 'archived-old-2']]) {
    const folder = join(dir, 'records', 'activity', day); mkdirSync(folder, { recursive: true })
    write(folder, 'old.jsonl', JSON.stringify(row(id)) + '\n')
  }
  const a = importArchivedActivityChunk(dir); const b = importArchivedActivityChunk(dir)
  assert.equal(a.imported, 1); assert.equal(a.more, true); assert.equal(b.imported, 1)
  const queue = readJsonFileSync(join(dir, 'records', 'archive-imports.json'), null)
  assert.equal(queue.discovery.position, 2); assert.ok(queue.discovery.nextScanAt > Date.now())
  assert.equal(importArchivedActivityChunk(dir).discovered, 0)
  assert.equal(readRecordEvents(dir, { type: 'activity' }).length, 2)
})

test('damaged immutable archive tails are reported once and do not block another archive', () => {
  const dir = temp(); const folder = join(dir, 'records', 'activity', '2026-01-01'); mkdirSync(folder, { recursive: true })
  write(folder, 'a.jsonl', JSON.stringify(row('bad-tail-valid-row')) + '\n{"unfinished":')
  write(folder, 'b.jsonl', JSON.stringify(row('after-bad-tail')) + '\n')
  const before = digest(readFileSync(join(folder, 'a.jsonl')))
  let errors = 0; let more = true; let rounds = 0
  while (more && rounds++ < 10) { const r = importArchivedActivityChunk(dir); if (r.error === 'ACTIVITY_PARTIAL_LINE') errors++; more = r.more }
  assert.equal(more, false); assert.equal(errors, 1)
  assert.equal(digest(readFileSync(join(folder, 'a.jsonl'))), before)
  assert.equal(readRecordEvents(dir, { type: 'activity' }).length, 2)
  assert.equal(importArchivedActivityChunk(dir).processed, false)
})

test('corrupt archive queue prevents rotation without moving or truncating the live source', () => {
  const dir = temp(); appendActivityRecord(dir, row('queue-failure'))
  const before = digest(readFileSync(join(dir, 'activity.jsonl')))
  write(join(dir, 'records'), 'archive-imports.json', '{broken')
  assert.throws(() => rotateActivityLog(dir, { force: true }), SyntaxError)
  assert.equal(digest(readFileSync(join(dir, 'activity.jsonl'))), before)
  assert.equal(readRecordEvents(dir, { type: 'activity' }).length, 1)
})

test('event retry repairs missing projection/index receipts and never overwrites damaged canonical events', () => {
  const dir = temp(); const a = appendActivityRecord(dir, row('receipt-repair'))
  unlinkSync(a.path + '.indexed')
  const projection = join(dir, 'records', 'projected', a.eventId.slice(0, 2), a.eventId + '.json')
  unlinkSync(projection)
  assert.equal(appendActivityRecord(dir, row('receipt-repair')).duplicate, true)
  assert.equal(readActivityTail(dir).rows.length, 1); assert.equal(readRecordEvents(dir).length, 1)
  assert.ok(existsSync(projection)); assert.ok(existsSync(a.path + '.indexed'))
  writeFileSync(a.path, '{broken')
  assert.throws(() => appendActivityRecord(dir, row('receipt-repair')), SyntaxError)
  assert.equal(readFileSync(a.path, 'utf8'), '{broken')
})

test('large revocation audits keep every tombstone instead of truncating at 500', () => {
  const items = Object.fromEntries(Array.from({ length: 650 }, (_, i) => [`style:test${i}`, { id: `style:test${i}`, kind: 'style', text: `旧合成记录${i}`, state: 'rejected', from: 'fixture' }]))
  const r = learnForget({ items }, { kind: 'style' }); assert.equal(r.removed, 650)
  const dir = temp(); const saved = appendLearningRecord(dir, r.auditEvent)
  assert.equal(saved.ok, true); assert.equal(saved.event.data.revoked.length, 650); assert.equal(saved.event.data.removed, 650)
})

test('invalid taste metadata and likes do not enter sample counts or fictional causal conclusions', () => {
  const book = { broken: { text: '本鱼', likes: 900 }, '1': { text: '', likes: 9 } }
  let valid = tasteRemember(book, '2', { text: '本鱼记下一句话', likes: 20 })
  valid = tasteRemember(valid, '3', { text: '本鱼记下另一句话', likes: 0 })
  valid = tasteRemember(valid, '4', { text: '本鱼还想试试', likes: 0 })
  assert.equal(tasteStats(valid).sample, 3)
  const out = tasteApplyLikes(valid, [{ item_id: '3', count: 1e308 }])
  assert.equal(out.ledger['3'].likes, 0)
  const digest = tasteDigest(out.ledger).lines.join('\n')
  assert.ok(!digest.includes('那是那条视频本身火'))
  assert.ok(!JSON.stringify(tasteStats(out.ledger)).includes('Infinity'))
  assert.ok(!tasteMirror(valid).lines.join('\n').includes('不点自己'))
  assert.equal(seenStats({ BV1234567890: { at: 'not-a-date' } }).lastAt, '')
})

test('importing a valid row against a damaged canonical event fails without advancing its cursor', () => {
  const dir = temp(); const a = appendActivityRecord(dir, row('canonical-damaged'))
  writeFileSync(a.path, '{broken-canonical')
  write(dir, 'legacy.jsonl', JSON.stringify(row('canonical-damaged')) + '\n')
  assert.throws(() => importActivityFile(dir, join(dir, 'legacy.jsonl')), SyntaxError)
  const cursors = join(dir, 'records', 'imports')
  assert.equal(existsSync(cursors), false)
  assert.equal(readFileSync(a.path, 'utf8'), '{broken-canonical')
})

test('memory snapshots refuse a missing or altered predecessor instead of fabricating a new chain', () => {
  const dir = temp(); const a = captureMemorySnapshot(dir, 'soul.md', '合成想法甲', { mode: 'dafeiyu' })
  const heads = readFileSync(join(dir, 'records', 'memory-heads.json'), 'utf8')
  const previous = JSON.parse(readFileSync(a.path, 'utf8')); previous.data.text = '被意外改动的合成文本'
  writeFileSync(a.path, JSON.stringify(previous))
  assert.throws(() => captureMemorySnapshot(dir, 'soul.md', '合成想法乙', { mode: 'dafeiyu' }), /MEMORY_EVENT_INVALID/)
  assert.equal(readFileSync(join(dir, 'records', 'memory-heads.json'), 'utf8'), heads)
  unlinkSync(a.path)
  assert.throws(() => captureMemorySnapshot(dir, 'soul.md', '合成想法甲', { mode: 'dafeiyu' }), /MEMORY_EVENT_INVALID/)
  assert.equal(readFileSync(join(dir, 'records', 'memory-heads.json'), 'utf8'), heads)
})
