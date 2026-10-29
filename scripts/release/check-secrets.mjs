import assert from 'node:assert/strict'
import { readFileSync, existsSync, lstatSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, extname } from 'node:path'
import { root, safeRelative } from './paths.mjs'

const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36,}\b/g],
  ['aws-access-id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['model-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g],
]

export function findCredentialPatterns(source) {
  const hits = []
  for (const [kind, pattern] of patterns) {
    pattern.lastIndex = 0
    for (const match of source.matchAll(pattern)) {
      if (kind === 'model-key' && /^sk-(?:test|fixture|example|fake|KfcCrazyDay)/i.test(match[0])) continue
      hits.push({ kind, line: source.slice(0, match.index).split('\n').length })
    }
  }
  return hits
}

export function validateSourceCredentials() {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, 'Release checks require a Git working tree; after extracting a source ZIP, run git init first (no commit is required)')
  let files = 0
  for (const path of new Set(result.stdout.split('\0').filter(Boolean))) {
    assert.ok(safeRelative(path), 'Unsafe source path')
    const file = join(root, path)
    if (!existsSync(file)) continue
    assert.ok(!lstatSync(file).isSymbolicLink(), 'Source archive must not follow a symlink: ' + path)
    if (!/\.(?:[cm]?js|py|md|json|ya?ml|txt|in)$/i.test(extname(path))) continue
    const hits = findCredentialPatterns(readFileSync(file, 'utf8'))
    assert.deepEqual(hits, [], 'Potential credentials in ' + path + ' (values are intentionally not printed)')
    files++
  }
  return { textFilesScanned: files, rules: patterns.map(([kind]) => kind) }
}
