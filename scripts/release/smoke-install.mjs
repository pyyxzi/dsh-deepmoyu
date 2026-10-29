import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { root, manifest, npm } from './paths.mjs'

const pkg = manifest()
const artifact = join(root, 'release', `${pkg.name}-${pkg.version}.tgz`)
assert.ok(existsSync(artifact), 'Run npm run release:build first')
const base = resolve(process.env.RELEASE_TMPDIR || process.env.QA_OUTPUT_DIR || tmpdir())
mkdirSync(base, { recursive: true })
const sandbox = mkdtempSync(join(base, 'deepmoyu-clean-install-'))
try {
  writeFileSync(join(sandbox, 'package.json'), JSON.stringify({ name: 'deepmoyu-release-smoke', private: true,
    version: '1.0.0', dependencies: { [pkg.name]: 'file:' + artifact.replaceAll('\\', '/') } }, null, 2))
  const registry = process.env.RELEASE_NPM_REGISTRY || 'https://registry.npmjs.org'
  npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=' + registry], { cwd: sandbox })
  const installed = join(sandbox, 'node_modules', pkg.name)
  const actual = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  assert.equal(actual.version, pkg.version)
  assert.deepEqual(actual.scripts, { check: 'node selfcheck.mjs' }, 'Runtime tarball must not reference omitted development scripts')
  assert.equal(actual.devDependencies, undefined)
  assert.ok(existsSync(join(installed, 'lib/tool-scope.mjs')))
  assert.ok(!existsSync(join(installed, 'node_modules/react')), 'QA React must not be a runtime dependency')
  const temporary = join(sandbox, 'tmp')
  mkdirSync(temporary)
  const env = { ...process.env, DSH_HOME: join(sandbox, 'test-home'), DSH_HOST_MODULES: join(sandbox, 'absent-host'),
    HOME: sandbox, USERPROFILE: sandbox, APPDATA: join(sandbox, 'appdata'), LOCALAPPDATA: join(sandbox, 'localappdata'),
    TMP: temporary, TEMP: temporary, TMPDIR: temporary }
  // Existing host profiles are deliberately unavailable: the package must load
  // from its own installed production dependencies and local tool fallback.
  const result = spawnSync(process.execPath, ['selfcheck.mjs'], { cwd: installed, env, stdio: 'inherit' })
  if (result.error) throw result.error
  assert.equal(result.status, 0, 'Installed package selfcheck failed')
  const modules = JSON.parse(npm(['ls', '--omit=dev', '--json'], { cwd: sandbox }))
  assert.equal(modules.dependencies[pkg.name].version, pkg.version)
  console.log(`PASS clean npm tarball install: ${pkg.name}@${pkg.version}; isolated selfcheck and production dependencies`)

  const sourceArchive = join(root, 'release', `${pkg.name}-${pkg.version}-source.zip`)
  assert.ok(existsSync(sourceArchive), 'The matching full source ZIP must exist')
  const sourceBase = join(sandbox, 'source')
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  const unpacked = spawnSync(python, ['-m', 'zipfile', '-e', sourceArchive, sourceBase], { env, stdio: 'inherit' })
  if (unpacked.error) throw unpacked.error
  assert.equal(unpacked.status, 0, 'Source ZIP extraction failed')
  const source = join(sourceBase, pkg.name)
  assert.ok(existsSync(join(source, 'package-lock.json')))
  assert.ok(existsSync(join(source, 'scripts/test-node.mjs')))
  // Release operations deliberately use a Git-governed file list. The source
  // ZIP omits .git, so initialize only this temporary extracted checkout.
  const initialized = spawnSync('git', ['init', '--quiet'], { cwd: source, env, stdio: 'inherit' })
  if (initialized.error) throw initialized.error
  assert.equal(initialized.status, 0)
  npm(['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=' + registry], { cwd: source, env })
  npm(['run', 'release:check'], { cwd: source, env })
  const tested = npm(['test'], { cwd: source, env })
  console.log(tested.split('\n').slice(-12).join('\n'))
  assert.ok(!/\bfail\s+[1-9]/.test(tested), 'Extracted source tests reported failures')
  console.log(`PASS clean source ZIP: npm ci, release manifest/docs/assets checks and complete Node suite; ${pkg.name}@${pkg.version}`)
} finally {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
