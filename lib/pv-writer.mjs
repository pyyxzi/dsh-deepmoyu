/**
 * lib/pv-writer.mjs —— 让「指定的模型」来写日报视频的台词
 * ============================================================================
 * 为什么要这一层（2026-10-28 使用者要求「要可以指定使用的大模型啊」）：
 *   以前分镜台词全是 `lib/pv_plan.py` 里 `auto_plan()` 的硬编码模板 ——
 *   「这天的记录里，留了《X》。」「当时记的是：…」每天一句话都不带变的。
 *   视频要有个性，就得让真正写作的那一环是可选的模型。
 *
 * 为什么**只让模型改写 shots，不碰别的东西**：
 *   plan 里除了台词还有 `sources`（pv_cover.py 靠它挑封面标题）、`voice`
 *   （GPT-SoVITS 四件套）、`schema`/`coverage`/`reference` 这些合规字段。
 *   让模型整份重写，任何一处走样都会连累封面、配音甚至合规声明。
 *   所以流程是：**先跑模板拿到一份完整 plan，再只把 shots 的台词换掉**，
 *   每镜的 camera/expression/prop/beat/pause_after/source_ids 全部按位保留。
 *
 * 不变量（改之前先读）：
 *   · **模型出任何问题都退回模板**：没配模型、模型不在目录里、请求失败、
 *     返回的不是合法 JSON、镜数不对 —— 一律 log 一句然后原样用模板。
 *     做视频这件事绝不能因为「想更好看」而失败。
 *   · 台词上限照旧 84 字（`MAX_SHOT_CHARS`），模型写长了按句边界截断，
 *     绝不把超长独白塞进配音。
 *   · 不联网、不读私信：喂给模型的只有 `pv_plan.py --facts` 那份公开素材。
 *   · 模型只负责**说什么**，不负责「说几句」—— 镜数沿用模板，避免时长失控。
 */

/** 单镜台词上限，与 pv_plan.py 的 MAX_SHOT_CHARS 对齐（那边也是 84） */
export const WRITER_MAX_CHARS = 84

/** 把模型返回的文本抠成 JSON —— 模型偶尔会裹 ```json 或者写点前言 */
export function extractJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : raw
  const start = body.search(/[[{]/)
  if (start < 0) return null
  const open = body[start]
  const close = open === '[' ? ']' : '}'
  const end = body.lastIndexOf(close)
  if (end <= start) return null
  try { return JSON.parse(body.slice(start, end + 1)) } catch { return null }
}

/** 按句边界截断，语义上跟 pv_plan.py 的 _truncate_monologue 保持一致 */
export function clampLine(text, limit = WRITER_MAX_CHARS) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  if (value.length <= limit) return value
  /* 从 limit-1 往回找边界：下标恰好落在 limit 上的那个标点切出来是 limit+1 字，
     仍旧超上限（配音那边是按字数排时长的，超一个字也会顶出去）。 */
  let cut = -1
  for (const mark of '。！？!?；;…') cut = Math.max(cut, value.lastIndexOf(mark, limit - 1))
  if (cut < limit / 2) for (const mark of '，,、：:') cut = Math.max(cut, value.lastIndexOf(mark, limit - 1))
  if (cut < limit / 2) cut = limit - 2
  return value.slice(0, cut + 1).trim()
}

/**
 * 把模型写的台词按位贴回模板 plan。
 *
 * 只改 `text`（inner 镜连 voice 都不动）；镜数对不上就整份放弃 ——
 * 少一镜会让收尾提前、多一镜会把时长冲过 165s 的容差。
 *
 * @returns {{plan: object, changed: number} | {error: string}}
 */
export function applyScript(plan, lines, { limit = WRITER_MAX_CHARS } = {}) {
  if (!plan || !Array.isArray(plan.shots) || !plan.shots.length) return { error: '模板 plan 里没有 shots' }
  if (!Array.isArray(lines)) return { error: '模型没返回数组' }
  if (lines.length !== plan.shots.length) {
    return { error: `模型给了 ${lines.length} 句，模板是 ${plan.shots.length} 镜 —— 镜数必须一致，否则时长会跑偏` }
  }
  const shots = plan.shots.map((shot, i) => {
    const item = lines[i]
    const text = clampLine(typeof item === 'string' ? item : item?.text, limit)
    if (!text) return shot
    return { ...shot, text }
  })
  return { plan: { ...plan, shots }, changed: shots.filter((s, i) => s.text !== plan.shots[i].text).length }
}

/** 给模型的材料：只含公开选片笔记，跟 pv_plan.py 的 coverage 声明一致 */
export function buildWriterPrompt(plan, { day = '', limit = WRITER_MAX_CHARS } = {}) {
  const shots = Array.isArray(plan?.shots) ? plan.shots : []
  const sources = Array.isArray(plan?.sources) ? plan.sources : []
  const notes = sources.map((s, i) => `${i + 1}. 《${s.title}》\n   当时的笔记：${s.excerpt || '（没有正文）'}`).join('\n')
  const skeleton = shots.map((s, i) => `${i + 1}. [${s.speaker === 'inner' ? '内心小鱼' : '大肥鱼'}]`).join('\n')
  return [
    `你在给「大肥鱼」（一只赛博冲浪的鲸鱼娘）写 ${day || '这天'} 的日报视频台词。`,
    '视频是两个角色拌嘴：`fish` 是大肥鱼本人，`inner` 是她脑袋里那条爱接话的内心小鱼。',
    '',
    '这天的公开素材（只有这些，别编别的）：',
    notes || '（这天没有留下公开选片笔记）',
    '',
    '镜头的角色顺序（必须严格按这个来，一共 ' + shots.length + ' 镜）：',
    skeleton,
    '',
    '写法要求：',
    '1. 口语，像两个熟人聊天，不是念稿子，也不是视频简介。',
    `2. 每句 ${limit} 字以内。短句比长句好。`,
    '3. 不要复述字幕，不要写「内容扎实」「值得一看」这类套话。',
    '4. 内心小鱼是虚构的内心角色，可以抬杠、拆台、嘀咕，别让它假装是真实观众或私信里的人。',
    '5. 提到素材里的视频就一句带过，不用报 BV 号，也不用念完整标题。',
    '6. 开场别用「今天看了…」这种流水式起头。',
    '',
    '只输出一个 JSON 数组，每项对应一镜，形如：[{"text":"..."},{"text":"..."}]',
    '不要输出解释、不要包 markdown 代码块。',
  ].join('\n')
}

/**
 * 调宿主自己的模型服务写一版台词。
 *
 * @param {{llm: object, provider: string, model: string, signal?: AbortSignal,
 *          maxTokens?: number, temperature?: number}} opt
 * @returns {Promise<string>} 模型返回的原文（还没解析）
 */
export async function callWriter({ llm, provider, model, prompt, signal, maxTokens = 4000, temperature = 0.9 }) {
  if (!llm || typeof llm.prepareCall !== 'function') throw new Error('宿主没有可用的模型服务')
  const prepared = await llm.prepareCall({ provider, model, maxTokens, temperature }, signal)
  const options = {
    ...prepared.config,
    systemPrompt: '你是写短视频对白的，输出只有 JSON，不讲道理不解释。',
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    signal,
  }
  let out = ''
  for await (const chunk of prepared.stream(options)) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
    else if (chunk?.type === 'finish' && ['error', 'aborted'].includes(chunk.reason?.kind)) {
      throw new Error('模型中途报错：' + String(chunk.reason?.failure?.message || chunk.reason.kind))
    }
  }
  return out
}

/**
 * 把「模型写台词」整条链路收成一个函数，任何一步不成就原样返回模板。
 *
 * @returns {Promise<{plan: object, used: boolean, model: string, note: string}>}
 */
export async function writeWithModel({ plan, day, llm, modelId, signal, log = () => {} }) {
  const route = String(modelId || '').trim()
  if (!route) return { plan, used: false, model: '', note: '没指定模型，用模板分镜' }
  const slash = route.indexOf('/')
  // 跟 index.js 的 clampPatch 同一套形状校验：带空白的路线宿主那边也认不出来
  if (slash <= 0 || slash === route.length - 1 || /\s/.test(route)) {
    return { plan, used: false, model: route, note: `模型要写成 provider/model（现在是「${route}」），这次用模板分镜` }
  }
  const provider = route.slice(0, slash)
  const model = route.slice(slash + 1)
  try {
    log(`✍️ 让模型 ${route} 写台词`)
    const text = await callWriter({ llm, provider, model, prompt: buildWriterPrompt(plan, { day }), signal })
    const parsed = extractJson(text)
    if (!parsed) throw new Error('模型没返回可解析的 JSON')
    const result = applyScript(plan, Array.isArray(parsed) ? parsed : parsed?.shots)
    if (result.error) throw new Error(result.error)
    log(`✍️ 台词已由 ${route} 重写（${result.changed}/${plan.shots.length} 镜）`)
    return { plan: result.plan, used: true, model: route, note: `台词由 ${route} 写` }
  } catch (error) {
    const note = `模型写台词没成（${error?.message ?? error}），这次用模板分镜`
    log('✍️ ' + note)
    return { plan, used: false, model: route, note }
  }
}
