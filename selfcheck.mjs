/**
 * selfcheck.mjs —— 插件的"预检"：**两个半端都在本地真跑一遍**，不靠"重启一次才知道错哪"
 *
 * 为什么要有它（2026-10-14 连栽两次，都是重启后翻 `.dsh-web.err.log` 才发现）：
 *   ① `config` 的值是对象 ⇒ 定时器里 TypeError ⇒ **把整个 dsh 带走**；
 *   ② `parameters.patch` 是 `{ type:'object' }` ⇒ `defineTool` 抛 JsonSchemaError ⇒ **插件整条不激活**。
 *
 * 用法：`node selfcheck.mjs`（宿主依赖由 lib/hostdeps.mjs 自己解析，不需要解析钩子）
 * 退出码：0 = 两个半端都正常；1 = 有问题（宿主里就会 "entry did not activate" / 设置页空白）
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'dsh-deepmoyu-selfcheck-'))
process.once('exit', () => {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch { /* Preserve the test result if cleanup is unavailable. */ }
})
const fail = (msg, e) => {
  console.error(`\n✗ ${msg}`)
  if (e) console.error(`  ${e?.name}: ${e?.message}`)
  const frame = String(e?.stack ?? '').split('\n').slice(1, 4).join('\n')
  if (frame) console.error(frame)
  process.exit(1)
}

/* ────────────── ① host 半端：假 ctx 上真跑 apply() ────────────── */

let mod
try {
  mod = await import('./index.js')
} catch (e) {
  fail('连 import index.js 都失败（依赖没解析？看 lib/hostdeps.mjs 的报错）', e)
}

const registered = []
const listeners = new Map()
const fishAgent = { id: 'selfcheck-fish', session: { id: 'selfcheck-fish', header: { agentPreset: 'dafeiyu' } },
  ctx: { tools: { register(t) { const name = t?.name ?? String(t); registered.push(name); return () => { const at = registered.indexOf(name); if (at >= 0) registered.splice(at, 1) } } } } }
const ordinaryAgent = { id: 'selfcheck-standard', session: { id: 'selfcheck-standard', header: { agentPreset: 'standard' } },
  ctx: { tools: { register() { throw new Error('ordinary conversation must never receive fish schemas') } } } }
const fakeCtx = {
  // ⭐ 宿主给的是**函数**（`dshHomePath(...segments)`），这里照样给函数 —— 别用字符串
  get: (k) => (k === 'dshHomePath' ? (...seg) => join(SANDBOX_HOME, ...seg) : k === 'agents' ? { list: () => [fishAgent, ordinaryAgent] } : undefined),
  logger: { info: () => {}, warn: () => {} },
  tools: { register: () => { throw new Error('root/global tool registration is forbidden') } },
  on(event, fn) { const set = listeners.get(event) || new Set(); set.add(fn); listeners.set(event, set); return () => set.delete(fn) },
  webServer: { register: () => ({ dispose() {} }) },
  effect: (fn) => { try { return fn() } catch { return undefined } },
  settings: { register: () => ({}) },
  slots: { inject: () => {}, register: () => ({}) },
}


try {
  mod.apply(fakeCtx, {})
} catch (e) {
  fail('host 半端 apply() 抛错了 —— 宿主里就是那句 `warning: 1 entry did not activate`', e)
}
if (registered.length < 30) fail('host 没有向鲸鱼会话作用域注册完整工具集')
const expectedToolCount = registered.length
fishAgent.session.header.agentPreset = 'standard'
for (const fn of listeners.get('agent-preset/selected') || []) fn(fishAgent.id, 'standard')
if (registered.length) fail('切出鲸鱼摸鱼模式后仍残留工具 schema')
fishAgent.session.header.agentPreset = 'dafeiyu'
for (const fn of listeners.get('agent-preset/selected') || []) fn(fishAgent.id, 'dafeiyu')
if (registered.length !== expectedToolCount) fail('切回鲸鱼摸鱼模式后工具未恢复')
console.log(`✓ host 半端 OK：name=${mod.name}  inject=${JSON.stringify(mod.inject)}  工具 ${registered.length} 个`)
for (const n of registered) console.log(`    - ${n}`)

/* ────────────── ② client 半端：假 window.__ModuleLoader__ 上真跑 factory() ────────────── */

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
let loaded = null
const prevWindow = globalThis.window
globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }
try {
  await import(`./client.js?selfcheck=${Date.now()}`)
} catch (e) {
  globalThis.window = prevWindow
  fail('client.js 一 import 就抛错（浏览器里会是一片空白）', e)
}
globalThis.window = prevWindow

if (!loaded) fail('client.js 没有调用 window.__ModuleLoader__.load({...}) —— 那它不会被挂上')
if (loaded.id !== pkg.name) fail(`client.js 的 id（${loaded.id}）必须等于 package.json 的 name（${pkg.name}）`)
if (typeof loaded.factory !== 'function') fail('client.js 的 load({...}) 里没有 factory 函数')

const fakeReact = {
  createElement: (...a) => ({ tag: a[0], props: a[1] }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  Fragment: 'Fragment',
}
/* ⭐ 2026-10-26 桌宠化：client 半端不再往 settings.section 注册任何东西（使用者的要求：
 *    "鲸鱼摸鱼的设置不要在 dsh 的默认设置里"），改成 apply() 里直接往 document.body 挂一棵
 *    桌宠树。原来只假的 document.head 不够用了 —— 这里把 body 和 react-dom 也补上，
 *    好让「桌宠到底挂没挂上」也能在这一步被真逼出来。 */
const renderedTrees = []
const fakeReactDom = {
  createRoot: (node) => ({
    render: (el) => { renderedTrees.push({ node, el }) },
    unmount: () => {},
  }),
}
let clientMod
try {
  clientMod = loaded.factory((name) => {
    if (name === 'react') return fakeReact
    if (name === 'react-dom/client') return fakeReactDom
    if (name === 'react-dom') return fakeReactDom
    throw new Error(`client.js require 了没预料到的包：${name}`)
  })
} catch (e) {
  fail('client.js 的 factory(require) 抛错', e)
}
if (typeof clientMod?.apply !== 'function') fail('client.js 的 factory 必须返回带 apply() 的对象')

// 真调一次 apply（假 DOM + 假 slots），把拼错的名字、漏掉的 ctx 方法都逼出来
const slotsReg = []
const styleNodes = []
const hostNodes = []
const prevDoc = globalThis.document
globalThis.document = {
  hidden: false,
  createElement: () => {
    const n = {
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = v },
      remove() {},
      textContent: '',
    }
    return n
  },
  head: { appendChild: (n) => styleNodes.push(n) },
  body: { appendChild: (n) => hostNodes.push(n) },
}
try {
  clientMod.apply({
    effect: (fn) => { try { return fn() } catch { return undefined } },
    slots: {
      inject: (name, fn) => { fn() },
      register: (opts, Component) => { slotsReg.push({ ...opts, hasComponent: typeof Component === 'function' }); return {} },
    },
    get: () => undefined,
  })
} catch (e) {
  globalThis.document = prevDoc
  fail('client.js 的 apply(ctx) 抛错', e)
}
globalThis.document = prevDoc

if (!styleNodes.length) fail('client.js 的 apply 没有把样式挂上（页面会没样子）')
/* ⭐ 这两条是 2026-10-26 改造后的新契约：**不许再注册 settings.section**（那正是
 *    "鲸鱼摸鱼的设置出现在 DSH 默认设置里"的来源），同时桌宠必须真的挂到 body 上。 */
if (slotsReg.length) {
  fail('client.js 又往 slot 注册了（' + slotsReg.map((s) => s.name + '/' + s.id).join(', ') +
    '）—— 鲸鱼摸鱼的设置不该出现在 DSH 的默认设置里，整页已经搬进桌宠的 ⚙️ 设置弹窗')
}
if (!hostNodes.length) fail('client.js 的 apply 没有往 document.body 挂桌宠（装上了却看不见鱼）')
if (!renderedTrees.length) fail('桌宠的 react-dom root 没有 render（鱼挂上了但是空壳）')
const parts = clientMod.debugParts || {}
/* ⭐ 2026-10-27：旧的全页 Panel 已退役删掉，debugParts 只剩弹窗 + 桌宠三个件 ——
 *    回归断言由 devtools/render-modal.cjs（弹窗）和 check-menu-dom.cjs（桌宠菜单）盯着。 */
for (const k of ['PetSettingsModal', 'PetRoot', 'PetFish']) {
  if (typeof parts[k] !== 'function') fail(`client.js 没有导出 debugParts.${k} —— devtools 的 render-modal/shot-modal 要靠它渲染设置弹窗`)
}
console.log(`✓ client 半端 OK：id=${loaded.id}  注入=${JSON.stringify(clientMod.inject)}  桌宠已挂上 body、调试入口 ${Object.keys(parts).length} 个`)

try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch { /* 留着也无所谓 */ }
console.log(`\n（预检不碰真家目录：host 用 ${SANDBOX_HOME}）`)
