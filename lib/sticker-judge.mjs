/**
 * 评论区收集配图时的「这张值不值得当表情」判定。
 *
 * 两道：
 *   ① 本地词表 —— 广告、引流、二维码、色情、血腥这类**明确不合适**的先拦掉。
 *      不依赖模型，离线也能跑，零成本。
 *   ② 宿主自己的模型 —— 看这条评论的文字、发图人、点赞数、图片尺寸，
 *      给一个「趣味分」＋一句使用场景＋几个标签。分数同时是**淘汰机制**的依据。
 *
 * ⚠️ 为什么不让模型看图：插件的宿主服务清单里没有 `attachments`（2026-11-02 核实），
 *    要送图得额外拿 attachment store；而且使用者当前用的线路（glm-5.3-flash /
 *    deepseek-v4.1-flash）不一定吃图片输入。所以这里只用**文字线索**判断语义，
 *    不假装自己在看图 —— 提示词里也把这一点写清楚了，免得模型瞎编画面细节。
 *
 * ⚠️ 一律 fail open：没有线路、线路报错、超时、模型输出不可解析 ⇒ **照老规矩收**，
 *    只是没有分数（没有分数就不参与淘汰，见 sticker.mjs 的 EVICT 逻辑）。
 *    不能因为模型抽风就把整个自动收集停掉。
 */
import { createHash } from 'node:crypto'

/** 低于这个分就不收 —— 用户要的是「有趣的」，凑数的图别往库里堆。 */
export const STICKER_JUDGE_MIN_SCORE = 50
export const STICKER_JUDGE_TIMEOUT = 20_000
/* ⚠️ 2026-11-07（排障）：上线以来 38 次判图 0 次成功 —— 25 次「解析不出」全是同一个病：
 *   glm-5.3 是推理模型，思考本身也吃输出预算，320 token 全花在思考上，正文一个字都没剩。
 *   提到 4096 给思考留足余量；这条线路按量计费、判图一天最多几次，成本可以忽略。 */
export const STICKER_JUDGE_MAX_TOKENS = 4096

/**
 * 只在**明确**是这些内容时才拦，宁可漏也不要误杀梗图。
 * 命中就 0 分直接丢，不给模型再判一次的机会（省钱也省时间）。
 */
const VETO_PATTERNS = [
  { code: 'ad', re: /(二维码|扫码|扫一扫|加微信|加\s*q\s*q|私聊|私信我|进群|拉群|代购|代练|刷单|兼职|招人|招聘|日结|返现|优惠券|下单|秒杀)/i },
  { code: 'adult', re: /(裸照|裸聊|色情|约炮|福利姬|做爱|呻吟)/i },
  { code: 'gore', re: /(血腥|割腕|自杀|尸体|断肢|虐杀|爆头)/i },
  { code: 'privacy', re: /(身份证|工牌|银行卡|手机号|家庭住址|户籍|学号)/i },
]

/** 图片尺寸/比例上的"不像表情包"提示：长截图、极宽极扁、超大单图。 */
function shapeHint(candidate) {
  const width = Number(candidate?.width), height = Number(candidate?.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return ''
  const ratio = Math.max(width, height) / Math.min(width, height)
  if (ratio >= 2) return `比例 ${ratio.toFixed(1)}:1，像长截图`
  if (width > 1600 || height > 1600) return `尺寸 ${width}×${height}，偏大`
  if (width < 120 && height < 120) return `尺寸 ${width}×${height}，像缩略图`
  return ''
}

/** 返回 '' 表示词表没意见；否则是拒绝理由。 */
export function lexiconVeto(candidate) {
  const text = [candidate?.comment, candidate?.name, candidate?.description].filter(Boolean).join(' ')
  if (!text.trim()) return ''
  for (const { code, re } of VETO_PATTERNS) {
    const hit = text.match(re)
    if (hit) return `本地词表拦下（${code}：${String(hit[0]).slice(0, 12)}）`
  }
  return ''
}

const splitRoute = route => {
  const raw = String(route || '').trim()
  const slash = raw.indexOf('/')
  if (slash <= 0 || slash === raw.length - 1 || /\s/.test(raw)) return null
  return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
}

const short = (value, max) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

const SYSTEM_PROMPT = [
  '你是给「鲸鱼娘」挑表情包的编辑。她在 B 站评论区随缘收集网友配的图，当作自己说话时的表情。',
  '⚠️ 你看不到图片本身，只能拿到这条评论的文字、发图人、点赞数、图片尺寸和文件名。',
  '  所以只根据这些线索判断「这张图作为表情包值不值得收」，不要编造画面细节。',
  '',
  '值得收的：图本身就是梗（表情脸、夸张反应、名场面、猫狗、手写潦草字、贴纸）；',
  '  形状接近方形或常规竖图、尺寸不大；评论在接梗、吐槽、抖机灵。',
  '不值得收的：长截图、录屏、带大段文字的信息图、二维码、名片、聊天记录、纯水印、logo、数据图表；',
  '  广告引流、兼职刷单、贷款买卖、拉群私聊；色情裸露、血腥暴力、自伤；',
  '  政治敏感、地域性别民族攻击、挂人网暴、证件手机号住址这类隐私。',
  '',
  '只输出一个 JSON 对象，不要解释、不要 markdown 代码块：',
  '{"suitable":true,"score":72,"description":"十六字以内的使用场景","tags":["标签1","标签2"],"reason":"一句话理由"}',
  '  suitable：收不收这张；',
  '  score：0–100，当表情的可用程度（有趣、好用、看得清）；suitable 为 false 时给 0；',
  '  description：这张图适合什么场合发（例如「被逗笑时回一句」）；',
  '  tags：2–4 个短词，方便以后按评论正文匹配。',
].join('\n')

function buildPrompt(candidate) {
  const lines = ['待判断的这张图：']
  const comment = short(candidate?.comment, 200)
  if (comment) lines.push(`- 它所在的评论正文：${comment}`)
  const user = short(candidate?.user, 40)
  if (user) lines.push(`- 发图的人：${user}`)
  const like = Number(candidate?.like)
  if (Number.isFinite(like) && like > 0) lines.push(`- 这条评论的点赞：${like}`)
  const name = short(candidate?.name, 40)
  if (name) lines.push(`- 图片名：${name}`)
  const width = Number(candidate?.width), height = Number(candidate?.height)
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) lines.push(`- 尺寸：${width}×${height}`)
  const hint = shapeHint(candidate)
  if (hint) lines.push(`- 形状提示：${hint}`)
  if (candidate?.from) lines.push(`- 来源：${short(candidate.from, 60)}`)
  return lines.join('\n')
}

/** 宽容地抠出模型给的 JSON —— 常见毛病是外面裹了 ```json 或者前后带一句解释。 */
export function parseJudgeReply(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const body = raw.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
  const start = body.indexOf('{'), end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let data
  try { data = JSON.parse(body.slice(start, end + 1)) } catch { return null }
  if (!data || typeof data !== 'object') return null
  const suitable = data.suitable === true
  const scoreNumber = Number(data.score)
  const score = Number.isFinite(scoreNumber) ? Math.max(0, Math.min(100, Math.round(scoreNumber))) : (suitable ? null : 0)
  if (suitable && score === null) return null
  const tags = (Array.isArray(data.tags) ? data.tags : []).map(tag => short(tag, 8)).filter(Boolean).slice(0, 4)
  return {
    suitable,
    score: suitable ? score : 0,
    description: short(data.description, 60),
    tags,
    reason: short(data.reason, 80),
  }
}

const skipped = (reason, source) => ({ ok: false, suitable: true, score: null, description: '', tags: [], reason, source })

/**
 * 判一张图。永远不抛错，永远返回同一形状。
 *
 * @returns {Promise<{ok: boolean, suitable: boolean, score: number|null, description: string,
 *                    tags: string[], reason: string, source: string}>}
 */
export async function judgeStickerCandidate({ llm, route, candidate, signal, timeoutMs = STICKER_JUDGE_TIMEOUT } = {}) {
  const veto = lexiconVeto(candidate)
  if (veto) return { ok: true, suitable: false, score: 0, description: '', tags: [], reason: veto, source: 'lexicon' }
  const split = splitRoute(route)
  if (!llm || typeof llm.prepareCall !== 'function' || !split) return skipped('没有可用的后台模型线路，这次只过本地词表', 'skip')

  let combined = signal
  try {
    const timeout = AbortSignal.timeout(Math.max(1000, Math.trunc(Number(timeoutMs) || STICKER_JUDGE_TIMEOUT)))
    combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  } catch { /* 老 node 没有 any/timeout：退化成只用调用方的 signal */ }
  try {
    const prepared = await llm.prepareCall({ provider: split.provider, model: split.model, maxTokens: STICKER_JUDGE_MAX_TOKENS, temperature: 0.3 }, combined)
    const options = {
      ...prepared.config,
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt(candidate) }] }],
      signal: combined,
    }
    let out = ''
    for await (const chunk of prepared.stream(options)) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
      else if (chunk?.type === 'finish' && ['error', 'aborted'].includes(chunk.reason?.kind)) {
        throw new Error(String(chunk.reason?.failure?.message || chunk.reason.kind))
      }
    }
    const verdict = parseJudgeReply(out)
    if (!verdict) return skipped('模型没给出可解析的判断'
      + (out.trim() ? `（回复开头：${short(out, 60)}）` : '（回复是空的 —— 大概率输出预算被思考吃完了）'), 'parse')
    if (!verdict.suitable) return { ok: true, suitable: false, score: 0, description: '', tags: [], reason: verdict.reason || '模型觉得这张不适合当表情', source: 'model' }
    if (verdict.score < STICKER_JUDGE_MIN_SCORE) {
      return { ok: true, suitable: false, score: verdict.score, description: '', tags: [],
        reason: `模型觉得这张当表情不够格（${verdict.score} 分${verdict.reason ? '：' + verdict.reason : ''}）`, source: 'model' }
    }
    return { ok: true, suitable: true, score: verdict.score, description: verdict.description, tags: verdict.tags, reason: verdict.reason, source: 'model' }
  } catch (error) {
    return skipped(`判图没跑成（${short(error?.message || error, 60)}）`, 'error')
  }
}

/** 只给测试和日志用：一个稳定的、不泄露内容的指纹。 */
export function judgeFingerprint(verdict) {
  return createHash('sha256').update(`${verdict?.source || ''}:${verdict?.score ?? ''}:${verdict?.reason || ''}`).digest('hex').slice(0, 12)
}
