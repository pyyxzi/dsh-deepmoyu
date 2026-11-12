/** Explicit viewing preferences. Topics guide discovery; exclusions never grant tool permissions. */
export const BROWSE_TOPICS = Object.freeze(['科技', '知识', '生活', '美食', '游戏', '动画', '音乐', '影视', '动物', '运动', '旅行'])
export const BROWSE_DEFAULTS = Object.freeze({
  browseTopics: Object.freeze([]), browseAvoidKeywords: Object.freeze([]), browseExplorePercent: 25,
  browseMinMinutes: 0, browseMaxMinutes: 0, browseRecentDays: 7, browseSort: 'click', browseMinViews: 50_000,
})
export const BROWSE_LIMITS = Object.freeze({
  browseExplorePercent: [0, 100], browseMinMinutes: [0, 1440], browseMaxMinutes: [0, 1440], browseRecentDays: [0, 365], browseMinViews: [0, 2_000_000_000],
})
const SORTS = ['mixed', 'pubdate', 'click', 'totalrank']
const own = (object, key) => Object.hasOwn(object || {}, key)
const phrases = value => Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))].slice(0, 30).map(item => item.slice(0, 80)) : []
const invalid = message => Object.assign(new Error(message), { status: 400, code: 'CONFIG_INPUT' })

/** Tolerate old persisted values on read; explicit writes go through validateBrowsePatch first. */
export function clampBrowseSettings(patch = {}) {
  const out = { ...patch }
  if (own(out, 'browseTopics')) out.browseTopics = phrases(out.browseTopics).filter(topic => BROWSE_TOPICS.includes(topic))
  if (own(out, 'browseAvoidKeywords')) out.browseAvoidKeywords = phrases(out.browseAvoidKeywords)
  if (own(out, 'browseSort')) out.browseSort = SORTS.includes(out.browseSort) ? out.browseSort : BROWSE_DEFAULTS.browseSort
  for (const [key, [lo, hi]] of Object.entries(BROWSE_LIMITS)) if (own(out, key)) {
    const n = Number(out[key])
    out[key] = Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : BROWSE_DEFAULTS[key]
  }
  return out
}

/** Validate against the current durable config inside its write lock as well as at the API boundary. */
export function validateBrowsePatch(patch = {}, current = {}) {
  for (const key of ['browseTopics', 'browseAvoidKeywords']) if (own(patch, key)) {
    if (!Array.isArray(patch[key]) || patch[key].length > 30 || patch[key].some(item => typeof item !== 'string' || !item.trim() || item.length > 80 || /[\r\n\x00-\x1f]/.test(item))) {
      throw invalid(key + ' 需要最多 30 个非空短词，每个不超过 80 字')
    }
    if (key === 'browseTopics' && patch[key].some(topic => !BROWSE_TOPICS.includes(topic.trim()))) throw invalid('视频类别包含未知选项')
  }
  if (own(patch, 'browseSort') && !SORTS.includes(patch.browseSort)) throw invalid('视频排序需要选择综合探索、最新、播放量或平台综合')
  for (const [key, [lo, hi]] of Object.entries(BROWSE_LIMITS)) if (own(patch, key)) {
    if (typeof patch[key] !== 'number' || !Number.isSafeInteger(patch[key]) || patch[key] < lo || patch[key] > hi) throw invalid(`${key} 需要 ${lo} 至 ${hi} 之间的整数`)
  }
  if (own(patch, 'browseMinMinutes') || own(patch, 'browseMaxMinutes')) {
    const cfg = { ...BROWSE_DEFAULTS, ...clampBrowseSettings(current), ...patch }
    if (cfg.browseMaxMinutes > 0 && cfg.browseMinMinutes > cfg.browseMaxMinutes) throw invalid('视频最短时长不能大于最长时长；最长填 0 表示不限')
  }
  return patch
}

export function browseSettings(source = {}) {
  const cfg = { ...BROWSE_DEFAULTS, ...clampBrowseSettings(source) }
  // Historical hand-edited config can have reversed bounds; do not silently exclude every candidate.
  if (cfg.browseMaxMinutes > 0 && cfg.browseMinMinutes > cfg.browseMaxMinutes) cfg.browseMaxMinutes = cfg.browseMinMinutes
  return Object.fromEntries(Object.keys(BROWSE_DEFAULTS).map(key => [key, Array.isArray(cfg[key]) ? [...cfg[key]] : cfg[key]]))
}

/** A fresh snapshot has no shared arrays with a later settings edit. */
export function snapshotBrowseSettings(source = {}) {
  const snapshot = { ...browseSettings(source), keywords: phrases(source.keywords) }
  Object.freeze(snapshot.browseTopics); Object.freeze(snapshot.browseAvoidKeywords); Object.freeze(snapshot.keywords)
  return Object.freeze(snapshot)
}

export function browsePreferenceBrief(source = {}) {
  const cfg = browseSettings(source), keywords = phrases(source.keywords)
  return [
    `【刷片偏好】类别：${cfg.browseTopics.join('、') || '随兴趣'}；喜欢的词：${keywords.join('、') || '随兴趣'}。`,
    `发布时间：${cfg.browseRecentDays ? `最近 ${cfg.browseRecentDays} 天` : '不限，旧片也可以'}；时长：${cfg.browseMinMinutes ? `至少 ${cfg.browseMinMinutes} 分钟` : '无下限'}，${cfg.browseMaxMinutes ? `最多 ${cfg.browseMaxMinutes} 分钟` : '无上限'}。`,
    `排序：${({ mixed: '兼顾兴趣与新鲜感', pubdate: '最新优先', click: '播放量优先', totalrank: '保持平台综合顺序' })[cfg.browseSort]}；约 ${cfg.browseExplorePercent}% 的探索机会留给平时少看的内容，这是倾向，不是逐条打卡配额。`,
    `热度：${cfg.browseMinViews ? `播放量至少 ${cfg.browseMinViews.toLocaleString('en-US')}；优先热门榜与高播放的新候选` : '不设最低播放量'}。播放量未知先用 bili_video_info 核对，不能把未知当热门；低于门槛就换片，不为凑候选降低门槛。`,
    `避开关键词：${cfg.browseAvoidKeywords.join('、') || '未设置'}。类别和喜欢词用来挑方向，不要求条条命中；日期、时长或热度缺失先读视频详情核对，不把未知当不合格。候选不足先换来源或关键词，不擅自放宽本人设定。`,
  ].join('\n')
}

export function videoDurationSeconds(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null
  if (typeof value !== 'string' || !value.trim()) return null
  const text = value.trim()
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) > 0 ? Number(text) : null
  if (!/^\d+:\d{2}(?::\d{2})?$/.test(text)) return null
  const parts = text.split(':').map(Number)
  if (parts.slice(1).some(part => part >= 60)) return null
  const seconds = parts.reduce((total, part) => total * 60 + part, 0)
  return seconds > 0 ? seconds : null
}
const publication = row => {
  const value = Number(row?.pubdate ?? row?.created)
  if (Number.isFinite(value) && value > 0) return value < 100_000_000_000 ? value * 1000 : value
  if (typeof row?.pubdate_str === 'string' && /^\d{4}-\d{2}-\d{2}/.test(row.pubdate_str)) {
    const date = Date.parse(row.pubdate_str)
    if (Number.isFinite(date)) return date
  }
  return null
}
const topicAliases = {
  科技: ['科技', '数码', '计算机', '人工智能', 'deepseek', 'ai'], 知识: ['知识', '科普', '历史', '科学', '人文', '社科'],
  生活: ['生活', '日常', '家居', '手工'], 美食: ['美食', '做饭', '料理', '烹饪', '吃播'], 游戏: ['游戏', '电竞', '单机', '手游'],
  动画: ['动画', '动漫', '番剧', '二次元'], 音乐: ['音乐', '歌曲', '演奏', '翻唱'], 影视: ['影视', '电影', '电视剧', '影评'],
  动物: ['动物', '宠物', '猫', '狗', '萌宠'], 运动: ['运动', '健身', '体育', '篮球', '足球'], 旅行: ['旅行', '旅游', '风景', '探店'],
}
const readable = value => String(value ?? '').replace(/<[^>]*>/g, '').toLowerCase()
const textOf = row => [row.title, row.description, row.tname, row.category, row.author].map(readable).join(' ')
/** Public APIs use both exact numbers and abbreviated display counts. Zero is known, not missing. */
export function videoViewCount(row) {
  for (const raw of [row?.play, row?.stat?.view, row?.view, row?.views]) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.floor(raw)
    if (typeof raw !== 'string') continue
    const text = raw.trim().replace(/[,，\s]/g, '')
    const match = /^(\d+(?:\.\d+)?)(万|亿|[wWkKmM])?(?:次(?:播放)?|播放)?$/.exec(text)
    if (!match) continue
    const multiplier = ({ 万: 1e4, 亿: 1e8, w: 1e4, W: 1e4, k: 1e3, K: 1e3, m: 1e6, M: 1e6 })[match[2]] || 1
    const count = Number(match[1]) * multiplier
    if (Number.isFinite(count)) return Math.floor(count)
  }
  return null
}

/** All discovery sources share the same filters. Unknown metadata remains visible with a verification hint. */
export function filterBrowseCandidates(rows = [], source = {}, { now = Date.now() } = {}) {
  const cfg = browseSettings(source), keywords = phrases(source.keywords).map(readable)
  const excluded = [], unknown = [], candidates = []
  const cutoff = now - cfg.browseRecentDays * 86400_000
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object') continue
    const text = textOf(row), seconds = videoDurationSeconds(row.duration ?? row.length), published = publication(row), viewCount = videoViewCount(row)
    const avoid = cfg.browseAvoidKeywords.find(word => text.includes(readable(word)))
    const reason = avoid ? `避开关键词：${avoid}`
      : seconds !== null && cfg.browseMinMinutes > 0 && seconds < cfg.browseMinMinutes * 60 ? '短于设置的最短时长'
        : seconds !== null && cfg.browseMaxMinutes > 0 && seconds > cfg.browseMaxMinutes * 60 ? '长于设置的最长时长'
          : published !== null && cfg.browseRecentDays > 0 && published < cutoff ? '超出设置的发布时间范围'
            : viewCount !== null && viewCount < cfg.browseMinViews ? '低于设置的最低播放量' : ''
    if (reason) { excluded.push({ bvid: row.bvid || '', reason }); continue }
    const check = []
    if (seconds === null && (cfg.browseMinMinutes || cfg.browseMaxMinutes)) check.push('duration')
    if (published === null && cfg.browseRecentDays) check.push('pubdate')
    if (viewCount === null && cfg.browseMinViews) check.push('views')
    if (check.length) unknown.push({ bvid: row.bvid || '', fields: check })
    const topicHits = cfg.browseTopics.filter(topic => topicAliases[topic].some(word => text.includes(word.toLowerCase())))
    const keywordHits = keywords.filter(word => text.includes(word))
    candidates.push({ row: { ...row, ...(viewCount !== null ? { view_count: viewCount } : {}), ...(check.length ? { preference_check: check, preference_hint: '日期、时长或播放量缺失，挑选前先读 bili_video_info 核对' } : {}) }, index, published, affinity: topicHits.length + keywordHits.length * 2 })
  }
  const compare = cfg.browseSort === 'pubdate' ? (a, b) => (b.published || 0) - (a.published || 0) || a.index - b.index
    : cfg.browseSort === 'click' ? (a, b) => (videoViewCount(b.row) ?? -1) - (videoViewCount(a.row) ?? -1) || a.index - b.index
      : (a, b) => a.index - b.index
  let ordered = candidates.slice().sort(compare)
  if (cfg.browseSort === 'mixed' && (cfg.browseTopics.length || keywords.length)) {
    const preferred = ordered.filter(item => item.affinity > 0).sort((a, b) => b.affinity - a.affinity || a.index - b.index)
    const exploring = ordered.filter(item => item.affinity === 0)
    ordered = []
    let p = 0, e = 0
    for (let index = 0; index < candidates.length; index++) {
      const explorationSlot = Math.floor((index + 1) * cfg.browseExplorePercent / 100) > Math.floor(index * cfg.browseExplorePercent / 100)
      ordered.push(explorationSlot && e < exploring.length || p >= preferred.length ? exploring[e++] : preferred[p++])
    }
  }
  return { items: ordered.map(item => item.row), excluded, unknown, settings: cfg }
}
