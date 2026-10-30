/**
 * render-modal.cjs —— 在 Node 里把桌宠设置弹窗（PetSettingsModal）真跑一遍。
 *
 * 为什么需要它：`node --check` 只验语法、`selfcheck.mjs` 只验结构，
 * 都验不到「渲染时引用了不存在的变量」「字段名拼错导致 undefined」「NaN 进了界面」
 * 「同一次工具调用的 call/done 没合并成一行」这类真会让用户看到坏界面的问题。
 *
 * 它接替退役的 render-panel.cjs（旧全页 Panel 已删）：
 *   1. 用假的 window.__ModuleLoader__ 接住工厂函数
 *   2. 假 React：按渲染路径区分实例，校验 hook 顺序/数量，依赖变化及卸载都执行 cleanup
 *   3. 假 fetch：完整学习列表、人工决定、审核、日志增量及既有端点 fixture
 *   4. 先渲染「读取中」态，等 promise 落地后再渲染完整 UI，递归展开所有子组件
 *   5. 六组与子页逐一巡览；normal 真点分页、筛选、人工决定、审核、soul、表情、菜单和新会话
 *   6. 收集全部文本叶子，断言关键内容出现、且没有 undefined / NaN / [object Object]
 *
 * 用法：node render-modal.cjs <client.js 路径> [normal|fresh|blocked|budget|empty|partial|pvrun|review-run|review-partial|review-retry]
 */
const fs = require('fs')

const CLIENT = process.argv[2] || require('./paths.cjs').CLIENT
const SCENARIO = process.argv[3] || 'normal'
if (!CLIENT || !fs.existsSync(CLIENT)) {
  console.error('usage: node render-modal.cjs <path/to/client.js> [normal|fresh|blocked|budget|empty|partial|pvrun|review-run|review-partial|review-retry]')
  process.exit(2)
}

/* ────────────────────────── 假 document / window ────────────────────────── */
const removed = []
const doc = {
  head: { appendChild() {} },
  createElement() {
    return { remove() { removed.push(1) }, setAttribute() {}, appendChild() {} }
  },
  body: { appendChild() {} },
  addEventListener() {}, removeEventListener() {},
  hidden: false,
}

let mod = null
let confirmResult = true
const configPosts = []
const win = {
  __ModuleLoader__: {
    load(m) { mod = m },
  },
  /* 「清空 soul 一节」有一次 confirm（不可撤销的动作）——假 window 也得有 */
  confirm: () => confirmResult,
  innerWidth: 1280, innerHeight: 800,
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {} },
}

/* ───── 假 React：组件实例、hook 顺序、依赖变化与卸载 cleanup ───── */
const store = new Map()
let currentInstance = null
let idx = 0
let pendingEffects = []
let visited = new Set()
const cleanupCalls = []
const updatesAfterUnmount = []

const createdElements = []
const h = (type, props, ...children) => {
  createdElements.push({ type: typeof type === 'function' ? type.name : String(type), page: props?.['data-bd-settings-page'] })
  return { type, props: props || {}, children: children.flat(Infinity) }
}
const sameDeps = (a, b) => Boolean(a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i])))
function nextHook(kind) {
  if (!currentInstance) throw new Error(kind + ' 在组件外调用')
  const instance = currentInstance
  const i = idx++
  if (instance.kinds[i] && instance.kinds[i] !== kind) throw new Error(`hook 顺序改变：${instance.id} #${i} ${instance.kinds[i]} → ${kind}`)
  instance.kinds[i] = kind
  return [instance, i]
}
function cleanEffect(instance, i) {
  const effect = instance.effects[i]
  if (typeof effect?.cleanup === 'function') {
    cleanupCalls.push(instance.id + '#' + i)
    const cleanup = effect.cleanup
    effect.cleanup = undefined
    cleanup()
  }
}
const React = {
  createElement: h,
  useState(init) {
    const [instance, i] = nextHook('state')
    if (!(i in instance.slots)) instance.slots[i] = typeof init === 'function' ? init() : init
    return [instance.slots[i], (value) => {
      if (!instance.mounted) { updatesAfterUnmount.push(instance.id + '#' + i); return }
      instance.slots[i] = typeof value === 'function' ? value(instance.slots[i]) : value
    }]
  },
  useEffect(fn, deps) {
    const [instance, i] = nextHook('effect')
    const old = instance.effects[i]
    if (!old || !sameDeps(old.deps, deps)) {
      instance.effects[i] = { deps: deps?.slice(), cleanup: old?.cleanup }
      pendingEffects.push({ instance, i, fn })
    }
  },
  useRef(init) {
    const [instance, i] = nextHook('ref')
    if (!(i in instance.slots)) instance.slots[i] = { current: init }
    return instance.slots[i]
  },
  useMemo(fn, deps) {
    const [instance, i] = nextHook('memo')
    const old = instance.slots[i]
    if (!old || !sameDeps(old.deps, deps)) instance.slots[i] = { deps: deps?.slice(), value: fn() }
    return instance.slots[i].value
  },
  useCallback(fn, deps) { return React.useMemo(() => fn, deps) },
}
function renderComp(fn, props, instancePath = 'root') {
  const id = instancePath + ':' + fn.name
  if (!store.has(id)) store.set(id, { id, slots: [], kinds: [], effects: [], mounted: true, hookCount: null })
  const instance = store.get(id)
  instance.mounted = true
  visited.add(id)
  const previous = currentInstance
  const previousIdx = idx
  currentInstance = instance
  idx = 0
  try {
    const result = fn(props || {})
    if (instance.hookCount !== null && instance.hookCount !== idx) throw new Error(`hook 数量改变：${id} ${instance.hookCount} → ${idx}`)
    instance.hookCount = idx
    return result
  } finally { currentInstance = previous; idx = previousIdx }
}
function commitEffects() {
  for (const [id, instance] of store) {
    if (visited.has(id)) continue
    instance.mounted = false
    instance.effects.forEach((_, i) => cleanEffect(instance, i))
    store.delete(id)
  }
  for (const { instance, i } of pendingEffects) cleanEffect(instance, i)
  for (const { instance, i, fn } of pendingEffects) if (instance.mounted) instance.effects[i].cleanup = fn()
  pendingEffects = []
}
function unmountAll() {
  visited = new Set()
  pendingEffects = []
  commitEffects()
}

/* ────────────────────────── 假数据 ────────────────────────── */
const CFG = {
  perDay: 5, peakValley: false, noon: true, night: true,
  autoComment: true, dmMode: 'off', dmUid: 0,
  autoReplyDm: false, dmReplyPerDay: 3, dmReplyFollowedOnly: true,
  transcribe: false, asrModel: 'small',
  commentPerRound: 1, mentionName: 'Fixture User',
  keywords: ['DeepSeek Harness', '本地大模型'],
  pythonPath: '/synthetic-fixture/bili-duty/.venv/bin/python',
  dshBin: '', headlessProfile: 'headless', overlayMcp: true,
  workspace: '/synthetic-fixture/workspace', reportLevel: 'full',
  replyToComments: true, replyPerRound: 3,
  persona: '说人话，有判断，不凑数。',
  autoMoment: false, momentPerDay: 1, momentStyle: '感想',
  videoModelId: 'deepseek-official/deepseek-pro',
  modelId: '', tokenBudget: 500000, totalTokenBudget: 3000000, maxRounds: 64,
  /* ⏱️ 出手节奏系数取 1.5（不是兜底的 1）——否则「字段名读错 → 走兜底」的变异渲染出来一样 */
  paceFactor: 1.5,
  petShow: true, idleChatter: true,
  scheduleEnabled: false, scheduleAllDay: false, scheduleStart: '18:00', scheduleEnd: '09:00',
  sessionModelId: '', sessionTokenBudget: 500000, sessionMaxRounds: 64, sessionMinutes: 0,
  backgroundModelId: '', backgroundTokenBudget: 300000, backgroundMinutes: 45,
  learnAutoReview: true, learnReviewBatchSize: 20, learnReviewMinutes: 10, learnReviewTokenBudget: 12000,
}

const FEIYU = {
  ok: true, active: true,
  goal: { id: 'goal-6d0506a0-8901-4315-b873-0fcb7d374fbf', phase: 'active', activation: 'armed', rounds: 2, maxRounds: 64 },
  roundsThisRun: 2,
  model: 'workbuddy-xdpool/deepseek-v4.1-flash',
  modelOverride: '', modelActive: 'workbuddy-xdpool/deepseek-v4.1-flash',
  tokens: { session: 2045136, input: 2018060, output: 27076, thisRun: 3045136, budget: 500000, left: 0, today: 45678, totalAll: 1234567, totalBudget: 3000000 },
  pickedToday: 5, perDay: 5, momentsToday: 1, momentPerDay: 1,
  autoComment: true, autoMoment: false, replyToComments: false,
  persona: true, focus: '',
  report: '/synthetic-fixture/bili-duty/out/2026-10-20.md',
  startedAt: 1792444479039, stopReason: '',
}

const PV = {
  ok: true,
  deps: true,
  python: '/synthetic-fixture/bili-duty/.venv/bin/python',
  voice: 'zh-CN-XiaoyiNeural',
  auto: false, at: '10:30', modelId: 'deepseek-official/deepseek-pro',
  sessions: [
    { sessionId: 'fixture-video-a', productionId: 'completed-a', date: '2026-10-20', mode: 'daily', model: 'deepseek-official/deepseek-pro', brief: 'fixture视频任务', stage: 'done', createdAt: '2026-10-21T09:00:00.000Z' },
    ...['cover', 'render', 'verify', 'publish', 'failed', 'authoring'].map((stage) => ({ sessionId: 'fixture-' + stage, date: '2026-10-20', mode: 'rant', model: 'deepseek-official/deepseek-pro', brief: 'fixture阶段', stage, ...(stage === 'failed' ? { error: 'fixture任务失败' } : {}) })),
  ],
  productions: [
    { id: 'completed-a', date: '2026-10-20', mode: 'daily', title: 'fixture完成视频A', file: 'C:/fixture/a.mp4', stage: 'done' },
    { id: 'completed-b', date: '2026-10-20', mode: 'rant', title: 'fixture完成视频B', file: 'C:/fixture/b.mp4', stage: 'done', verification: { ok: true } },
    { id: 'pending', date: '2026-10-20', mode: 'daily', title: 'fixture未完成视频', file: 'C:/fixture/pending.mp4', stage: 'render' },
    { id: 'failed', date: '2026-10-20', mode: 'daily', title: 'fixture失败视频', file: 'C:/fixture/failed.mp4', stage: 'failed' },
    { id: 'bad-verify', date: '2026-10-20', mode: 'daily', title: 'fixture未通过校验视频', file: 'C:/fixture/bad.mp4', stage: 'done', verification: { ok: false } },
  ],
  gsv: { on: true, repo: '/synthetic-fixture/GPT-SoVITS', ref: '/synthetic-fixture/reference.wav', python: '/synthetic-fixture/gsv/bin/python' },
  gsvRepo: '/synthetic-fixture/GPT-SoVITS',
  gsvRef: '/synthetic-fixture/reference.wav',
  gsvPrompt: '今天的海水温度刚刚好，特别适合一边摸鱼，一边认真工作。',
  gsvPython: '/synthetic-fixture/gsv/bin/python',
  yesterday: '2026-10-20',
  out: '/synthetic-fixture/out', work: '/synthetic-fixture/work', root: '/synthetic-fixture',
  running: false, stage: 'done',
  date: '2026-10-20', startedAt: 1792444479039, ms: 281000,
  file: '/synthetic-fixture/out/daily-2026-10-20.mp4',
  log: '/synthetic-fixture/build-2026-10-20.log',
  error: '', tail: '✅ 大肥鱼日报_2026-10-20.mp4 (4.6 分钟, 7.9 MB)',
  videos: [
    { date: '2026-10-20', file: '/synthetic-fixture/out/daily-2026-10-20.mp4', size: 8211388, mb: 7.8, at: '2026-10-21T08:43:06.000Z' },
    { date: '2026-10-19', file: '/synthetic-fixture/out/daily-2026-10-19.mp4', size: 7000000, mb: 6.7, at: '2026-10-20T08:40:00.000Z' },
  ],
}

const ACT = {
  ok: true,
  rows: [
    { seq: 1, uid: 'aa-1', t: 1792444670000, kind: 'start', text: '开刷：最多 64 轮 · 模型 workbuddy-xdpool/deepseek-v4.1-flash' },
    { seq: 2, uid: 'aa-2', t: 1792444671000, kind: 'call', text: '去搜「DeepSeek Harness」（近 7 天）', id: 't2', tool: 'bili_search' },
    { seq: 3, uid: 'aa-3', t: 1792444675000, kind: 'done', text: '去搜「DeepSeek Harness」（近 7 天） → 1 条', id: 't2', tool: 'bili_search', ms: 3955 },
    { seq: 4, uid: 'aa-4', t: 1792444678000, kind: 'call', text: '看 technology 区七日榜', id: 't5', tool: 'bili_rank' },
    { seq: 5, uid: 'aa-5', t: 1792444679000, kind: 'done', text: '看 technology 区七日榜 → 100 条', id: 't5', tool: 'bili_rank', ms: 114 },
    { seq: 6, uid: 'aa-6', t: 1792444682000, kind: 'say', text: '这一轮我挑了一条讲本地大模型的，因为封面那句「7B 能跑」我信不过', bvid: 'BV1bKJX6mEnY' },
    { seq: 7, uid: 'aa-7', t: 1792444685000, kind: 'call', text: '读字幕 BV1bKJX6mEnY', id: 't9', tool: 'bili_subtitle' },
    { seq: 8, uid: 'aa-8', t: 1792444691000, kind: 'done', text: '读字幕 BV1bKJX6mEnY → 149 段 · 528 秒 · 把大模型，装进背包！', id: 't9', tool: 'bili_subtitle', ms: 5830 },
    { seq: 9, uid: 'aa-9', t: 1792444695000, kind: 'round', text: '第 1 轮游完啦（上限 64）' },
  ],
  last: 'aa-9', lastSeq: 9,
}

/* 🧾 token 账本卡的假数据（/status 顶层字段，形状与 index.js 一致） */
const TOKEN_ROUNDS = {
  ok: true,
  sums: { tasks: 2, input: 111111, output: 22222, total: 133333, unknown: 1 },
  entries: [
    { id: 'tok-a', kind: 'session', label: '鲸鱼摸鱼会话', model: 'workbuddy-xdpool/deepseek-v4.1-flash', rounds: 6, budget: 500000, startedAt: '2026-10-27T09:12:00.000Z', durationSec: 1240, tokens: { input: 111111, output: 22222, total: 133333 }, stopReason: 'token-budget' },
    { id: 'tok-b', kind: 'background', label: '桌宠后台轮', model: 'x/y', rounds: 0, budget: 300000, startedAt: '2026-10-27T02:00:00.000Z', durationSec: 240, tokens: null, tokensUnknown: true, stopReason: 'exit' },
    { id: 'tok-c', kind: 'background', label: '部分计量后台轮', model: 'x/y', startedAt: '2026-10-27T01:00:00.000Z', tokens: { input: 10, output: 2, total: 12 }, unknownRequests: 1, stopReason: 'exit' },
  ],
}
/* 14 天柱图：给两个有值的天 + 若干零值天（柱图/零值样式两条分支都要走到） */
const TOKEN_DAYS = {}
{
  const p = (n) => String(n).padStart(2, '0')
  for (let i = 13; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    TOKEN_DAYS[key] = i === 0 ? 45678 : i === 1 ? 12345 : 0
  }
}

const STATUS = {
  ok: true,
  home: '/synthetic-fixture/bili-duty',
  config: CFG,
  windows: {
    noon: { label: '中午谷时', start: '12:00', end: '14:00', switchOn: true, opening: false },
    night: { label: '晚上/夜间谷时', start: '18:00', end: '09:00', switchOn: true, opening: true },
  },
  today: '2026-10-20', ranToday: 1, pickedToday: 5,
  lastRunAt: 1792444479039, lastWhy: 'window:night',
  loggedIn: true, venvReady: true, version: '2.2.1', notSynced: '',
  dshCli: { command: 'dsh', ok: true },
  installFailed: false, installing: false,
  asrReady: true, asrModelReady: true, asrInstalling: false, asrLog: '', asrTail: '',
  installLog: '/synthetic-fixture/install.log', installTail: 'venvReady=true',
  report: '/synthetic-fixture/out/2026-10-20.md', log: '/synthetic-fixture/duty.log',
  feiyu: FEIYU,
  modelNow: FEIYU.model,
  models: [
    { id: 'workbuddy-xdpool/deepseek-v4.1-flash', label: 'workbuddy · deepseek-v4.1-flash' },
    { id: 'deepseek-official/deepseek-flash', label: 'deepseek · deepseek-flash' },
    { id: 'deepseek-official/deepseek-pro', label: 'deepseek · deepseek-pro' },
  ],
  tokenUsage: { total: 2045136, input: 2018060, output: 27076 },
  tokensTotal: 1234567, tokensToday: 45678, totalTokenBudget: 3000000, activeDays: 3,
  tokenRounds: TOKEN_ROUNDS,
  tokenDays: TOKEN_DAYS,
  /* 🗨️🎨 2.2.1 显示层（fixture 与 /status 载荷对账，2026-10-28 审查补的） */
  petEvent: { at: Date.now() - 8 * 60_000, text: '刷了 20 分钟，挑了 1 条想说给你听 —— 日报都写好了。', tone: 'good' },
  mood: 'curious',
  attention: { level: 'soft', reasons: ['学习队列积了 8 条待审 —— 顺手去「学习与记忆」翻一翻'] },
  bgWindow: { start: '20:00', end: '23:00', active: true, holdUntil: 0 },
  seen: {
    videos: 159, videosToday: 12, lastSeenAt: '2026-10-20T14:47:31.897Z',
    replied: 199, lastRepliedAt: '2026-10-20T09:12:00.000Z',
    md: '/synthetic-fixture/bili-duty/seen.md', mdExists: true,
  },
  learn: {
    pending: 2, approved: 5, rejected: 1, total: 8,
    byKind: { style: { label: '说话方式', pending: 1, approved: 3 }, jargon: { label: '黑话/梗', pending: 1, approved: 2 } },
    recent: [
      { id: 'style:3f2a1b', kind: 'style', label: '说话方式', text: '热评里那种「先损一句再夸」的转折最短也最招人', from: 'BV1bKJX6mEnY', at: '2026-10-20T10:00:00.000Z' },
      { id: 'jargon:9c1d', kind: 'jargon', label: '黑话/梗', text: '「不削能玩？」是「这也太难了」的意思', from: '热词', at: '2026-10-20T11:00:00.000Z' },
    ],
    kinds: ['style', 'jargon', 'fact', 'voice'],
    labels: { style: '说话方式', jargon: '黑话/梗', fact: '场子常识', voice: '踩过的坑' },
  },
  soul: {
    ok: true, file: '/synthetic-fixture/bili-duty/soul.md', md: '/synthetic-fixture/bili-duty/soul.md',
    budget: 900, chars: 128, empty: false,
    updatedAt: '2026-10-21T05:29:43.646Z', exists: true,
    filled: ['mood', 'crave'], counts: { mood: 2, crave: 1, self: 0, next: 0 },
    sections: [
      { key: 'mood', title: '我最近的心情' }, { key: 'crave', title: '我惦记的事' },
      { key: 'self', title: '我对自己学到的事' }, { key: 'next', title: '下次想试试' },
    ],
    text: '## 我最近的心情\n- 10-21 昨天那个 -352 还没消，有点委屈，但也没那么急\n\n## 我惦记的事\n- 10-21 那个讲修表的老哥还有三期没看',
  },
  mirror: {
    dir: '/synthetic-fixture/mirror', auto: true,
    names: ['seen.md', 'voice.md', 'state.json', 'feiyu.json', 'duty.md', 'charter.sha256', 'config.json'],
    files: [{ name: 'seen.md', size: 4200, at: '2026-10-20T14:47:31.897Z' }],
    lastAt: '2026-10-20T14:47:31.897Z', lastCopied: ['state.json', 'activity.jsonl'],
  },
  activity: [],
  /* ⏱️ 出手节奏：刻意给混合态（回评论能发、发新评论在等、额度停牌递增）——
     全都能发的话「waitSec>0 显示还要等」的分支根本走不到，等于没测。 */
  pace: {
    ok: true, factor: 1.5, recentCount: 4,
    cooldown: null,
    burst: { windowMin: 10, max: 10, used: 4 },
    quota: {
      comment: {
        until: '2026-10-21T06:41:46.360Z', waitSec: 2500, kinds: ['comment', 'reply'],
        strikes: 1, parkMin: 42, maxParkMin: 180,
      },
    },
    kinds: {
      comment: { label: '发新评论', gapSec: 180, jitterSec: 90, hourCap: 8, usedThisHour: 3, nextAt: 1792445000000, waitSec: 2500 },
      reply: { label: '回评论', gapSec: 90, jitterSec: 45, hourCap: 15, usedThisHour: 1, nextAt: 1792445000000, waitSec: 2500 },
      opusReply: { label: '回动态评论', gapSec: 30, jitterSec: 15, hourCap: 30, usedThisHour: 0, nextAt: 0, waitSec: 0 },
      dm: { label: '回私信', gapSec: 45, jitterSec: 23, hourCap: 20, usedThisHour: 0, nextAt: 0, waitSec: 0 },
      moment: { label: '发动态', gapSec: 900, jitterSec: 450, hourCap: 1, usedThisHour: 1, nextAt: 1792446000000, waitSec: 0 },
    },
  },
  schedule: { due: false, inWindow: false, lastStartedAt: '', nextRunAt: '', lastError: '' },
  learnReview: { running: false, pending: 2, approved: 0, rejected: 0 },
  backgroundRun: null, bgBusy: false, petShow: true,
  rev: 'fixture-rev-1',
}

const { stickerFixture } = require('./ui-browser-fixture.cjs')
const STICKERS = stickerFixture()
const stickerPosts = []
let stickerFails = false
let stickerHttpStatus = 200
let stickerHttpPlain = false
const paths = { hits: [] }
let actPollCount = 0
const pvPosts = []
const videoSessionPosts = []
let videoFailure = 0
let videoHttpStatus = 200
let videoDeferred = null
let workspaceDeferred = null
const unknownRequests = []
let closeCalls = 0
const videoWarnings = []
let workspaceOpenFails = false
let PV_BODY = PV
const mirrorPosts = []
const openPosts = []
const updateGets = []
const upgradePosts = []
let UPDATE_BODY = { ok: true, current: '2.4.1', latest: '2.5.0', outdated: true, canUpgrade: true, blocker: '', install: { updatable: true, mode: 'registry', profile: 'web', reason: '' }, hint: '可以升级到 2.5.0；升级后需要重启 DSH 才能加载新代码', upgrading: false }
const soulPosts = []
const diagGets = []
const sessionPosts = []
const startPosts = []
const learnPosts = []
const memoryPosts = []
const MEMORY_ITEMS = [
  { source: 'learning', id: 'fact:memory-fixture', state: 'approved', label: '统一经验', text: '统一检索纸张经验', from: 'BV1bKJX6mEnY', version: 'a'.repeat(64), actions: ['revoke', 'forget'], mutable: true, at: '2026-10-29' },
  { source: 'soul', id: 'mood:1', label: '最近的心情', text: '统一检索纸张心情', from: 'soul.md', version: 'b'.repeat(64), actions: ['forget'], mutable: true, at: '2026-10-29' },
  { source: 'seen', id: 'BV1bKJX6mEnY', label: '浏览历史', text: '统一检索浏览证据', from: 'BV1bKJX6mEnY', actions: [], mutable: false, at: '2026-10-29' },
]
const reviewPosts = []
const sendReviewPosts = []
const SEND_REVIEW_ITEMS = [
  { id: 'sr-' + 'a'.repeat(20), hash: '1'.repeat(64), tool: 'bili_reply', kind: '视频评论', state: 'pending', args: { bvid: 'BV1234567890', text: 'fixture第一条待审核评论' }, attachments: [] },
  { id: 'sr-' + 'b'.repeat(20), hash: '2'.repeat(64), tool: 'bili_moment', kind: '动态', state: 'pending', args: { text: 'fixture第二条待审核动态' }, attachments: [] },
  { id: 'sr-' + 'c'.repeat(20), hash: '3'.repeat(64), tool: 'bili_dm_reply', kind: '私信', state: 'unknown', args: { uid: '123', text: 'fixture需要核对发送结果' }, attachments: [] },
]
STATUS.sendReview = { ok: true, enabled: false, pending: 2, unknown: 1, rev: 'send-review-fixture-1' }
const openedSessions = []
let logPollCount = 0
let logUnchangedCount = 0
const LEARNING = Array.from({ length: 23 }, (_, i) => ({
  id: 'style:fixture-' + (i + 1), kind: i % 2 ? 'jargon' : 'style',
  label: i % 2 ? '黑话/梗' : '说话方式', state: 'pending',
  text: `学习长记录 ${String(i + 1).padStart(2, '0')}：${'先说明具体观察，再表达自己的判断。'.repeat(8)}`,
  example: '参考例句 ' + (i + 1) + '：' + '这是外部评论，不是角色自己的经历。'.repeat(12),
  from: 'BV1bKJX6mEnY', at: '2026-10-20T10:00:00.000Z', version: 1,
}))
LEARNING.push({ ...LEARNING[0], id: 'style:approved', state: 'approved', text: '已批准的旧记录', why: '证据充分，可作为参考', decidedAt: '2026-10-21T10:00:00.000Z', version: 3 })
LEARNING.push({ ...LEARNING[1], id: 'jargon:rejected', state: 'rejected', text: '已拒绝的旧记录', why: '来源不够明确', decidedAt: '2026-10-21T11:00:00.000Z', version: 2 })
function learningResponse(view) {
  const state = view.state || 'pending'
  const filter = String(view.filter || '').toLowerCase()
  const matches = LEARNING.filter((row) => (state === 'all' || row.state === state) && (!view.kind || row.kind === view.kind)
    && (!filter || [row.text, row.example, row.from, row.why].some((value) => String(value || '').toLowerCase().includes(filter))))
  const offset = Number(view.offset) || 0
  const limit = Number(view.limit) || 20
  return { ok: true, items: matches.slice(offset, offset + limit), matched: matches.length, more: offset + limit < matches.length, state, offset, limit }
}
const LOG_BASE = [
  { eventId: 'event-start', at: '2026-10-27T09:00:00.000Z', type: 'bg-start', why: 'manual', model: 'fixture/background', raw: { task: 'background' } },
  { eventId: 'event-error', at: '2026-10-27T09:00:01.000Z', type: 'model-error', text: 'fixture模型错误', error: 'fixture错误详情', raw: { detail: 'fixture原始错误' } },
  { eventId: 'event-unknown', at: '2026-10-27T09:00:02.000Z', type: 'future-fixture', text: 'fixture未知事件', raw: { answer: 42 } },
]
const LOG_LATE = { eventId: 'event-after-unchanged', at: '2026-10-27T09:00:03.000Z', type: 'bg-progress', text: 'unchanged后新增进度', raw: { text: 'unchanged后新增进度' } }
const reviewFixture = (extra = {}) => ({ running: false, enabled: true, pending: 23, approved: 0, rejected: 0, remaining: 20, complete: false, model: 'fixture/reviewer', ...extra })
if (SCENARIO === 'review-run') STATUS.learnReview = reviewFixture({ running: true, approved: 2, rejected: 1, remaining: 17 })
if (SCENARIO === 'review-partial') STATUS.learnReview = reviewFixture({ approved: 2, rejected: 1, remaining: 17, lastError: '本批仍有 17 条未处理', lastFinishedAt: '2026-10-27T09:12:00.000Z', nextRetryAt: Date.now() + 180000 })
if (SCENARIO === 'review-retry') STATUS.learnReview = reviewFixture({ enabled: false, lastError: 'fixture暂时不可用', nextRetryAt: Date.now() + 180000, lastFinishedAt: '2026-10-27T09:12:00.000Z' })

/* ────────────────────── 场景变体 ────────────────────── */
if (SCENARIO === 'fresh') {
  Object.assign(STATUS, { loggedIn: false, venvReady: false, ranToday: 0, pickedToday: 0, lastRunAt: null, lastWhy: '', activity: [], tokensTotal: 0, tokensToday: 0, tokenDays: {}, activeDays: 0, tokenRounds: { ok: true, sums: { tasks: 0, input: 0, output: 0, total: 0, unknown: 0 }, entries: [] } })
  STATUS.petEvent = null; STATUS.attention = { level: 'none', reasons: [] }; STATUS.bgWindow = { start: '', end: '', active: false, holdUntil: 0 }
  STATUS.feiyu = { ok: true, active: false, needsChatStart: true, goal: null, tokens: { session: 0, input: 0, output: 0 } }
  PV_BODY = { ...PV, deps: false, stage: '', file: '', videos: [], productions: [], sessions: [] }
  STATUS.modelNow = ''
  STATUS.tokenUsage = { total: 0, input: 0, output: 0 }
  ACT.rows = []
} else if (SCENARIO === 'blocked') {
  FEIYU.active = false
  FEIYU.goal = { id: 'goal-x', phase: 'blocked', activation: 'disarmed', rounds: 64, maxRounds: 64 }
  FEIYU.stopReason = 'round-limit'
  ACT.rows.push({ seq: 10, uid: 'aa-10', t: 1792444999000, kind: 'stop', text: '停下（轮数用尽）· 已跑 64 轮' })
} else if (SCENARIO === 'budget') {
  FEIYU.active = false
  FEIYU.goal = { id: 'goal-y', phase: 'paused', activation: 'disarmed', rounds: 12, maxRounds: 64 }
  FEIYU.stopReason = 'token-budget'
  FEIYU.tokens = { session: 900000, input: 880000, output: 20000, thisRun: 600000, budget: 500000, left: 0, today: 90000, totalAll: 2900000, totalBudget: 3000000 }
  STATUS.tokensTotal = 2900000
  ACT.rows.push({ seq: 11, uid: 'aa-11', t: 1792444999000, kind: 'budget', text: 'token 预算用完（600000/500000）⇒ 自动停' })
  /* 💬 顺手验「自动回复私信」开着时的样子（子项只在开着时渲染） */
  CFG.autoReplyDm = true
  CFG.dmReplyPerDay = 7
} else if (SCENARIO === 'empty') {
  FEIYU.goal = null
  FEIYU.active = false
  FEIYU.model = ''
  ACT.rows = []
  CFG.persona = ''
  CFG.videoModelId = ''
  STATUS.models = []
  PV_BODY = { ...PV, modelId: '', stage: '', file: '', videos: [], productions: [], sessions: [] }
  CFG.keywords = []
  CFG.mentionName = ''
  CFG.dmMode = 'only'
  CFG.workspace = ''
  STATUS.report = ''
} else if (SCENARIO === 'pvrun') {
  PV_BODY = {
    ...PV,
    running: true, stage: 'render', date: '2026-10-20',
    startedAt: Date.now() - 92000, ms: 92000,
    id: 'fixture-running-production', file: '', error: '', videos: [], productions: [],
    sessions: [{ sessionId: 'fixture-running-video', productionId: 'fixture-running-production', date: '2026-10-20', mode: 'custom', model: 'deepseek-official/deepseek-pro', stage: 'render', brief: 'fixture正在渲染' }],
  }
} else if (SCENARIO === 'partial') {
  for (const k of ['persona', 'autoMoment', 'momentPerDay', 'momentStyle', 'modelId', 'tokenBudget', 'totalTokenBudget', 'maxRounds']) delete CFG[k]
  PV_BODY = undefined
  STATUS.feiyu = undefined
  STATUS.modelNow = undefined
  STATUS.tokenUsage = undefined
  STATUS.activity = undefined
  delete STATUS.models
  delete STATUS.seen
  delete STATUS.learn
  delete STATUS.mirror
  delete STATUS.pace
  ACT.rows = []
  FEIYU.ok = false
}
const io = {
  async fetch(url, init) {
    const u = String(url)
    paths.hits.push(u)
    if (/\/config$/.test(u) && init?.method === 'POST') configPosts.push(JSON.parse(init.body || '{}'))
    let body = { ok: true }
    if (/\/mirror$/.test(u)) mirrorPosts.push(String(init?.body ?? ''))
    if (/\/open$/.test(u)) openPosts.push(String(init?.body ?? ''))
    if (/\/update(\?|$)/.test(u)) updateGets.push(u)
    if (/\/upgrade$/.test(u)) upgradePosts.push(String(init?.body ?? ''))
    if (/\/soul$/.test(u)) soulPosts.push(String(init?.body ?? ''))
    if (/\/pv$/.test(u) && init?.method === 'POST') pvPosts.push(String(init?.body ?? ''))
    const parsed = new URL(u, 'http://fixture.local')
    const pathname = parsed.pathname.replace('/api/bili-duty', '')
    const request = init?.body ? JSON.parse(init.body) : {}
    const method = init?.method || 'GET'
    const key = method + ' ' + pathname
    const known = new Set(['GET /status', 'GET /feiyu', 'GET /activity', 'POST /activity', 'GET /pet/log', 'GET /memory', 'POST /memory', 'GET /learn', 'POST /learn', 'POST /learn/review', 'GET /pv', 'POST /pv', 'POST /pv/session-new', 'GET /stickers', 'POST /stickers/collect', 'POST /stickers/forget', 'POST /stickers/upload', 'POST /stickers/approve', 'POST /stickers/reject', 'POST /pet/session-new', 'POST /pet/start', 'POST /pet/stop', 'POST /config', 'GET /diag', 'POST /mirror', 'POST /open', 'GET /update', 'POST /upgrade', 'POST /soul', 'GET /report', 'GET /cfg'])
    known.add('GET /send-review'); known.add('POST /send-review')
    if (!known.has(key)) { unknownRequests.push(key); return { ok: false, status: 404, json: async () => ({ ok: false, error: 'Unknown fixture route: ' + key }) } }
    if (videoDeferred?.key === key) { const held = videoDeferred; videoDeferred = null; return await held.promise }
    if (key === 'GET /pv' && videoHttpStatus !== 200) return { ok: false, status: videoHttpStatus, json: async () => ({ ok: false, error: 'fixture视频HTTP故障' }) }
    if (pathname === '/send-review') {
      if (method === 'POST') {
        sendReviewPosts.push(request)
        const row = SEND_REVIEW_ITEMS.find(item => item.id === request.id && item.state === 'pending' && item.hash === request.expectedHash)
        if (!row || Object.keys(request).sort().join(',') !== 'decision,expectedHash,id') return { ok: false, status: 409, json: async () => ({ ok: false, error: 'fixture预览已变化' }) }
        row.state = request.decision === 'approve' ? 'sent' : 'rejected'
      }
      body = { ok: true, enabled: Boolean(CFG.sendReview), pending: SEND_REVIEW_ITEMS.filter(item => item.state === 'pending').length, items: structuredClone(SEND_REVIEW_ITEMS) }
    } else if (pathname === '/stickers') {
      if (stickerHttpStatus !== 200) return { ok: false, status: stickerHttpStatus, json: async () => { if (stickerHttpPlain) throw Error('HTML error page'); return { ok: false, error: stickerHttpStatus === 404 ? 'fixture图库接口缺失' : 'fixture图库HTTP故障详情' } } }
      body = stickerFails ? { ok: false, error: 'fixture读取中断，可重试' } : structuredClone(STICKERS)
    } else if (pathname === '/stickers/approve' || pathname === '/stickers/reject') {
      stickerPosts.push({ path: pathname, ...request })
      const row = STICKERS.stickers.find((item) => item.source === 'collected' && item.name === request.name && item.status === 'pending')
      if (!row || row.hash !== request.expectedHash || Object.keys(request).sort().join(',') !== 'expectedHash,name') return { ok: false, status: 409, json: async () => ({ ok: false, error: 'fixture审核图片已变化' }) }
      if (pathname.endsWith('/approve')) row.status = 'approved'
      else STICKERS.stickers = STICKERS.stickers.filter((item) => item !== row)
      STICKERS.counts.pending = STICKERS.stickers.filter((item) => item.status === 'pending').length
      body = { ok: true, name: request.name, status: pathname.endsWith('/approve') ? 'approved' : 'rejected' }
    } else if (pathname === '/stickers/collect' || pathname === '/stickers/forget') {
      stickerPosts.push({ path: pathname, ...request })
      body = { ok: true }
    } else if (pathname === '/memory') {
      if (method === 'POST') memoryPosts.push(request)
      const source = parsed.searchParams.get('source') || 'all', filter = String(parsed.searchParams.get('filter') || '')
      const matches = MEMORY_ITEMS.filter((row) => (source === 'all' || source === row.source) && (!filter || row.text.includes(filter)))
      body = { ok: true, source, filter, items: matches, matched: matches.length, total: MEMORY_ITEMS.length, more: false, offset: 0 }
    } else if (pathname === '/learn/review') {
      reviewPosts.push(request)
      STATUS.learnReview = request.action === 'stop' ? reviewFixture({ lastError: '使用者停止审核' }) : reviewFixture({ running: true })
      body = { ok: true, started: request.action !== 'stop', learnReview: STATUS.learnReview }
    } else if (pathname === '/learn') {
      if (init?.method === 'POST') {
        learnPosts.push(request)
        const at = LEARNING.findIndex((row) => row.id === request.id)
        if (at >= 0 && request.decision === 'forget') LEARNING.splice(at, 1)
        else if (at >= 0) Object.assign(LEARNING[at], { state: request.decision === 'approve' ? 'approved' : 'rejected', why: '人工决定fixture', decidedAt: new Date().toISOString(), version: LEARNING[at].version + 1 })
      }
      body = learningResponse(init?.method === 'POST' ? request : Object.fromEntries(parsed.searchParams))
    } else if (pathname === '/pet/log') {
      logPollCount++
      if (logPollCount === 2 && parsed.searchParams.has('rev')) { logUnchangedCount++; body = { ok: true, unchanged: true } }
      else body = { ok: true, rev: logPollCount >= 3 ? 'log-2' : 'log-1', entries: logPollCount >= 3 ? [...LOG_BASE, LOG_LATE] : LOG_BASE }
    } else if (pathname === '/pv/session-new') {
      videoSessionPosts.push(request)
      if (videoFailure === 2) return { ok: false, status: 503, json: async () => ({ ok: false, error: 'fixtureHTTP启动失败', sessionId: 'fixture-http-partial' }) }
      body = videoFailure === 1 ? { ok: false, error: 'fixture部分启动失败', sessionId: 'fixture-partial' }
        : videoFailure === 3 ? { ok: false, error: 'fixture创建失败' }
          : { ok: true, sessionId: 'fixture-video-created', model: request.model, date: request.date, mode: request.mode, accepted: true }
    } else if (pathname === '/pv' && init?.method === 'POST') {
      const row = PV_BODY?.sessions?.find((item) => item.sessionId === request.sessionId)
      if (request.action !== 'stop' || !row) body = { ok: false, error: 'fixture需要指定制作会话' }
      else { row.stage = 'stopped'; body = { ok: true, stopped: true, sessionId: request.sessionId, stage: 'stopped' } }
    } else if (pathname === '/update') { body = { ...UPDATE_BODY } }
    else if (pathname === '/upgrade') {
      body = request.confirm === true
        ? { ok: true, started: true, from: '2.4.1', to: '2.5.0', ...UPDATE_BODY, upgrading: true }
        : { ok: false, code: 'UPGRADE_CONFIRM_REQUIRED', error: '升级需要显式确认（confirm: true）' }
    }
    else if (pathname === '/pet/session-new') { sessionPosts.push(request); body = { ok: true, sessionId: 'fixture-new-session' } }
    else if (pathname === '/pet/start') { startPosts.push(request); body = { ok: true, started: true } }
    else if (pathname === '/config' && init?.method === 'POST') { Object.assign(CFG, request); body = { ok: true, config: { ...CFG } } }
    else if (u.includes('/diag')) { diagGets.push(u); body = { ok: true, text: '诊断包（fixture）' } }
    else if (u.includes('/status')) body = STATUS
    else if (u.includes('/feiyu')) body = FEIYU
    else if (/\/pv(\?|$)/.test(u)) body = PV_BODY === undefined ? { ok: false, error: 'unknown GET /api/bili-duty/pv' } : PV_BODY
    else if (u.includes('/activity')) {
      /* 增量轮询最关键的一关：同一次调用先 call、再 done（共用一个 id），
         前端必须把 done 原地改写进 call 那一行，而不是多出一行。 */
      actPollCount++
      const liveOn = SCENARIO === 'normal'
        ? { active: true, thinking: true, round: 3, maxRounds: 64, since: 92000, stopReason: '' }
        : { active: false }
      if (SCENARIO === 'normal' && actPollCount === 2) {
        body = { ok: true, live: liveOn, rows: [{ seq: 90, uid: 'poll-1', t: 1792444999000, kind: 'call', text: '读字幕 BV1poll', id: 'tp1', tool: 'bili_subtitle' }], last: 'poll-1' }
      } else if (SCENARIO === 'normal' && actPollCount >= 3) {
        body = { ok: true, live: liveOn, rows: [{ seq: 91, uid: 'poll-2', t: 1792444999000, kind: 'done', text: '读字幕 BV1poll → 88 段', id: 'tp1', tool: 'bili_subtitle', ms: 2100 }], last: 'poll-2' }
      } else {
        body = { ...ACT, live: liveOn }
      }
    } else if (u.includes('/report')) body = { ok: true, text: '### BV1bKJX6mEnY\n\n把大模型装进背包，29999 元的定价和「渲 5 秒要 15 分钟」对不上。\n' }
    else if (u.includes('/soul')) body = { ...STATUS.soul, ok: true, cleared: 'mood', filled: ['crave'], text: '## 我惦记的事\n- 10-21 那个讲修表的老哥还有三期没看' }
    else if (u.includes('/cfg')) body = CFG
    return { ok: true, status: 200, json: async () => body }
  },
}

/* ────────────────────────── 装载 client.js ────────────────────────── */
const src = fs.readFileSync(CLIENT, 'utf8')
const intervalCallbacks = new Map()
const timeoutCallbacks = new Map()
let manualTimers = false
const fastTimers = {
  setInterval: (fn, ms) => { const timer = setInterval(fn, Math.max(4, Math.round((ms || 0) / 60))); intervalCallbacks.set(timer, { fn, ms }); return timer },
  setTimeout: (fn, ms) => {
    let timer
    const invoke = () => { timeoutCallbacks.delete(timer); return fn() }
    timer = manualTimers ? {} : setTimeout(invoke, Math.max(4, Math.round((ms || 0) / 60)))
    timeoutCallbacks.set(timer, { fn: invoke, ms, manual: manualTimers })
    return timer
  },
  clearInterval: (t) => { intervalCallbacks.delete(t); clearInterval(t) },
  clearTimeout: (t) => { timeoutCallbacks.delete(t); clearTimeout(t) },
}
try {
  // eslint-disable-next-line no-new-func
  new Function(
    'window', 'document', 'require', 'React', 'fetch',
    'setInterval', 'setTimeout', 'clearInterval', 'clearTimeout', src,
  )(
    win, doc, () => React, React, io.fetch,
    fastTimers.setInterval, fastTimers.setTimeout, fastTimers.clearInterval, fastTimers.clearTimeout,
  )
} catch (e) {
  console.error('✗ 顶层执行失败：' + (e && e.stack || e))
  process.exit(1)
}
if (!mod) { console.error('✗ window.__ModuleLoader__.load 没被调用'); process.exit(1) }
if (mod.id !== 'dsh-deepmoyu') { console.error('✗ 模块 id 不对：' + mod.id); process.exit(1) }

const slotsSeen = []
const slots = {
  inject(_slot, cb) { cb() },
  register(meta, comp) { slotsSeen.push(String(meta && meta.name) + '/' + String(meta && meta.id)) },
}
const ctx = {
  get(name) {
    if (name === 'slots') return slots
    if (name === 'uiWorkspace') return {
      selection: { getSnapshot: () => ({ sessionId: 'fixture-source-session' }) },
      workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'fixture-workspace', sessionIds: ['fixture-source-session'] }] }) } },
      openSession: async (id) => { openedSessions.push(id); if (workspaceDeferred) { const held = workspaceDeferred; workspaceDeferred = null; await held.promise }; if (workspaceOpenFails) throw Error('fixture无法打开会话') },
    }
  },
  effect(fn) { try { const d = fn(); return d } catch (e) { throw e } },
}

const api = mod.factory(() => React)
api.apply(ctx)

const parts = api.debugParts || {}
if (typeof parts.PetSettingsModal !== 'function') {
  console.error('✗ client.js 没有导出 debugParts.PetSettingsModal —— 弹窗拿不到了'); process.exit(1)
}
if (slotsSeen.length) {
  console.error('✗ 还在往 settings.section 注册（' + slotsSeen.join(', ') +
    '）—— 鲸鱼摸鱼的设置不该出现在 DSH 默认设置里'); process.exit(1)
}
const comp = parts.PetSettingsModal

/* ────────────────────────── 递归展开 + 收集文本 ────────────────────────── */
const texts = []
const tags = new Set()
const visitedTags = new Set()
const bad = []
const flat = []

function walk(node, depth, instancePath = 'root/body') {
  if (depth > 60) { bad.push('渲染树深超过 60，可能自引用'); return }
  if (node == null || node === false) return
  if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return }
  if (Array.isArray(node)) { node.forEach((n, i) => walk(n, depth, instancePath + '/' + (n?.props?.key ?? i))); return }
  if (typeof node !== 'object') return
  const { type } = node
  if (typeof type === 'function') {
    if (type === comp) { bad.push('自引用：弹窗里又渲染了弹窗'); return }
    walk(renderComp(type, node.props, instancePath), depth + 1, instancePath + '/body')
    return
  }
  flat.push({ tag: String(type), props: node.props || {}, children: node.children, depth })
  tags.add(String(type))
  visitedTags.add(String(type))
  const props = node.props || {}
  for (const k of ['value', 'placeholder']) {
    const v = props[k]
    if (typeof v === 'string') {
      texts.push(v)
      if (v.includes('NaN')) bad.push(`属性 ${k} 含 NaN：${v.slice(0, 60)}`)
    } else if (typeof v === 'number' && Number.isNaN(v)) bad.push(`属性 ${k} 是 NaN`)
  }
  for (const k of Object.keys(props)) {
    if (k === 'children') continue
    const v = props[k]
    if (v === undefined) continue
    if (typeof v === 'number' && Number.isNaN(v)) bad.push(`属性 ${k} 是 NaN`)
    if (typeof v === 'string' && v.includes('NaN')) bad.push(`属性 ${k} 含 NaN：${v.slice(0, 60)}`)
  }
  walk(node.children, depth + 1, instancePath + '/' + String(type))
}

function hasDeepText(node, needle) {
  if (node == null || node === false) return false
  if (typeof node === 'string' || typeof node === 'number') return String(node).includes(needle)
  if (typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some((k) => hasDeepText(k, needle))
  return hasDeepText(node.children, needle)
}

function subtreeOf(idx) {
  const d = flat[idx].depth
  const out = []
  for (let i = idx + 1; i < flat.length; i++) {
    if (flat[i].depth <= d) break
    out.push(flat[i])
  }
  return out
}

let rootComponent = comp
let rootProps = null
function renderOnce(label) {
  pendingEffects = []
  visited = new Set()
  flat.length = 0
  let tree
  try {
    tree = renderComp(rootComponent, rootProps || { onClose: () => { closeCalls++ }, toast: (...args) => { videoWarnings.push(args) }, ctx })
    walk(tree, 0)
    commitEffects()
  } catch (e) {
    console.error(`✗ ${label} 渲染/effect 抛错：` + (e && e.stack || e))
    process.exit(1)
  }
  return tree
}

const tick = () => new Promise((r) => setImmediate(r))

;(async () => {
  // 节奏 fixture 与真实状态 API 共用纯描述，避免另钉一套范围/额度/风控数字。
  if (STATUS.pace) {
    const { paceExplain, paceSummary } = await import(require('node:url').pathToFileURL(require('node:path').join(require('./paths.cjs').ROOT, 'lib/pace.mjs')))
    const now = Date.now()
    const book = { last: { comment: { at: now - 1000, next: now + 90_000 } },
      recent: ['comment', 'comment', 'comment', 'reply'].map((k, i) => ({ k, t: now - 120_000 - i * 1000 })),
      quota: { comment: now + 2_500_000 }, quotaStrikes: { comment: 1 } }
    Object.assign(STATUS.pace, paceSummary(book, now, CFG.paceFactor), { explanation: paceExplain(book, now, CFG.paceFactor) })
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  renderOnce('首轮（读取中）')
  const initialLoading = texts.join(' ').includes('正在读取配置')
  await wait(120)

  texts.length = 0
  tags.clear()
  bad.length = 0
  for (let i = 0; i < 10; i++) { renderOnce('数据就绪'); await wait(60) }
  await wait(200)
  renderOnce('数据就绪')

  /* helper：切页签（假 React 里 setState 直接改槽位，下一次 renderOnce 就能看到新 tab） */
  const findButton = (needle) => flat.find((e) => e.tag === 'button' && hasDeepText({ children: e.children }, needle))
  const textOf = (node) => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(textOf).join('') : node && typeof node === 'object' ? textOf(node.children) : ''
  const exactButton = (label) => flat.find((e) => e.tag === 'button' && textOf(e.children) === label)
  const click = async (label) => {
    const button = exactButton(label)
    if (!button?.props.onClick) throw new Error('找不到按钮「' + label + '」')
    await button.props.onClick()
    texts.length = 0; tags.clear(); renderOnce('点击 ' + label)
    await wait(40)
    texts.length = 0; tags.clear(); renderOnce('点击完成 ' + label)
  }
  const clickTab = async (label) => {
    const childPages = { '偏好与桌宠': ['偏好与设置', 'basic'], '账号与环境': ['偏好与设置', 'other'],
      '学习与记忆': ['记忆与素材', 'learning'], '表情收藏': ['记忆与素材', 'stickers'],
      '运行日志': ['记录与用量', 'logs'], 'token 账本': ['记录与用量', 'ledger'], '数据回顾': ['记录与用量', 'review'] }
    const nested = childPages[label]
    const tabs = flat.filter((e) => e.tag === 'button' && e.props?.role === 'tab')
    const t = tabs.find((e) => hasDeepText({ children: e.children }, nested ? nested[0] : label))
    if (!t) { bad.push(`找不到页签「${label}」`); return false }
    try { await t.props.onClick() } catch (e) { bad.push(`切页签 ${label} 抛错：${e && e.message}`); return false }
    renderOnce('切到 ' + label)
    await wait(60)
    if (nested) {
      const child = flat.find(e => e.props?.['data-bd-page-target'] === nested[1])
      if (!child) { bad.push('缺少分组子页：' + label); return false }
      await child.props.onClick(); renderOnce('切到子页 ' + label); await wait(60)
    }
    return true
  }
  const snap = () => { texts.length = 0; tags.clear(); renderOnce('快照') }

  /* ────────────────────────── 断言 ────────────────────────── */
  const rows = []
  const ok = (name, pass, detail) => rows.push({ name, pass, detail })
  const all = () => texts.join(' \u0001 ')

  snap()
  ok('首屏为运行方式，主操作在参数与恢复信息前', flat.some(e => e.props?.['data-bd-settings-page'] === 'run')
    && ['session', 'background'].every(key => flat.some(e => e.props?.['data-bd-launch-action'] === key))
    && flat.findIndex(e => 'data-bd-run-launches' in e.props) < flat.findIndex(e => 'data-bd-run-details' in e.props))
  await clickTab('偏好与桌宠'); snap()
  const all0 = all()
  ok('首轮有「读取中」占位', initialLoading)
  ok('渲染出内容', all0.length > 200, `文本 ${all0.length} 字符`)
  ok('无渲染期异常', bad.length === 0, bad.slice(0, 3).join(' | '))

  const commonMust = ['运行方式', '互动与投递', '记忆与素材', '视频工作室', '记录与用量', '偏好与设置'].map((label) => [label, label + '导航'])
  for (const [needle, label] of commonMust) ok(`含「${label}」`, all0.includes(needle), all0.includes(needle) ? '' : `缺 ${needle}`)
  for (const anti of ['undefined', 'NaN', '[object Object]']) {
    ok(`没有 ${anti}`, !all0.includes(anti), all0.includes(anti) ? '出现在文本里' : '')
  }

  /* 独立账本：基础页只留导航入口，不再塞累计卡；tab 的键盘契约沿用同一套。 */
  ok('基本页没有重复 token 累计卡', !flat.some((e) => 'data-bd-ledger' in e.props))
  ok('六组主导航保留完整功能子页', flat.filter((e) => e.props?.role === 'tab').length === 6
    && !flat.filter((e) => e.props?.role === 'tab').some((e) => (e.children || []).some((c) => c?.props?.['data-bd-ico'])))
  ok('首次基本页不请求视频、学习、统一记忆或表情库', !paths.hits.some((u) => /\/(pv|learn|memory|stickers)(\?|$)/.test(u)))
  const basicCreations = []
  for (let i = 0; i < 3; i++) {
    createdElements.length = 0; snap(); basicCreations.push(createdElements.length)
    ok('基本页第 ' + (i + 1) + ' 次只构建当前页', createdElements.every((e) => !e.page || e.page === 'basic') && !createdElements.some((e) => ['PetTokenLedgerPanel', 'PetOtherSettings', 'PetStickersPanel', 'PetRunCard'].includes(e.type)))
  }
  ok('基本页四卡扁平同一网格（可选的新手引导卡通栏在外，另算）',
    flat.filter((e) => 'data-bd-basic-grid' in e.props).length === 1
    && flat.filter((e) => 'data-bd-sec' in e.props).length === 4 + flat.filter((e) => 'data-bd-onboard' in e.props).length)
  ok('基本页创建量记录且稳定', basicCreations.length === 3 && new Set(basicCreations).size === 1, JSON.stringify(basicCreations))
  await clickTab('token 账本'); snap()
  const ledgerText = all()
  ok('账本页有累计、今天、当前任务与已保存上限', ['累计用量', '今日用量', STATUS.feiyu?.active ? '本次会话' : '当前任务', '累计上限'].every((s) => ledgerText.includes(s)))
  ok('账本累计数读宿主字段而不是明细加总', SCENARIO === 'normal' ? ledgerText.includes('1,234,567')
    : SCENARIO === 'budget' ? ledgerText.includes('2,900,000') : ledgerText.includes('累计用量'))
  ok('账本保留称号', ledgerText.includes('称号 · '))
  if (SCENARIO === 'normal') {
    ok('任务明细：会话那条带轮数与真实 token', ledgerText.includes('鲸鱼摸鱼会话') && ledgerText.includes('133,333'))
    const unmeteredRow = flat.find((e) => 'data-bd-tokrow' in e.props && hasDeepText(e, '桌宠后台轮'))
    ok('任务明细：后台未计量不冒充 0', Boolean(unmeteredRow) && textOf(unmeteredRow.children).includes('未计量') && textOf(unmeteredRow.children).includes('不按 0 计算'))
    ok('任务明细：部分计量保留已知用量并标明缺失响应', ledgerText.includes('1 条部分计量') && ledgerText.includes('部分计量 · 另有 1 次缺失'))
    ok('任务明细：停因改用可读中文且保留原始 title', ledgerText.includes('已达单次预算') && flat.some((e) => e.props?.title === 'token-budget'))
    ok('上限进度条有可访问数值（41%）', flat.some((e) => 'data-bd-tok-bar' in e.props && e.props['aria-valuenow'] === 41))
    ok('14 天图和零值天保留', flat.some((e) => 'data-bd-tok-days' in e.props) && flat.some((e) => e.props['data-zero'] !== undefined))
    ok('连击与预算输入回填保留', ledgerText.includes('连续运行 3 天') && flat.some((e) => e.tag === 'input' && String(e.props.value) === '3000000'))
    const focusButton = findButton('截图视图')
    await focusButton.props.onClick(); snap()
    ok('截图视图隐藏危险操作但保留计量说明', !findButton('清零计数') && all().includes('未计量不等于没有消耗'))
    await findButton('退出截图视图').props.onClick(); snap()
    const reset = findButton('清零计数')
    configPosts.length = 0; confirmResult = false
    await reset.props.onClick()
    ok('清零取消确认时不发请求', configPosts.length === 0)
    confirmResult = true; await reset.props.onClick()
    ok('清零确认后只发 resetTokensTotal 不改上限', configPosts.length === 1 && configPosts[0].resetTokensTotal === true && !('totalTokenBudget' in configPosts[0]))
  }
  if (SCENARIO === 'fresh') ok('fresh：任务列表空状态', ledgerText.includes('暂无任务记录'))
  await clickTab('偏好与桌宠'); snap()
  ok('偏好页保留人格、选片、报告、关键词和桌宠', ['角色与表达', '一天最多挑几条', '报告详细程度', '关键词', '显示桌宠'].every((needle) => all().includes(needle)))
  /* 🧭 新手三步卡（2026-10-28）：待办时出现、齐了消失 */
  if (SCENARIO === 'fresh') ok('fresh：初始化状态与配置入口完整', all().includes('初始化状态') && Boolean(findButton('配置')))
  if (SCENARIO === 'normal') ok('normal：完成初始化后清单不再显示', !all().includes('初始化状态'))
  ok('偏好页含设定文件路径', flat.some((e) => e.tag === 'input' && String(e.props.value || '') === CFG.workspace))
  await clickTab('互动与投递'); snap()
  const speechText = all()
  if (SCENARIO === 'normal') {
    ok('发送预览只在互动页挂载时读取完整队列', paths.hits.some(u => /\/send-review$/.test(u)) && !Object.hasOwn(STATUS.sendReview, 'items'))
    ok('发送预览显示待审正文与收件对象', speechText.includes('fixture第一条待审核评论') && speechText.includes('BV1234567890'))
    const previewToggle = () => {
      const at = flat.findIndex(e => e.props?.['data-bd-row'] !== undefined && hasDeepText(e, '发送前审核'))
      return at < 0 ? null : subtreeOf(at).find(e => e.tag === 'button' && 'data-bd-sw' in e.props)
    }
    await previewToggle()?.props.onClick(); await wait(40); snap()
    await previewToggle()?.props.onClick(); await wait(40); snap()
    ok('关闭发送预览保留已有待审内容，不自动发出', CFG.sendReview === false && SEND_REVIEW_ITEMS.filter(item => item.state === 'pending').length === 2 && sendReviewPosts.length === 0)
    const approve = flat.find(e => e.props?.['aria-label'] === '批准并发送：' + SEND_REVIEW_ITEMS[0].id)
    await approve?.props.onClick(); snap()
    ok('批准发送携带当前内容 hash，且只批准这一条', sendReviewPosts.length === 1 && sendReviewPosts[0].id === SEND_REVIEW_ITEMS[0].id && sendReviewPosts[0].expectedHash === SEND_REVIEW_ITEMS[0].hash && sendReviewPosts[0].decision === 'approve' && SEND_REVIEW_ITEMS[1].state === 'pending')
    const reject = flat.find(e => e.props?.['aria-label'] === '拒绝发送：' + SEND_REVIEW_ITEMS[1].id)
    await reject?.props.onClick(); snap()
    ok('拒绝预览只提交当前 id/hash，不携带 force 或正文', sendReviewPosts.length === 2 && Object.keys(sendReviewPosts[1]).sort().join(',') === 'decision,expectedHash,id' && sendReviewPosts[1].decision === 'reject')
    await click('全部记录'); snap()
    const unknownAt = flat.findIndex(e => e.props?.['data-bd-send-review-item'] !== undefined && hasDeepText(e, 'fixture需要核对发送结果'))
    ok('发送结果未知只提示核对，不提供重试发送', unknownAt >= 0 && !subtreeOf(unknownAt).some(e => e.tag === 'button') && all().includes('不自动重试'))
  }
  if (SCENARIO === 'normal') {
    /* 这两条「说明文案」同时是两条变异的落点（check-ui.cjs）：谁把「不限条数」的口径
     * 退化成旧版条数上限、或把「同一条只回一次」的判重承诺弄丢，这里就红。 */
    ok('自动评论说明保留自主判断、无固定日上限和单视频判重',
      speechText.includes('无固定每日条数上限；是否评论由角色自主判断') && speechText.includes('同一个视频只评论一次'), '')
    ok('评论回复说明保留自主判断、无固定上限和单条判重',
      speechText.includes('无固定条数上限；是否回复由角色自主判断') && speechText.includes('同一条评论只回复一次'), '')
  }

  /* ⏱️ 互动页继续覆盖节奏、私信显隐和原有不限条数口径。 */
  if (SCENARIO === 'normal') {
    ok('额度限制横幅保留12014、触发次数和递增说明', speechText.includes('视频评论额度已满（12014）') && speechText.includes('第 1 次触发'))
    ok('视频评论额度不影响私信、动态评论回复和动态发布', speechText.includes('私信、动态评论回复和动态发布不受此项额度影响'))
    ok('发送通道展示当前等待时间', /发新评论：需等待 \d+ 分钟/.test(speechText))
    ok('连续发送次数保留', speechText.includes('已使用 4 次'))
    ok('normal 场景 autoReplyDm 关闭时不渲染私信回复子项', !speechText.includes('同一条私信只回复一次'))
    ok('互动页保留公开发言、成果投递与节奏三类卡', ['公开发言', '私信与投递', '发送节奏'].every((text) => speechText.includes(text)))
  }
  if (SCENARIO === 'empty') ok('仅私信模式明确提示公开评论不执行', speechText.includes('自动评论开关保持开启但不执行') && speechText.includes('仅私信'))
  if (SCENARIO === 'budget') {
    ok('自动回复私信说明保留无固定每日条数上限', speechText.includes('无固定每日条数上限'))
    ok('自动回复私信说明保留单条判重', speechText.includes('同一条私信只回复一次'))
    ok('自动回复私信提供已关注用户筛选开关', speechText.includes('仅回复已关注的用户'))
    const followIdx = flat.findIndex((e) => e.props?.['data-bd-row'] !== undefined && hasDeepText(e, '仅回复已关注的用户'))
    const followDeep = followIdx < 0 ? [] : subtreeOf(followIdx)
    ok('已关注用户筛选使用统一 Switch', followDeep.some((e) => e.tag === 'button' && 'data-bd-sw' in e.props))
    ok('且默认开着（data-on 有值）', followDeep.some((e) => e.tag === 'button' && 'data-bd-sw' in e.props && e.props['data-on'] !== undefined))
    ok('私信时效限制保留3天说明', /仅处理 3 天内的消息/.test(speechText))
  }

  if (SCENARIO === 'normal') {
    const rangeRow = (kind) => textOf(flat.find((e) => e.props['data-bd-pace-range'] === kind)?.children)
    const currentRow = (kind) => textOf(flat.find((e) => e.props['data-bd-pace-current'] === kind)?.children)
    const paceInput = () => flat.find((e) => e.props['aria-label'] === '节奏倍数')
    const startConfig = configPosts.length, startCurrent = currentRow('comment')
    const pinnedAt = STATUS.pace.explanation.kinds.comment.nextAt
    ok('节奏快捷预设完整且不自动覆盖保存值', ['标准 1', '轻快 0.5', '谨慎 1.5'].every((label) => Boolean(exactButton(label))) && String(paceInput()?.props.value) === '1.5')
    ok('节奏范围来自基础与已保存系数，不拿新间隔冒充倒计时', rangeRow('comment').includes('基础 120–180 秒') && rangeRow('comment').includes('已保存 180–270 秒') && speechText.includes('不是当前倒计时') && speechText.includes('下一次成功发送后') && speechText.includes('已钉下的等待不会重算'))
    ok('解释保留小时/连发/额度/风控与安全口径', ['滚动一小时', '13 次', '45 → 90 → 180', '-352：20 分钟', '-412：60 分钟', '不是 B站 承诺的安全频率'].every((text) => speechText.includes(text)))
    await click('轻快 0.5'); snap()
    ok('点击预设只改草稿、原等待仍保留', configPosts.length === startConfig && String(paceInput()?.props.value) === '0.5' && CFG.paceFactor === 1.5 && rangeRow('comment').includes('草稿 60–90 秒') && rangeRow('comment').includes('已保存 180–270 秒') && currentRow('comment') === startCurrent && STATUS.pace.explanation.kinds.comment.nextAt === pinnedAt)
    for (const invalid of ['', '0.29', '3.01', 'not-a-number']) {
      paceInput().props.onChange({ target: { value: invalid } }); snap()
      const save = exactButton('保存节奏')
      ok('无效节奏草稿不提交：' + JSON.stringify(invalid), save?.props.disabled === true && paceInput().props['aria-invalid'] === true)
      await save.props.onClick(); snap()
      ok('绕过 disabled 调处理器也不写配置：' + JSON.stringify(invalid), configPosts.length === startConfig)
    }
    paceInput().props.onChange({ target: { value: '0.73' } }); snap()
    ok('小数草稿预览保留真实毫秒精度', rangeRow('dm').includes('草稿 21.9–32.85 秒'))
    await click('保存节奏'); snap()
    const savedPatch = configPosts.at(-1)
    ok('保存节奏仅发已有 config patch、不动开关或账本', configPosts.length === startConfig + 1 && Object.keys(savedPatch).length === 1 && savedPatch.paceFactor === 0.73 && CFG.paceFactor === 0.73 && STATUS.pace.explanation.kinds.comment.nextAt === pinnedAt)
    ok('保存后已保存范围更新，当前等待不受新系数回算', rangeRow('comment').includes('已保存 87.6–131.4 秒') && !rangeRow('comment').includes('草稿') && currentRow('comment') === startCurrent)
    await click('标准 1'); snap()
    ok('标准预设同样只填草稿', configPosts.length === startConfig + 1 && CFG.paceFactor === 0.73 && String(paceInput()?.props.value) === '1')
    await click('谨慎 1.5'); snap()
    ok('谨慎预设同样只填草稿', configPosts.length === startConfig + 1 && CFG.paceFactor === 0.73 && String(paceInput()?.props.value) === '1.5')
  }

  /* 表情页：独立读取、完整图库、显式自动化权限及人工操作。 */
  await clickTab('表情收藏'); snap()
  ok('表情页完整渲染合成图库与固定高列表入口', flat.filter((e) => 'data-bd-sticker-item' in e.props).length === 56 && flat.some((e) => 'data-bd-sticker-list' in e.props && e.props.tabIndex === 0))
  ok('本地上传独立表单、原生文件与名字描述入口保留', flat.some((e) => 'data-bd-sticker-upload' in e.props && e.tag === 'form') && flat.some((e) => e.props['aria-label'] === '本地表情图片' && e.props.type === 'file' && /image\/png/.test(e.props.accept)) && ['上传表情名称', '上传表情描述'].every((label) => flat.some((e) => e.props['aria-label'] === label)) && Boolean(exactButton('上传到表情库')) && flat.some((e) => 'data-bd-sticker-form' in e.props))
  ok('表情页默认概率、冷却、容量回填', [['收集概率', 35], ['配图概率', 30], ['收集冷却（秒）', 60], ['配图冷却（秒）', 180], ['收集容量', 60]].every(([label, value]) => flat.some((e) => e.props['aria-label'] === label && Number(e.props.value) === value)))
  ok('内置只读，只有收集区能移除', flat.filter((e) => String(e.props['aria-label'] || '').startsWith('移除表情：')).length === 50 && !flat.some((e) => String(e.props['aria-label'] || '').startsWith('移除表情：内置')))
  if (SCENARIO === 'normal') {
    const changeSticker = (label, value) => {
      const field = flat.find((e) => e.props['aria-label'] === label)
      if (!field?.props.onChange) throw Error('找不到表情输入 ' + label)
      field.props.onChange({ target: { value: String(value) } }); snap()
    }
    changeSticker('搜索表情', '内置鲸鱼01')
    ok('表情名字搜索只保留匹配项', flat.filter((e) => 'data-bd-sticker-item' in e.props).length === 1)
    changeSticker('搜索表情', '不存在夹具')
    ok('表情搜索无匹配时有空态', all().includes('无匹配的表情'))
    changeSticker('搜索表情', '')
    changeSticker('表情来源', 'builtin')
    ok('表情来源筛选内置六项', flat.filter((e) => 'data-bd-sticker-item' in e.props).length === 6)
    changeSticker('表情来源', 'collected')
    ok('表情来源筛选收集五十项', flat.filter((e) => 'data-bd-sticker-item' in e.props).length === 50)
    const remove = flat.find((e) => String(e.props['aria-label'] || '').startsWith('移除表情：'))
    confirmResult = false; const beforeRemove = stickerPosts.length
    await remove.props.onClick(); await wait(40)
    ok('取消表情移除确认不发请求', stickerPosts.length === beforeRemove)
    confirmResult = true; await remove.props.onClick(); await wait(40); snap()
    ok('确认移除只发该名字', stickerPosts.length === beforeRemove + 1 && stickerPosts.at(-1).path === '/stickers/forget' && stickerPosts.at(-1).name === '收藏鲸鱼07')
    changeSticker('表情名称', '合成探头')
    changeSticker('图片链接', 'https://fixture.invalid/peek.png')
    changeSticker('表情描述', '观察细节时')
    const form = flat.find((e) => 'data-bd-sticker-form' in e.props)
    form.props.onSubmit({ preventDefault() {} }); await wait(40); snap()
    ok('手动收集携带名字、图片链接与描述', stickerPosts.some((p) => p.path === '/stickers/collect' && p.name === '合成探头' && p.url === 'https://fixture.invalid/peek.png' && p.description === '观察细节时'))
    changeSticker('收集概率', 101)
    const configCount = configPosts.length; await click('保存收集参数')
    ok('表情概率越界时不写配置', configPosts.length === configCount)
    changeSticker('收集概率', 0); changeSticker('收集容量', 1); changeSticker('收集冷却（秒）', 86400)
    await click('保存收集参数')
    ok('表情参数允许零概率及范围端点且不改变发言权限', configPosts.at(-1)?.stickerCollectProbability === 0 && configPosts.at(-1)?.stickerCapacity === 1 && configPosts.at(-1)?.stickerCollectCooldown === 86400 && !('autoComment' in configPosts.at(-1)) && !('autoReplyDm' in configPosts.at(-1)))
    stickerFails = true; await click('刷新图库')
    ok('表情拉取失败保留旧图库且允许重试', all().includes('fixture读取中断，可重试') && Boolean(exactButton('重试')) && flat.filter((e) => 'data-bd-sticker-item' in e.props).length === 50)
    stickerFails = false; await click('重试')
    ok('表情重试成功清掉错误', !all().includes('fixture读取中断，可重试'))
    stickerHttpStatus = 503; await click('刷新图库')
    ok('HTTP图库失败保留后端JSON原因与状态', all().includes('HTTP 503') && all().includes('fixture图库HTTP故障详情'))
    await clickTab('偏好与桌宠'); stickerHttpStatus = 404; await clickTab('表情收藏'); snap()
    ok('首次图库404明确宿主未加载而不是空图库', all().includes('后端尚未加载图库接口') && all().includes('只刷新页面不会加载后端') && all().includes('未连接') && !flat.some((e) => 'data-bd-sticker-list' in e.props) && Boolean(exactButton('重试')))
    const countLibrary = () => paths.hits.filter((u) => /\/stickers(\?|$)/.test(u)).length
    const tickLibrary = async () => { for (let i = 0; i < 5; i++) { for (const timer of intervalCallbacks.values()) if (timer.ms === 20000) timer.fn(); await wait(10) } }
    let before404 = countLibrary(); await tickLibrary(); snap()
    ok('404后五次20秒timer不再自动请求图库', countLibrary() === before404)
    await click('重试')
    ok('404暂停轮询但手动重试仍恰好发送一次', countLibrary() === before404 + 1 && all().includes('后端尚未加载图库接口'))
    stickerHttpPlain = true; await click('重试')
    ok('HTML404不引发JSON错误并保留重启提示', all().includes('后端尚未加载图库接口') && !all().includes('HTML error page'))
    stickerHttpPlain = false; stickerHttpStatus = 200; await click('重试')
    ok('宿主恢复后手动重试重新显示完整图库', !all().includes('图库读取失败') && flat.filter((e) => 'data-bd-sticker-item' in e.props).length === 56)
    before404 = countLibrary(); await tickLibrary()
    ok('图库恢复成功后20秒自动读取也恢复', countLibrary() >= before404 + 5)
    const pendingRows = [1, 2].map((index) => ({ ...STICKERS.stickers[6], name: '待审核夹具' + index, status: 'pending', hash: String(index).padStart(64, '0'), source: 'collected' }))
    STICKERS.stickers.push(...pendingRows); STICKERS.counts.pending = 2
    await click('刷新图库'); snap()
    ok('审核图库显式请求 status=all 且默认隐藏待审项', paths.hits.some((u) => /\/stickers\?status=all$/.test(u)) && flat.filter((e) => 'data-bd-sticker-item' in e.props).length === 56 && Boolean(exactButton('查看待审核')))
    await click('查看待审核'); snap()
    ok('待审视图只呈现待审图及批准拒绝操作', flat.filter((e) => 'data-bd-sticker-item' in e.props).length === 2 && all().includes('待审核 · 暂不发送'))
    const approve = flat.find((e) => e.props['aria-label'] === '批准表情：待审核夹具1')
    await approve.props.onClick(); await wait(20); snap()
    const approval = stickerPosts.at(-1)
    ok('批准只提交 name 和图片 expectedHash 并移到可用图库', approval.path === '/stickers/approve' && approval.name === pendingRows[0].name && approval.expectedHash === pendingRows[0].hash && Object.keys(approval).length === 3 && STICKERS.stickers.find((item) => item.name === pendingRows[0].name)?.status === 'approved' && flat.find((e) => e.props['aria-label'] === '表情审核状态')?.props.value === 'approved')
    changeSticker('表情审核状态', 'pending')
    pendingRows[1].hash = 'f'.repeat(64)
    await flat.find((e) => e.props['aria-label'] === '拒绝表情：待审核夹具2').props.onClick(); await wait(20); snap()
    ok('审核图片变化时显示冲突且不误移除', all().includes('fixture审核图片已变化') && STICKERS.stickers.includes(pendingRows[1]))
    await flat.find((e) => e.props['aria-label'] === '拒绝表情：待审核夹具2').props.onClick(); await wait(20); snap()
    const rejection = stickerPosts.at(-1)
    ok('刷新审核快照后拒绝携带新hash并清掉待审图', rejection.path === '/stickers/reject' && rejection.expectedHash === 'f'.repeat(64) && Object.keys(rejection).length === 3 && !STICKERS.stickers.some((item) => item.name === pendingRows[1].name) && all().includes('暂无待审核表情'))
    STICKERS.stickers.push({ ...pendingRows[1], name: '缺少哈希的待审夹具', hash: '' }); STICKERS.counts.pending = 1
    await click('刷新图库'); snap()
    ok('缺少图片hash时批准与拒绝均禁用', ['批准表情：缺少哈希的待审夹具', '拒绝表情：缺少哈希的待审夹具'].every((label) => flat.find((e) => e.props['aria-label'] === label)?.props.disabled === true))
  }
  await clickTab('偏好与桌宠'); snap()
  const stickerRequestsAtLeave = paths.hits.filter((u) => /\/stickers(\?|$)/.test(u)).length
  await wait(400)
  ok('离开表情页后停止图库轮询', paths.hits.filter((u) => /\/stickers(\?|$)/.test(u)).length === stickerRequestsAtLeave)

  /* 📡 独立日志页：无变化后仍轮询、事件筛选、稳定详情、实时流水。 */
  await clickTab('运行日志'); await wait(300); snap()
  const logText = all()
  ok('日志页有事件/实时切换与独立事件列表', Boolean(exactButton('运行事件')) && Boolean(exactButton('实时动态')) && flat.some((e) => 'data-bd-settings-log' in e.props))
  ok('日志 unchanged 后继续轮询并接到新增', logUnchangedCount > 0 && logPollCount >= 3 && logText.includes('unchanged后新增进度'), `拉取 ${logPollCount} 次，unchanged ${logUnchangedCount} 次`)
  ok('日志保留模型错误与未知事件兜底', logText.includes('fixture模型错误') && logText.includes('fixture未知事件'))
  const details = exactButton('详情')
  if (details) { await details.props.onClick(); snap() }
  ok('运行日志详情展示原始事件', flat.some((e) => e.tag === 'pre' && textOf(e.children).includes('event-start')))
  const logFilter = flat.find((e) => e.props['aria-label'] === '筛选运行日志')
  logFilter.props.onChange({ target: { value: 'fixture模型错误' } }); snap()
  ok('事件筛选只保留匹配日志', flat.filter((e) => 'data-bd-logrow' in e.props).length === 1 && all().includes('fixture模型错误'))
  logFilter.props.onChange({ target: { value: '' } }); snap()
  await click('实时动态'); snap()
  const activityText = all()
  if (SCENARIO === 'normal') {
    ok('流水卡在（标题 + 在刷徽章）', activityText.includes('它刚才在干嘛') && activityText.includes('在刷'))
    ok('say 记录出现', activityText.includes('这一轮我挑了一条讲本地大模型'))
    ok('搜索动作出现', activityText.includes('去搜「DeepSeek Harness」'))
    ok('轮次记录出现', activityText.includes('第 1 轮游完啦'))
    const nPoll = activityText.split('读字幕 BV1poll').length - 1
    ok('同 id 的 call→done 合并成一行（不是追加成两行）', nPoll === 1, `出现 ${nPoll} 次`)
    ok('那一行显示的是结果（原地改写了）', activityText.includes('→ 88 段'))
    ok('运行中显示模型处理状态', activityText.includes('模型处理中'))
    ok('呼吸条带轮次（第 3/64 轮）', /第 3\/64 轮/.test(activityText))
    ok('呼吸条带已跑多久（92000ms → 1 分 32 秒）', activityText.includes('1 分 32 秒'))
  } else ok('空闲时不显示模型处理状态', !activityText.includes('模型处理中'))
  await clickTab('偏好与桌宠'); snap()
  const logHitsAfterLeave = logPollCount
  const cleanupAfterLeave = cleanupCalls.length
  await wait(160)
  ok('切离日志页执行 cleanup 并停止日志轮询', cleanupAfterLeave > 0 && logPollCount === logHitsAfterLeave, `离开后 ${logHitsAfterLeave} → ${logPollCount}`)

  /* ── 运行方式、视频、学习及环境逐页巡览 ── */
  {
    /* 会话页 */
    if (await clickTab('运行方式')) {
      await click('会话参数'); snap()
      const s1 = all()
      ok('会话参数和运行状态完整保留', s1.includes('运行参数') && s1.includes('运行状态'), '')
      ok('会话页：模型选择（有清单=下拉，没清单=手填输入框，都不白屏）',
        !STATUS.models?.length
          ? flat.some((e) => e.tag === 'input' && String(e.props?.placeholder || '').includes('默认模型'))
          : s1.includes('使用当前会话的模型'), '')
      ok('会话页保留新消息中断规则说明', s1.includes('新消息') && s1.includes('中断'), '')
      ok('会话页启动入口在首屏且不重复', flat.filter(e => e.props?.['data-bd-launch-action'] === 'session').length === 1, '')
      if (SCENARIO === 'normal') {
        ok('会话页：运行中徽章', s1.includes('运行中'), '')
        ok('会话页：读数（已刷轮数/本趟 token/今日精选）', s1.includes('已刷轮数') && s1.includes('本趟 token'), '')
        const savedRun = { active: FEIYU.active, source: FEIYU.source, goal: FEIYU.goal, tokens: FEIYU.tokens }
        Object.assign(FEIYU, { active: true, source: 'manual', goal: null, tokens: { thisRun: 0, tokensUnknown: false } }); snap()
        ok('手动刷站无 goal 仍显示运行、来源、停止入口与真实零', all().includes('运行中') && all().includes('手动刷站') && Boolean(exactButton('停止手动刷站')) && !all().includes('未计量'))
        FEIYU.tokens = { thisRun: null, tokensUnknown: true }; snap()
        ok('手动刷站缺 usage 显示未计量，不冒充零', all().includes('未计量') && Boolean(exactButton('停止手动刷站')))
        FEIYU.active = false; snap()
        ok('手动刷站结束恢复空闲且移除停止入口', all().includes('空闲') && !exactButton('停止手动刷站'))
        Object.assign(FEIYU, savedRun); snap()
      }
      if (SCENARIO === 'blocked') {
        ok('blocked：会话页出现清除任务按钮', Boolean(findButton('清除任务')), '')
        ok('blocked：运行状态显示已暂停', s1.includes('已暂停'), '')
      }
    }
    /* 后台页 */
    {
      await click('后台与定时'); snap()
      const s2 = all()
      ok('后台参数和运行状态完整保留', s2.includes('运行参数') && s2.includes('运行状态'), '')
      ok('后台页：模型选择（下拉空值项或手填输入框）',
        !STATUS.models?.length
          ? flat.some((e) => e.tag === 'input' && String(e.props?.placeholder || '').includes('默认模型'))
          : s2.includes('使用宿主默认模型'), '')
      ok('后台页：开始后台刷按钮', s2.includes('开始后台刷'), '')
      ok('后台页：定时开关与每天只启动一次说明', s2.includes('定时自动运行') && s2.includes('每天只启动一次'))
      ok('后台页：token 软预算与精确截断限制明确', s2.includes('不能按精确用量自动截断'))
      if (SCENARIO === 'normal') {
        const toggleRow = flat.findIndex((e) => 'data-bd-toggle' in e.props && hasDeepText(e, '每天按时间自动跑一轮'))
        const toggle = subtreeOf(toggleRow).find((e) => e.tag === 'button' && 'data-bd-sw' in e.props)
        await toggle.props.onClick(); snap()
        ok('定时开启后显示跨午夜窗口草稿', ['18:00', '09:00'].every((value) => flat.some((e) => e.tag === 'input' && e.props.type === 'time' && e.props.value === value)))
        await click('会话参数'); snap()
        await flat.find(e => e.props?.['data-bd-launch-action'] === 'session').props.onClick(); snap()
        ok('设置内新会话携带当前会话与workspace关联', sessionPosts.some((p) => p.sourceSessionId === 'fixture-source-session' && p.workspaceId === 'fixture-workspace'))
        ok('设置内新会话创建后启动且切到新会话', startPosts.some((p) => p.mode === 'session' && p.sessionId === 'fixture-new-session') && openedSessions.includes('fixture-new-session'))
        await click('保存默认设置')
        ok('新会话默认保存不覆盖后台预算', configPosts.some((p) => 'sessionTokenBudget' in p && !('backgroundTokenBudget' in p)))
      }
    }
    /* 视频工作室：本地草稿、可见会话、校验成品与故障恢复。 */
    if (await clickTab('视频工作室')) {
      snap()
      const sectionInput = (label, type) => {
        const at = flat.findIndex((e) => e.tag === 'label' && hasDeepText(e, label))
        return at < 0 ? null : subtreeOf(at).find((e) => e.tag === type)
      }
      const player = () => flat.find((e) => e.tag === 'video')
      const gallerySelect = () => sectionInput('选择成片', 'select')
      const videoText = all()
      ok('视频页：四种形式和制作模型，移除隐藏写手文案', ['冲浪日报', '有话想说', '精选安利', '自定主题', '制作模型'].every((value) => videoText.includes(value)) && !/台词由谁写|内置模板|视频台词模型/.test(videoText))
      ok('视频页：日期按已读取状态回填，失败时保持空值', sectionInput('日期', 'input')?.props.value === (SCENARIO === 'partial' ? '' : '2026-10-20'))
      ok('视频页：30/60/90/150 秒目标时长均可选', sectionInput('目标时长', 'select')?.children.filter((item) => item?.type === 'option').map((item) => item.props.value).join(',') === '30,60,90,150')
      ok('视频页：解释会话内工具异步渲染', videoText.includes('模型调用工具异步完成'))
      ok('视频页：保留每天时间并说明可见制作会话', videoText.includes('每天自动做') && videoText.includes('创建可见的制作会话') && videoText.includes('10:30'))
      if (SCENARIO === 'partial') {
        ok('partial：视频读取错误明确且制作按钮禁用', videoText.includes('视频状态读取失败') && exactButton('新开会话制作')?.props.disabled === true)
      } else if (SCENARIO === 'fresh') {
        ok('fresh：依赖缺失仍展示制作入口与安装提示', exactButton('新开会话制作')?.props.disabled === true && videoText.includes('装主依赖'))
        ok('fresh：尚无成品与会话时有独立空态', !player() && videoText.includes('暂无已通过音视频校验的成片') && videoText.includes('新会话会记在这里'))
      } else if (SCENARIO === 'empty') {
        ok('empty：没有模型清单时保留手填入口', sectionInput('制作模型', 'input')?.props.value === '' && !sectionInput('制作模型', 'select'))
        ok('empty：没有成品时可新开会话', !player() && exactButton('新开会话制作')?.props.disabled === false)
        const startsBeforeVideo = startPosts.length
        await exactButton('新开会话制作').props.onClick(); snap()
        const request = videoSessionPosts.at(-1)
        ok('empty：默认模式时长与空模型传给视频新会话', request?.mode === 'daily' && request.targetDurationSec === 60 && request.model === '' && request.brief === '' && openedSessions.includes('fixture-video-created') && startPosts.length === startsBeforeVideo)
      } else if (SCENARIO === 'pvrun') {
        ok('pvrun：真实渲染阶段与秒数可见', videoText.includes('渲染画面') && videoText.includes('92 秒'))
        ok('pvrun：停止按钮绑定该制作会话', flat.some((item) => item.tag === 'button' && item.props['aria-label'] === '停止制作会话：fixture-running-video' && typeof item.props.onClick === 'function'))
        ok('pvrun：未完成视频不会进入放映室', !player() && videoText.includes('暂无已通过音视频校验的成片'))
        const stopsBefore = pvPosts.length
        await flat.find((item) => item.props['aria-label'] === '停止制作会话：fixture-running-video').props.onClick(); snap()
        const stop = JSON.parse(pvPosts.at(-1) || '{}')
        ok('pvrun：停止只发送该 sessionId 与 action', pvPosts.length === stopsBefore + 1 && stop.action === 'stop' && stop.sessionId === 'fixture-running-video' && Object.keys(stop).length === 2 && all().includes('已停止'))
      } else if (SCENARIO === 'normal') {
        ok('视频模型：默认选中 videoModelId', sectionInput('制作模型', 'select')?.props.value === CFG.videoModelId)
        ok('成片：已完成制作使用 production id 路由', /\/pv\/video\?id=completed-a$/.test(player()?.props.src || ''))
        ok('成片：隐藏未完成与校验拒绝项', !['fixture未完成视频', 'fixture失败视频', 'fixture未通过校验视频'].some((value) => videoText.includes(value)))
        ok('会话阶段：封面、渲染、校验、成片、完成、失败', ['制作封面', '渲染画面', '校验音视频', '整理成片', '制作完成', '制作失败'].every((value) => videoText.includes(value)))
        const initialSrc = player()?.props.src
        PV_BODY.productions.unshift({ id: 'newer', date: '2026-10-20', mode: 'custom', title: 'fixture新到成片', file: 'C:/fixture/new.mp4', stage: 'done' })
        await exactButton('刷新').props.onClick(); snap()
        ok('成片轮询：新增作品不替换正在播放的 src', player()?.props.src === initialSrc)
        gallerySelect().props.onChange({ target: { value: 'studio:completed-b' } }); snap()
        const chosenSrc = player()?.props.src
        await exactButton('刷新').props.onClick(); snap()
        ok('成片轮询：保留用户所选的同日另一作品', /id=completed-b$/.test(chosenSrc || '') && player()?.props.src === chosenSrc)
        gallerySelect().props.onChange({ target: { value: 'legacy:2026-10-19' } }); snap()
        ok('历史成片：保留 day 路由', /\?day=2026-10-19$/.test(player()?.props.src || ''))
        gallerySelect().props.onChange({ target: { value: 'studio:completed-a' } }); snap()
        const outputButton = flat.find((item) => item.tag === 'button' && hasDeepText({ children: item.children }, '打开成片目录'))
        ok('成片目录：只发送 pv 这一种服务端白名单动作', Boolean(outputButton) && typeof outputButton.props.onClick === 'function')
        if (outputButton) {
          openPosts.length = 0
          await outputButton.props.onClick(); await wait(30)
          ok('成片目录：点击发出 POST /open {what:pv}', openPosts.length === 1 && JSON.parse(openPosts[0] || '{}').what === 'pv' && Object.keys(JSON.parse(openPosts[0] || '{}')).length === 1)
        }
        const closesBeforeReturn = closeCalls
        await exactButton('回到制作会话').props.onClick(); snap()
        ok('成片返回：打开原制作会话并关闭弹窗', openedSessions.includes('fixture-video-a') && closeCalls === closesBeforeReturn + 1)
        await flat.find((item) => item.props['aria-label'] === '回到制作会话：fixture-render').props.onClick(); snap()
        ok('会话列表：可导航回未完成的制作', openedSessions.includes('fixture-render'))
        pvPosts.length = 0
        await flat.find((item) => item.props['aria-label'] === '停止制作会话：fixture-cover').props.onClick(); snap()
        const stoppedBody = JSON.parse(pvPosts[0] || '{}')
        ok('会话停止：仅停止指定会话且保留其他运行入口', pvPosts.length === 1 && stoppedBody.action === 'stop' && stoppedBody.sessionId === 'fixture-cover' && Object.keys(stoppedBody).length === 2 && !flat.some((item) => item.props['aria-label'] === '停止制作会话：fixture-cover') && flat.some((item) => item.props['aria-label'] === '停止制作会话：fixture-render'))
        const postsBeforeDraft = videoSessionPosts.length
        await exactButton('有话想说').props.onClick(); snap()
        sectionInput('创作要求', 'textarea').props.onChange({ target: { value: '  fixture想拍的内容  ' } })
        sectionInput('目标时长', 'select').props.onChange({ target: { value: '90' } })
        sectionInput('日期', 'input').props.onChange({ target: { value: '2026-10-18' } })
        snap()
        ok('视频草稿：只在本地编辑，不提前创建会话', videoSessionPosts.length === postsBeforeDraft && sectionInput('目标时长', 'select').props.value === 90)
        await sectionInput('制作模型', 'select').props.onChange({ target: { value: 'deepseek-official/deepseek-flash' } }); snap()
        ok('制作模型：选择只保存 videoModelId', configPosts.some((request) => request.videoModelId === 'deepseek-official/deepseek-flash' && Object.keys(request).length === 1))
        const startsBeforeVideo = startPosts.length
        const closesBeforeMake = closeCalls
        const make = exactButton('新开会话制作').props.onClick
        await Promise.all([make(), make()]); snap()
        const request = videoSessionPosts[0]
        ok('视频制作：session-new 携带完整草稿与来源关联且防双发', videoSessionPosts.length === 1 && request?.date === '2026-10-18' && request.mode === 'rant' && request.brief === 'fixture想拍的内容' && request.targetDurationSec === 90 && request.model === 'deepseek-official/deepseek-flash' && request.sourceSessionId === 'fixture-source-session' && request.workspaceId === 'fixture-workspace' && Object.keys(request).length === 7)
        ok('视频制作：打开新会话并关闭弹窗，不发 pet/start', openedSessions.includes('fixture-video-created') && closeCalls === closesBeforeMake + 1 && startPosts.length === startsBeforeVideo)
        videoFailure = 1
        await exactButton('新开会话制作').props.onClick(); snap()
        ok('视频失败：明确提示并打开已部分创建的会话', openedSessions.includes('fixture-partial') && videoWarnings.some((args) => args[0].includes('fixture部分启动失败')))
        videoFailure = 2
        await exactButton('新开会话制作').props.onClick(); snap()
        ok('视频HTTP失败：保留并打开返回的 sessionId', openedSessions.includes('fixture-http-partial') && videoWarnings.some((args) => args[0].includes('fixtureHTTP启动失败')))
        videoFailure = 3
        const closesBeforeError = closeCalls
        await exactButton('新开会话制作').props.onClick(); snap()
        ok('视频失败：没有 sessionId 则留在弹窗显示错误', closeCalls === closesBeforeError && flat.some((item) => item.props.role === 'alert' && hasDeepText(item, 'fixture创建失败')))
        videoFailure = 0
        workspaceOpenFails = true
        await exactButton('新开会话制作').props.onClick(); snap()
        ok('会话打开失败：保留弹窗、sessionId 与明确错误', closeCalls === closesBeforeError && ['fixture-video-created', '无法自动打开', 'fixture无法打开会话'].every((value) => all().includes(value)))
        workspaceOpenFails = false
        const goodBody = PV_BODY
        PV_BODY = { ...goodBody, deps: false }
        await exactButton('刷新').props.onClick(); snap()
        ok('缺渲染依赖：制作禁用但安装提示可见', exactButton('新开会话制作')?.props.disabled === true && all().includes('装主依赖'))
        PV_BODY = { ok: false, error: 'fixture状态读取失败' }
        await exactButton('刷新').props.onClick(); snap()
        ok('视频读取失败：明确错误并保留上次成片', all().includes('fixture状态读取失败') && player()?.props.src === initialSrc && exactButton('新开会话制作')?.props.disabled === true)
        PV_BODY = goodBody
        await exactButton('刷新').props.onClick(); snap()
        ok('视频读取恢复：错误清除且制作重新可用', !all().includes('视频状态读取失败：') && exactButton('新开会话制作')?.props.disabled === false)
      }
    }
    const pvRequestsAtLeave = paths.hits.filter((u) => /\/pv(\?|$)/.test(u)).length
    await clickTab('偏好与桌宠'); await wait(320)
    ok('离开视频页后停止视频轮询', paths.hits.filter((u) => /\/pv(\?|$)/.test(u)).length === pvRequestsAtLeave)
    /* 学习页：完整队列、人工决定、审核和折叠 soul。 */
    if (await clickTab('学习与记忆')) {
      snap()
      const learningText = all()
      const learningQueueText = textOf(flat.find((e) => 'data-bd-learning-queue' in e.props)?.children)
      if (SCENARIO === 'normal') {
        ok('学习页：学习队列概览（待审/已批准/已拒绝）', learningQueueText.includes('待审 2 · 已批准 5 · 已拒绝 1'))
        ok('学习页：判重账本概览（已浏览 N 个视频 / 已回复 N 条）', learningQueueText.includes('已浏览 159 个视频') && learningQueueText.includes('已回复 199 条评论'))
      } else if (SCENARIO === 'partial') ok('partial：判重/学习缺省不会显示 undefined', !learningText.includes('刷过 undefined') && !learningText.includes('待审 undefined'))
      ok('学习页：20 条长学习记录完整渲染且有来源、例句、审计', flat.filter((e) => 'data-bd-learn-id' in e.props).length === 20
        && learningText.includes('参考例句（外部数据）') && learningText.includes('审计：记录于') && flat.some((e) => e.tag === 'a' && e.props.href === 'https://www.bilibili.com/video/BV1bKJX6mEnY'))
      ok('学习页：列表可键盘聚焦，分页在固定区域外', flat.some((e) => 'data-bd-learn-list' in e.props && e.props.tabIndex === 0) && learningText.includes('显示 1–20 / 23 条'))
      ok('学习页：后台审核手动按钮和状态在高级折叠外', flat.some((e) => 'data-bd-advanced' in e.props && !hasDeepText(e, '开始批量审核') && !hasDeepText(e, '停止审核')) && learningText.includes('后台自动审核'))
      ok('学习页：审核模型、每批、分钟及 token 参数全部保留', ['跟随后台模型', '每批最多', '最长分钟', 'token 预算', '保存审核设置'].every((text) => learningText.includes(text)) || SCENARIO === 'partial' && learningText.includes('留空 = 跟随后台模型'))
      ok('学习页：soul 四节都在', ['最近的心情', '惦记的事', '对自己的认识', '下次想试试'].every((k) => learningText.includes(k)))
      ok('学习页：soul 只能删不能写（pre 只读 + 无输入框）', flat.some((e) => e.tag === 'pre' && 'data-bd-soul' in e.props)
        && !flat.some((e) => (e.tag === 'textarea' || e.tag === 'input') && /最近的心情|惦记的事/.test(String(e.props?.placeholder || '') + String(e.props?.value || ''))))
      if (SCENARIO === 'normal') {
        await click('下一页'); snap()
        ok('学习分页：第二页 3 条并保留查询 offset', flat.filter((e) => 'data-bd-learn-id' in e.props).length === 3 && all().includes('显示 21–23 / 23 条') && paths.hits.some((url) => url.includes('/learn?') && url.includes('offset=20')))
        await click('上一页'); snap()
        const filter = flat.find((e) => e.props['aria-label'] === '筛选学习记录')
        filter.props.onChange({ target: { value: '学习长记录 23' } }); snap(); await wait(40); snap()
        ok('学习筛选：全文查询重置分页且只显示匹配项', flat.filter((e) => 'data-bd-learn-id' in e.props).length === 1 && all().includes('显示 1–1 / 1 条'))
        flat.find((e) => e.props['aria-label'] === '筛选学习记录').props.onChange({ target: { value: '' } }); snap(); await wait(40); snap()
        await click('批准'); snap()
        await click('拒绝'); snap()
        await click('移除记录'); snap()
        ok('人工学习决定真实发送 approve/reject/forget 并携带当前视图', ['approve', 'reject', 'forget'].every((decision) => learnPosts.some((post) => post.decision === decision && post.state === 'pending' && post.limit === 20 && post.offset === 0)))
        await click('已批准'); snap()
        ok('学习历史：已批准可改拒绝且有决定理由和版本', Boolean(exactButton('改为拒绝')) && all().includes('决定理由：') && all().includes('版本 3'))
        await click('已拒绝'); snap()
        ok('学习历史：已拒绝可重新批准', Boolean(exactButton('重新批准')))
        await click('待审'); snap()
        await click('开始批量审核'); snap()
        ok('后台审核：手动开始发请求并显示进行状态', reviewPosts.some((p) => !p.action) && all().includes('审核中') && Boolean(exactButton('停止审核')))
        await click('停止审核'); snap()
        ok('后台审核：停止发送 stop 并刷新状态', reviewPosts.some((p) => p.action === 'stop') && !exactButton('停止审核'))
        const clear = exactButton('清除章节')
        soulPosts.length = 0; confirmResult = false; await clear.props.onClick()
        ok('soul 清除取消不发送请求', soulPosts.length === 0)
        confirmResult = true; await clear.props.onClick(); snap()
        ok('soul 清除只发送选中节', soulPosts.length === 1 && JSON.parse(soulPosts[0]).section === 'mood')
        ok('记忆中心统一展示学习、心情与只读浏览历史', flat.filter((e) => 'data-bd-memory-result' in e.props).length === 3
          && all().includes('统一检索纸张经验') && all().includes('统一检索纸张心情') && all().includes('只读历史记录'))
        const memorySearch = () => flat.find((e) => e.props['aria-label'] === '搜索所有记忆')
        const memorySource = () => flat.find((e) => e.props['aria-label'] === '记忆来源')
        memorySearch().props.onChange({ target: { value: '纸张' } }); snap(); await wait(40); snap()
        ok('统一记忆按关键词查询并重置分页', flat.filter((e) => 'data-bd-memory-result' in e.props).length === 2 && paths.hits.some((u) => u.includes('/memory?') && u.includes('offset=0') && u.includes('filter=' + encodeURIComponent('纸张'))))
        memorySource().props.onChange({ target: { value: 'soul' } }); snap(); await wait(40); snap()
        ok('统一记忆按来源筛选且保留搜索词', flat.filter((e) => 'data-bd-memory-result' in e.props).length === 1 && all().includes('统一检索纸张心情') && !all().includes('统一检索纸张经验'))
        memoryPosts.length = 0; confirmResult = false
        await click('从当前记忆移除'); snap()
        ok('统一记忆忘记取消不发请求', memoryPosts.length === 0)
        confirmResult = true; await click('从当前记忆移除'); snap(); await wait(40); snap()
        ok('统一记忆忘记绑定来源、记录与展示版本', memoryPosts.some((p) => p.source === 'soul' && p.id === 'mood:1' && p.version === 'b'.repeat(64) && p.action === 'forget' && Object.keys(p).length === 4))
        memorySource().props.onChange({ target: { value: 'learning' } }); snap(); await wait(40); snap()
        await click('撤销批准'); snap()
        ok('统一记忆撤销批准走人工 memory 接口且保留审计', memoryPosts.some((p) => p.source === 'learning' && p.action === 'revoke' && p.version === 'a'.repeat(64)) && all().includes('审计'))
      }
      if (SCENARIO === 'review-run') {
        ok('审核运行 fixture：状态、模型、批准拒绝和剩余可见', ['审核中', 'fixture/reviewer', '本批批准 2', '本批拒绝 1', '本批剩余 17'].every((text) => learningText.includes(text)))
        ok('审核运行 fixture：启动禁用而停止可点', exactButton('审核中…')?.props.disabled === true && !exactButton('停止审核')?.props.disabled)
      }
      if (SCENARIO === 'review-partial') ok('部分审核 fixture：剩余不当完成且显示失败与重试', learningText.includes('本批未完成') && learningText.includes('本批剩余 17') && learningText.includes('自动重试最早') && !learningText.includes('本批完成'))
      if (SCENARIO === 'review-retry') ok('审核重试 fixture：错误、退避时间、关闭提示及手动入口可见', ['fixture暂时不可用', '自动重试最早', '自动审核未开启'].every((text) => learningText.includes(text)) && Boolean(exactButton('开始批量审核')))
    }
    /* 环境页仅维护环境，学习不重复混入。 */
    if (await clickTab('账号与环境')) {
      snap()
      const s4 = all()
      ok('环境页：账号与环境三按钮', s4.includes('安装主依赖') && s4.includes('检查连接') && s4.includes('扫码登录'))
      ok('环境页：诊断信息按钮在', Boolean(findButton('生成诊断信息')))
      ok('环境页：转写、镜像、路径均保留且不再重复学习列表', ['本地转写', '记录镜像', '保存 ASR 参数'].every((text) => s4.includes(text)) && !flat.some((e) => 'data-bd-learn-list' in e.props))
      /* 🔄 更新通道：这一卡只在环境页出现，且必须走真实点击。 */
      ok('更新卡：显示当前/最新版本与安装方式', flat.some((e) => 'data-bd-update' in e.props) && s4.includes('v2.4.1') && s4.includes('最新 v2.5.0') && s4.includes('registry 安装'))
      if (SCENARIO === 'normal') {
        updateGets.length = 0
        await click('检查更新'); await wait(30)
        ok('更新卡：检查更新带 force 真发 GET /update', updateGets.some((u) => u.includes('force=1')))
        const beforeUpgrade = upgradePosts.length
        confirmResult = true
        await click('升级到最新版'); await wait(40)
        ok('更新卡：升级必须显式 confirm 且只发这一项', upgradePosts.length === beforeUpgrade + 1 && Object.keys(JSON.parse(upgradePosts.at(-1) || '{}')).join(',') === 'confirm' && JSON.parse(upgradePosts.at(-1)).confirm === true)
        ok('更新卡：升级开始后显示安装中并禁用按钮', all().includes('正在安装新版本') && exactButton('正在升级…')?.props.disabled === true)
        UPDATE_BODY = { ...UPDATE_BODY, outdated: false, canUpgrade: false, upgrading: false, latest: '2.4.1', hint: '已是最新版本' }
        await click('检查更新'); await wait(30)
        ok('更新卡：已是最新时禁用升级', exactButton('升级到最新版')?.props.disabled === true && all().includes('已是最新版本'))
        UPDATE_BODY = { ...UPDATE_BODY, latest: '2.5.0', outdated: true, canUpgrade: false, hint: '这是目录联接安装（包目录指向别处，常见于本机分叉），自更新会把指向的目录换掉；请手动覆盖或重新 link', install: { updatable: false, mode: 'link', profile: '', reason: '这是目录联接安装（包目录指向别处，常见于本机分叉），自更新会把指向的目录换掉；请手动覆盖或重新 link' } }
        await click('检查更新'); await wait(30)
        ok('更新卡：目录联接分叉锁定升级并说明原因', exactButton('升级到最新版')?.props.disabled === true && all().includes('目录联接安装') && all().includes('手动覆盖'))
        UPDATE_BODY = { ok: true, current: '2.4.1', latest: '', outdated: false, canUpgrade: false, blocker: '', upgrading: false, install: { updatable: true, mode: 'registry', profile: 'web', reason: '' }, error: '' , hint: '点「检查更新」问一下 registry 上有没有新版本。' }
        await click('检查更新'); await wait(30)
        ok('更新卡：查不到最新版时不谎称已是最新、也不谎称有新版', !all().includes('已是最新版本') && exactButton('升级到最新版')?.props.disabled === true)
        UPDATE_BODY = { ok: true, current: '2.4.1', latest: '2.5.0', outdated: true, canUpgrade: true, blocker: '', upgrading: false, install: { updatable: true, mode: 'registry', profile: 'web', reason: '' }, hint: '可以升级到 2.5.0；升级后需要重启 DSH 才能加载新代码' }
      }
      if (SCENARIO === 'normal') {
        const previousEnvironment = STATUS.environment, previousReady = STATUS.venvReady
        const legacyHint = '需要 Python 3.11–3.13（当前 3.10.19）；需要 Pillow 13.0+（当前 12.3.0）'
        STATUS.environment = { upgradeRequired: true, pythonVersion: '3.10.19', pillowVersion: '12.3.0', upgradeHint: legacyHint }
        STATUS.venvReady = false; snap()
        const upgrade = flat.find((e) => 'data-bd-environment-upgrade' in e.props)
        ok('旧环境显示后端升级说明并提供可访问状态', Boolean(upgrade) && textOf(upgrade.children) === legacyHint && upgrade.props.role === 'status' && upgrade.props['aria-live'] === 'polite' && 'data-warn' in upgrade.props)
        STATUS.environment = { upgradeRequired: false, upgradeHint: '' }; STATUS.venvReady = previousReady; snap()
        ok('环境升级说明为空时不显示警告', !flat.some((e) => 'data-bd-environment-upgrade' in e.props))
        STATUS.environment = previousEnvironment; snap()
        /* 真点「一键诊断」——断言它真的去 GET /diag */
        diagGets.length = 0
        const btn = findButton('生成诊断信息')
        if (btn && typeof btn.props?.onClick === 'function') {
          try { await btn.props.onClick() } catch (e) { bad.push('点诊断抛错：' + (e && e.message)) }
        }
        await wait(60)
        ok('「一键诊断」真发出 GET /diag', diagGets.length >= 1, diagGets.length ? '' : '点了但压根没发请求')
        /* 真点「现在同步」——断言 POST /mirror 真发出去了 */
        mirrorPosts.length = 0
        const mbtn = findButton('同步记录')
        if (mbtn && typeof mbtn.props?.onClick === 'function') {
          try { await mbtn.props.onClick() } catch (e) { bad.push('点同步抛错：' + (e && e.message)) }
        }
        await wait(60)
        ok('「现在同步」真发出 POST /mirror', mirrorPosts.length >= 1, mirrorPosts.length ? '' : '点了但压根没发请求')
      }
    }
  }

  /* 菜单 token 语义和 hook 生命周期：直接渲染同一 PetRoot 实例。 */
  if (SCENARIO === 'normal') {
    unmountAll()
    rootComponent = parts.PetRoot
    rootProps = { ctx }
    snap(); await wait(30); snap()
    const fish = () => flat.find((e) => 'data-bd-pet' in e.props)
    fish().props.onContextMenu({ preventDefault() {}, stopPropagation() {} }); snap()
    const tokenText = () => textOf(flat.find((e) => 'data-bd-menu-token' in e.props)?.children)
    ok('菜单为 6 个入口和 outline SVG 图标', flat.filter((e) => 'data-bd-pet-item' in e.props).length === 6 && flat.filter((e) => e.tag === 'svg' && 'data-bd-ico' in e.props && e.props.fill === 'none' && e.props.stroke === 'currentColor').length >= 6)
    ok('菜单本轮 token 取 thisRun 而非累计总账', tokenText().includes('3,045,136') && !tokenText().includes('1,234,567'))
    FEIYU.tokens.thisRun = 0; snap()
    ok('菜单真实零用量显示 0 而非不限', tokenText().includes('0') && !tokenText().includes('不限') && !tokenText().includes('未计量'))
    delete FEIYU.tokens.thisRun; snap()
    ok('菜单未知用量显示未计量', tokenText().includes('未计量'))
    STATUS.bgBusy = true; STATUS.backgroundRun = { active: true, task: 'learn-review', usage: { total: 12 }, unknownRequests: 1 }; snap()
    ok('菜单后台审核优先展示已知部分计量', tokenText().includes('12') && tokenText().includes('后台审核') && tokenText().includes('部分计量'))
    STATUS.backgroundRun.usage = null; snap()
    ok('菜单后台缺失 usage 不编零', tokenText().includes('未计量'))
    STATUS.bgBusy = false; STATUS.backgroundRun = null
    const savedManualMenu = { active: FEIYU.active, source: FEIYU.source, goal: FEIYU.goal, tokens: FEIYU.tokens }
    Object.assign(FEIYU, { active: true, source: 'manual', goal: null, tokens: { thisRun: null, tokensUnknown: true } }); snap()
    await findButton('运行状态').props.onClick(); snap()
    ok('状态卡手动刷站无 goal 时仍显示运行且未知不编零', ['运行中', '手动刷站', '未计量'].every((text) => all().includes(text)))
    FEIYU.tokens = { thisRun: 0, tokensUnknown: false }; snap()
    ok('状态卡手动真实零保留零，未计量提示消失', all().includes('0 / 不限') && !all().includes('未计量'))
    FEIYU.active = false; snap()
    ok('状态卡手动结束显示空闲', all().includes('空闲') && !all().includes('运行中'))
    Object.assign(FEIYU, savedManualMenu)
    STATUS.petShow = false; snap()
    ok('隐藏桌宠保留复原点且 hook 数量稳定', flat.some((e) => 'data-bd-pet-dot' in e.props))
    STATUS.petShow = true; snap()
    if (!flat.some((e) => 'data-bd-menu' in e.props)) { fish().props.onContextMenu({ preventDefault() {}, stopPropagation() {} }); snap() }
    await findButton('新开会话刷').props.onClick(); await wait(40); snap()
    ok('快捷菜单新会话也携带来源会话与workspace', sessionPosts.length >= 2 && sessionPosts.every((p) => p.sourceSessionId === 'fixture-source-session' && p.workspaceId === 'fixture-workspace'))
  }
  unmountAll()
  const afterUnmount = paths.hits.length
  await wait(160)
  ok('关闭后所有 effect cleanup 停止轮询', paths.hits.length === afterUnmount)
  ok('无卸载后 setState', updatesAfterUnmount.length === 0, updatesAfterUnmount.slice(0, 3).join(', '))

  /* ───────── 源码级断言：渲染树抓不到的东西 ───────── */
  ok('① [data-bd-row] 带 flex-wrap', /\[data-bd-row\]\{[^}]*flex-wrap:wrap/.test(src), '')
  ok('② 保留 [data-bd-nowrap] 逃生口', src.includes('[data-bd-row][data-nowrap]{flex-wrap:nowrap'), '')
  ok('③ [data-bd-sec] 有 border + border-radius', /(?:^|\n)\[data-bd-sec\]\{[^}]*border-radius[^}]*border:1px[^}]*\}/.test(src), '')
  ok('④ 流水行靠 id 原地改写', src.includes('x.id === row.id'), '')
  ok('⑤ 增量轮询用 sinceUid（不是 sinceSeq）', src.includes("'/activity?sinceUid='"), '')
  ok('⑥ live 每趟都更新（没塞进增量分支里）', src.includes('if (r.live) setActLive(r.live)'), '')
  ok('⑦ 呼吸点 + keyframes 在', src.includes("'data-bd-dot'") && src.includes('@keyframes bdBreathe'), '')
  ok('⑧ 「这趟」和「一共」是两个分开的字段', src.includes('tokenBudget') && src.includes('totalTokenBudget'), '')
  ok('⑨ 总 token 账本能清零', src.includes('resetTokensTotal'), '')
  ok('⑩ 「关注什么」那一格已删掉（不再限制它刷什么）', !src.includes("'关注什么'") && !src.includes('想让它盯的话题'), '')
  ok('⑪ focus 键还在（只为配置兼容，删键会让宿主报未知字段）', !/次重点|focus: String\(focus/.test(src), '')
  ok('⑫ /status 增量：客户端带 ?rev= 且 unchanged 时不 setState',
    src.includes("'?rev=' + encodeURIComponent(revRef.current)") && /if \(d\.unchanged\) return/.test(src), '')
  ok('⑬ /pet/log 增量：unchanged 时不重渲染', /r\.unchanged\) return/.test(src), '')

  ok('⑭ 角色不再有 Aura/Glow 呼吸层（保留轻微浮动）', !/bdPetAura|bdPetGlow|data-bd-pet-aura/.test(src) && src.includes('@keyframes bdPetFloat'))
  ok('⑮ 后台进度、错误、停因与未知事件均有显示分支', src.includes("t === 'bg-progress'") && src.includes("'model-error': '模型错误'") && src.includes('return JSON.stringify(e || {})'))
  /* 渲染元素类型抽查 */
  ok('用了 button/input/textarea', visitedTags.has('button') && visitedTags.has('input') && visitedTags.has('textarea'), [...visitedTags].sort().join(','))

  let failed = 0
  const w = Math.max(...rows.map((r) => r.name.length))
  for (const r of rows) {
    if (!r.pass) failed++
    console.log(`${r.pass ? '✓' : '✗'} ${r.name.padEnd(w)}${r.detail ? '  ' + r.detail : ''}`)
  }
  console.log(`\n渲染元素：${[...tags].sort().join(' ')}`)
  console.log(`拉过的端点：${[...new Set(paths.hits.map((u) => u.replace(/^.*\/api\/bili-duty/, '').split('?')[0]))].join(' ')}`)
  console.log(`文本总长：${all0.length} 字符`)
  if (failed) { console.log(`\n✗ ${failed} 项没通过`); process.exitCode = 1 } else { console.log('\n✓ 全部通过 —— 六组设置与子页、表情、按需构建、学习审核、日志生命周期与会话关联回归通过') }
  // useStatus 里的 setInterval 会挂住事件循环，跑完必须显式退出
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error('✗ 巡览抛错：' + (e && e.stack || e)); process.exit(1) })
