import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { MIN_TARGET_DURATION_RATIO, normalizeProduction, productionGuide, PRODUCTION_MODES, PRODUCTION_SCHEMA } from '../lib/pv-production.mjs'
import { createPv, PV_COVER_RUNTIME_CHECK, PV_PREFIX, PV_RUNTIME_CHECK } from '../lib/pv.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const sample = () => structuredClone(productionGuide().sample)

test('video dependency probes require supported Python and Pillow versions', () => {
  for (const check of [PV_RUNTIME_CHECK, PV_COVER_RUNTIME_CHECK]) {
    assert.match(check, /\(3,11\)<=sys\.version_info\[:2\]<\(3,14\)/)
    assert.match(check, /PIL\.__version__/)
    assert.match(check, />=13/)
  }
  assert.match(PV_RUNTIME_CHECK, /edge_tts,imageio_ffmpeg/)
  assert.doesNotMatch(PV_COVER_RUNTIME_CHECK, /edge_tts|imageio_ffmpeg/)
})

// Pure authored-plan boundary tests; no network, TTS, model or media processes.
test('guide sample is self-contained and normalizes without mutating the input', () => {
  const raw = sample()
  const before = JSON.stringify(raw)
  const plan = normalizeProduction(raw)
  assert.equal(JSON.stringify(raw), before)
  assert.equal(plan.schema, PRODUCTION_SCHEMA)
  assert.deepEqual(PRODUCTION_MODES, ['daily', 'rant', 'highlights', 'custom'])
  assert.deepEqual(plan.shots.map((s) => s.speaker), ['fish', 'inner', 'fish'])
  assert.equal(plan.shots[1].voice.name, 'zh-CN-YunxiNeural')
  assert.match(plan.disclosure, /虚构演绎/)
  assert.match(plan.disclosure, /虚构内心角色/)
  assert.equal(plan.shots[0].kind, 'dialogue')
  assert.equal(plan.shots[0].prop, 'rice')
  assert.equal(plan.maxDurationSec, 40)
  assert.ok(plan.estimatedDurationSec > 15)
  assert.deepEqual(normalizeProduction(JSON.stringify(raw)), plan)
})

test('default dates and budgets stay bounded and options inject voice only through trusted config', () => {
  const raw = sample()
  delete raw.date
  delete raw.targetDurationSec
  delete raw.maxDurationSec
  const plan = normalizeProduction(raw, { date: '2024-02-29', voice: { name: 'host-voice', rate: '+4%' },
    gsv: { gsvRepo: 'D:\\voice', gsvRef: 'D:\\voice\\reference.wav', gsvPrompt: 'host reference' } })
  assert.equal(plan.date, '2024-02-29')
  assert.equal(plan.targetDurationSec, 150)
  assert.equal(plan.maxDurationSec, 165)
  assert.equal(plan.voice.name, 'host-voice')
  assert.equal(plan.voice.gsvRepo, 'D:\\voice')
  assert.equal(plan.shots[1].voice.mode, 'edge')
  assert.equal(normalizeProduction(raw).date.length, 10)
})

test('all supported authored camera/expression/prop fields survive without templates', () => {
  const raw = sample()
  raw.mode = 'rant'
  raw.shots[0].camera = 'insert'
  raw.shots[0].expression = 'worried'
  delete raw.shots[0].prop
  raw.shots[0].props = ['note']
  const plan = normalizeProduction(raw)
  assert.equal(plan.mode, 'rant')
  assert.equal(plan.shots[0].camera, 'insert')
  assert.equal(plan.shots[0].expression, 'worried')
  assert.equal(plan.shots[0].prop, 'note')
  assert.equal(plan.shots[0].text, raw.shots[0].text)
  assert.equal(plan.title, raw.title)
})

test('daily requires dated grounded sources, valid source ids and honest quote provenance', () => {
  const raw = sample()
  raw.mode = 'daily'
  assert.throws(() => normalizeProduction(raw), /daily/)
  raw.sources = [{ id: 'record-1', title: '当日公开冲浪记录', bvid: 'BV1Ab411c7xy', date: raw.date,
    kind: 'public-record', excerpt: raw.shots[0].text, eventId: 'public-event-1' }]
  raw.shots[0].source_ids = ['record-1']
  raw.shots[0].provenance = 'source-quote'
  const plan = normalizeProduction(raw)
  assert.equal(plan.sources[0].url, 'https://www.bilibili.com/video/BV1Ab411c7xy')
  assert.equal(plan.shots[0].provenance, 'source-quote')
  raw.shots[0].text = '这句不在公开来源原文里面。'
  assert.throws(() => normalizeProduction(raw), /excerpt/)
  raw.shots[0].provenance = 'record-adaptation'
  raw.sources[0].date = '2026-10-20'
  assert.throws(() => normalizeProduction(raw), /同一天/)
  raw.sources[0].date = raw.date
  raw.shots[0].source_ids = ['missing']
  assert.throws(() => normalizeProduction(raw), /找不到来源/)
})

for (const [label, mutate, pattern] of [
  ['unknown schema', (p) => { p.schema = 'other' }, /schema/],
  ['invalid real date', (p) => { p.date = '2026-02-29' }, /日期/],
  ['invalid mode', (p) => { p.mode = 'template' }, /mode/],
  ['speaker injection', (p) => { p.shots[0].speaker = 'narrator' }, /speaker/],
  ['voice injection', (p) => { p.voice = { gsvPython: 'bad.exe' } }, /voice/],
  ['shot voice injection', (p) => { p.shots[0].voice = 'bad' }, /voice/],
  ['local media path', (p) => { p.shots[0].file = 'C:\\secret.png' }, /file/],
  ['unsupported quote alias', (p) => { p.shots[0].quote_ids = ['x'] }, /quote_ids/],
  ['unsupported camera', (p) => { p.shots[0].camera = 'drone' }, /camera/],
  ['unsupported expression', (p) => { p.shots[0].expression = 'evil' }, /expression/],
  ['unsupported prop', (p) => { p.shots[0].prop = 'computer' }, /prop/],
  ['multiple props', (p) => { delete p.shots[0].prop; p.shots[0].props = ['rice', 'note'] }, /props/],
  ['duplicate shot ids', (p) => { p.shots[1].id = p.shots[0].id }, /ID重复/],
  ['long line rejects without truncation', (p) => { p.shots[0].text = '鱼'.repeat(85) }, /最多 84 字/],
  ['long title', (p) => { p.title = '鱼'.repeat(101) }, /最多 100 字/],
  ['placeholder cover', (p) => { p.cover.title = '日报' }, /具体事件标题/],
  ['duration over hard maximum', (p) => { p.maxDurationSec = 301 }, /300/],
  ['duration under minimum', (p) => { p.targetDurationSec = 14 }, /15/],
  ['empty shots', (p) => { p.shots = [] }, /1..40/],
  ['too many shots', (p) => { p.shots = Array.from({ length: 41 }, (_, i) => ({ speaker: 'fish', text: '鱼', id: `s${i}` })) }, /1..40/],
]) {
  test(`rejects ${label}`, () => {
    const raw = sample()
    mutate(raw)
    assert.throws(() => normalizeProduction(raw), pattern)
  })
}

test('duration estimation enforces the whole text and minimum shot time', () => {
  const raw = sample()
  raw.targetDurationSec = 15
  raw.maxDurationSec = 15
  raw.shots = [{ speaker: 'fish', text: '鱼'.repeat(84) }]
  assert.throws(() => normalizeProduction(raw), /超过 15 秒预算/)
  raw.shots = Array.from({ length: 10 }, () => ({ speaker: 'fish', text: '鱼' }))
  assert.throws(() => normalizeProduction(raw), /超过 15 秒预算/)
  raw.targetDurationSec = 300
  raw.maxDurationSec = 300
  raw.shots = [{ speaker: 'fish', text: '鱼'.repeat(84) }]
  assert.throws(() => normalizeProduction(raw), /目标 300 秒的60%/)
})

test('explicit target duration requires meaningful coverage while legacy plans stay compatible', () => {
  const boundary = sample()
  boundary.targetDurationSec = 15
  boundary.maxDurationSec = 15
  boundary.gap = 0
  boundary.lead = 1
  boundary.tail = 0
  boundary.shots = Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, speaker: 'fish', text: '鱼' }))
  const accepted = normalizeProduction(boundary)
  assert.equal(MIN_TARGET_DURATION_RATIO, 0.6)
  assert.equal(accepted.estimatedDurationSec, 9)

  boundary.lead = 0.999
  assert.throws(() => normalizeProduction(boundary), /预计 9\.00 秒.*目标 15 秒的60%.*有意义的场景和旁白/)

  const legacy = sample()
  delete legacy.targetDurationSec
  delete legacy.maxDurationSec
  legacy.shots = [{ speaker: 'fish', text: '鱼' }]
  assert.equal(normalizeProduction(legacy).estimatedDurationSec, 2.68)
})

test('sources reject local URLs, credentials, invalid BV and unknown paths', () => {
  for (const url of ['file:///C:/secret', 'https://localhost/x', 'https://127.0.0.1/x', 'https://user:pass@example.com/x']) {
    const raw = sample()
    raw.sources = [{ id: 'source', title: '来源', url }]
    assert.throws(() => normalizeProduction(raw), /公开 HTTPS/)
  }
  const raw = sample()
  raw.sources = [{ id: 'source', title: '来源', bvid: 'wrong' }]
  assert.throws(() => normalizeProduction(raw), /BV 号/)
  raw.sources = [{ id: 'source', title: '来源', url: 'https://example.com/record', path: 'private.json' }]
  assert.throws(() => normalizeProduction(raw), /path/)
})

const FAKE_COVER = String.raw`import struct,sys
from pathlib import Path
out = Path(sys.argv[sys.argv.index('--outdir') + 1])
for name,w,h in [('封面_16x9.png',1920,1080),('封面_4x3.png',1440,1080)]:
    (out/name).write_bytes(b'\x89PNG\r\n\x1a\n'+bytes(8)+struct.pack('>II',w,h)+bytes(12))
`
const FAKE_RENDER = `import json,os,sys,time
from pathlib import Path
if os.environ.get('PV_TEST_RENDER_WAIT') == '1':
    time.sleep(10)
args = sys.argv
out = Path(args[args.index('--out') + 1]); out.write_bytes(b'authored-film' + bytes(1500))
work = Path(args[args.index('--work') + 1]); work.mkdir(parents=True,exist_ok=True)
(work/'timeline.json').write_text(json.dumps({'authored': True}),encoding='utf8')
`
const FAKE_VERIFY = `import json,os,sys,time
from pathlib import Path
out = Path(sys.argv[sys.argv.index('--outdir') + 1])
if os.environ.get('PV_TEST_VERIFY_WAIT') == '1':
    time.sleep(10)
ok = os.environ.get('PV_TEST_VERIFY_FAIL') != '1'
(out/'verification.json').write_text(json.dumps({'ok':ok,'argv':sys.argv[1:]}),encoding='utf8')
raise SystemExit(0 if ok else 9)
`
async function fixture(run) {
  const root = mkdtempSync(join(here, '.tmp-production-'))
  const state = join(root, 'state'), plugin = join(root, 'plugin'), out = join(root, 'out'), work = join(root, 'work')
  for (const path of [state, join(plugin, 'lib'), out, work]) mkdirSync(path, { recursive: true })
  for (const [name, content] of [['pv.py', FAKE_RENDER], ['pv_cover.py', FAKE_COVER], ['pv_verify.py', FAKE_VERIFY]]) {
    writeFileSync(join(plugin, 'lib', name), content)
  }
  const controllers = []
  const controller = (env = {}, extra = {}) => {
    const pv = createPv({ stateDir: state, pluginDir: plugin, python: () => process.env.PV_TEST_PYTHON || 'python',
      dirs: () => ({ out, work, root }), env: { ...process.env, ...env }, ...extra })
    controllers.push(pv)
    return pv
  }
  try { await run({ root, out, controller }) }
  finally {
    for (const pv of controllers) pv.stop()
    for (const pv of controllers) await until(pv, (s) => !s.running)
    assert.ok(root.startsWith(join(here, '.tmp-production-')))
    rmSync(root, { recursive: true, force: true })
  }
}
async function until(pv, predicate) {
  for (let i = 0; i < 300; i++) {
    const state = pv.status()
    if (predicate(state)) return state
    await delay(20)
  }
  throw new Error('authored production did not reach expected state')
}

test('authored jobs isolate repeated/concurrent outputs and retain every publication artifact', async () => {
  await fixture(async ({ out, controller }) => {
    const legacy = join(out, `${PV_PREFIX}_2026-10-21.mp4`)
    writeFileSync(legacy, Buffer.alloc(1600, 41))
    const a = controller(), b = controller()
    const first = a.render(sample()), parallel = b.render(JSON.stringify(sample()))
    assert.equal(first.started, true, first.error)
    assert.equal(parallel.started, true, parallel.error)
    assert.notEqual(first.id, parallel.id)
    assert.notEqual(first.work, parallel.work)
    assert.equal(first.production.path, first.work)
    assert.equal(first.production.status, 'cover')
    assert.equal(a.render(sample()).ok, false)
    assert.equal(a.productionFileOf(first.id), '')
    const completed = await until(a, (s) => s.stage === 'done' && !s.running)
    await until(b, (s) => s.stage === 'done' && !s.running)
    assert.equal(completed.production.id, first.id)
    const second = a.render(sample())
    await until(a, (s) => s.stage === 'done' && !s.running)
    assert.notEqual(second.id, first.id)
    for (const started of [first, parallel, second]) {
      for (const name of ['plan.json', 'timeline.json', 'build.log', 'verification.json', 'production.json', 'video.mp4', '封面_16x9.png', '封面_4x3.png']) {
        assert.ok(existsSync(join(started.work, name)), name)
      }
      const receipt = JSON.parse(readFileSync(started.verification, 'utf8'))
      assert.equal(receipt.ok, true)
      assert.equal(receipt.video, started.file, 'receipt exposes the published file, not the now-renamed temporary path')
      assert.equal(receipt.verifiedVideo, started.file, 'verification receipt points at the durable published bytes')
      assert.equal(receipt.verificationInput, 'video.partial.mp4', 'temporary input name is retained without a stale absolute path')
      assert.deepEqual(receipt.argv.slice(receipt.argv.indexOf('--target-duration'), receipt.argv.indexOf('--target-duration') + 2), ['--target-duration', '30'])
      assert.equal(JSON.parse(readFileSync(join(started.work, 'production.json'), 'utf8')).status, 'done')
      assert.equal(a.productionFileOf(started.id), started.file)
    }
    assert.equal(a.productions().length, 3)
    assert.equal(a.status().productions.length, 3)
    assert.equal(a.list().length, 1)
    assert.deepEqual(readFileSync(legacy), Buffer.alloc(1600, 41))
    assert.equal(a.productionFileOf('../escape'), '')
    assert.equal(a.productionFileOf(first.id.toUpperCase()), '')
    const bad = `${first.id.slice(0, -1)}${first.id.endsWith('0') ? '1' : '0'}`
    symlinkSync(first.work, join(out, 'studio', bad), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(a.productionFileOf(bad), '')
    assert.equal(a.productions().length, 3)
  })
})

test('failed verification keeps the authored job private and records failure stage', async () => {
  await fixture(async ({ controller }) => {
    const pv = controller({ PV_TEST_VERIFY_FAIL: '1' })
    const started = pv.render(sample())
    const status = await until(pv, (s) => s.stage === 'failed' && !s.running)
    assert.equal(status.production.status, 'failed')
    assert.equal(status.failures[0].stage, 'verify')
    assert.equal(pv.productionFileOf(started.id), '')
    assert.equal(pv.productions().length, 0)
    assert.equal(existsSync(started.file), false)
    assert.ok(existsSync(join(started.work, 'video.partial.mp4')))
  })
})

test('cancelled authored verify never publishes and rejects jobs until its child exits', async () => {
  await fixture(async ({ controller }) => {
    const pv = controller({ PV_TEST_VERIFY_WAIT: '1' })
    const started = pv.render(sample())
    await until(pv, (s) => s.stage === 'verify')
    pv.stop()
    assert.equal(pv.status().stage, 'stopped')
    assert.equal(pv.status().running, true)
    assert.equal(pv.render(sample()).ok, false)
    await until(pv, (s) => !s.running)
    assert.equal(pv.status().stage, 'stopped')
    assert.equal(pv.productionFileOf(started.id), '')
    assert.equal(pv.productions().length, 0)
    assert.equal(existsSync(started.file), false)
    assert.equal(JSON.parse(readFileSync(join(started.work, 'production.json'), 'utf8')).status, 'stopped')
  })
})

test('normalization failures return immediately without making any studio jobs', async () => {
  await fixture(async ({ out, controller }) => {
    const pv = controller()
    assert.equal(pv.render('{bad json').ok, false)
    assert.equal(pv.render({ ...sample(), voice: { gsvPython: 'bad.exe' } }).ok, false)
    assert.equal(existsSync(join(out, 'studio')), false)
    assert.equal(pv.status().running, false)
  })
})
