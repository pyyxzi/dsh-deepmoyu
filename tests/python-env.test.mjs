import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectMainEnvironment, environmentPython, MAIN_ENV_PACKAGES, MAIN_PYTHON_RANGE } from '../lib/python-env.mjs'

function fixture(t, { python = '3.12.10', pillow = '13.0.0', platform = process.platform, distInfo = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fish-python-env-')), root = join(home, '.venv')
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const executable = environmentPython(root, platform)
  mkdirSync(join(executable, '..'), { recursive: true }); writeFileSync(executable, 'synthetic executable, never launched')
  writeFileSync(join(root, 'pyvenv.cfg'), `version_info = ${python}.final.0\n`)
  const site = platform === 'win32' ? join(root, 'Lib', 'site-packages') : join(root, 'lib', 'python3.12', 'site-packages')
  for (const name of MAIN_ENV_PACKAGES) mkdirSync(join(site, name), { recursive: true })
  if (distInfo) {
    const metadata = join(site, `pillow-${pillow}.dist-info`); mkdirSync(metadata)
    writeFileSync(join(metadata, 'METADATA'), `Name: pillow\nVersion: ${pillow}\n`)
  } else writeFileSync(join(site, 'PIL', '_version.py'), `__version__ = '${pillow}'\n`)
  return { home, root, executable, site }
}

test('missing environments stay missing; metadata checks never create directories or run an interpreter', t => {
  const home = mkdtempSync(join(tmpdir(), 'fish-python-missing-')); t.after(() => rmSync(home, { recursive: true, force: true }))
  const root = join(home, 'missing'), value = inspectMainEnvironment(root)
  assert.equal(value.ready, false); assert.equal(value.exists, false); assert.equal(existsSync(root), false)
  assert.equal(MAIN_PYTHON_RANGE, '>=3.11,<3.14')
})

for (const [python, pillow, ready] of [['3.10.19', '12.3.0', false], ['3.11.14', '12.3.0', false], ['3.11.14', '13.0.0', true], ['3.13.9', '13.0.0', true], ['3.14.0', '13.0.0', false]]) {
  test(`metadata readiness requires a compatible Python and Pillow: ${python}/${pillow}`, t => {
    const f = fixture(t, { python, pillow }), value = inspectMainEnvironment(f.root)
    assert.equal(value.ready, ready); assert.equal(value.pythonVersion, python); assert.equal(value.pillowVersion, pillow)
    if (!ready) assert.equal(value.upgradeRequired, true)
  })
}

test('POSIX layouts and distribution metadata report exact versions; missing or ambiguous versions fail closed', t => {
  const f = fixture(t, { platform: 'linux', distInfo: true })
  assert.equal(inspectMainEnvironment(f.root, { platform: 'linux' }).ready, true)
  writeFileSync(join(f.root, 'pyvenv.cfg'), 'home = /synthetic/python\n')
  assert.equal(inspectMainEnvironment(f.root, { platform: 'linux' }).ready, false)
  writeFileSync(join(f.root, 'pyvenv.cfg'), 'version = 3.12.10\n')
  const conflict = join(f.site, 'Pillow-12.3.0.dist-info'); mkdirSync(conflict)
  writeFileSync(join(conflict, 'METADATA'), 'Version: 12.3.0\n')
  assert.equal(inspectMainEnvironment(f.root, { platform: 'linux' }).pillowCompatible, false)
})

test('package prefix lookalikes and a PIL directory without a version cannot create false readiness', t => {
  const f = fixture(t)
  rmSync(join(f.site, 'mcp'), { recursive: true }); mkdirSync(join(f.site, 'mcp_unrelated'))
  rmSync(join(f.site, 'PIL', '_version.py'))
  const value = inspectMainEnvironment(f.root)
  assert.equal(value.ready, false); assert.ok(value.missing.includes('mcp')); assert.equal(value.pillowCompatible, false)
})

test('a failed or damaged runtime receipt stays unready until an explicit successful recheck', t => {
  const f = fixture(t), file = join(f.root, 'deepmoyu-health.json')
  for (const text of ['{"ok":false}', '{damaged']) {
    writeFileSync(file, text)
    assert.equal(inspectMainEnvironment(f.root).ready, false)
    assert.equal(inspectMainEnvironment(f.root, { ignoreRuntimeFailure: true }).ready, true)
  }
  writeFileSync(file, '{"ok":true}')
  assert.equal(inspectMainEnvironment(f.root).ready, true)
})
