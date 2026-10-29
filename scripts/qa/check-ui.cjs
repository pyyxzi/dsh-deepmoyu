/**
 * check-ui.cjs —— 一条命令跑完设置弹窗的全部渲染验证 + 变异自检 + 后端契约。
 *
 * 为什么需要它：`node --check` 只验语法、`selfcheck.mjs` 只验结构，
 * 都验不到「渲染时引用了不存在变量」「字段名拼错导致 undefined」「NaN 进了界面」
 * 「同一次工具调用的 call/done 没合并成一行」这类真会让用户看到坏界面的问题。
 *
 * 它做三件事（2026-10-27 起跑 render-modal.cjs —— 旧全页 Panel 已退役，弹窗即设置页）：
 *   1. render-modal.cjs 的十个场景（原七场景 + review-run / review-partial / review-retry）
 *   2. 变异自检 —— 故意把代码改坏，确认断言**真的能抓到**（否则等于没验）
 *   3. 后端契约 —— 渲染树看不见的源码级承诺（镜像 heavy、凭证隔离、计量信标、rev 增量）
 *
 * 用法：node check-ui.cjs [client.js 路径]
 * 默认验证仓库内 client.js；可显式传其他副本。
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const DEF = require('./paths.cjs').CLIENT
const CLIENT = process.argv[2] || DEF
const HERE = __dirname
const RUNNER = path.join(HERE, 'render-modal.cjs')

if (!fs.existsSync(CLIENT)) { console.error('找不到 client.js: ' + CLIENT); process.exit(2) }
if (!fs.existsSync(RUNNER)) { console.error('找不到 render-modal.cjs（应与本文件同目录）'); process.exit(2) }

const SCENARIOS = ['normal', 'fresh', 'blocked', 'budget', 'empty', 'partial', 'pvrun', 'review-run', 'review-partial', 'review-retry']
let totalPass = 0
let totalFail = 0
const failures = []

function runOne(cliPath, scenario) {
  try {
    const out = execFileSync(process.execPath, [RUNNER, cliPath, scenario], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') }
  }
}

console.log('═══ ① 十个场景（六组导航与子页 + 本地上传入口 + HTTP错误与404恢复 + 按需创建 + 计量 + 学习审核 + 日志生命周期） ═══')
for (const s of SCENARIOS) {
  const { code, out } = runOne(CLIENT, s)
  const pass = (out.match(/^✓/gm) || []).length
  const failedLines = out.split('\n').filter((line) => /^✗/.test(line) && !/^✗ \d+ 项没通过/.test(line))
  const fail = failedLines.length
  totalPass += pass
  totalFail += fail
  const mark = code === 0 ? '✓' : '✗'
  console.log(`${mark} ${s.padEnd(9)} exit=${code}  ${pass} 通过  ${fail} 失败`)
  if (code !== 0) {
    for (const line of failedLines) { console.log('      ' + line.trim()); failures.push(`${s}: ${line.trim()}`) }
    if (!failedLines.length) { totalFail++; failures.push(`${s}: 运行器异常退出 ${code}`); console.log(out.slice(-1600)) }
  }
}

console.log('\n═══ ② 变异自检（故意改坏，断言必须抓到） ═══')
const src = fs.readFileSync(CLIENT, 'utf8')
const MUTANTS = [
  /* 💬 私信判重是「自动回复私信」唯一的安全底座：UI 必须把「同一条只回一次」说出口，
     而且子项只在开关打开时渲染（关着还渲染 = 用户以为开着就生效）。 */
  ['回复口径退回「有人回就都回」（旧条数观复活）',
    (t) => t.replace("'无固定条数上限；是否回复由角色自主判断。同一条评论只回复一次", "'收到评论后必须全部回复。同一条评论只回复一次"), 'normal'],
  ['私信回复子项不看开关（关着也渲染）', (t) => t.replace("sw('autoReplyDm') ? h('div', { 'data-bd-sub': '' },", "true ? h('div', { 'data-bd-sub': '' },"), 'normal'],
  ['私信判重承诺丢失', (t) => t.replace('同一条私信只回复一次', '同一条私信允许重复回复'), 'budget'],
  ['已关注用户筛选未使用统一 Switch',
    (t) => t.replace(/h\(Switch, \{\s+on: Boolean\(sw\('dmReplyFollowedOnly'\)\),/, "h('span', { 'data-not-a-switch': '', on: Boolean(sw('dmReplyFollowedOnly')),"),
    'budget'],
  /* 🧱 布局/骨架：这几条护着 2026-10-19 那次布局修复 —— flex-wrap 收窄换行、卡片描边、
     blocked 相位的徽章（撞上限停下不能显示成「空闲」）。 */
  ['删掉 flex-wrap（还原布局 bug）', (t) => t.replace('gap:10px;flex-wrap:wrap;}', 'gap:10px;}'), 'normal'],
  ['卡片去掉 border', (t) => t.replace('border:1px solid var(--dsw-alias-border-l2,', 'outline:none;--x:'), 'normal'],
  ['撞上限停下徽章仍显示「空闲」（漏了 blocked 相位）',
    (t) => t.replace("fy.goal?.phase === 'paused' || fy.goal?.phase === 'blocked'", "fy.goal?.phase === 'paused'"), 'blocked'],
  /* 📡 活动流水：id 合并（call/done 一行）+ sinceUid 增量 + live 每趟都进 —— 流水不动
     用户就以为卡死了，这三条是「让使用者看见操作」的底线。 */
  ['流水永远追加（不按 id 合并）', (t) => t.replace('const at = row.id ? next.findIndex((x) => x && x.id === row.id) : -1', 'const at = -1'), 'normal'],
  ['增量参数换成 sinceSeq（协议对不上）', (t) => t.replace("'/activity?sinceUid='", "'/activity?sinceSeq='"), 'normal'],
  ['live 只在增量里有（流水不动就不更新 thinking）', (t) => t.replace('if (r.live) setActLive(r.live)', 'if (false) setActLive(r.live)'), 'normal'],
  ['thinking 恒为真（没在跑也说正在想）', (t) => t.replace('fyLive && actLive && actLive.thinking', 'true'), 'empty'],
  /* 🚫 条数上限不允许复活（2026-10-20 使用者拍板「不限制条数」）：
     自动评论子项那行说明就是旧输入框的坟头碑，丢了就等于口子又开了。 */
  ['评论条数上限又写回设置页（旧输入框复活）',
    (t) => t.replace("'无固定每日条数上限；是否评论由角色自主判断。同一个视频只评论一次，发送受节奏、冷却和判重限制。'", "'一轮最多评几条'"),
    'normal'],
  ['回复子项缺少自主判断与单条判重说明',
    (t) => t.replace("'无固定条数上限；是否回复由角色自主判断。同一条评论只回复一次，避免对同一对象连续重复回复。'", "'收到评论后自动回复。'"),
    'normal'],
  /* 🧾 token 账本卡（新代码不钉等于零覆盖）：KPI 读数、明细行、未计量诚实原则、
     14 天柱图、学习/判重概览、镜像与诊断按钮的请求行为。 */
  ['token 总账读错字段（tokensTotal → tokensTotai）',
    (t) => t.replace('const total = st.tokensTotal', 'const total = st.tokensTotai'),
    'normal'],
  ['任务明细整段读丢（entries → entires）',
    (t) => t.replace('st.tokenRounds.entries : []', 'st.tokenRounds.entires : []'),
    'normal'],
  ['未计量被编成 0（诚实原则破坏）',
    (t) => t.replace("unmetered(r) ? '未计量' : fmt(r.tokens.total)", "unmetered(r) ? fmt(0) : fmt(r.tokens.total)"),
    'normal'],
  ['14 天柱图零值天不标记（data-zero 丢失）',
    (t) => t.replace("'data-zero': c.value > 0 ? undefined : ''", "'data-zero': undefined"),
    'normal'],
  ['判重账本读错字段（seen.videos → seen.videoCount）',
    (t) => t.replace('Number(sn.videos) || 0', 'Number(sn.videoCount) || 0'),
    'normal'],
  ['学习队列概览读错字段（learn.pending → learn.waiting）',
    (t) => t.replaceAll('Number(learnInfo.pending) || 0', 'Number(learnInfo.waiting) || 0'),
    'normal'],
  ['镜像按钮不发请求（点了没反应）',
    (t) => t.replace("jpost('/mirror', {})", "Promise.resolve({ ok: true })"),
    'normal'],
  ['一键诊断不发请求（点了没反应）',
    (t) => t.replace("jget('/diag')", "Promise.resolve({ ok: true, pack: {} })"),
    'normal'],
]
const mutationRoot = require('./paths.cjs').qaOutput('mutants')
fs.mkdirSync(mutationRoot, { recursive: true })
const mutationDir = fs.mkdtempSync(path.join(mutationRoot, 'run-'))
const tmp = path.join(mutationDir, 'client.js')
process.on('exit', () => fs.rmSync(mutationDir, { recursive: true, force: true }))
let mutCaught = 0
let mutSkipped = 0
for (const [name, mut, scenario] of MUTANTS) {
  const mutated = mut(src)
  if (mutated === src) { console.log(`  ✗ ${name} —— 替换没生效（必须更新变异目标）`); mutSkipped++; totalFail++; failures.push('变异未命中: ' + name); continue }
  fs.writeFileSync(tmp, mutated, 'utf8')
  const { code } = runOne(tmp, scenario)
  if (code !== 0) { console.log(`  ✓ ${name} —— 抓到了`); mutCaught++ }
  else { console.log(`  ✗ ${name} —— 漏了（断言不够严）`); failures.push(`变异漏检: ${name}`); totalFail++ }
}
fs.rmSync(tmp, { force: true })

console.log('\n═══ ③ 后端契约（源码级，渲染树看不见的） ═══')
{
  const LIB = path.join(path.dirname(CLIENT), 'lib', 'mirror.mjs')
  const IDX = path.join(path.dirname(CLIENT), 'index.js')
  const m = fs.existsSync(LIB) ? fs.readFileSync(LIB, 'utf8') : ''
  const ix = fs.existsSync(IDX) ? fs.readFileSync(IDX, 'utf8') : ''
  const okB = (name, pass, detail) => {
    totalPass += pass ? 1 : 0; totalFail += pass ? 0 : 1
    console.log(`${pass ? '✓' : '✗'} ${name}${detail && !pass ? '  ' + detail : ''}`)
    if (!pass) failures.push('后端契约: ' + name)
  }
  /* 🧾 2026-10-21 真抓到过的 bug：`mirrorOnce` 收了 `{heavy:true}` 却从没读过它，
     ⇒ activity.jsonl 一次都没被镜像。这条只能源码级盯 —— 渲染树、语法检查都看不出。 */
  okB('mirrorOnce 真读 opts.heavy（不是收下参数就丢）',
    /opts\.heavy\s*\?/.test(m),
    m ? 'lib/mirror.mjs 里没有 opts.heavy ?' : '找不到 lib/mirror.mjs')
  okB('手动同步那条走 heavy（人点了就该看全的）',
    /mirrorNow\(\s*'手动'\s*,\s*true\s*\)/.test(ix),
    'index.js /mirror 路由没传 heavy=true')
  okB('挂载重镜像保留 heavy（直接或排队执行）',
    /mirrorNow\(\s*'挂载'\s*,\s*true\s*\)/.test(ix)
      || (/queueMirror\(\s*'挂载'\s*,\s*true\s*\)/.test(ix)
        && ix.includes('mirrorPendingHeavy ||= heavy') && ix.includes('const heavyNow = mirrorPendingHeavy')
        && /mirrorNow\(\s*whyNow\s*,\s*heavyNow\s*\)/.test(ix)))
  /* ⚠️ 只看**数组字面量本身**，别扫整个文件头 —— 文件头那句注释恰恰写着
         「绝不复制 bili_credential.json」，扫全文会把它当违规（假红）。 */
  const namesBlock = (() => {
    const i = m.indexOf('export const MIRROR_NAMES')
    if (i < 0) return ''
    const j = m.indexOf(']', i)
    return j < 0 ? '' : m.slice(i, j + 1)
  })()
  const heavyBlock = (() => {
    const i = m.indexOf('export const MIRROR_HEAVY')
    if (i < 0) return ''
    const j = m.indexOf(']', i)
    return j < 0 ? '' : m.slice(i, j + 1)
  })()
  okB('登录凭证永不进镜像（MIRROR_NAMES / MIRROR_HEAVY 里没有 credential）',
    Boolean(namesBlock) && !/credential/i.test(namesBlock + heavyBlock),
    namesBlock ? '镜像名单里出现了 credential —— 这是硬红线' : '解析不到 MIRROR_NAMES')

  /* 🛰 2026-10-27 新增：后台轮计量信标 + 对账。子进程若加载了本插件，会往
     bg-usage.jsonl 追加计量；宿主按 pid 对账回总账/今日账/任务账本。 */
  okB('后台子进程带上 BILI_DUTY_ROLE=background（信标的开关钥匙）',
    /BILI_DUTY_ROLE:\s*'background'/.test(ix),
    'runDuty spawn env 里没有 BILI_DUTY_ROLE')
  okB('信标只认「后台角色 + 明确 state 目录」（前台进程绝不写信标）',
    /BILI_DUTY_ROLE \|\| ''\) === 'background' && process\.env\.BILI_DUTY_HOME/.test(ix),
    '信标门槛不完整，可能前台也写')
  okB('后台结束后按 pid 对账（reconcileBgUsage(child.pid)）',
    /reconcileBgUsage\(\s*child\.pid\s*\)/.test(ix),
    'exit/error 收尾没调 reconcileBgUsage')
  /* 🧾 清零要连明细账一起清 —— 只清总数、明细里还躺着 50 万，用户会以为明细是编的。 */
  const resetIdx = ix.indexOf("if (body?.resetTokensTotal)")
  okB('总 token 清零连明细账（clearTokenLedger）一起清',
    resetIdx >= 0 && ix.indexOf('clearTokenLedger(stateDir)', resetIdx) - resetIdx < 400 && ix.indexOf('clearTokenLedger(stateDir)', resetIdx) > 0,
    resetIdx < 0 ? '没找到 resetTokensTotal 分支' : 'clearTokenLedger 离清零分支太远')
  /* 🔁 /status 与 /pet/log 的 rev 增量：cheap 签名不变 ⇒ 不建 payload、不重渲染。 */
  okB('/status 有 rev 短路（wantRev 对上就直接 unchanged）',
    /const wantRev = url\.searchParams\.get\('rev'\)/.test(ix) && ix.includes("unchanged: true"),
    'status 路由没有 rev 分支')
  /* ⏱️ 2026-10-28「刷多久」语义：后台时长是工作量目标。提示词要写明刷满；
     提前干净收工要自动接力（bg-continue），手动停/出错/时限到不接力。 */
  okB('后台提示词写明「要把本轮时间刷满」（工作量目标，不是上限）',
    ix.includes('要把本轮时间刷满'),
    'promptFor 还是旧的「做完一小段就结束进程」口径')
  okB('后台提前收工自动接力（bg-continue），保险丝 _chain + 剩余 2 分钟门槛',
    ix.includes("petLog('bg-continue'") && /opts\._chain/.test(ix) && /remainMs >= 120_000/.test(ix) && /stopReason === 'exit'/.test(ix),
    '接力逻辑缺了关键护栏')
  /* ⭐ 2026-10-28 后台「时段」任务：常设指令（配置即持久化），段内一直刷。 */
  okB('后台时段进了 /config 白名单（漏表 = 保存被静默丢掉）',
    ix.includes("'backgroundWindowStart', 'backgroundWindowEnd'"),
    '保存会被静默丢掉')
  okB('时段内一直刷：automationTick 段内自动拉起（bg-window），跨午夜由 backgroundWindowActive/EndAt 算',
    ix.includes("runDuty('bg-window'") && ix.includes('backgroundWindowActive(') && ix.includes('backgroundWindowEndAt('),
    '时段常设指令没接进调度钩子')
  okB('手动停止挂免跑牌（bgWindowHold），时段内不再自动拉起、重启也认',
    /bgWindowHold: endAt/.test(ix) && /Number\(st\.bgWindowHold\)/.test(ix),
    '停止后会被调度钩子重新拉起')
  okB('/pet/start 请求体不带时段字段（契约被 E2E 严格钉死），host 从 config 读常设时段',
    ix.includes('backgroundWindowActive(ws, we)') && ix.includes('runDuty(\'pet\', { ...run, ...(windowEndAt ? { windowEndAt } : {}) })'),
    '时段字段漏进了请求体')
  /* 🗨️🎨 2026-10-28 拟人包：收工小结 / 心情色 / 闲聊 / 需要你 —— 全是显示层，不碰行为。 */
  okB('收工小结是人话（wrapUpLine 走 petEvent 通道），额度满了会说破',
    ix.includes('const wrapUpLine') && ix.includes('petEvent: st.petEvent && st.petEvent.at') && ix.includes('后半程我只看不发'),
    'petEvent 通道或小结文案缺失')
  okB('时段任务连刷 3 小时会自己歇 15 分钟（按 bgWindowSince 墙钟累计，休息/接力互斥）',
    ix.includes('bgWindowSince') && /continuousMs > 3 \* 3600_000/.test(ix) && /!restUntil && runState\.stopReason === 'exit'/.test(ix),
    '休息和接力打起来了')
  okB('接力发生的轮次绝不发收工小结（willContinue 与小结互斥，防「我去睡了」刷屏）',
    ix.includes('const willContinue') && /!opts\.review && !willContinue/.test(ix),
    '小结会在接力轮误发')
  okB('闲聊低频且可关（idleChatter + 下次开口时间存 state，不再每跳重抽随机数）',
    ix.includes('idleChatter !== false') && ix.includes('petChatterAt') && ix.includes('const chatterLine'),
    '闲聊通道缺失')
  okB('心情色纯显示层（moodOf 只读 soul 最近一行 + 最近收尾）',
    ix.includes('const moodOf') && ix.includes("soulSectionBody(stripComments(readSoul(stateDir)), 'mood')"),
    'mood 推导缺失')
  okB('孤儿进程只认领不乱杀（pid 落盘 + ESRCH 探测 + 信标对账，没有单参 kill）',
    ix.includes('bgChildPid') && ix.includes('process.kill(orphan, 0)') && !/process\.kill\(orphan\)(?!,)/.test(ix),
    '孤儿处理不安全')
  okB('客户端：需要你不吞掉 err/run/bg 优先级 + petEvent/attention toast 只报新账',
    /attention\.length \? 'attention'/.test(src) && src.includes('lastPetEventRef') && src.includes('lastAttentionRef'),
    'aura 优先级或 toast 去重缺失')
  okB('客户端：心情小灯 + 新手三步卡 + 时段进度 + 节奏说人话 + 闲聊开关全都在',
    src.includes('data-bd-pet-mood') && src.includes('data-bd-onboard') && src.includes('本时段已刷')
      && src.includes('data-bd-pace-current') && src.includes('已保存的发送间隔') && src.includes('不是当前倒计时')
      && src.includes('闲聊提示'),
    '某一处 UI 没接上')
}

console.log(`\n变异抓到 ${mutCaught}/${MUTANTS.length - mutSkipped}${mutSkipped ? `（${mutSkipped} 个跳过）` : ''}`)
console.log(`\n─────────────── 总计 ───────────────`)
console.log(`断言：${totalPass} 通过 / ${totalFail} 失败`)
if (failures.length) { console.log('\n失败明细：'); for (const f of failures) console.log('  · ' + f) }
const ok = totalFail === 0 && mutCaught === MUTANTS.length && mutSkipped === 0
console.log(ok ? '\n✓ 工作台回归通过：六组导航、完整子功能、上传入口、HTTP错误与404恢复、按需创建、学习审核、日志清理、token 与会话关联均有证据。' : '\n✗ 回归失败，见失败明细。')
process.exit(ok ? 0 : 1)
