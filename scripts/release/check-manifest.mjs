import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { parseDocument } from 'yaml'
import { root, manifest, safeRelative, npm } from './paths.mjs'
import { validateDocs } from './check-docs.mjs'
import { validateSourceCredentials } from './check-secrets.mjs'

export const REQUIRED_RUNTIME = ['package.json', 'README.md', 'LICENSE', 'NOTICE.md', 'SECURITY.md',
  'CHANGELOG.md', 'client.js', 'index.js', 'selfcheck.mjs', 'cordis.patch.yml', 'presets/deepmoyu.patch.yml',
  'prompts/duty.md', 'assets/pet/pet.png', 'assets/avatar/bust.png', 'assets/avatar/face.png', 'assets/avatar/fish.png',
  'lib/tool-scope.mjs', 'lib/pv.mjs', 'lib/pv.py', 'lib/pv_plan.py', 'lib/pv_cover.py', 'lib/pv_gsv.py',
  'lib/asr.py', 'lib/favops.py', 'lib/pv_editorial.py', 'lib/pv_verify.py',
  'vendor/bilibili-mcp/mcp_server.py', 'vendor/bilibili-mcp/runtime_guard.py',
  'vendor/bilibili-mcp/requirements.txt', 'vendor/bilibili-mcp/requirements.in', 'vendor/bilibili-mcp/LICENSE',
  'marketplace/pyyxzi__dsh-deepmoyu.yml', 'docs/DEPLOYMENT.md', 'docs/RELEASING.md', 'docs/PRIVACY.md', 'docs/ASSETS.md']

export function forbidden(path) {
  const parts = path.replaceAll('\\', '/').split('/')
  return ['release', 'dist', 'coverage'].includes(parts[0])
    || parts.some(part => ['node_modules', '.git', '__pycache__', '.pytest_cache', '.qa-output', '.tmp',
      '.venv', '.venv-asr'].includes(part))
    || /(?:^|\/)(?:\.npmrc|\.env(?:\..*)?|bili_credential\.json|config\.json|state\.json|feiyu\.json|token-ledger\.json|activity\.jsonl|pet-log\.jsonl|soul\.md|voice\.md|seen\.md)$/.test(path)
    || /\.(?:pyc|pyo|sqlite(?:3)?(?:-wal|-shm)?|tgz|zip|pem|key)$/i.test(path)
}

export function parsePatch(file) {
  const document = parseDocument(readFileSync(join(root, file), 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })
  assert.equal(document.errors.length, 0, `${file}: ${document.errors.map(error => error.message).join('; ')}`)
  const rows = document.toJS()
  assert.ok(Array.isArray(rows) && rows.length, file + ' must contain a patch array')
  return rows
}

export function validateManifest(pkg = manifest()) {
  assert.equal(pkg.name, 'dsh-deepmoyu')
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/)
  assert.equal(pkg.private, false)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'index.js')
  assert.equal(pkg.license, 'MIT')
  assert.ok(pkg.keywords.includes('dsh-plugin'))
  assert.ok(pkg.engines?.node && pkg.engines?.dsh, 'Declare supported host and Node versions')
  assert.ok(pkg.repository?.url?.includes('github.com/pyyxzi/dsh-deepmoyu'))
  assert.ok(pkg.homepage && pkg.bugs?.url, 'Public support and project links are required')
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare', 'prepublish']) assert.ok(!pkg.scripts?.[hook], 'Unexpected install-time hook: ' + hook)
  assert.equal(pkg.scripts?.check, 'node selfcheck.mjs')
  for (const [name, version] of Object.entries(pkg.dependencies || {})) assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Runtime dependencies must pin a verified version: ' + name)
  const patches = Array.isArray(pkg.dsh?.bundle?.patch) ? pkg.dsh.bundle.patch : [pkg.dsh?.bundle?.patch]
  assert.ok(patches.length >= 2 && patches.every(Boolean), 'Host and role bundle patches must both be declared')
  let plugin = false, role = false
  for (const path of patches) {
    const relative = path.replace(/^\.\//, '')
    assert.ok(safeRelative(relative), 'Unsafe patch path: ' + path)
    for (const row of parsePatch(relative)) {
      for (const insert of row.insert || []) {
        if (insert.id === 'dafeiyu' && insert.name === pkg.name) plugin = true
        if (insert.name === '@deepseek-ai/dsh-agent-preset' && insert.config?.id === 'dafeiyu') role = true
      }
    }
  }
  assert.ok(plugin && role, 'Both actual plugin and isolated role must be installable')
  assert.equal(pkg.dsh.client.platform, 'web')
  for (const path of REQUIRED_RUNTIME) assert.ok(existsSync(join(root, path)), 'Missing runtime file: ' + path)
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[''].version, pkg.version)
  for (const key of ['dependencies', 'devDependencies']) assert.deepEqual(lock.packages[''][key] || {}, pkg[key] || {}, key + ' do not match lockfile')
  const permissions = JSON.parse(readFileSync(join(root, 'docs/assets-permissions.json'), 'utf8'))
  assert.equal(permissions.confirmedForRedistribution, true, 'Artwork redistribution permission has not been confirmed')
  for (const path of permissions.files) {
    assert.ok(safeRelative(path) && existsSync(join(root, path)), 'Missing documented artwork: ' + path)
    assert.equal(createHash('sha256').update(readFileSync(join(root, path))).digest('hex'), permissions.sha256?.[path], 'Artwork changed since permission confirmation: ' + path)
  }
  const entry = parseDocument(readFileSync(join(root, 'marketplace/pyyxzi__dsh-deepmoyu.yml'), 'utf8')).toJS()
  assert.deepEqual(Object.keys(entry).filter(key => !['url', 'name', 'category', 'description', 'icon'].includes(key)), [])
  assert.equal(entry.url, 'https://github.com/pyyxzi/dsh-deepmoyu')
  assert.equal(entry.name, 'pyyxzi/dsh-deepmoyu')
  assert.equal(entry.category, 'fun')
  assert.ok(typeof entry.description.en === 'string' && entry.description.en.endsWith('.'))
  assert.ok(typeof entry.description.zh === 'string' && entry.description.zh.endsWith('。'))
  const screenshots = JSON.parse(readFileSync(join(root, 'screenshots.json'), 'utf8'))
  assert.ok(Array.isArray(screenshots) && screenshots.length >= 1 && screenshots.length <= 8)
  for (const path of screenshots) {
    assert.ok(safeRelative(path) && /\.(?:png|jpe?g|webp)$/i.test(path) && existsSync(join(root, path)), 'Invalid screenshot: ' + path)
    const bytes = readFileSync(join(root, path))
    assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      || bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP', 'Screenshot is not a raster image: ' + path)
  }
  const evidence = JSON.parse(readFileSync(join(root, 'docs/tool-evidence.json'), 'utf8'))
  const declaredTools = [...new Set([...readFileSync(join(root, 'index.js'), 'utf8').matchAll(/name:\s*'(bili_[a-z_]+)'/g)].map(match => match[1]))].sort()
  assert.equal(evidence.version, pkg.version)
  assert.deepEqual(evidence.tools.map(row => row.tool).sort(), declaredTools, 'Tool evidence inventory must match current registration')
  for (const row of evidence.tools) assert.ok(existsSync(join(root, 'tests', row.specialist)), 'Missing tool specialist test: ' + row.tool)
  return { package: pkg.name, version: pkg.version, patches, screenshots }
}

export function validatePackFiles(files) {
  const paths = new Set(files.map(file => file.path))
  for (const file of REQUIRED_RUNTIME) assert.ok(paths.has(file), 'Not included by npm pack: ' + file)
  for (const file of paths) assert.ok(safeRelative(file) && !forbidden(file), 'Private/generated file would ship: ' + file)
  for (const file of paths) {
    if (file.endsWith('.md') && (file.startsWith('docs/') || !file.includes('/'))) {
      for (const match of readFileSync(join(root, file), 'utf8').matchAll(/\]\((<?[^)]+>?)\)/g)) {
        const target = match[1].replace(/^<|>$/g, '').split('#')[0]
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue
        const absoluteRoot = decodeURIComponent(pathToFileURL(root + '/').pathname)
        const path = decodeURIComponent(new URL(target, pathToFileURL(join(root, file))).pathname)
        assert.ok(path.startsWith(absoluteRoot) && paths.has(path.slice(absoluteRoot.length)), 'Packed documentation link is missing: ' + file + ' → ' + target)
      }
    }
    if (!/\.(?:mjs|js)$/.test(file) || file === 'client.js') continue
    const source = readFileSync(join(root, file), 'utf8')
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)) {
      const base = new URL(match[1], pathToFileURL(join(root, file)))
      const target = decodeURIComponent(base.pathname).replaceAll('\\', '/')
      const absoluteRoot = decodeURIComponent(pathToFileURL(root + '/').pathname)
      assert.ok(target.startsWith(absoluteRoot), file + ' imports outside the package')
      assert.ok(paths.has(target.slice(absoluteRoot.length)), file + ' imports a missing packed file: ' + match[1])
    }
  }
  return { files: paths.size, unpackedBytes: files.reduce((sum, file) => sum + file.size, 0) }
}

export function main() {
  const result = validateManifest()
  result.documentation = validateDocs()
  result.credentials = validateSourceCredentials()
  const [pack] = JSON.parse(npm(['pack', '--dry-run', '--json', '--ignore-scripts']))
  Object.assign(result, validatePackFiles(pack.files))
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
