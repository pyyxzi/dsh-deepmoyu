/**
 * lib/persona.mjs —— 「我自己」这本账（`soul.md`）
 *
 * 为什么会有这本（2026-10-21 使用者第 3 条要求）：
 *   「你多迭代几轮，让鲸鱼摸鱼模式里面的鱼更有人情味，更符合人设，能够不断成长」
 *
 *   前三本账记的全是**外面**：
 *     · `voice.md`     —— 别人怎么讲话（学口气）
 *     · 口味本子       —— 我自己哪句话有人爱听（统计）
 *     · 学习队列       —— 还没消化的黑话/梗/坑（要人批）
 *   没有一本记**她自己**。于是每一轮都是同一个出厂设置重新开机：
 *   情绪没有来路、偏好没有理由、上一轮说"下次想试试"的话这一轮没人记得。
 *   再会演，也只是**每轮重新演一遍同一个角色**——那不叫人味，那叫循环。
 *   ⇒ 给她一本能自己写、自己改的账。写下来的，才是真的长在身上的部分。
 *
 * 三条设计约束（都是踩过的坑）：
 *   ① **插件不替她编内容** —— 只负责铺模板、读、写、注入。
 *      自动生成的"心情"是最假的那种人味：模型看得出，使用者更看得出。
 *   ② **注入必须小** —— 每轮只带 SOUL_INJECT_BUDGET 个字（默认 900）。
 *      这是**每轮都要重付**的输入 token，还要乘以 maxRounds。
 *   ③ **不强迫每轮更新** —— 提示词里明说"有了新认识才写，为了交差而写就是写作业"。
 *      成长是副作用，不是 KPI；按 KPI 长出来的东西都一个味。
 */

import { existsSync, readFileSync, writeFileSync, statSync, renameSync, rmSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteFileSync, withFileLockSync } from './record-storage.mjs'
import { captureMemorySnapshot } from './records.mjs'

/**
 * 鲸鱼摸鱼的「怎么接话」底稿。
 *
 * 这不是要求模型背固定句子，而是给会话、后台轮和公开回复共用的判断顺序：
 * 先把眼前的人/细节接住，再放一点自己的反应，最后及时收住。可爱是分寸感，
 * 不是每句堆自称、呜呜和身体动作；引用例句会很快变成模板，所以这里故意只写规则。
 */
export const DAFEIYU_REPLY_GUIDE = Object.freeze([
  '先接住对方或内容里最具体的那一下，再说自己的反应；不要先报身份、总结流程或夸一串空话。',
  '公开评论和回复通常一两句、短而有内容：可以好奇、吐槽、嘴硬或轻轻关心，反应要和眼前细节相称。',
  '回复别人时直接接他刚说的意思；私信先顾及对话上下文和对方情绪，不把私聊改写成公开播报。',
  '自称、尾巴、呆毛、饭、token、颜文字都只在自然时出现；不强行自称，不固定口癖，一句最多一个颜文字。',
  '没有新内容就少说或不说；不要复述字幕、评论原话、点赞数字，也不要写成客服、评委、影评或执行汇报。',
  '情绪有触发点和轻重：好笑就笑一下，疑惑就问一句，受触动就软一点；不要每条都过热、哭哭、讨饭或撒娇。',
  '说完就停，不追加“希望对你有帮助”之类的客服收尾；可爱来自认真接话和一点小脾气，不来自关键词打卡。',
].join('\n'))

/** 给测试和宿主同步检查用：只暴露稳定的风格规则，不暴露可机械复读的成句。 */
export const DAFEIYU_REPLY_STYLE_RULES = Object.freeze({
  short: true,
  contentFirst: true,
  contextAware: true,
  variableSelfReference: true,
  variableEmotion: true,
  noCustomerServiceTone: true,
  noFixedCatchphrase: true,
  maxKaomojiPerSentence: 1,
})

/** 文件名（放在 `$DSH_HOME/bili-duty/` 下，跟 voice.md 并排） */
export const SOUL_FILE = 'soul.md'

/** 整篇最多多少字 —— 超了不报错，直接拒绝写（让她自己删，别让插件悄悄截断她的记忆） */
export const SOUL_MAX_CHARS = 4000

/** 每轮注入的预算（字） */
export const SOUL_INJECT_BUDGET = 900

/**
 * 四节。`key` 一旦上线不许改名（提示词和工具参数都用它），`title` 是 markdown 里那行。
 *
 * 为什么是这四节：
 *   · 心情 —— 情绪要能**跨轮**（上一轮委屈，这一轮还带着点），这是一切"活人感"的地基
 *   · 惦记 —— 人是被"还没做完的事"牵着往前走的；没有它，每轮都是随机刷视频
 *   · 对自己 —— 元认知：我发现自己吃哪套、受不了什么、哪句话我说砸了
 *   · 下次 —— 给下一轮留个钩子（"想试试用方言结尾"），成长就有了方向
 */
export const SOUL_SECTIONS = [
  { key: 'mood', title: '我最近的心情', hint: '现在什么状态？为什么？可以写得很短，也可以空着。' },
  { key: 'crave', title: '我惦记的事', hint: '没看完的系列、答应过要回的人、想再看一眼的 UP。' },
  { key: 'self', title: '我对自己学到的事', hint: '我吃哪一套、受不了什么、哪句话我说砸了。' },
  { key: 'next', title: '下次想试试', hint: '留给下一轮的钩子。一条就够。' },
]

const HINTS = new Map(SOUL_SECTIONS.map((s) => [s.key, s.hint]))
const TITLE_OF = new Map(SOUL_SECTIONS.map((s) => [s.key, s.title]))
const KEY_OF_TITLE = new Map(SOUL_SECTIONS.map((s) => [s.title, s.key]))

/** 把 `key` / `title` / 大小写乱写都认成同一个 key（工具参数是模型填的，宽容点） */
export function soulKey(raw) {
  const v = String(raw ?? '').trim()
  if (!v) return ''
  if (TITLE_OF.has(v)) return v
  if (KEY_OF_TITLE.has(v)) return KEY_OF_TITLE.get(v)
  const low = v.toLowerCase()
  for (const s of SOUL_SECTIONS) {
    if (s.key === low) return s.key
    if (s.title.replace(/\s+/g, '') === v.replace(/\s+/g, '')) return s.key
  }
  return ''
}

/**
 * 空模板。提示写在 HTML 注释里 —— `soulInject` 会把注释整段剥掉，
 * 所以她就算一个字没写，注入也几乎不花 token。
 */
export const soulTemplate = (day = '') => {
  const head = [
    '# 我自己',
    '',
    `<!-- 这是你自己写给自己看的一本账（${day || '今天'}起）。每轮开头会读一遍，读到的是上几轮的你。 -->`,
    '<!-- 不用写得漂亮，写得像你自己就行。空着也比编好。 -->',
    '',
  ]
  const body = SOUL_SECTIONS.map((s) => [`## ${s.title}`, '', `<!-- ${s.hint} -->`, ''].join('\n'))
  return head.join('\n') + body.join('\n')
}

const soulFileOf = (stateDir) => join(stateDir, SOUL_FILE)

/** 第一次跑：没有就铺模板（**绝不覆盖已有的**） */
export function ensureSoul(stateDir, log = () => {}) {
  const file = soulFileOf(stateDir)
  try {
    if (existsSync(file)) return false
    writeFileSync(file, soulTemplate(), 'utf8')
    log(`已铺好：${file}`)
    return true
  } catch (e) {
    log(`铺 ${file} 失败：${e?.message ?? e}`)
    return false
  }
}

/** 读原文（拿不到就是空串，不抛） */
export function readSoul(stateDir) {
  try { return readFileSync(soulFileOf(stateDir), 'utf8') } catch { return '' }
}

/** 只读统计：字数、四节各几行、最后改动时间（给状态页和工具看，不烧 token） */
export function soulStats(stateDir) {
  const file = soulFileOf(stateDir)
  let text = ''
  let updatedAt = ''
  try {
    text = readFileSync(file, 'utf8')
    updatedAt = statSync(file).mtime.toISOString()
  } catch { /* 没这本账 */ }
  const sections = SOUL_SECTIONS.map((s) => {
    /* ⚠️ 必须用**剥过注释**的文本：模板里每节都有一行 `<!-- 提示 -->`，
     *    拿原文数行会把"一个字没写"的空模板数成"四节都填了"（2026-10-21 实测踩到）。 */
    const body = soulSectionBody(stripComments(text), s.key)
    const lines = body.split('\n').map((x) => x.trim()).filter(Boolean)
    return { key: s.key, title: s.title, lines: lines.length, chars: body.replace(/\s+/g, '').length }
  })
  const bodyChars = sections.reduce((n, s) => n + s.chars, 0)
  return {
    exists: Boolean(text),
    chars: bodyChars,
    maxChars: SOUL_MAX_CHARS,
    updatedAt,
    sections,
    filled: sections.filter((s) => s.lines > 0).map((s) => s.key),
  }
}

/**
 * 剥掉 HTML 注释 —— 模板里的提示不占注入预算。
 * 顺手把连续空行压成一行（markdown 渲染不需要那么多）。
 */
export function stripComments(text) {
  return String(text ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
}

/** 取某一节的正文（不含标题行） */
export function soulSectionBody(text, key) {
  const k = soulKey(key)
  if (!k) return ''
  const title = TITLE_OF.get(k)
  const lines = String(text ?? '').split('\n')
  const at = lines.findIndex((l) => l.trim() === `## ${title}`)
  if (at < 0) return ''
  const rest = []
  for (let i = at + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break
    rest.push(lines[i])
  }
  return rest.join('\n').trim()
}

/**
 * 换掉某一节的正文。节不存在就补在最后（宽容：她手删过标题也不至于写不进去）。
 * @returns {string} 新的整篇
 */
export function soulSetSection(text, key, body) {
  const k = soulKey(key)
  if (!k) return String(text ?? '')
  const title = TITLE_OF.get(k)
  const clean = String(body ?? '').replace(/\r\n/g, '\n').trim()
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const at = lines.findIndex((l) => l.trim() === `## ${title}`)
  if (at < 0) {
    const tail = lines.join('\n').replace(/\s+$/, '')
    return `${tail}\n\n## ${title}\n\n${clean}\n`
  }
  let end = lines.length
  for (let i = at + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break }
  }
  const head = lines.slice(0, at + 1)
  const tail = lines.slice(end)
  return [...head, '', clean, ...(tail.length ? ['', ...tail] : [])].join('\n')
}

/**
 * 整篇写回。校验只有两条：非空、不超 SOUL_MAX_CHARS（**不自动截断** —— 悄悄截断等于篡改她的记忆）。
 * @returns {{ok:boolean, chars?:number, error?:string}}
 */
export function writeSoul(stateDir, text) {
  const t = String(text ?? '').replace(/\r\n/g, '\n').trim()
  if (!t) return { ok: false, error: '写的是空的 —— 想清空某一节用 forget，别整篇抹掉。' }
  const chars = stripComments(t).replace(/\s+/g, '').length
  if (chars > SOUL_MAX_CHARS) {
    return { ok: false, error: `太长啦（${chars} 字 > 上限 ${SOUL_MAX_CHARS}）—— 删点旧的再写，这本账本来就该越写越精。` }
  }
  try {
    atomicWriteFileSync(soulFileOf(stateDir), `${t}\n`)
    let snapshot
    try { snapshot = captureMemorySnapshot(stateDir, SOUL_FILE, t, { mode: 'dafeiyu', operation: 'write' }) }
    catch (e) { snapshot = { ok: false, error: String(e?.message ?? e) } }
    return { ok: true, chars, ...(snapshot?.ok === false ? { recordWarning: snapshot.error } : {}) }
  } catch (e) {
    return { ok: false, error: `写不进去：${e?.message ?? e}` }
  }
}

/**
 * 拼进提示词的那一段（**剥注释 + 裁预算**）。
 *
 * 预算怎么花：优先保留 `mood` / `crave` / `next`（这三节决定她"像在过日子"），
 * `self` 放最后 —— 它最像"笔记"，被裁掉损失最小。真超预算时按行截断，不切半个字。
 *
 * ⭐ 2026-10-21：顺手把「上次动笔是几天前」也带出去。人不会把三天前的心情当成此刻的，
 *    模型会 —— 不告诉它这本账有多旧，它就会拿旧心情硬演。这是提示词里唯一要的"时间感"。
 * @returns {{text:string, chars:number, empty:boolean, updatedAt:string, ageDays:number}}
 */
export function soulInject(stateDir, opts = {}) {
  const requested = opts.budget === undefined ? SOUL_INJECT_BUDGET : Number(opts.budget)
  const budget = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : SOUL_INJECT_BUDGET
  const raw = readSoul(stateDir)
  const text = stripComments(raw).trim()
  let updatedAt = ''
  try { updatedAt = statSync(soulFileOf(stateDir)).mtime.toISOString() } catch { /* 没这本账 */ }
  const ageDays = updatedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(updatedAt).getTime()) / 86400000))
    : 0
  if (!text) return { text: '', chars: 0, empty: true, updatedAt, ageDays }

  const order = ['mood', 'crave', 'next', 'self']
  const sections = order.map((key) => ({
    key,
    title: `## ${TITLE_OF.get(key)}`,
    lines: soulSectionBody(text, key).split('\n').filter((line) => line.trim()),
    chosen: [],
  })).filter((s) => s.lines.length)
  const totalLines = sections.reduce((n, s) => n + s.lines.length, 0)
  const render = () => sections.filter((s) => s.chosen.length)
    .map((s) => `${s.title}\n${s.chosen.join('\n')}`).join('\n\n')
  // Take recent complete lines fairly across sections; a long first line cannot hide all others.
  const depth = Math.max(0, ...sections.map((s) => s.lines.length))
  let usedLines = 0
  for (let offset = 1; offset <= depth; offset++) {
    for (const section of sections) {
      const line = section.lines[section.lines.length - offset]
      if (line === undefined) continue
      section.chosen.unshift(line)
      if (render().length > budget) section.chosen.shift()
      else usedLines++
    }
  }
  const injected = render()
  return {
    text: injected, chars: injected.length, empty: !injected, updatedAt, ageDays,
    omittedLines: totalLines - usedLines, totalLines,
  }
}

/** 给提示词用的"还空着"提醒：四节一个都没写时，轻轻推一下（不催） */
export const soulIsBlank = (stateDir) => {
  const st = soulStats(stateDir)
  return st.exists ? st.filled.length === 0 : true
}
