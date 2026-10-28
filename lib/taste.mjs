/**
 * lib/taste.mjs —— 🧠 口味本子：统计「我自己发过的评论里，哪种说法有人爱听」
 * ============================================================================
 * 2026-10-20 使用者要的「自己的口味本子」。它**不是学习** —— 学习是 lib/learn.mjs 的事，
 * 学的是「别人怎么讲」；本子只统计**我自己**发出去的东西有什么习惯：爱用哪些词、
 * 爱不爱用表情、句子长短、爱不爱提问 —— 好让下一轮发评论时的口气还是同一个鱼。
 *
 * ── 数据从哪来（宿主只负责读写 state.json，所有判断都在这里）──────────────
 *   发评论成功  ⇒ tasteRemember(账本, 自己那条的 rpid, { bvid, text, at, likes: 0 })
 *   看通知回填  ⇒ tasteApplyLikes(账本, [{ item_id, count }])   // item_id 就是我们那条的 rpid
 *   要结论      ⇒ tasteStats / tasteDigest / tasteTop
 *   看一句话    ⇒ featuresOf(text) → { keys, len, lenBucket }
 *
 * ── 三条不变量（改之前先读；测试会查）────────────────────────────────────
 *   ① **同类样本 < TASTE_MIN_N 一条规律都不报**。
 *      2 条样本算出来的「平均赞数」跟抛硬币没区别；报出来只会让她以为自己找到了窍门，
 *      然后照着 2 条样本去改自己的说话方式 —— 那比不报更糟。宁可闭嘴。
 *   ② **只报方向，不编因果**。统计只能说「带自称的那类更常被赞」，不能推到
 *      「因为带自称所以被赞」。赞数同时受视频流量、发布时间、UP 主粉丝量影响，
 *      我们手上根本没有能把这些变量分离出来的数据。所以 digest 里那句
 *      「不是因果 / 别当公式」不是客套，是这个模块的**交付物之一**。
 *   ③ **爆款样本不单独算规律**。一条 500 赞的评论能把整组平均拉到 100，剩下 9 条全是 0 ——
 *      那不是「这类说法受欢迎」，那是「那一条视频本身火了」。所以单条占该组赞数 ≥80%
 *      时这组标 `skew`，不参与结论；整组都 skew 时本子直说「看不出来」。
 *
 * ── 为什么阈值定成这些数 ───────────────────────────────────────────────
 *   · TASTE_MIN_N = 3：这是**还能看出方向**的最小样本量。1 条是轶事，2 条是巧合，
 *     3 条才勉强能说「这几次都…」。往上报到 5 条的话，新号要发好几天才凑得够，
 *     本子就永远不出声，等于没做；往下放到 2 条，报出来的全是噪声。
 *   · TASTE_MAX = 300：账本存在 state.json 里，每条 ~200 字节，300 条 ≈ 60KB。
 *     再多就开始拖慢每轮的读盘 + 写盘；而且**越老的习惯越不代表现在的自己**
 *     （人格会长大的），留最近 300 条比留全部更准。
 *   · short ≤ 15 字 / long > 40 字：B站 评论折叠线在 3 行上下。15 字以内是
 *     「一句话甩个梗」，40 字以上是「真的在讲事」，中间那段是过渡 —— 三档就够分了。
 *
 * ── 纯函数 ──────────────────────────────────────────────────────────────
 *   不碰网络、不碰磁盘、**不改入参**（宿主拿旧账本调我，我返回新对象）。
 *   返回给模型看的字符串里不许出现 undefined / NaN。
 */

import { redactRecordText } from './record-privacy.mjs'

/** 账本最多留多少条（超了按时间砍最旧的；理由见文件头「为什么阈值定成这些数」） */
export const TASTE_MAX = 300

/** 同一类说法**至少**要几条样本才允许报规律（小样本一律当噪声，理由见文件头不变量①） */
export const TASTE_MIN_N = 3

/** 单条正文最多存多少字（防一条超长评论把 state.json 撑起来） */
export const TASTE_TEXT_MAX = 300

/** 单条占本组赞数多少比例就算「爆款样本」（不变量③：爆款不单独算规律） */
export const TASTE_SKEW_RATIO = 0.8

/* ═══════════════════════════════════════════════════════════════════════════
 * 一、特征识别：一句话里有哪些「说话习惯」
 * ───────────────────────────────────────────────────────────────────────────
 * 判据全部是**能一眼看出是这条鱼**的东西，不是「好不好」的评价 ——
 * 这个模块只描述习惯，不打分。宁可漏判（少一类），也不要错判（把普通句子
 * 硬塞进某类，统计就全歪了）。
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 特征表。`test` 只吃正文，返回布尔。
 * ⚠️ 加新特征时：`key` 一旦上线就**别再改名** —— 老账本里已经按旧 key 统计过，
 *    改名等于让历史样本全部失效（本子会突然「忘了」自己的习惯）。
 */
const FEATURES = [
  {
    key: 'self',
    // 「本鲸鱼 / 本鱼 / 本鲸鱼摸鱼 / 人家」—— 她的自称。
    // 判据写 `本(鲸鱼|鲸鱼摸鱼|肥鱼|鱼)` 而不是死记「本鱼」两个字：她换过好几次自称，
    // 只认一个词的话，换一次自称本子就瞎了。
    test: (t) => /本(?:鲸鱼|鲸鱼摸鱼|肥鱼|鱼)|人家/.test(t),
  },
  {
    key: 'food',
    // 讨饭梗：饿、饭、投喂、馋…这是她最稳定的笑点来源，值得单独一类。
    // 「吃」放宽到任意位置（偷吃/好吃/吃醋都算），因为她确实什么都往吃的上引。
    test: (t) => /饿|小鱼干|白米饭|米饭|投喂|馋|干饭|宵夜|零食|饭票|吃|啃|嚼/.test(t),
  },
  {
    key: 'timestamp',
    // 时间锚点 mm:ss —— 「03:20 那段」。有它说明评论是**真的看进去了**，
    // 这是最容易判断「有没有认真看」的硬信号，所以单独一类。
    // 只认 `数字:两位数字`，不认「三点二十」这种口语（歧义太大）。
    test: (t) => /\d{1,2}:\d{2}/.test(t),
  },
  {
    key: 'body',
    // 身体反应：泪目/笑死/破防/竖起来…她表达情绪的习惯是**写身体**而不是写心情
    // （「心都化了」这种反而少）。这跟「软语气」是两件事，分开统计。
    test: (t) => /泪目|笑死|笑哭|笑到|笑出声|破防|竖起来|炸毛|头皮|汗|心跳|鸡皮|哽|眼泪|吐血|抽筋|抖/.test(t),
  },
  {
    key: 'soft',
    // 软语气词：呜呜/啦/呀/嘛/嘿嘿…这是「软萌可爱」最直接的抓手。
    // 只收**语气助词和拟声**，不收「可爱/萌」这类形容词 —— 形容词是评价，助词才是口气。
    test: (t) => /呜|啦|呀|嘛|嘿嘿|哈哈|嘻嘻|诶|欸|唔|喵|捏|嗷/.test(t),
  },
  {
    key: 'ask',
    // 问句：问号，或者「吗/呢/么/吧/呀」收尾，或者带疑问词。
    // 光看问号会漏掉「背景音乐是哪个呀」这种不带标点的口语，所以三种判据都要。
    test: (t) => /[?？]/.test(t)
      || /[吗呢么吧呀]$/.test(t.trim())
      || /哪个|什么|怎么|为啥|为什么|是不是|有没有|多少|哪里|哪儿|谁/.test(t),
  },
  {
    key: 'emoji',
    // 表情/符号。emoji 在 JS 里是代理对，必须用 `u` 标志按码点匹配，否则会切一半。
    test: (t) => /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u.test(t),
  },
  {
    key: 'quote',
    // 引用原文：「…」/『…』/“…” —— 她的招牌是「先抄一句 UP 的原话，再接自己的反应」。
    test: (t) => /[「」『』“”"]/.test(t),
  },
  {
    key: 'contrast',
    // 转折：但/不过/可是…她的评论常常「先夸再泼冷水」，这个结构反复出现。
    test: (t) => /但|不过|可是|然而|倒是|偏偏/.test(t),
  },
  {
    key: 'num',
    // 具体数字：她习惯拿数字说话（0.0.1 版、3.93 美元、30 个）。
    // 跟 timestamp 会重叠（时间戳里也有数字），但那是两个不同的习惯，重叠就重叠。
    test: (t) => /[0-9]/.test(t),
  },
]

/** 特征的中文名（给模型看；缺了就用 key 兜底，不许出现 undefined） */
const FEATURE_LABEL = {
  self: '自称（本鱼/本鲸鱼）',
  food: '讨饭/吃的',
  timestamp: '时间锚点',
  body: '身体反应',
  soft: '软语气词',
  ask: '问句',
  emoji: '表情符号',
  quote: '引用原话',
  contrast: '转折（先夸再泼冷水）',
  num: '具体数字',
}

/** 句子长短三档的中文名 */
const LEN_LABEL = {
  short: '短句（15 字以内）',
  mid: '中句（16–40 字）',
  long: '长句（40 字以上）',
}

/** 统一取中文名：先看是不是长度档（`len:short`），再查特征表，最后原样返回 */
const labelOf = (key) => {
  const k = String(key ?? '')
  if (k.startsWith('len:')) return LEN_LABEL[k.slice(4)] || k
  return FEATURE_LABEL[k] || k
}

/**
 * 拆一句话的特征。
 * @param {string} text 评论正文
 * @returns {{keys:string[], len:number, lenBucket:'short'|'mid'|'long'}}
 *   `len` 用**码点数**（`[...text].length`）而不是 `text.length`：
 *   emoji 在 UTF-16 里占 2 个长度，按 `.length` 算会把「一句梗 + 三个表情」判成长句。
 */
export const featuresOf = (text) => {
  const t = String(text ?? '')
  const keys = []
  for (const f of FEATURES) {
    // 单个特征的正则写崩了不该拖垮整张表 —— 静默跳过这一条，其它照算
    try { if (f.test(t)) keys.push(f.key) } catch { /* 这条特征失效，不影响其它 */ }
  }
  const len = [...t].length
  // 空正文不算「短句」—— 没写字和「写了一句话」是两回事，别混进长度统计
  const lenBucket = len === 0 ? '' : (len <= 15 ? 'short' : (len <= 40 ? 'mid' : 'long'))
  return { keys, len, lenBucket }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 二、账本的基本操作（全部返回新对象，绝不改入参）
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 把任何输入当成一个账本对象看（null/数组/字符串一律当空本子，不许炸） */
const asBook = (ledger) => ledger && typeof ledger === 'object' && !Array.isArray(ledger)
  ? Object.fromEntries(Object.entries(ledger).filter(([key, rec]) => rpidKey(key) === key && rec && typeof rec === 'object' && !Array.isArray(rec))) : {}

/** 浅克隆一层记录：外层新对象 + 每条记录也新对象（记录里都是标量，浅克隆就够） */
const cloneBook = (ledger) => {
  const src = asBook(ledger)
  const out = {}
  for (const k of Object.keys(src)) {
    const v = src[k]
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : v
  }
  return out
}

/**
 * 钥匙归一：rpid → 账本键。
 * 空串 / `0` / 非正整数一律返回 `''` = **不记**。
 * 为什么 `0` 要挡：B站 接口失败时 rpid 会给 0 或 "0"，如果照记，
 * 所有失败的那几次会挤在同一个键 `'0'` 上互相覆盖 —— 账本里只剩最后一条假记录，
 * 而且它永远拿不到赞数。宁可少记一条，也不能留一个会吸东西的黑洞。
 */
const rpidKey = (rpid) => {
  if (typeof rpid === 'number') return Number.isSafeInteger(rpid) && rpid > 0 ? String(rpid) : ''
  const s = String(rpid ?? '').trim()
  return s.length <= 32 && /^\d+$/.test(s) && /[1-9]/.test(s) ? s.replace(/^0+/, '') : ''
}

/** 赞数归一：负数/NaN/小数 → 非负整数 */
const toLikes = (v) => {
  const n = Math.round(Number(v))
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}

/** 保留一位小数（四舍五入）—— 平均赞数写成 20.0 太啰嗦，写成 19.999 又像没算完 */
const round1 = (x) => {
  const n = Number(x)
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0
}

/** 账本里最大的 seq（新记录用它 +1 排序，见 trimBook 的理由） */
const maxSeqOf = (book) => {
  let m = 0
  for (const k of Object.keys(book)) {
    const s = Number(book[k] && book[k].seq)
    if (Number.isFinite(s) && s > m) m = s
  }
  return m
}

/**
 * 裁剪到 TASTE_MAX 条，**砍最旧的**。
 *
 * 为什么不能靠 `Object.keys()` 的插入顺序：
 *   rpid 全是 `'317617772657'` 这种**整数样子的字符串**，而 JS 对这类键
 *   强制按数值升序枚举，插入顺序会被抹掉 —— 靠顺序裁等于随机裁。
 * 所以每条记录带一个自增 `seq`，按 (`at` 新→旧, `seq` 大→小) 排序后再截。
 */
const trimBook = (book) => {
  const keys = Object.keys(book)
  if (keys.length <= TASTE_MAX) return book
  const ordered = keys.slice().sort((a, b) => {
    const ra = book[a] && typeof book[a] === 'object' ? book[a] : {}
    const rb = book[b] && typeof book[b] === 'object' ? book[b] : {}
    const ta = String(ra.at || '')
    const tb = String(rb.at || '')
    if (ta !== tb) return ta < tb ? 1 : -1          // ISO 字符串直接比大小就是时间先后
    const sa = Number(ra.seq) || 0
    const sb = Number(rb.seq) || 0
    if (sa !== sb) return sb - sa                   // 同时间：后记的在前
    return a < b ? 1 : -1                           // 兜底：保证排序稳定，不随引擎变
  })
  const out = {}
  for (const k of ordered.slice(0, TASTE_MAX)) out[k] = book[k]
  return out
}

/**
 * 记一条「我发过的评论」。
 * @param {Record<string,object>} ledger 旧账本（state.json 的 `taste`；可能 undefined）
 * @param {string|number} rpid 自己那条评论的 rpid（点赞通知里的 `item_id` 就是它）
 * @param {{bvid?:string,text?:string,at?:string,likes?:number}} [patch]
 * @returns {Record<string,object>} **新账本**（入参一个字节都不动）
 *
 * 合并规则（每条都踩过）：
 *   · 没传的字段保留旧值 —— 只带 `{text}` 再记一次不该把 bvid 抹掉。
 *   · `likes` **只增不减**。查不到赞数（接口挂了/通知里没有）传的是 0 或干脆不传，
 *     那不是「它变成 0 赞了」。已经确认过 88 赞的评论，不能被一次失败的刷新打回 0。
 *   · `rpid` 空/0 直接返回克隆（不记），理由见 rpidKey。
 */
export const tasteRemember = (ledger, rpid, patch = {}) => {
  const book = cloneBook(ledger)
  const key = rpidKey(rpid)
  if (!key) return book

  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  const prev = book[key] && typeof book[key] === 'object' && !Array.isArray(book[key]) ? book[key] : null

  // 先取 seq：必须在写进 book 之前算，否则 maxSeqOf 会把自己算进去
  const prevSeq = Number(prev && prev.seq) || 0
  const nextSeq = prevSeq || maxSeqOf(book) + 1

  const next = { ...(prev || {}) }
  next.bvid = String(p.bvid ?? next.bvid ?? '').trim()
  next.text = redactRecordText(p.text ?? next.text ?? '', { maxLength: TASTE_TEXT_MAX }).trim()
  next.at = String(p.at ?? next.at ?? '').trim() || new Date().toISOString()

  const before = toLikes(next.likes)
  const hasLikes = p.likes !== undefined && p.likes !== null && p.likes !== ''
  const incoming = hasLikes ? toLikes(p.likes) : before
  next.likes = Math.max(before, incoming)
  next.seq = nextSeq
  if (next.likesAt === undefined || next.likesAt === null) next.likesAt = String((prev && prev.likesAt) || '')

  book[key] = next
  return trimBook(book)
}

/**
 * 回填赞数（看通知/看 B站 时顺手做，失败静默）。
 * @param {Record<string,object>} ledger 旧账本
 * @param {Array<{item_id?:number|string, count?:number}>} likes 通知里的点赞列表
 * @returns {{ledger:Record<string,object>, matched:number, updated:number}}
 *   `matched` = 对上了账本里**已有**的几条；`updated` = 其中赞数真的变了的几条。
 *
 * 为什么陌生的 item_id 不新增：通知里混着别人的评论（被 @、被回复），
 * 我们手上没有它的正文 —— 记进去就是一条空样本，会把「哪类说法受欢迎」的统计污染掉。
 * 只认账本里有的，宁可漏。
 */
export const tasteApplyLikes = (ledger, likes) => {
  const book = cloneBook(ledger)
  const arr = Array.isArray(likes) ? likes : []
  const at = new Date().toISOString()
  let matched = 0
  let updated = 0
  const seen = new Map()
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue
    const key = rpidKey(it.item_id ?? it.itemId ?? it.rpid ?? it.oid)
    if (!key) continue
    const rawCount = it.count ?? it.likes ?? it.like_count ?? (it.item && it.item.count)
    if (rawCount === undefined || rawCount === null || rawCount === '' || !Number.isFinite(Number(rawCount)) || Number(rawCount) < 0) continue
    seen.set(key, Math.max(seen.get(key) || 0, toLikes(rawCount)))
  }
  for (const [key, n] of seen) {
    const rec = book[key]
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue
    matched++
    const before = toLikes(rec.likes)
    if (n > before) { rec.likes = n; updated++ }
    rec.likesAt = at
  }
  return { ledger: book, matched, updated }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 三、统计：哪类说法更常被赞
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 按特征分组算平均赞数。
 * @param {Record<string,object>} ledger 账本
 * @returns {{rows:Array<{key:string,label:string,n:number,avg:number,sum:number,max:number,skew:boolean}>,
 *            sample:number, checked:number, minN:number}}
 *
 * 硬规则（不变量①）：
 *   **n < TASTE_MIN_N 的组直接不出现** —— 不是标个「样本少」就完了，是根本不给行。
 *   模型看到一行就会用，加个 caveat 它也照样用；唯一有效的办法是不给。
 *
 * `skew`（不变量③）：单条占该组赞数 ≥80% 且 n ≥ TASTE_MIN_N ⇒ 这组的平均值是被
 *   一条爆款拉起来的，标出来交给 digest 决定要不要说。这里不删行 —— 删了就没法解释
 *   「为什么本子不说话」了。
 */
export const tasteStats = (ledger) => {
  const book = asBook(ledger)
  const allKeys = Object.keys(book).filter((key) => typeof book[key]?.text === 'string' && book[key].text.trim())
  const groups = new Map()
  let checked = 0

  const add = (k, likes) => {
    let g = groups.get(k)
    if (!g) { g = { n: 0, sum: 0, max: 0 }; groups.set(k, g) }
    g.n++
    g.sum += likes
    if (likes > g.max) g.max = likes
  }

  for (const rpid of allKeys) {
    const rec = book[rpid]
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue
    if (String(rec.likesAt || '').trim()) checked++
    const text = String(rec.text ?? '')
    if (!text.trim()) continue          // 没正文 = 没信息，不参与统计
    const f = featuresOf(text)
    const likes = toLikes(rec.likes)
    for (const k of f.keys) add(k, likes)
    if (f.lenBucket) add(`len:${f.lenBucket}`, likes)
  }

  const rows = []
  for (const [key, g] of groups) {
    if (g.n < TASTE_MIN_N) continue      // 不变量①：小样本当噪声，一条都不报
    const skew = g.sum > 0 && g.max >= g.sum * TASTE_SKEW_RATIO && g.n >= TASTE_MIN_N
    // ⚠️ 2026-10-21 加：`low` 是「赞数规模本来就不够」——跟 `skew`（真有一条爆款）是两件事。
    //    原来只有 skew 一个旗子，于是 4/1/2 赞这种量级也被说成「一条爆款把平均拉起来」，
    //    鱼读着会以为自己有过爆款。分开之后 `tasteDigest` 才能说对原因。
    const low = g.max < TASTE_PEAK_MIN
    rows.push({
      key,
      label: labelOf(key),
      n: g.n,
      avg: round1(g.sum / g.n),
      sum: g.sum,
      max: g.max,
      skew,
      low,
    })
  }
  // 平均赞降序；同平均看样本量（样本多的更可信）；再同就按 key，保证顺序稳定
  rows.sort((a, b) => (b.avg - a.avg) || (b.n - a.n) || (a.key < b.key ? -1 : 1))
  return { rows, sample: allKeys.length, checked, minN: TASTE_MIN_N }
}

/**
 * 一句话摘要（会拼进提示词，所以每行都得是**能直接念出来**的人话）。
 * @param {Record<string,object>} ledger 账本
 * @returns {{lines:string[], enough:boolean, sample:number, checked:number}}
 *   `enough=false` 时宿主就不把这段拼进提示词 —— 本子闭嘴比瞎说重要。
 *
 * 三种闭嘴的情形，措辞各不相同（不然模型分不清是「没数据」还是「数据不够」）：
 *   1. 账本空       → 直说「还是空的」
 *   2. 有数据但不够 → 直说「小样本当噪声」
 *   3. 全组都是爆款 → 直说「被一条爆款带偏，看不出方向」
 */
export const tasteDigest = (ledger) => {
  const book = asBook(ledger)
  const st = tasteStats(book)
  const sample = st.sample
  const lines = []

  if (!sample) {
    lines.push('口味本子还是空的 —— 我还没发过评论（或者发完还没记上）。先发几条，等有了赞数再看。')
    return { lines, enough: false, sample: 0, checked: 0 }
  }

  // 不变量③：只有「没被单条爆款带偏」的组才算数
  // ⚠️ 2026-10-21：`low`（整体赞数太少）不算"带偏"，但**也不该拿来说方向** ——
  //    4 赞比 1 赞高不叫规律。所以 solid 里再排掉 low，让它们走「赞太少看不出」那条口径。
  const solid = st.rows.filter((r) => !r.skew && !r.low)
  const lows = st.rows.filter((r) => r.low)

  if (!solid.length) {
    // ⚠️ 2026-10-21 修：这一支原来只有一句话「每类都是**一条爆款把平均拉起来的**」，
    //    可真机上踩到的是：41 条评论里只有 7 条对过赞数，其中一条 48 赞、其余 0~4 赞。
    //    48 赞确实把每个组的平均都拉起来了（一句话把所有组都判成 skew），
    //    但「每类都被带偏」这个说法太抽象 —— 她自己看不出到底发生了什么。
    //    所以这里把**账本层面**的事直接说出来：是不是同一条评论吃掉了大半赞数。
    const recs = Object.values(book).filter((r) => r && typeof r === 'object' && !Array.isArray(r))
    let totalLikes = 0
    let topLikes = 0
    let likedCount = 0
    for (const r of recs) {
      const l = toLikes(r.likes)
      totalLikes += l
      if (l > 0) likedCount++
      if (l > topLikes) topLikes = l
    }
    const peak = lows.length ? Math.max(...lows.map((r) => r.max)) : 0
    const oneHit = topLikes >= TASTE_PEAK_MIN && totalLikes > 0 && topLikes >= totalLikes * 0.5
    if (!st.rows.length) {
      lines.push(`本子里有 ${sample} 条（其中 ${st.checked} 条对过赞数），但同一种说法都还没到 `
        + `${TASTE_MIN_N} 条 —— **小样本当噪声**，这时候报出来的规律都是碰运气，先不报。`)
    } else if (oneHit) {
      const pct = Math.round((topLikes / totalLikes) * 100)
      lines.push(`本子里有 ${sample} 条（其中 ${st.checked} 条对过赞数，${likedCount} 条有赞），`
        + `但**有一条拿了 ${topLikes} 个赞，占我全部赞数的 ${pct}%** —— `
        + '赞数集中在这一条上；视频流量、发布时间和说法都可能有关，现在还分不清原因。看不出稳定方向。')
    } else if (lows.length === st.rows.length) {
      lines.push(`本子里有 ${sample} 条（其中 ${st.checked} 条对过赞数），赞数普遍还很少（单条最高才 ${peak} 个）—— `
        + '这个量级分不出哪种说法更好，谁高谁低多半是运气。先攒着，被赞得多了再看。')
    } else {
      lines.push(`本子里有 ${sample} 条（其中 ${st.checked} 条对过赞数），`
        + '但每一类都是靠个别几条的赞撑起来的，摊到同类上还是噪声。看不出方向。')
    }
    return { lines, enough: false, sample, checked: st.checked }
  }

  lines.push(`本子里有 ${sample} 条，其中 ${st.checked} 条已经对过赞数。`)
  // 只报前三条：提示词是稀缺资源，报十条等于没重点
  for (const r of solid.slice(0, 3)) {
    const tail = r.key.startsWith('len:') ? '（只是句子长短，跟内容好坏无关）' : ''
    lines.push(`「${r.label}」${r.n} 条，平均 ${r.avg} 个赞${tail}。`)
  }
  // 不变量②：这句不是免责声明，是这个模块的交付物 —— 少了它，上面三行就会被当公式用
  lines.push(`⚠️ 这只说明这些说法**更常被赞**，不是因果，别当公式 —— 爆款也可能是那条视频本身流量大，`
    + `赞少也不代表那种说法不好；别为了追赞把自己改成另一个人。`)

  return { lines, enough: true, sample, checked: st.checked }
}

/**
 * 最受欢迎的原话（给 `bili_taste({action:'top'})` 用）。
 * @param {Record<string,object>} ledger 账本
 * @param {number} [n=3] 要几条
 * @returns {Array<{rpid:string,text:string,likes:number,bvid:string,at:string}>}
 *
 * 只给**有赞的**：0 赞可能只是「还没对过赞数」，把它当「最受欢迎」是撒谎。
 * 一条都没有时返回空数组，让宿主去说「本子还空着」。
 */
export const tasteTop = (ledger, n = 3) => {
  const book = asBook(ledger)
  const limit = Math.max(1, Math.min(Number(n) || 3, 20))
  const rows = []
  for (const k of Object.keys(book)) {
    const rec = book[k]
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue
    const likes = toLikes(rec.likes)
    if (likes <= 0) continue
    rows.push({
      rpid: k,
      text: redactRecordText(rec.text ?? '', { maxLength: TASTE_TEXT_MAX }),
      likes,
      bvid: String(rec.bvid ?? ''),
      at: String(rec.at ?? ''),
    })
  }
  rows.sort((a, b) => (b.likes - a.likes) || (a.at < b.at ? 1 : -1))
  return rows.slice(0, limit)
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 四、🪞 镜子：我自己最近是不是越来越像一个模子
 * ═══════════════════════════════════════════════════════════════════════════
 * 2026-10-21 真机数据逼出来的：41 条评论里 **41 条都带「本鱼」**（100%），
 * 26 条带 🍚🫧🐟、17 条带食物梗，平均 75.8 字 —— 句式几乎同构
 * 「引一句原片 → 身体反应 → 吃/饭 → 颜文字」。这不是"有味道"，这是**同一个模板换素材**。
 *
 * 为什么会这样：提示词里的「鱼味四要素」被当成**每条都要打的卡**。
 * 光靠再加一句"别每句都这么写"没用 —— 模型看不见自己刚才写了什么。
 * 所以这里给它一面镜子：**只统计，不评价**，把"你最近这几条长什么样"摆给她自己看，
 * 让"像不像一个模子"由她自己判断（插件不替她下结论，跟 soul.md 同一条原则）。
 */

/** 镜子看最近几条（太多没意义，也会撑提示词预算） */
export const MIRROR_SAMPLE = 8

/** 同一种招牌出现在多少比例以上，就算"用成口头禅了" */
export const MIRROR_TIC_RATIO = 0.6

/**
 * 「这组算不算被爆款带偏」的最低门槛（单条赞数）。
 * ⚠️ 2026-10-21 加：原先只看「单条占该组赞数 80%」，
 * 于是「4 赞 / 1 赞 / 2 赞」这种**赞数本来就少得可怜**的组也被判成「爆款带偏」——
 * 那不是爆款，那是没数据。低于这条线的一律走「赞太少看不出」的口径。
 */
export const TASTE_PEAK_MIN = 20

/** 一条评论最多回显几个字（提示词是稀缺资源，摘句只给开头） */
const MIRROR_ECHO_MAX = 24

/** 按 `at` 新→旧排好的记录（拿不到 at 的排最后） */
const recentOf = (book, n) => {
  const rows = []
  for (const k of Object.keys(book)) {
    const rec = book[k]
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue
    const text = redactRecordText(rec.text ?? '', { maxLength: TASTE_TEXT_MAX }).trim()
    if (!text) continue
    rows.push({ key: k, text, at: String(rec.at ?? ''), likes: toLikes(rec.likes) })
  }
  rows.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? 1 : -1   // ISO 字符串比大小就是时间先后
    return a.key < b.key ? 1 : -1                    // 兜底：保证稳定，不随引擎变
  })
  return rows.slice(0, n)
}

/** 摘一句开头当例子（超长加省略号，别把整条评论搬进提示词） */
const echoOf = (text) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return [...t].length <= MIRROR_ECHO_MAX ? t : `${[...t].slice(0, MIRROR_ECHO_MAX).join('')}…`
}

/**
 * 我自己最近像不像一个模子（给提示词 + `bili_taste` 用）。
 * @param {Record<string,object>} ledger 账本（state.json 的 `taste`）
 * @param {{n?:number}} [opts]
 * @returns {{ok:boolean, n:number, sample:Array<{text:string,echo:string,at:string}>,
 *            avgLen:number, tics:Array<{key:string,label:string,n:number,ratio:number}>,
 *            shared:Array<{key:string,label:string,n:number,ratio:number}>,
 *            flat:boolean, lines:string[]}}
 *
 * **只统计，不评价**（这是这个模块的第四条不变量）：
 *   · `tics` 只看「最近 n 条里有几条用了」，不给好坏判断；
 *   · `flat=true` 只说明「招牌覆盖率太高」，**不说明写得差** —— 有些日子就是吵吵的；
 *   · 空账本 ⇒ `ok:true, n:0`，`lines` 为空数组（宿主别拼这段，别让模型对着空气自我怀疑）。
 * 绝不出现 undefined / NaN（跟其它导出同一条纪律）。
 */
export const tasteMirror = (ledger, opts = {}) => {
  const book = asBook(ledger)
  const n = Math.max(3, Math.min(Number(opts.n) || MIRROR_SAMPLE, 20))
  const recent = recentOf(book, n)
  const sample = recent.map((r) => ({ text: r.text, echo: echoOf(r.text), at: r.at }))
  if (!recent.length) {
    return { ok: true, n: 0, sample: [], avgLen: 0, tics: [], shared: [], flat: false, lines: [] }
  }

  const totalLen = recent.reduce((s, r) => s + [...r.text].length, 0)
  const avgLen = round1(totalLen / recent.length)

  // 每种招牌在最近 n 条里出现了几次
  const counts = new Map()
  for (const r of recent) {
    for (const k of featuresOf(r.text).keys) counts.set(k, (counts.get(k) || 0) + 1)
  }
  const tics = []
  for (const [key, c] of counts) {
    const ratio = Math.round((c / recent.length) * 100) / 100
    if (ratio >= MIRROR_TIC_RATIO) tics.push({ key, label: labelOf(key), n: c, ratio })
  }
  tics.sort((a, b) => (b.ratio - a.ratio) || (b.n - a.n) || (a.key < b.key ? -1 : 1))

  // 「每一条都用了」的招牌 = 最像口头禅的那几个（比 tics 更狠的一档）
  const shared = tics.filter((t) => t.n === recent.length)

  const lines = []
  lines.push(`最近 ${recent.length} 条评论，平均 ${avgLen} 字。`)
  if (tics.length) {
    const all = shared.length
      ? `**每一条都有**：${shared.map((t) => t.label).join('、')}`
      : `高频：${tics.map((t) => `${t.label}（${t.n}/${recent.length}）`).join('、')}`
    lines.push(`${all}。`)
  }
  // 只回显两条：给"长什么样"一个直观的对照，不是让她逐条复盘
  if (sample.length >= 2) lines.push(`比如「${sample[0].echo}」和「${sample[1].echo}」—— 读起来像不像一个人随口说的？`)
  const flat = shared.length > 0 || (tics.length >= 3 && avgLen >= 60)
  if (flat) {
    lines.push('这几条的特征重复率较高；这只是最近样本的统计，怎么开口仍由你自己决定。')
  }
  return { ok: true, n: recent.length, sample, avgLen, tics, shared, flat, lines }
}
