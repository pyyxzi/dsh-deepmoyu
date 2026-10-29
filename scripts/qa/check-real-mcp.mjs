/** Real Python/FastMCP handshake and local guard call. No credentials or platform requests. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { McpClient } from '../../lib/mcp.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const base = resolve(process.env.QA_OUTPUT_DIR || tmpdir())
mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'deepmoyu-real-mcp-'))
for (const file of ['mcp_server.py', 'runtime_guard.py']) copyFileSync(join(root, 'vendor/bilibili-mcp', file), join(home, file))
const launcher = join(home, 'offline-launch.py')
writeFileSync(launcher, String.raw`import os, runpy, socket, sys
home = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, home)
def forbidden(*args, **kwargs):
    raise RuntimeError('REAL_MCP_OFFLINE_GUARD_BLOCKED')
local = {'localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1'}
getaddrinfo, create_connection = socket.getaddrinfo, socket.create_connection
connect, connect_ex = socket.socket.connect, socket.socket.connect_ex
def guarded_getaddrinfo(host, *args, **kwargs):
    if host not in local: return forbidden()
    return getaddrinfo(host, *args, **kwargs)
def guarded_create(address, *args, **kwargs):
    if not isinstance(address, tuple) or address[0] not in local: return forbidden()
    return create_connection(address, *args, **kwargs)
def guarded_connect(self, address):
    if not isinstance(address, tuple) or address[0] not in local: return forbidden()
    return connect(self, address)
def guarded_connect_ex(self, address):
    if not isinstance(address, tuple) or address[0] not in local: return forbidden()
    return connect_ex(self, address)
socket.getaddrinfo = guarded_getaddrinfo
socket.create_connection = guarded_create
socket.socket.connect = guarded_connect
socket.socket.connect_ex = guarded_connect_ex
runpy.run_path(os.path.join(home, 'mcp_server.py'), run_name='__main__')
`)
const client = new McpClient({ command: process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
  args: [launcher], cwd: home,
  env: { BILI_DUTY_HOME: home, BILI_MCP_TOOLS: 'bili_guard_status', PYTHONUTF8: '1',
    HF_HOME: join(home, 'models'), BILI_DUTY_ROLE: '' }, log: text => console.log(text) })
const deadline = setTimeout(() => client.stop(), 45_000)
let child
try {
  const startup = client.start()
  child = client.proc
  await startup
  const result = await client.call('bili_guard_status', { limit: 1 }, { timeoutMs: 15_000 })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(result.counts && typeof result.counts === 'object')
  assert.equal(existsSync(join(home, 'bili_credential.json')), false)
  assert.ok(!client.stderr.includes('REAL_MCP_OFFLINE_GUARD_BLOCKED'), 'Python attempted an external socket')
} finally {
  clearTimeout(deadline)
  const exited = child && (child.exitCode === null && child.signalCode === null || !child.stdout?.closed || !child.stderr?.closed)
    ? new Promise(resolveClose => child.once('close', resolveClose)) : Promise.resolve()
  client.stop()
  let timer
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP process did not exit')), 5000) })]) }
  finally { clearTimeout(timer) }
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
console.log('PASS real Python/FastMCP initialization, local SQLite guard result and process cleanup; no credentials or platform calls')
