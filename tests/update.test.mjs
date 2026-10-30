import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  buildUpdateReport, compareVersions, detectInstallMode, fetchPackument, looksLikeInstall,
  parseVersion, pickPublished, summarizeUpgrade, upgradeBlocker, upgradeCommand, checkForUpdate,
} from '../lib/update.mjs'

const install = (over = {}) => ({ updatable: true, mode: 'registry', profile: 'web', reason: '', ...over })
const report = (over = {}) => buildUpdateReport({ current: '2.4.1', published: { version: '2.5.0', publishedAt: '2026-10-30T00:00:00Z' }, install: install(), ...over })

test('versions compare numerically, tolerate v prefix and rank prereleases below releases', () => {
  assert.deepEqual(parseVersion('v2.4.10'), { major: 2, minor: 4, patch: 10, pre: '' })
  assert.equal(parseVersion('2.4'), null)
  assert.equal(compareVersions('2.4.10', '2.4.9'), 1)
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1)
  assert.equal(compareVersions('2.4.1', 'v2.4.1'), 0)
  assert.equal(compareVersions('2.4.1-beta.2', '2.4.1'), -1)
  assert.equal(compareVersions('2.4.1-beta.2', '2.4.1-beta.10'), -1)
  assert.equal(compareVersions('garbage', '2.4.1'), -1, 'unknown versions never look newer')
  assert.equal(compareVersions('2.4.1', 'garbage'), 1)
})

test('published version prefers dist-tags.latest and falls back to the highest stable release', () => {
  assert.deepEqual(pickPublished({ 'dist-tags': { latest: '2.5.0' }, time: { '2.5.0': 'T' }, versions: { '2.5.0': {} } }),
    { version: '2.5.0', publishedAt: 'T', source: 'dist-tags.latest' })
  assert.equal(pickPublished({ 'dist-tags': { latest: 'not-semver' }, versions: { '2.4.0': {}, '2.6.0': {}, '3.0.0-rc.1': {} } }).version, '2.6.0')
  assert.equal(pickPublished({}), null)
  assert.equal(pickPublished(null), null)
})

test('report never calls an unreadable registry the newest version', () => {
  const unknown = buildUpdateReport({ current: '2.4.1', published: null, install: install(), error: '连不上 registry' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.outdated, false)
  assert.equal(unknown.canUpgrade, false)
  assert.match(unknown.hint, /连不上 registry/)
  const fresh = buildUpdateReport({ current: '2.4.1', published: { version: '2.4.1' }, install: install() })
  assert.equal(fresh.outdated, false); assert.equal(fresh.canUpgrade, false); assert.match(fresh.hint, /最新/)
  const ahead = buildUpdateReport({ current: '2.6.0', published: { version: '2.5.0' }, install: install() })
  assert.equal(ahead.ahead, true); assert.equal(ahead.canUpgrade, false)
  const newer = report()
  assert.equal(newer.outdated, true); assert.equal(newer.canUpgrade, true); assert.match(newer.hint, /2\.5\.0/)
  assert.equal(newer.install.mode, 'registry')
})

test('a new version on a linked or source install is reported but never auto-upgradable', () => {
  for (const mode of [install({ updatable: false, mode: 'link', reason: '这是目录联接安装' }),
    install({ updatable: false, mode: 'source', reason: '这是源码检出' }),
    install({ updatable: false, mode: 'unknown', reason: '没找到安装' })]) {
    const value = report({ install: mode })
    assert.equal(value.outdated, true, '仍然要告诉用户有新版')
    assert.equal(value.canUpgrade, false, '但不许自动升级')
    assert.equal(value.hint, mode.reason)
  }
})

test('upgrade blockers cover busy work, reentry and unsafe install modes', () => {
  const current = report()
  assert.equal(upgradeBlocker({ report: current, upgrading: true }), '已经有一个升级在进行，请等它结束')
  assert.match(upgradeBlocker({ report: null }), /先点「检查更新」/)
  assert.match(upgradeBlocker({ report: report({ publishthish: 1, published: { version: '2.4.1' } }) }), /最新/)
  assert.match(upgradeBlocker({ report: report({ install: install({ updatable: false, reason: '这是目录联接安装' }) }) }), /目录联接/)
  assert.match(upgradeBlocker({ report: current, runningSend: true }), /刷站任务正在运行/)
  assert.match(upgradeBlocker({ report: current, busy: { install: true } }), /有任务在运行（install）/)
  assert.equal(upgradeBlocker({ report: current, busy: { install: false } }), '', 'false 不算忙')
  assert.equal(upgradeBlocker({ report: current }), '')
})

test('upgrade command only builds a fixed plugin add invocation', () => {
  const ok = upgradeCommand({ dshCli: 'C:/dsh/lib/bin.js', profile: 'web', electron: true, registry: 'https://registry.npmjs.org' })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.args.slice(1), ['plugin', '--profile', 'web', 'add', 'dsh-deepmoyu'])
  assert.equal(ok.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(ok.env.npm_config_registry, 'https://registry.npmjs.org')
  assert.equal(upgradeCommand({ dshCli: 'x' }).ok, false, 'no profile ⇒ refuse')
  assert.equal(upgradeCommand({ dshCli: 'x', profile: 'web; rm -rf /' }).code, 'NO_PROFILE')
  assert.equal(upgradeCommand({ profile: 'web' }).code, 'NO_DSH_CLI')
  assert.equal(upgradeCommand({ dshCli: 'x', profile: 'web', registry: 'file:///etc/passwd' }).code, 'BAD_REGISTRY')
})

test('detectInstallMode refuses the local fork layout and accepts a plain registry install', () => {
  const home = mkdtempSync(join(tmpdir(), 'dm-update-mode-'))
  try {
    const profiles = join(home, 'profiles', 'web', 'node_modules')
    mkdirSync(profiles, { recursive: true })
    const real = join(profiles, 'dsh-deepmoyu')
    mkdirSync(real, { recursive: true })
    for (const name of ['package.json', 'index.js', 'client.js', 'selfcheck.mjs']) writeFileSync(join(real, name), '{}')
    assert.equal(looksLikeInstall(real), true)
    assert.equal(looksLikeInstall(join(home, 'nope')), false)
    assert.deepEqual(
      (({ updatable, mode, profile }) => ({ updatable, mode, profile }))(detectInstallMode({ pluginDir: real, dshHome: home })),
      { updatable: true, mode: 'registry', profile: 'web' })
    // A package directory outside the profile is never assumed updatable.
    const outside = mkdtempSync(join(tmpdir(), 'dm-update-outside-'))
    try {
      const result = detectInstallMode({ pluginDir: outside, dshHome: home })
      assert.equal(result.updatable, false); assert.equal(result.mode, 'unknown')
    } finally { rmSync(outside, { recursive: true, force: true }) }
    // The source checkout case is detected by .git before anything else.
    const checkout = join(outside, 'src')
    mkdirSync(join(checkout, '.git'), { recursive: true })
    assert.equal(detectInstallMode({ pluginDir: checkout, dshHome: home }).mode, 'source')
    // A junction (the actual local-fork wiring) must be refused.
    if (process.platform === 'win32') {
      const linkHome = join(home, 'profiles', 'linked', 'node_modules')
      mkdirSync(linkHome, { recursive: true })
      const made = spawnSync('cmd.exe', ['/c', 'mklink', '/J', join(linkHome, 'dsh-deepmoyu'), real])
      if (made.status === 0) {
        const result = detectInstallMode({ pluginDir: join(linkHome, 'dsh-deepmoyu'), dshHome: home })
        assert.equal(result.mode, 'link', 'junction must be refused'); assert.equal(result.updatable, false)
      }
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('fetchPackument bounds the request and never throws', async () => {
  const seen = []
  const fake = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, text: async () => JSON.stringify({ 'dist-tags': { latest: '2.5.0' } }) } }
  const got = await fetchPackument({ fetchImpl: fake })
  assert.equal(got.ok, true)
  assert.match(seen[0].url, /^https:\/\/registry\.npmjs\.org\/dsh-deepmoyu$/)
  assert.equal(seen[0].init.headers.accept, 'application/vnd.npm.install-v1+json')
  const missing = await fetchPackument({ fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }) })
  assert.equal(missing.code, 'NOT_PUBLISHED')
  const broken = await fetchPackument({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'not json' }) })
  assert.equal(broken.code, 'BAD_JSON')
  const huge = await fetchPackument({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(40) }), maxBytes: 10 })
  assert.equal(huge.code, 'TOO_LARGE')
  const offline = await fetchPackument({ fetchImpl: async () => { throw new Error('offline') } })
  assert.equal(offline.code, 'NETWORK'); assert.match(offline.error, /offline/)
  const aborted = await fetchPackument({ fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e } })
  assert.equal(aborted.code, 'TIMEOUT')
})

test('checkForUpdate combines install mode and registry without touching the network on failure', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dm-update-check-'))
  try {
    const dir = join(home, 'profiles', 'web', 'node_modules', 'dsh-deepmoyu')
    mkdirSync(dir, { recursive: true })
    for (const name of ['package.json', 'index.js', 'client.js', 'selfcheck.mjs']) writeFileSync(join(dir, name), '{}')
    const newest = await checkForUpdate({ current: '2.4.1', pluginDir: dir, dshHome: home,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ 'dist-tags': { latest: '2.5.0' } }) }) })
    assert.equal(newest.canUpgrade, true)
    const offline = await checkForUpdate({ current: '2.4.1', pluginDir: dir, dshHome: home, fetchImpl: async () => { throw new Error('nope') } })
    assert.equal(offline.ok, false); assert.equal(offline.outdated, false); assert.equal(offline.canUpgrade, false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('upgrade output is summarised into an honest outcome', () => {
  assert.equal(summarizeUpgrade({ code: 0, output: 'added 1 package', latest: '2.5.0' }).ok, true)
  assert.match(summarizeUpgrade({ code: 0, latest: '2.5.0' }).message, /完全重启 DSH/)
  assert.match(summarizeUpgrade({ code: 1, output: 'npm ERR! code EBUSY' }).message, /文件被占用/)
  assert.match(summarizeUpgrade({ code: 1, output: 'npm ERR! E401 Unauthorized' }).message, /权限/)
  assert.match(summarizeUpgrade({ code: 1, output: 'npm ERR! E404' }).message, /找不到这个版本/)
  assert.match(summarizeUpgrade({ code: 1, output: 'getaddrinfo ENOTFOUND registry.npmjs.org' }).message, /网络/)
  assert.match(summarizeUpgrade({ code: 2, output: 'boom' }).message, /退出码 2/)
  assert.equal(summarizeUpgrade({ timedOut: true }).ok, false)
})
