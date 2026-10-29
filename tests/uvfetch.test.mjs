import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ensureUv, uvAssetFor, officialUvWheel, fetchUvBytes, downloadUvArchive, findBin, extractArchive } from '../lib/uvfetch.mjs'

const archive = Buffer.from('fixture archive: no downloaded binary is executed')
const hash = createHash('sha256').update(archive).digest('hex')
const official = 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip'
const temp = t => { const dir = mkdtempSync(join(tmpdir(), 'deepmoyu-uv-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }
function fixture({ digest = hash, version = () => true, onExtract } = {}) {
  const calls = [], commands = []
  const fetchImpl = async (url, options) => {
    calls.push(String(url)); assert.ok(options.signal instanceof AbortSignal)
    if (url === 'https://pypi.org/pypi/uv/json') return new Response('{"urls":[]}')
    if (String(url).endsWith('.sha256')) { assert.equal(url, official + '.sha256'); return new Response(digest) }
    return new Response(archive)
  }
  const run = async (command, args, options) => {
    commands.push([command, args]); assert.ok(options.timeout > 0)
    if (command === 'tar' || command === 'unzip') {
      const dir = args[args.indexOf(command === 'tar' ? '-C' : '-d') + 1]
      mkdirSync(join(dir, 'nested'), { recursive: true }); writeFileSync(join(dir, 'nested', 'uv.exe'), 'fixture executable')
      await onExtract?.(dir)
      return { status: 0 }
    }
    assert.deepEqual(args, ['--version'])
    return { status: await version(command) ? 0 : 1 }
  }
  return { fetchImpl, run, calls, commands }
}

test('uv downloads select the real CPU for Windows, Intel/Apple Mac and GNU/musl Linux', () => {
  assert.equal(uvAssetFor('win32', 'x64').name, 'uv-x86_64-pc-windows-msvc.zip')
  assert.equal(uvAssetFor('win32', 'arm64').name, 'uv-aarch64-pc-windows-msvc.zip')
  assert.equal(uvAssetFor('darwin', 'x64').name, 'uv-x86_64-apple-darwin.tar.gz')
  assert.equal(uvAssetFor('darwin', 'arm64').name, 'uv-aarch64-apple-darwin.tar.gz')
  assert.equal(uvAssetFor('linux', 'arm64').name, 'uv-aarch64-unknown-linux-gnu.tar.gz')
  assert.equal(uvAssetFor('linux', 'x64', 'musl').name, 'uv-x86_64-unknown-linux-musl.tar.gz')
  assert.equal(uvAssetFor('darwin', 'ia32'), null)
  assert.equal(uvAssetFor('freebsd', 'x64'), null)
  assert.equal(uvAssetFor('linux', 'unknown'), null)
})

test('PyPI wheel metadata requires exact platform, official HTTPS file host and a full SHA-256', () => {
  const wheel = (version, url = 'https://files.pythonhosted.org/packages/uv.whl', sha = hash) => ({
    filename: `uv-${version}-py3-none-win_amd64.whl`, url, digests: { sha256: sha } })
  assert.equal(officialUvWheel({ urls: [wheel('0.9.9'), wheel('0.13.6')] }, 'win_amd64').filename, 'uv-0.13.6-py3-none-win_amd64.whl')
  for (const bad of [wheel('0.13.6', 'https://mirror.invalid/uv.whl'), wheel('0.13.6', 'http://files.pythonhosted.org/uv.whl'),
    wheel('0.13.6', 'https://name@files.pythonhosted.org/uv.whl'), wheel('0.13.6', undefined, 'abc'),
    { ...wheel('0.13.6'), filename: '../uv-0.13.6-py3-none-win_amd64.whl' }]) assert.equal(officialUvWheel({ urls: [bad] }, 'win_amd64'), null)
  assert.equal(officialUvWheel({ urls: [wheel('0.13.6')] }, 'win_arm64'), null)
})

test('download byte bounds apply to declared lengths and chunked responses', async () => {
  await assert.rejects(fetchUvBytes('https://example.test', { fetchImpl: async () => new Response('abc', { headers: { 'content-length': '9999' } }), maxBytes: 4 }), /UV_DOWNLOAD_TOO_LARGE/)
  await assert.rejects(fetchUvBytes('https://example.test', { fetchImpl: async () => new Response('12345'), maxBytes: 4 }), /UV_DOWNLOAD_TOO_LARGE/)
  await assert.rejects(fetchUvBytes('https://example.test', { fetchImpl: async () => new Response('', { status: 503 }) }), /UV_HTTP_503/)
  await assert.rejects(fetchUvBytes('https://example.test', { fetchImpl: async () => new Response('') }), /UV_EMPTY_RESPONSE/)
  assert.equal((await fetchUvBytes('https://example.test', { fetchImpl: async () => new Response('1234'), maxBytes: 4 })).toString(), '1234')
})

test('download deadlines abort stalled requests and do not leave a timer behind', async () => {
  let aborted = false
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
    aborted = true; reject(signal.reason)
  }, { once: true }))
  await assert.rejects(fetchUvBytes('https://example.test', { fetchImpl, timeoutMs: 15 }), /UV_DOWNLOAD_TIMEOUT/)
  assert.equal(aborted, true)
})

test('binary download streams into an exclusive file, hashes actual bytes and deletes incomplete writes', async t => {
  const dir = temp(t), file = join(dir, 'archive.zip')
  assert.equal(await downloadUvArchive('https://example.test', file, { fetchImpl: async () => new Response(archive) }), hash)
  assert.deepEqual(readFileSync(file), archive)
  await assert.rejects(downloadUvArchive('https://example.test', file, { fetchImpl: async () => new Response('replacement') }), /EEXIST/)
  assert.deepEqual(readFileSync(file), archive)
  const failed = join(dir, 'partial.zip')
  await assert.rejects(downloadUvArchive('https://example.test', failed, { fetchImpl: async () => new Response('too long'), maxBytes: 3 }), /UV_DOWNLOAD_TOO_LARGE/)
  assert.equal(existsSync(failed), false)
})

test('binary lookup recurses only regular directories and refuses external symlink targets', t => {
  const dir = temp(t), external = temp(t)
  writeFileSync(join(external, 'uv.exe'), 'external')
  try { symlinkSync(external, join(dir, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir') } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error
  }
  assert.equal(findBin('uv.exe', dir), null)
  mkdirSync(join(dir, 'nested')); writeFileSync(join(dir, 'nested', 'uv.exe'), 'inside')
  assert.equal(findBin('uv.exe', dir), join(dir, 'nested', 'uv.exe'))
})

test('extractor fallback is bounded and does not report an archive without the requested file', async t => {
  const dir = temp(t), calls = []
  const result = await extractArchive('uv', 'fixture.zip', dir, async (command, _args, { timeout }) => {
    assert.equal(timeout, 90_000); calls.push(command)
    if (command === 'unzip') writeFileSync(join(dir, 'uv'), 'fixture')
    return { status: command === 'tar' ? 1 : 0 }
  })
  assert.equal(result, join(dir, 'uv')); assert.deepEqual(calls, ['tar', 'unzip'])
  assert.equal(await extractArchive('absent', 'fixture.zip', dir, async () => ({ status: 0 })), null)
})

test('existing uv is probed before reuse and a supported no-op performs no download', async t => {
  const dir = temp(t), io = fixture(); writeFileSync(join(dir, 'uv.exe'), 'existing')
  assert.equal(await ensureUv({ dir, platform: 'win32', arch: 'x64', ...io }), join(dir, 'uv.exe'))
  assert.equal(io.calls.length, 0)
  assert.equal(readFileSync(join(dir, 'uv.exe'), 'utf8'), 'existing')
})

test('unsupported platforms do not download a silently wrong executable', async t => {
  const io = fixture()
  assert.equal(await ensureUv({ dir: temp(t), platform: 'freebsd', arch: 'x64', ...io }), null)
  assert.equal(io.calls.length, 0)
})

test('official digest mismatch prevents extraction and execution', async t => {
  const dir = temp(t), io = fixture({ digest: 'a'.repeat(64) })
  assert.equal(await ensureUv({ dir, platform: 'win32', arch: 'x64', ...io }), null)
  assert.equal(io.commands.length, 0)
  assert.equal(existsSync(join(dir, 'uv.exe')), false)
  assert.deepEqual(readdirSync(dir), [])
})

test('missing official checksum fails closed rather than trusting a download proxy', async t => {
  const dir = temp(t), io = fixture({ digest: 'not a checksum' })
  assert.equal(await ensureUv({ dir, platform: 'win32', arch: 'x64', ...io }), null)
  assert.equal(io.calls.filter(url => !url.endsWith('.sha256') && !url.includes('pypi.org')).length, 0)
  assert.equal(io.commands.length, 0)
})

test('verified installs probe staging and final files, atomically commit and clean private temporary files', async t => {
  const dir = temp(t), io = fixture()
  assert.equal(await ensureUv({ dir, platform: 'win32', arch: 'x64', ...io }), join(dir, 'uv.exe'))
  assert.equal(readFileSync(join(dir, 'uv.exe'), 'utf8'), 'fixture executable')
  assert.deepEqual(readdirSync(dir), ['uv.exe'])
  assert.ok(io.commands.some(([command]) => command.endsWith('.staging')))
  assert.ok(io.commands.some(([command]) => command === join(dir, 'uv.exe')))
})

test('failed and throwing version checks never become a successful install receipt', async t => {
  for (const mode of ['failed', 'throw']) {
    const dir = temp(t), io = fixture({ version: () => { if (mode === 'throw') throw new Error('AV blocked'); return false } })
    assert.equal(await ensureUv({ dir, platform: 'win32', arch: 'x64', ...io }), null)
    assert.deepEqual(readdirSync(dir), [])
  }
})

test('same-process requests share one installer instead of deleting one another artifacts', async t => {
  const dir = temp(t), io = fixture()
  const a = ensureUv({ dir, platform: 'win32', arch: 'x64', ...io })
  const b = ensureUv({ dir, platform: 'win32', arch: 'x64', ...io })
  assert.equal(a, b)
  assert.equal(await a, join(dir, 'uv.exe'))
  assert.equal(io.calls.filter(url => url === official).length, 1)
})

test('independent installer instances sharing a home have unique extraction and staging ownership', async t => {
  const other = await import('../lib/uvfetch.mjs?independent-installer=' + Date.now())
  const dir = temp(t), extraction = []
  let both, release
  const ready = new Promise(resolve => { both = resolve }), hold = new Promise(resolve => { release = resolve })
  const io = fixture({ onExtract: async path => { extraction.push(path); if (extraction.length === 2) both(); await hold } })
  const first = ensureUv({ dir, platform: 'win32', arch: 'x64', ...io })
  const second = other.ensureUv({ dir, platform: 'win32', arch: 'x64', ...io })
  await ready
  assert.equal(new Set(extraction).size, 2)
  assert.ok(extraction.every(path => existsSync(join(path, 'nested', 'uv.exe'))))
  release()
  assert.deepEqual(await Promise.all([first, second]), [join(dir, 'uv.exe'), join(dir, 'uv.exe')])
  assert.deepEqual(readdirSync(dir), ['uv.exe'])
})
