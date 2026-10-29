import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createPv, listPv, pvDateOk, pvFileOf, PV_PREFIX } from '../lib/pv.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const python = process.env.PV_TEST_PYTHON || 'python'

// Minimal valid 1920x1080 / 1440x1080 PNG headers: the coordinator checks
// dimensions, not pixels. No Pillow is needed by this fixture.
const FAKE_COVER = String.raw`
import os, struct, sys, zlib
from pathlib import Path
args = sys.argv
outdir = Path(args[args.index('--outdir') + 1])
only_missing = '--only-missing' in args
if os.environ.get('PV_FAKE_COVER_FAIL') == '1':
    raise SystemExit(3)
def png(width, height):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IEND', b'')
for name, size in (('封面_16x9.png', (1920, 1080)), ('封面_4x3.png', (1440, 1080))):
    target = outdir / name
    if only_missing and target.is_file() and target.stat().st_size > 24:
        continue
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(png(*size))
`

const FAKE_PLAN = `import json,sys
from pathlib import Path
p = Path(sys.argv[sys.argv.index('-o')+1])
p.write_text(json.dumps({'date': p.stem.replace('plan_',''), 'cover': {'title': '蜻蜓的产房没了'},
                         'shots': [{'kind': 'story', 'title': '蜻蜓的产房没了', 'text': 'fixture'}]}, ensure_ascii=False), encoding='utf-8')
`

const FAKE_RENDER = `import os,sys,time
from pathlib import Path
if os.environ.get('PV_FAKE_FAIL') == '1':
    raise SystemExit(7)
marker = os.environ.get('PV_RENDER_MARKER')
if marker:
    Path(marker).write_text('rendered', encoding='utf-8')
if os.environ.get('PV_FAKE_RENDER_WAIT') == '1':
    time.sleep(10)
out = Path(sys.argv[sys.argv.index('--out')+1]); out.parent.mkdir(parents=True, exist_ok=True)
out.write_bytes(b'new-render' + bytes(1600))
work = Path(sys.argv[sys.argv.index('--work')+1]); work.mkdir(parents=True, exist_ok=True)
(work / 'timeline.json').write_text('{}', encoding='utf-8')
`

const FAKE_VERIFY = `import json,os,sys,time
from pathlib import Path
args = sys.argv
outdir = Path(args[args.index('--outdir') + 1])
marker = os.environ.get('PV_VERIFY_MARKER')
if marker:
    Path(marker).write_text('verifying', encoding='utf-8')
if os.environ.get('PV_FAKE_VERIFY_WAIT') == '1':
    time.sleep(10)
if os.environ.get('PV_FAKE_VERIFY_FAIL') == '1':
    (outdir / 'verification.json').write_text(json.dumps({'ok': False}), encoding='utf-8')
    raise SystemExit(9)
if os.environ.get('PV_FAKE_VERIFY_RECEIPT') != 'missing':
    receipt = {'ok': True, 'maxDuration': args[args.index('--max-duration') + 1]}
    if os.environ.get('PV_FAKE_VERIFY_RECEIPT') == 'false':
        receipt['ok'] = False
    (outdir / 'verification.json').write_text(json.dumps(receipt), encoding='utf-8')
`

async function fixture(run) {
  const root = mkdtempSync(join(here, '.tmp-pv-'))
  const state = join(root, 'state')
  const plugin = join(root, 'plugin')
  const work = join(root, 'work')
  const out = join(root, 'out')
  for (const path of [state, join(plugin, 'lib'), work, out]) mkdirSync(path, { recursive: true })
  // A stale home copy must never win script selection.
  for (const name of ['pv.py', 'pv_plan.py', 'pv_cover.py', 'pv_verify.py']) {
    writeFileSync(join(state, name), 'raise RuntimeError("stale home script used")\n')
  }
  writeFileSync(join(plugin, 'lib', 'pv_plan.py'), FAKE_PLAN, 'utf-8')
  writeFileSync(join(plugin, 'lib', 'pv.py'), FAKE_RENDER, 'utf-8')
  writeFileSync(join(plugin, 'lib', 'pv_cover.py'), FAKE_COVER, 'utf-8')
  writeFileSync(join(plugin, 'lib', 'pv_verify.py'), FAKE_VERIFY, 'utf-8')
  try { await run({ root, state, plugin, work, out }) }
  finally {
    assert.ok(root.startsWith(join(here, '.tmp-pv-')))
    rmSync(root, { recursive: true, force: true })
  }
}

async function settled(controller) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const state = controller.status()
    if (state.stage === 'done' || state.stage === 'failed') return state
    await delay(20)
  }
  controller.stop()
  throw new Error('video coordinator did not settle within test timeout')
}

async function until(controller, predicate) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const status = controller.status()
    if (predicate(status)) return status
    await delay(20)
  }
  controller.stop()
  throw new Error('video coordinator did not reach expected state')
}

const dayDir = (out, day) => join(out, day)
const dayMovie = (out, day) => join(dayDir(out, day), `${PV_PREFIX}_${day}.mp4`)

test('video dates require real calendar dates', () => {
  for (const day of ['2024-02-29', '2026-10-21']) assert.equal(pvDateOk(day), true)
  for (const day of ['2026-02-29', '2026-04-31', '2026-00-01', '2026-1-01', 'foo', '../2026-10-21']) {
    assert.equal(pvDateOk(day), false)
  }
})

test('listing prefers dated folders and still sees legacy flat files', async () => {
  await fixture(async ({ out }) => {
    mkdirSync(dayDir(out, '2026-10-21'))
    writeFileSync(dayMovie(out, '2026-10-21'), Buffer.alloc(1500))
    writeFileSync(join(out, `${PV_PREFIX}_2026-10-21.mp4`), Buffer.alloc(1300))
    writeFileSync(join(out, `${PV_PREFIX}_2026-10-20.mp4`), Buffer.alloc(1500))
    writeFileSync(join(out, `${PV_PREFIX}_2026-10-19.partial.mp4`), Buffer.alloc(1500))
    writeFileSync(join(out, `${PV_PREFIX}_2026-10-18.mp4`), Buffer.alloc(0))
    mkdirSync(join(out, `${PV_PREFIX}_2026-10-17.mp4`))
    mkdirSync(dayDir(out, '2026-13-01'))
    const rows = listPv(out)
    assert.deepEqual(rows.map((x) => x.date), ['2026-10-21', '2026-10-20'])
    assert.equal(rows[0].file, dayMovie(out, '2026-10-21'))
    assert.equal(rows[0].canonical, true)
    assert.equal(pvFileOf(out, '2026-10-20'), join(out, `${PV_PREFIX}_2026-10-20.mp4`))
    assert.equal(pvFileOf(out, '2026-10-18'), dayMovie(out, '2026-10-18'))
  })
})

test('successful render publishes movie and both covers into the dated folder', async () => {
  await fixture(async ({ state, plugin, work, out }) => {
    const controller = createPv({ stateDir: state, pluginDir: plugin, python: () => python,
      dirs: () => ({ root: out, out, work, legacy: out, legacyDirs: [out] }),
      env: { ...process.env, PV_FAKE_FAIL: '0' } })
    const started = controller.start('2026-10-21', { force: true })
    assert.equal(started.started, true)
    const status = await settled(controller)
    assert.equal(status.stage, 'done', status.tail)
    assert.equal(status.file, dayMovie(out, '2026-10-21'))
    assert.equal(readFileSync(dayMovie(out, '2026-10-21')).subarray(0, 10).toString(), 'new-render')
    assert.equal(readFileSync(join(dayDir(out, '2026-10-21'), '封面_16x9.png')).readUInt32BE(16), 1920)
    assert.equal(readFileSync(join(dayDir(out, '2026-10-21'), '封面_4x3.png')).readUInt32BE(16), 1440)
    assert.ok(existsSync(status.plan))
    assert.ok(existsSync(status.timeline))
    assert.equal(JSON.parse(readFileSync(status.verification, 'utf8')).ok, true)
    for (const name of ['plan.json', 'timeline.json', 'build.log', 'verification.json', 'job.json']) {
      assert.ok(existsSync(join(dayDir(out, '2026-10-21'), name)), name)
    }
    assert.equal(existsSync(join(out, `${PV_PREFIX}_2026-10-21.mp4`)), false)
  })
})

test('failed render retains the previous published movie and covers', async () => {
  await fixture(async ({ state, plugin, work, out }) => {
    const movie = dayMovie(out, '2026-10-21')
    const previous = Buffer.alloc(1400, 66)
    mkdirSync(dayDir(out, '2026-10-21'))
    writeFileSync(movie, previous)
    const controller = createPv({ stateDir: state, pluginDir: plugin, python: () => python,
      dirs: () => ({ root: out, out, work, legacy: out, legacyDirs: [out] }),
      env: { ...process.env, PV_FAKE_FAIL: '1' } })
    controller.start('2026-10-21', { force: true })
    const status = await settled(controller)
    assert.equal(status.stage, 'failed')
    assert.match(status.error, /exit 7/)
    assert.deepEqual(readFileSync(movie), previous)
  })
})

test('cover failure is a package failure, not a silent delivery', async () => {
  await fixture(async ({ state, plugin, work, out }) => {
    const controller = createPv({ stateDir: state, pluginDir: plugin, python: () => python,
      dirs: () => ({ root: out, out, work, legacy: out, legacyDirs: [out] }),
      env: { ...process.env, PV_FAKE_FAIL: '0', PV_FAKE_COVER_FAIL: '1' } })
    controller.start('2026-10-21', { force: true })
    const status = await settled(controller)
    assert.equal(status.stage, 'failed')
    assert.match(status.error, /封面生成失败/)
    assert.equal(existsSync(dayMovie(out, '2026-10-21')), false)
  })
})

test('existing movie with missing covers repairs only artwork, never renders', async () => {
  await fixture(async ({ state, plugin, work, out }) => {
    const marker = join(out, 'render-was-called')
    mkdirSync(dayDir(out, '2026-10-21'))
    const movie = dayMovie(out, '2026-10-21')
    const previous = Buffer.alloc(1400, 67)
    writeFileSync(movie, previous)
    const controller = createPv({ stateDir: state, pluginDir: plugin, python: () => python,
      dirs: () => ({ root: out, out, work, legacy: out, legacyDirs: [out] }),
      env: { ...process.env, PV_FAKE_FAIL: '0', PV_RENDER_MARKER: marker } })
    const started = controller.start('2026-10-21')
    assert.equal(started.started, true)
    assert.equal(started.repairing, true)
    assert.equal(started.verificationSkipped, true)
    const status = await settled(controller)
    assert.equal(status.stage, 'done', status.tail)
    assert.equal(existsSync(marker), false)
    assert.deepEqual(readFileSync(movie), previous)
    assert.ok(existsSync(join(dayDir(out, '2026-10-21'), '封面_16x9.png')))
    assert.ok(existsSync(join(dayDir(out, '2026-10-21'), '封面_4x3.png')))
  })
})

test('verifier exit failure preserves the full previous daily package and failure history', async () => {
  await fixture(async ({ state, plugin, work, out }) => {
    const previous = Buffer.alloc(1400, 70)
    mkdirSync(dayDir(out, '2026-10-21'))
    writeFileSync(dayMovie(out, '2026-10-21'), previous)
    writeFileSync(join(dayDir(out, '2026-10-21'), '封面_16x9.png'), 'previous-cover')
    writeFileSync(join(dayDir(out, '2026-10-21'), 'verification.json'), '{"ok":true,"old":true}')
    const controller = createPv({ stateDir: state, pluginDir: plugin, python: () => python,
      dirs: () => ({ root: out, out, work }), env: { ...process.env, PV_FAKE_VERIFY_FAIL: '1' } })
    controller.start('2026-10-21', { force: true })
    const status = await settled(controller)
    assert.equal(status.stage, 'failed')
    assert.match(status.error, /成片校验失败.*exit 9/)
    assert.deepEqual(readFileSync(dayMovie(out, '2026-10-21')), previous)
    assert.equal(readFileSync(join(dayDir(out, '2026-10-21'), '封面_16x9.png'), 'utf8'), 'previous-cover')
    assert.equal(JSON.parse(readFileSync(join(dayDir(out, '2026-10-21'), 'verification.json'), 'utf8')).old, true)
    assert.equal(status.failures[0].stage, 'verify')
  })
})

for (const receipt of ['false', 'missing']) {
  test(`zero-exit verifier still fails when explicit receipt is ${receipt}`, async () => {
    await fixture(async ({ state, plugin, work, out }) => {
      const controller = createPv({ stateDir: state, pluginDir: plugin, python: () => python,
        dirs: () => ({ root: out, out, work }), env: { ...process.env, PV_FAKE_VERIFY_RECEIPT: receipt } })
      controller.start('2026-10-21', { force: true })
      const status = await settled(controller)
      assert.equal(status.stage, 'failed')
      assert.match(status.error, /verification.json/)
      assert.equal(existsSync(dayMovie(out, '2026-10-21')), false)
    })
  })
}

test('verify is running and stop blocks a competing start until the process closes', async () => {
  await fixture(async ({ state, plugin, work, out }) => {
    const marker = join(out, 'verify-started')
    const controller = createPv({ stateDir: state, pluginDir: plugin, python: () => python,
      dirs: () => ({ root: out, out, work }),
      env: { ...process.env, PV_VERIFY_MARKER: marker, PV_FAKE_VERIFY_WAIT: '1' } })
    controller.start('2026-10-21', { force: true })
    const verifying = await until(controller, (status) => status.stage === 'verify' && existsSync(marker))
    assert.equal(verifying.running, true)
    assert.equal(controller.start('2026-10-22').ok, false)
    const stopped = controller.stop()
    assert.equal(stopped.stopped, true)
    assert.equal(controller.status().stage, 'stopped')
    assert.equal(controller.status().running, true)
    assert.equal(controller.start('2026-10-22').ok, false)
    await until(controller, (status) => !status.running)
    assert.equal(existsSync(dayMovie(out, '2026-10-21')), false)
    assert.equal(controller.status().stage, 'stopped')
    assert.equal(controller.status().failures.length, 0)
  })
})

test('total job timeout remains failed and cannot publish after the child exits', async () => {
  await fixture(async ({ state, plugin, work, out }) => {
    const controller = createPv({ stateDir: state, pluginDir: plugin, python: () => python,
      dirs: () => ({ root: out, out, work }), timeoutMs: 120,
      env: { ...process.env, PV_FAKE_RENDER_WAIT: '1' } })
    controller.start('2026-10-21', { force: true })
    await until(controller, (status) => status.stage === 'failed' && !status.running)
    const status = controller.status()
    assert.match(status.error, /总时限/)
    assert.equal(status.failures.length, 1)
    assert.equal(existsSync(dayMovie(out, '2026-10-21')), false)
  })
})

test('legacy flat movie is archived without re-rendering the film', async () => {
  await fixture(async ({ state, plugin, work, out }) => {
    const marker = join(out, 'render-was-called')
    const legacy = join(out, `${PV_PREFIX}_2026-10-21.mp4`)
    const previous = Buffer.alloc(1400, 68)
    writeFileSync(legacy, previous)
    const controller = createPv({ stateDir: state, pluginDir: plugin, python: () => python,
      dirs: () => ({ root: out, out, work, legacy: out, legacyDirs: [out] }),
      env: { ...process.env, PV_FAKE_FAIL: '0', PV_RENDER_MARKER: marker } })
    const started = controller.start('2026-10-21')
    assert.equal(started.repairing, true)
    assert.equal(started.verificationSkipped, true)
    const status = await settled(controller)
    assert.equal(status.stage, 'done', status.tail)
    assert.equal(existsSync(marker), false)
    assert.deepEqual(readFileSync(dayMovie(out, '2026-10-21')), previous)
    assert.ok(existsSync(join(dayDir(out, '2026-10-21'), '封面_4x3.png')))
  })
})
