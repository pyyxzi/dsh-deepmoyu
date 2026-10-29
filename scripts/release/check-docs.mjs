import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { root } from './paths.mjs'
import { pathToFileURL } from 'node:url'

export function validateDocs() {
  const documents = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'CONTRIBUTORS.md', 'NOTICE.md', 'SECURITY.md', 'AGENTS.md',
    ...readdirSync(join(root, 'docs')).filter(name => name.endsWith('.md')).map(name => 'docs/' + name)]
  let links = 0
  for (const document of documents) {
    const source = readFileSync(join(root, document), 'utf8')
    assert.ok(!/\b(?:D:\\A_four_2|D:\/A_four_2|C:\\Users\\|C:\/Users\/)/i.test(source), document + ' contains a personal workspace path')
    for (const match of source.matchAll(/\]\((<?[^)]+>?)\)/g)) {
      let target = match[1].replace(/^<|>$/g, '').split(/\s+"/)[0]
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue
      target = decodeURIComponent(target.split('#')[0])
      if (!target) continue
      const absolute = resolve(dirname(join(root, document)), target)
      assert.ok(absolute.startsWith(root + '/') || absolute.startsWith(root + '\\'), 'Link leaves source repository: ' + document + ' → ' + target)
      assert.ok(existsSync(absolute), 'Broken documentation link: ' + document + ' → ' + target)
      links++
    }
  }
  return { documents: documents.length, relativeLinks: links }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(validateDocs())
