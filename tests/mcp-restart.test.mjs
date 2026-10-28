/**
 * ⭐ 「同一条评论被回了两条」的**最后一根刺**（2026-10-25）：
 *
 * 判重代码早就改好了，真机上却照样重复 —— 因为那个 Python MCP 是**长命子进程**，
 * Python 不热加载模块，`runtime_guard.py` 改了它也不知道，一直用老代码里那本
 * 不认识「跨通道」的账去判重。
 *
 * 于是这里钉死两件事，缺一条修复就白改：
 *   ① `McpClient.stop()` 必须把 `starting` 清干净
 *      （否则下一次 call 会复用那个已失效的启动过程，永远起不来新进程）；
 *   ② 脚本（mcp_server.py / runtime_guard.py）一改，宿主就必须起一个新的子进程。
 *
 * 计数方式：假 server 每被启动一次就往 countFile 追加一个字符 ⇒ 「到底重起没重起」可数。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { McpClient } from '../lib/mcp.mjs'

const root = resolve(import.meta.dirname, '../../..')
const mcpUrl = pathToFileURL(join(root, 'plugin/dsh-dafeiyu/lib/mcp.mjs')).href

/** 最小 stdio MCP server：启动时往 COUNT_FILE 追加一个字符，好数「起了几次」 */
const FAKE_SERVER = `
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.COUNT_FILE, 'x')
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined) return
  const result = msg.method === 'initialize'
    ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '0' } }
    : { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
})
`

function runNode(source) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    timeout: 60000,
  })
  assert.equal(r.status, 0, `子进程失败：\n${r.stdout}\n${r.stderr}`)
  return r.stdout
}

test('stop() 会把 starting 清掉（否则再也不会起新子进程）', () => {
  const c = new McpClient({ command: process.execPath, args: ['-e', '0'], cwd: process.cwd(), log: () => {} })
  c.starting = Promise.resolve()      // 模拟「上一次启动留下的那个 Promise」
  c.proc = { kill() {} }              // 而且进程已经没了
  c.stop()
  assert.equal(c.starting, null, 'stop() 没清 starting ⇒ 下一次 call() 会复用已失效的启动过程')
  assert.equal(c.running, false)
})

test('脚本指纹一变，宿主就重起子进程（判重代码改完立刻生效）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-restart-'))
  try {
    const stateDir = join(dir, 'state')
    mkdirSync(stateDir, { recursive: true })
    const fake = join(stateDir, 'fake-server.mjs')
    const count = join(dir, 'starts.txt')
    writeFileSync(fake, FAKE_SERVER, 'utf8')
    // 这两个是**被 stat 的指纹源**（真宿主 stat 的就是它们），内容与假 server 无关
    writeFileSync(join(stateDir, 'mcp_server.py'), '# v1\n', 'utf8')
    writeFileSync(join(stateDir, 'runtime_guard.py'), '# v1\n', 'utf8')
    writeFileSync(count, '', 'utf8')

    // 把 index.js 里的 mcpStampNow / ensureMcp 语义原样复刻（真宿主不许 import ⇒ 只能这样测）
    const source = `
import { McpClient } from ${JSON.stringify(mcpUrl)}
import { statSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const stateDir = ${JSON.stringify(stateDir)}
const countFile = ${JSON.stringify(count)}
const fake = ${JSON.stringify(fake)}
const scripts = () => [join(stateDir, 'mcp_server.py'), join(stateDir, 'runtime_guard.py')]
const stampNow = () => scripts()
  .map((f) => { try { const s = statSync(f); return s.size + ':' + s.mtimeMs } catch { return '-' } })
  .join('|')
const starts = () => readFileSync(countFile, 'utf8').length
let mcp = null
let key = ''
const ensure = () => {
  const stamp = stampNow()
  const keyNow = 'node|' + join(stateDir, 'mcp_server.py') + '#' + stamp
  if (mcp && mcp.running && key === keyNow) return mcp
  if (mcp) { mcp.stop(); mcp = null }
  key = keyNow
  mcp = new McpClient({
    command: process.execPath, args: [fake], cwd: stateDir,
    env: { COUNT_FILE: countFile }, log: () => {},
  })
  return mcp
}
const out = []
// ① 连两次、指纹没变：只该起 1 个进程
await ensure().call('ping', {})
await ensure().call('ping', {})
out.push(starts())
// ② 改判重脚本：下一次调用必须重起
writeFileSync(join(stateDir, 'runtime_guard.py'), '# v2 跨通道判重\\n', 'utf8')
await new Promise((r) => setTimeout(r, 30))
await ensure().call('ping', {})
out.push(starts())
// ③ 再连：指纹没变，不该再起
await ensure().call('ping', {})
out.push(starts())
// ④ 收摊：子进程必须真的退掉（stdio 关掉 —— 它靠 stdin 结束自然退出），
//    否则这个脚本会一直挂着、把测试拖到超时
ensure().stop()
process.stdout.write('RESULT:' + JSON.stringify(out))
`
    const out = runNode(source)
    const m = out.match(/RESULT:(\[.*?\])/s)
    assert.ok(m, `没拿到结果：${out}`)
    const [a, b, c] = JSON.parse(m[1])
    assert.equal(a, 1, `同样的脚本连两次只该起 1 个子进程，实际起了 ${a} 个`)
    assert.equal(b, 2, `脚本改了却没重起子进程（还是 ${b} 个）—— 真机上判重就会一直是旧代码`)
    assert.equal(c, 2, `指纹没变却又多起了进程（${c} 个）`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
