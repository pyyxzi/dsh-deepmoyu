/** Strict, side-effect-free authoring boundary for the local short-film renderer. */
export const PRODUCTION_SCHEMA = 'dafeiyu-dialogue-v1'
export const EDITORIAL_SCHEMA = 'deepmoyu-editorial-v2'
const LEGACY_SCHEMA = PRODUCTION_SCHEMA
const SCENES = Object.freeze(['hook', 'headline', 'compare', 'steps', 'quote', 'spotlight', 'outro'])
const THEMES = Object.freeze(['paper', 'midnight', 'signal'])
const ENERGIES = Object.freeze(['quiet', 'warm', 'punchy', 'surprise'])
const TRANSITIONS = Object.freeze(['cut', 'slide', 'match', 'hold'])
export const PRODUCTION_MODES = Object.freeze(['daily', 'rant', 'highlights', 'custom'])
const CAMERAS = Object.freeze(['wide', 'medium', 'close', 'push', 'reverse', 'close-inner', 'insert'])
const EXPRESSIONS = Object.freeze(['neutral', 'happy', 'question', 'thinking', 'surprised', 'worried'])
const PROPS = Object.freeze(['rice', 'note'])
const PROVENANCE = Object.freeze(['original-dialogue', 'record-adaptation', 'source-quote'])
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const BV_RE = /^BV[A-Za-z0-9]{10}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const SPEECH_RATE = 4.4
export const MIN_TARGET_DURATION_RATIO = 0.60
const INNER_VOICE = Object.freeze({ name: 'zh-CN-YunxiNeural', rate: '+12%', pitch: '+0Hz', mode: 'edge' })
const DEFAULT_VOICE = Object.freeze({ name: 'zh-CN-XiaoyiNeural', rate: '+8%', pitch: '+12Hz' })

const fail = (where, reason) => { throw new Error(`${where}: ${reason}`) }
const object = (raw, where) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail(where, '必须是 JSON 对象')
  return raw
}
const keys = (raw, allowed, where) => {
  object(raw, where)
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) fail(`${where}.${key}`, '不支持此字段；路径、执行程序和音色只能来自宿主配置')
}
const text = (raw, where, max, required = true) => {
  if (raw === undefined && !required) return ''
  if (typeof raw !== 'string') fail(where, '必须是字符串')
  const value = raw.trim()
  if (required && !value) fail(where, '不能为空')
  if ([...value].length > max) fail(where, `最多 ${max} 字；请重写，系统不会截断台词或标题`)
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail(where, '不能含控制字符')
  return value
}
const choice = (raw, allowed, where, fallback) => {
  const value = raw === undefined ? fallback : raw
  if (!allowed.includes(value)) fail(where, `只支持 ${allowed.join(' / ')}`)
  return value
}
const number = (raw, where, min, max, fallback) => {
  const value = raw === undefined ? fallback : raw
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(where, `必须是 ${min}..${max} 之间的数值`)
  return value
}
const identifier = (raw, where) => {
  if (typeof raw !== 'string' || !ID_RE.test(raw)) fail(where, '只支持 1..64 位字母、数字、下划线或连字符，首位须为字母或数字')
  return raw
}
const validDate = (raw, where) => {
  if (typeof raw !== 'string' || !DATE_RE.test(raw)) fail(where, '必须是有效 YYYY-MM-DD 日期')
  const value = new Date(`${raw}T00:00:00Z`)
  if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== raw) fail(where, '必须是有效 YYYY-MM-DD 日期')
  return raw
}
const yesterday = () => {
  const d = new Date(Date.now() - 86400_000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const sourceUrl = (raw, bvid, where) => {
  if (raw === undefined && bvid) return `https://www.bilibili.com/video/${bvid}`
  const value = text(raw, where, 500)
  let parsed
  try { parsed = new URL(value) } catch { fail(where, '必须是公开 HTTPS 来源链接') }
  const host = parsed.hostname.toLowerCase()
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
      || !host.includes('.') || /^(?:localhost|.*\.localhost|.*\.local|.*\.internal)$/u.test(host)
      || /^[\d.]+$/u.test(host) || host.includes(':') || parsed.hash) fail(where, '必须是公开 HTTPS 来源链接；不接受本地路径、账号口令、IP 或片段')
  if (bvid && (host !== 'www.bilibili.com' || parsed.pathname.replace(/\/$/, '') !== `/video/${bvid}` || parsed.search)) fail(where, '有 bvid 时链接必须是对应的标准 B站视频链接')
  return parsed.href
}

/** Useful in a visible production session; no model or network calls occur here. */
export function productionGuide() {
  return {
    schema: PRODUCTION_SCHEMA,
    modes: [...PRODUCTION_MODES],
    input: {
      required: ['mode', 'title', 'cover', 'shots'],
      optional: ['schema', 'theme', 'date', 'brief', 'sources', 'disclosure', 'coverage', 'targetDurationSec', 'maxDurationSec', 'gap', 'lead', 'tail'],
      shot: { required: ['text', 'headline'], optional: ['id', 'kind', 'speaker', 'scene', 'kicker', 'body', 'items', 'energy', 'transition', 'camera', 'expression', 'prop', 'props', 'beat', 'pause_after', 'provenance', 'source_ids'] },
      scenes: [...SCENES], themes: [...THEMES], energies: [...ENERGIES], transitions: [...TRANSITIONS],
      items: 'compare 恰好2项，steps 为2..4项；每项是 {label:最多12字, detail:最多36字}。其他场景不传 items。',
      source: { required: ['id', 'title', 'url or bvid'], optional: ['bvid', 'author', 'date', 'kind', 'excerpt', 'digest', 'eventId'] },
      speakers: { fish: '默认主讲人，使用大肥鱼口型动画', narrator: '纯旁白备用；没有角色出镜', },
      cameras: [...CAMERAS], expressions: [...EXPRESSIONS], props: [...PROPS], provenance: [...PROVENANCE],
    },
    constraints: [
      '由当前会话模型亲自选题、写旁白和设计视觉。用单人解说、冷知识拆解、观点实验、精选策展、微纪录或明确虚构的故事；不安排脑内小鱼对话，不用固定饭桌拌嘴。大肥鱼是主讲者，在关键镜头张口说话、做反应和收束。',
      '1..40 镜，每镜非空旁白最多84字。新计划 schema 为 deepmoyu-editorial-v2，kind 可省或为 editorial；speaker 可省或用 fish / narrator，省略时默认 fish。',
      '每镜 headline 必填，最多24字，是屏幕上可一眼读懂的核心信息；kicker 最多16字，body 最多60字。屏幕不复制整段旁白。scene 默认 headline。',
      'hook=大字悬念与轨道图形；headline=观点与放大镜式焦点；compare=双栏对照；steps=递进卡片；quote=引语/原创金句；spotlight=聚光结论；outro=开放问题收束。quote 逐字引用仍须 source-quote 与有效来源，原创金句用 original-dialogue。',
      '先写具体钩子，再揭示信息、举例或对照、最后回收钩子。0..1.5秒抓人，中段每1.5..3.5秒改变画面或信息层，结尾给有余味的落点。开场不自我介绍、不念日期。按主题选至少3种场景，推荐6..14镜，相邻同版式不超过2镜。',
      'editorial-v2 的第一镜必须是 hook，最后一镜必须是 outro；至少使用3种 scene（15秒以下可2种），相邻同scene最多2镜。每镜选择 energy 与 transition，让节奏有强弱和转折，不要所有镜头同速。',
      'theme 选择 paper（暖白/珊瑚橙）、midnight（雾蓝白/靛蓝）、signal（奶油黄/朱红）；全片一种明亮主题，避免大面积绿色和深色背景。转场和图形动画由渲染器生成。',
      '目标 targetDurationSec 默认150秒，允许15..300秒；maxDurationSec 默认目标的110%且最多300秒，且不得小于目标。',
      '预算按每镜 max(2秒, 字数/4.4) 加停顿、片头尾估算；超 maxDurationSec 拒绝。明确给出 targetDurationSec 时，预计时长还必须达到目标的60%，不足时应增加有意义的场景与旁白，不能靠静态补帧凑时长。最终仍由实测音视频校验时长。',
      '实际 renderer 字段是 prop 单数：rice 或 note；props 只作输入别名，必须恰有一个值，不能与 prop 同用。',
      '引用使用 source_ids，对应 sources[].id；来源改编用 record-adaptation，逐字引用用 source-quote 且台词必须包含于对应 excerpt。没有 quote_ids 字段。',
      'daily 必须至少有一个当天来源（source.date 等于片子日期），以及引用该来源的镜头；只据已核实的当日公开记录写，不把当前想法装成当天经历。',
      '来源只收公开视频或脱敏公开记录；不复制私信、账号归属、真名、地址、联系方式或凭证，不提交任意本地 file/path。',
      'custom 可写明确虚构的故事；disclosure 必须诚实，规范化层会加上“虚构演绎 / 原创评论”。',
      'cover.title 1..60字，是具体事件标题，不放日期、BV号或“日报/测试/TODO”等标签；subtitle 最多72字、hook最多84字，仅留作编辑元数据，当前封面画面只绘制 title。',
      '只接收列明字段。禁止原始 voice、shot.voice、GSV配置、路径、可执行程序、自定义 speaker。宿主通过可信选项注入音色。',
      'date 可省，默认本地昨天；raw JSON 只能是一个对象（不要 Markdown 代码围栏）。',
    ],
    editorialSample: {
      schema: EDITORIAL_SCHEMA, mode: 'custom', date: '2026-10-21', theme: 'paper',
      title: '收藏夹为什么越攒越重', brief: '用一个日常观察讲清输入与行动的区别。单人短片。',
      targetDurationSec: 30, maxDurationSec: 40,
      cover: { title: '收藏夹为什么越攒越重', subtitle: '把一个好点子，变成一次小行动' },
      disclosure: '原创虚构评论；没有声称发生真实互动', sources: [],
      shots: [
        { id: 'opening', speaker: 'fish', scene: 'hook', energy: 'punchy', transition: 'cut', kicker: '一个日常观察', headline: '收藏了，然后呢？', text: '有没有一种可能，你的收藏夹正在替你假装努力？', provenance: 'original-dialogue', source_ids: [] },
        { id: 'contrast', speaker: 'fish', scene: 'compare', energy: 'warm', transition: 'slide', headline: '收藏，不等于学会', items: [{ label: '按下收藏', detail: '给未来的自己留作业' }, { label: '动手一次', detail: '让今天的自己有反馈' }], text: '收藏像给未来的自己留作业。动手试一次，今天就能收到一点反馈。', provenance: 'original-dialogue', source_ids: [] },
        { id: 'closing', speaker: 'fish', scene: 'outro', energy: 'quiet', transition: 'hold', headline: '少存一条，多试一步', body: '打开最想学的那一条，只做第一步。', text: '现在打开最想学的那条，只做第一步。让收藏夹里的一件事真的发生。', provenance: 'original-dialogue', source_ids: [] },
      ],
    },
    sample: {
      schema: PRODUCTION_SCHEMA, mode: 'custom', date: '2026-10-21',
      title: '脑袋也要细嚼慢咽', brief: '虚构的饭桌拌嘴，谈理解比点头慢一点。',
      targetDurationSec: 30, maxDurationSec: 40,
      cover: { title: '脑袋也要细嚼慢咽', subtitle: '大肥鱼与脑内小鱼的原创饭桌短剧' },
      disclosure: '原创虚构评论；没有声称发生真实互动', sources: [],
      shots: [
        { id: 'opening', speaker: 'fish', text: '饭都快凉了，我还在想：听懂一个道理，怎么比点头慢这么多？', camera: 'medium', expression: 'thinking', prop: 'rice', provenance: 'original-dialogue', source_ids: [] },
        { id: 'reply', speaker: 'guigui', text: '点头只用一下脖子。理解得把问题放进脑袋里，嚼一嚼，再看看有没有骨头。', camera: 'reverse', expression: 'question', prop: 'note', provenance: 'original-dialogue', source_ids: [] },
        { id: 'closing', speaker: 'fish', text: '行，那先记下来。饭要趁热吃，问题可以带着慢慢想。', camera: 'close', expression: 'happy', prop: 'rice', provenance: 'original-dialogue', source_ids: [] },
      ],
    },
  }
}

/**
 * Validate authored JSON and return a fresh renderer-compatible plan.
 * Trusted voice/GSV options never come from the authored object.
 * @param {object|string} raw
 * @param {{date?:string,voice?:string|object,gsv?:object}} options
 * @returns {object}
 */
export function normalizeProduction(raw, { date, voice, gsv } = {}) {
  if (typeof raw === 'string') {
    if (raw.length > 100_000) fail('production', 'JSON 过大（最多100000字符）')
    try { raw = JSON.parse(raw) } catch { fail('production', '必须是有效 JSON 对象，不能包含 Markdown 围栏') }
  }
  keys(raw, ['schema', 'theme', 'mode', 'date', 'title', 'brief', 'cover', 'shots', 'sources', 'disclosure', 'coverage', 'targetDurationSec', 'maxDurationSec', 'gap', 'lead', 'tail'], 'production')
  const schema = choice(raw.schema, [EDITORIAL_SCHEMA, LEGACY_SCHEMA], 'production.schema', EDITORIAL_SCHEMA)
  const editorial = schema === EDITORIAL_SCHEMA
  const theme = choice(raw.theme, THEMES, 'production.theme', 'paper')
  const mode = choice(raw.mode, PRODUCTION_MODES, 'production.mode')
  const day = validDate(raw.date === undefined ? (date === undefined ? yesterday() : date) : raw.date, 'production.date')
  if (date !== undefined && validDate(date, 'options.date') !== day) fail('production.date', '与当前制作会话约定的日期不一致')
  const title = text(raw.title, 'production.title', 100)
  const brief = text(raw.brief, 'production.brief', 500, false)
  keys(raw.cover, ['title', 'subtitle', 'hook'], 'production.cover')
  const coverTitle = text(raw.cover.title, 'production.cover.title', 60)
  if (/日报|todo|\bBV[A-Za-z0-9]{8,}\b|\d{4}[-/.年]\d{1,2}|\d{1,2}[-/月]\d{1,2}|[一二两三四五六七八九十]+月|^(?:标题|title|cover|封面|测试|test|待定|待补|未命名|placeholder|unknown|tbd|n\/a)$/iu.test(coverTitle)
      || !/[\u4e00-\u9fffA-Za-z]/u.test(coverTitle)) fail('production.cover.title', '需要具体事件标题，不能用日期、BV号、日报或占位标签')
  const cover = { title: coverTitle, subtitle: text(raw.cover.subtitle, 'production.cover.subtitle', 72, false) }
  if (raw.cover.hook !== undefined) cover.hook = text(raw.cover.hook, 'production.cover.hook', 84, false)
  const hasTargetDuration = raw.targetDurationSec !== undefined
  const targetDurationSec = number(raw.targetDurationSec, 'production.targetDurationSec', 15, 300, 150)
  const maxDurationSec = number(raw.maxDurationSec, 'production.maxDurationSec', targetDurationSec, 300, Math.min(300, Math.ceil(targetDurationSec * 1.1)))
  const gap = number(raw.gap, 'production.gap', 0, 2, .18)
  const lead = number(raw.lead, 'production.lead', 0, 3, .18)
  const tail = number(raw.tail, 'production.tail', 0, 3, .5)
  if (raw.sources !== undefined && (!Array.isArray(raw.sources) || raw.sources.length > 80)) fail('production.sources', '必须是最多80个来源的数组')
  const sourceMap = new Map()
  const sources = (raw.sources || []).map((source, i) => {
    const where = `production.sources[${i}]`
    keys(source, ['id', 'bvid', 'title', 'author', 'url', 'date', 'kind', 'excerpt', 'digest', 'eventId'], where)
    const id = identifier(source.id, `${where}.id`)
    if (sourceMap.has(id)) fail(`${where}.id`, '来源ID重复')
    const bvid = source.bvid === undefined ? '' : text(source.bvid, `${where}.bvid`, 12)
    if (bvid && !BV_RE.test(bvid)) fail(`${where}.bvid`, '必须是有效 BV 号（BV 加10位字母数字）')
    const item = { id, title: text(source.title, `${where}.title`, 160), url: sourceUrl(source.url, bvid, `${where}.url`),
      kind: choice(source.kind, ['public-video', 'public-report-note', 'public-record', 'public-web'], `${where}.kind`, bvid ? 'public-video' : 'public-web') }
    if (bvid) item.bvid = bvid
    for (const [key, limit] of [['author', 80], ['excerpt', 1000], ['eventId', 120]]) {
      if (source[key] !== undefined) item[key] = text(source[key], `${where}.${key}`, limit)
    }
    if (source.digest !== undefined) {
      if (typeof source.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(source.digest)) fail(`${where}.digest`, '必须是小写 SHA256 摘要')
      item.digest = source.digest
    }
    if (source.date !== undefined) item.date = validDate(source.date, `${where}.date`)
    if (mode === 'daily' && item.date !== day) fail(`${where}.date`, 'daily 来源须注明同一天日期；不要把视频发布日期冒充观看记录日期')
    sourceMap.set(id, item)
    return item
  })
  if (!Array.isArray(raw.shots) || raw.shots.length < 1 || raw.shots.length > 40) fail('production.shots', '必须是1..40镜的数组')
  const shotIds = new Set()
  const shots = raw.shots.map((shot, i) => {
    const where = `production.shots[${i}]`
    keys(shot, ['id', 'kind', 'speaker', 'text', 'scene', 'headline', 'kicker', 'body', 'items', 'energy', 'transition', 'camera', 'expression', 'prop', 'props', 'beat', 'pause_after', 'provenance', 'source_ids'], where)
    if (shot.kind !== undefined && shot.kind !== (editorial ? 'editorial' : 'dialogue')) fail(`${where}.kind`, `只支持 ${editorial ? 'editorial' : 'dialogue'}`)
    const id = identifier(shot.id === undefined ? `shot-${i + 1}` : shot.id, `${where}.id`)
    if (shotIds.has(id)) fail(`${where}.id`, '镜头ID重复')
    shotIds.add(id)
    const speaker = choice(shot.speaker, editorial ? ['narrator', 'fish'] : ['fish', 'guigui', 'inner'], `${where}.speaker`, 'fish')
    let prop = shot.prop
    if (shot.props !== undefined) {
      if (prop !== undefined || !Array.isArray(shot.props) || shot.props.length !== 1) fail(`${where}.props`, '只允许一个道具，且不能与 prop 同用')
      prop = shot.props[0]
    }
    if (shot.source_ids !== undefined && (!Array.isArray(shot.source_ids) || shot.source_ids.length > 8)) fail(`${where}.source_ids`, '必须是最多8个来源ID的数组')
    const source_ids = (shot.source_ids || []).map((sid) => {
      identifier(sid, `${where}.source_ids`)
      if (!sourceMap.has(sid)) fail(`${where}.source_ids`, `找不到来源 ${sid}`)
      return sid
    })
    if (new Set(source_ids).size !== source_ids.length) fail(`${where}.source_ids`, '不能重复来源ID')
    const provenance = choice(shot.provenance, PROVENANCE, `${where}.provenance`, source_ids.length ? 'record-adaptation' : 'original-dialogue')
    if (provenance !== 'original-dialogue' && !source_ids.length) fail(`${where}.source_ids`, '来源改编或引用必须给出有效来源ID')
    const line = text(shot.text, `${where}.text`, 84)
    if (provenance === 'source-quote' && !source_ids.some((sid) => sourceMap.get(sid).excerpt?.includes(line))) fail(`${where}.text`, '逐字引用必须存在于对应来源的 excerpt 中')
    const result = { id, kind: editorial ? 'editorial' : 'dialogue', speaker: speaker === 'guigui' ? 'inner' : speaker, text: line,
      camera: choice(shot.camera, CAMERAS, `${where}.camera`, speaker === 'fish' ? 'medium' : 'reverse'),
      expression: choice(shot.expression, EXPRESSIONS, `${where}.expression`, 'neutral'),
      prop: choice(prop, PROPS, `${where}.prop`, 'rice'),
      pause_after: number(shot.pause_after, `${where}.pause_after`, 0, 2, gap), provenance, source_ids }
    if (shot.beat !== undefined) result.beat = text(shot.beat, `${where}.beat`, 60, false)
    if (editorial) {
      result.scene = choice(shot.scene, SCENES, `${where}.scene`, 'headline')
      result.energy = choice(shot.energy, ENERGIES, `${where}.energy`, result.scene === 'hook' ? 'punchy' : result.scene === 'outro' ? 'quiet' : 'warm')
      result.transition = choice(shot.transition, TRANSITIONS, `${where}.transition`, result.energy === 'punchy' ? 'cut' : 'slide')
      result.headline = text(shot.headline, `${where}.headline`, 24)
      result.kicker = text(shot.kicker, `${where}.kicker`, 16, false)
      result.body = text(shot.body, `${where}.body`, 60, false)
      const count = result.scene === 'compare' ? [2, 2] : result.scene === 'steps' ? [2, 4] : [0, 0]
      const items = shot.items === undefined ? [] : shot.items
      if (!Array.isArray(items) || items.length < count[0] || items.length > count[1]) fail(`${where}.items`, `${result.scene} 需要 ${count[0]}..${count[1]} 项`)
      result.items = items.map((item, j) => {
        const field = `${where}.items[${j}]`
        keys(item, ['label', 'detail'], field)
        return { label: text(item.label, `${field}.label`, 12), detail: text(item.detail, `${field}.detail`, 36, false) }
      })
    } else if (speaker !== 'fish') result.voice = { ...INNER_VOICE }
    return result
  })
  if (editorial) {
    const scenes = shots.map((shot) => shot.scene)
    if (scenes[0] !== 'hook') fail('production.shots', 'editorial-v2 第一镜必须是 hook，先抓住观众再展开')
    if (scenes[scenes.length - 1] !== 'outro') fail('production.shots', 'editorial-v2 最后一镜必须是 outro，给观众一个收束')
    const distinct = new Set(scenes).size
    if (distinct < (targetDurationSec < 15 ? 2 : Math.min(3, scenes.length))) fail('production.shots', 'editorial-v2 至少需要两到三种不同场景，避免整条片子像一张海报')
    for (let i = 2; i < scenes.length; i += 1) if (scenes[i] === scenes[i - 1] && scenes[i] === scenes[i - 2]) fail('production.shots', '相邻同场景最多连续两镜，请加入转折或换版式')
  }
  if (mode === 'daily' && (!sources.length || !shots.some((shot) => shot.source_ids.length && shot.provenance !== 'original-dialogue'))) fail('production.sources', 'daily 至少需要一个当天公开来源及引用该来源的镜头；缺素材请先如实说明，不能生成虚构日报')
  const estimate = lead + tail + shots.reduce((sum, shot, i) => sum + Math.max(2, [...shot.text].length / SPEECH_RATE) + (i < shots.length - 1 ? shot.pause_after : 0), 0)
  if (estimate > maxDurationSec) fail('production.shots', `预计 ${estimate.toFixed(2)} 秒，超过 ${maxDurationSec} 秒预算；请自行精简编排，系统不会截断`)
  const minimumDuration = targetDurationSec * MIN_TARGET_DURATION_RATIO
  if (hasTargetDuration && estimate + 1e-9 < minimumDuration) {
    fail('production.shots', `预计 ${estimate.toFixed(2)} 秒，低于目标 ${targetDurationSec} 秒的60%（至少 ${minimumDuration.toFixed(2)} 秒）；请增加有意义的场景和旁白，不能用静态补帧凑时长`)
  }
  const voiceConfig = { ...DEFAULT_VOICE }
  if (typeof voice === 'string') voiceConfig.name = text(voice, 'options.voice', 100)
  else if (voice !== undefined) {
    keys(voice, ['name', 'rate', 'pitch'], 'options.voice')
    for (const key of ['name', 'rate', 'pitch']) if (voice[key] !== undefined) voiceConfig[key] = text(voice[key], `options.voice.${key}`, 100)
  }
  if (gsv !== undefined && gsv !== null) {
    keys(gsv, ['gsvRepo', 'gsvRef', 'gsvPrompt', 'gsvPython', 'gsvSpeed', 'gsvSeed', 'gsvTopK', 'gsvTopP', 'gsvTemp', 'gsvRepPen'], 'options.gsv')
    for (const key of ['gsvRepo', 'gsvRef', 'gsvPrompt']) if (!gsv[key] || typeof gsv[key] !== 'string') fail(`options.gsv.${key}`, '宿主音色配置不完整')
    for (const [key, value] of Object.entries(gsv)) {
      if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) fail(`options.gsv.${key}`, '宿主音色配置无效')
      voiceConfig[key] = value
    }
  }
  const authoredDisclosure = text(raw.disclosure, 'production.disclosure', 120, false)
  const disclosure = `${mode === 'custom' ? '虚构演绎 / 原创评论' : mode === 'daily' ? '据当日公开记录改编' : '原创评论'}${editorial ? '' : ' · 小鱼为虚构内心角色'}${authoredDisclosure ? ` · ${authoredDisclosure}` : ''}`
  return { schema, ...(editorial ? { theme } : {}), mode, date: day, title, brief, cover, targetDurationSec, maxDurationSec,
    estimatedDurationSec: Math.round(estimate * 1000) / 1000, voice: voiceConfig, gap, lead, tail,
    disclosure, coverage: text(raw.coverage, 'production.coverage', 300, false) || '仅公开来源与原创对白；不含私信、账号归属、联系方式或凭证。', sources, shots }
}
