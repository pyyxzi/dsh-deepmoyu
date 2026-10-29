import test from 'node:test'
import assert from 'node:assert/strict'
import { safeRelative } from '../scripts/release/paths.mjs'
import { forbidden, parsePatch, REQUIRED_RUNTIME } from '../scripts/release/check-manifest.mjs'
import { findCredentialPatterns } from '../scripts/release/check-secrets.mjs'

test('release paths reject traversal, drive paths, empty components and platform separators', () => {
  for (const value of ['../x', '/x', 'D:/x', 'a/../b', 'a//b', './file', 'a\\file', '', null]) {
    assert.equal(safeRelative(value), false, String(value))
  }
  for (const value of ['index.js', 'lib/pv.py', 'assets/角色.png', '.github/workflows/ci.yml']) {
    assert.equal(safeRelative(value), true, value)
  }
})

test('runtime packaging rejects private data, account credentials, caches and nested archives', () => {
  for (const value of ['config.json', 'nested/bili_credential.json', '.env', 'some/.env.local', '.npmrc',
    'state.json', 'feiyu.json', 'activity.jsonl', 'soul.md', 'voice.md', 'seen.md',
    'node_modules/react/index.js', 'lib/__pycache__/pv.cpython-312.pyc', 'cache/runtime.sqlite3-wal',
    'release/archive.tgz', 'assets/old.zip', 'private.pem', '.git/config']) assert.equal(forbidden(value), true, value)
  for (const value of ['package.json', 'docs/PRIVACY.md', 'prompts/duty.md', 'lib/state.mjs',
    'vendor/bilibili-mcp/runtime_guard.py', 'scripts/release/build.mjs']) assert.equal(forbidden(value), false, value)
})

test('bundle YAML parsing preserves the host-only JavaScript tags as data', () => {
  const rows = parsePatch('presets/deepmoyu.patch.yml')
  const role = rows.flatMap(row => row.insert || []).find(row => row.config?.id === 'dafeiyu')
  assert.ok(role)
  const shell = role.config.plugins.find(plugin => plugin.id === 'tool-pwsh')
  assert.equal(shell.disabled, "process.platform !== 'win32'")
  assert.ok(REQUIRED_RUNTIME.includes('lib/tool-scope.mjs'))
  assert.ok(REQUIRED_RUNTIME.includes('lib/pv_editorial.py'))
  assert.ok(REQUIRED_RUNTIME.includes('lib/pv_verify.py'))
})

test('release scanner reports known credential shapes without returning their values', () => {
  const source = ['npm_' + 'A'.repeat(36), 'ghp_' + 'B'.repeat(36), 'sk-proj-' + 'C'.repeat(40),
    '-----BEGIN ' + 'PRIVATE KEY-----'].join('\n')
  const hits = findCredentialPatterns(source)
  assert.deepEqual(hits.map(hit => hit.kind).sort(), ['github-token', 'model-key', 'npm-token', 'private-key'])
  assert.ok(hits.every(hit => Object.keys(hit).sort().join(',') === 'kind,line'))
  assert.deepEqual(findCredentialPatterns('sk-fixture-' + 'z'.repeat(40)), [])
})
