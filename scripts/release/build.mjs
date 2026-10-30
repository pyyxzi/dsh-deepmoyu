import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { root, manifest, npm, packReport } from './paths.mjs'
import { validateManifest, validatePackFiles } from './check-manifest.mjs'
import { validateDocs } from './check-docs.mjs'
import { validateSourceCredentials } from './check-secrets.mjs'

const pkg = manifest()
validateManifest(pkg)
validateDocs()
validateSourceCredentials()
const destination = join(root, 'release')
mkdirSync(destination, { recursive: true })
const [pack] = packReport(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', destination]))
validatePackFiles(pack.files)
const npmFile = join(destination, pack.filename)
const sourceFile = join(destination, `${pkg.name}-${pkg.version}-source.zip`)
const reportFile = join(destination, 'archive-verification.json')
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const result = spawnSync(python, [join(root, 'scripts/release/archives.py'), '--root', root, '--npm', npmFile,
  '--source', sourceFile, '--report', reportFile], { stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1' } })
if (result.error) throw result.error
assert.equal(result.status, 0, 'Archive verification failed')
assert.ok(existsSync(sourceFile))
const report = JSON.parse(readFileSync(reportFile, 'utf8'))
assert.equal(report.npm.name, pkg.name)
assert.equal(report.npm.version, pkg.version)
validatePackFiles(report.npm.files)
const hashes = [npmFile, sourceFile].map(file => {
  const name = file.slice(destination.length + 1)
  return createHash('sha256').update(readFileSync(file)).digest('hex') + '  ' + name
})
writeFileSync(join(destination, 'SHA256SUMS'), hashes.join('\n') + '\n')
console.log(`Verified release/${pack.filename} and release/${pkg.name}-${pkg.version}-source.zip`)
