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
  // 版本漂移是发布事故：2.5.0/2.6.0 两次发版 README 都还写着 2.4.2，而目录站点
  // 详情页正是渲染仓库 README，读者会把旧文案当成当前版本。这里只拦「声称本包版本」
  // 的两种写法（依赖/引擎版本如 dsh-bili-scroll 0.1.19 不受影响）。
  const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const claimed = [...readme.matchAll(/dsh-deepmoyu-(\d+\.\d+\.\d+)/g), ...readme.matchAll(/当前源码版本为\s*\**\s*(\d+\.\d+\.\d+)/g)]
    .map(match => match[1]).filter(version => version !== pkgVersion)
  assert.deepEqual(claimed, [], 'README.md pins a version other than package.json (' + pkgVersion + '): ' + claimed.join(', ')
    + '；改为链接 package.json，或在发版时同步这些数字')
  return { documents: documents.length, relativeLinks: links }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(validateDocs())
