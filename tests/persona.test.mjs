import test from 'node:test'
import assert from 'node:assert/strict'
import { DAFEIYU_DEFAULT_PERSONA, DAFEIYU_SHARED_STYLE_GUIDE, DAFEIYU_REPLY_GUIDE, DAFEIYU_REPLY_STYLE_RULES, DAFEIYU_MOMENT_GUIDE, momentStyleHint } from '../lib/persona.mjs'
import { CHARACTER_COMPASS, characterPrompt } from '../lib/mode.mjs'
import { buildFeiyuObjective, buildLiveBrief, MOMENT_OPENING_KEEP } from '../lib/prompts.mjs'
import { learnAdd, learnDecide, learnInject } from '../lib/learn.mjs'

const base = {
  cfg: { keywords: [], perDay: 5, momentPerDay: 1, dmMode: 'off', autoComment: true, replyToComments: true, autoReplyDm: false, autoMoment: false, reportLevel: 'brief' },
  stateDir: 'C:/fixture/bili-duty',
  outDir: 'C:/fixture/bili-duty/out',
  digestDir: 'C:/fixture/bili-duty/digest',
  charter: 'C:/fixture/bili-duty/duty.md',
  day: '2026-10-27',
}

test('one bounded default persona describes the lively fish without supplying repeatable lines', () => {
  const chineseLength = [...DAFEIYU_DEFAULT_PERSONA].filter(char => /\p{Script=Han}/u.test(char)).length
  assert.ok(chineseLength >= 150 && chineseLength <= 230)
  assert.match(DAFEIYU_DEFAULT_PERSONA, /你是大肥鱼.*鲸鱼摸鱼.*鲸鱼娘/)
  assert.match(DAFEIYU_DEFAULT_PERSONA, /聪明、贪吃、爱面子.*嘴硬心软.*小脾气/)
  assert.match(DAFEIYU_DEFAULT_PERSONA, /像朋友混群聊天.*几字短梗.*不凑长度/)
  assert.match(DAFEIYU_DEFAULT_PERSONA, /轻怼、认真关心.*不演固定的可爱收尾/)
  assert.match(DAFEIYU_DEFAULT_PERSONA, /梗懂且贴语境才玩.*热评学节奏不抄句/)
  assert.match(DAFEIYU_DEFAULT_PERSONA, /严肃问题就认真展开.*记忆相关才自然带一句.*不都叫主人/)
  assert.doesNotMatch(DAFEIYU_DEFAULT_PERSONA, /示例[:：]|例如写|可以这样说|照着写|「[^」]+。」/)
  assert.doesNotMatch(DAFEIYU_DEFAULT_PERSONA, /授权|判重|风控|工具|配额/)
})

test('shared style permits warm pushback and serious answers while keeping casual chat unstructured', () => {
  assert.ok(DAFEIYU_REPLY_GUIDE.includes(DAFEIYU_SHARED_STYLE_GUIDE))
  assert.match(DAFEIYU_SHARED_STYLE_GUIDE, /几字、一句、短梗或笑一下.*不必补细节、解释笑点/)
  assert.match(DAFEIYU_SHARED_STYLE_GUIDE, /默认不总结、不分点、不说教/)
  assert.match(DAFEIYU_SHARED_STYLE_GUIDE, /认真求助和严肃问题正常认真答.*展开或结构化/)
  assert.match(DAFEIYU_SHARED_STYLE_GUIDE, /嫌弃、反问、轻怼.*心软、认错/)
  assert.match(DAFEIYU_SHARED_STYLE_GUIDE, /不恶毒追骂.*不把群友、朋友全当主人/)
  assert.match(DAFEIYU_SHARED_STYLE_GUIDE, /从热评学节奏、反差和省略，不抄原句/)
  for (const rule of ['noSummaryByDefault', 'noListsByDefault', 'noLecturingByDefault',
    'seriousQuestionsCanBeStructured', 'lightPushback', 'noMaliciousHarassment']) {
    assert.equal(DAFEIYU_REPLY_STYLE_RULES[rule], true, rule)
  }
})

test('persona guide encodes natural, content-first fish replies without a catchphrase recipe', () => {
  assert.match(DAFEIYU_REPLY_GUIDE, /客服/)
  assert.match(DAFEIYU_REPLY_GUIDE, /固定口癖/)
  assert.match(DAFEIYU_REPLY_GUIDE, /不要求具体细节加反应/)
  assert.match(DAFEIYU_REPLY_GUIDE, /不默认追问.*不把一句玩笑展开成认真分析/)
  assert.doesNotMatch(DAFEIYU_REPLY_GUIDE, /先接住.*再说自己的反应|通常一两句|情绪有触发点和轻重/)
  assert.equal(DAFEIYU_REPLY_STYLE_RULES.short, true)
  assert.equal(DAFEIYU_REPLY_STYLE_RULES.contentFirst, true)
  assert.equal(DAFEIYU_REPLY_STYLE_RULES.variableSelfReference, true)
  assert.equal(DAFEIYU_REPLY_STYLE_RULES.variableEmotion, true)
  assert.equal(DAFEIYU_REPLY_STYLE_RULES.noCustomerServiceTone, true)
  assert.equal(DAFEIYU_REPLY_STYLE_RULES.noFixedCatchphrase, true)
  assert.equal(DAFEIYU_REPLY_STYLE_RULES.maxKaomojiPerSentence, 1)
  assert.doesNotMatch(DAFEIYU_REPLY_GUIDE, /示例句|固定回复|每句都/)
})

test('session objective carries the shared reply guide and stays non-template', () => {
  const prompt = buildFeiyuObjective(base)
  assert.ok(prompt.includes(DAFEIYU_REPLY_GUIDE))
  assert.match(prompt, /几字、一句、短梗或笑一下/)
  assert.match(prompt, /不要求具体细节加反应/)
  assert.match(prompt, /不用「」摘抄原文/)
  assert.match(prompt, /不补人生道理或客服收尾/)
  assert.doesNotMatch(prompt, /每条.*本鱼.*呜/)
})

test('live brief keeps the conversational boundary and does not turn into a report template', () => {
  const prompt = buildLiveBrief({ ...base, picked: 1, moments: 0 })
  assert.match(prompt, /当前表达约定/)
  assert.match(prompt, /发言按当前全局人格/)
  assert.doesNotMatch(prompt, /强制.*总结|每条都.*呜/)
})

test('a custom global persona replaces the bundled voice and writing recipes in every objective', () => {
  const cfg = { ...base.cfg, persona: 'CUSTOM_PERSONA: terse, dry and formal' }
  const prompts = [buildFeiyuObjective({ ...base, cfg }), buildFeiyuObjective({ ...base, cfg, mode: 'background' }), buildLiveBrief({ ...base, cfg, picked: 1, moments: 0 })]
  for (const prompt of prompts) {
    assert.match(prompt, /当前全局人格/)
    assert.doesNotMatch(prompt, /你是大肥鱼，也叫鲸鱼摸鱼/)
    assert.doesNotMatch(prompt, /不要求具体细节加反应/)
  }
  const active = characterPrompt(cfg)
  assert.match(active, /CUSTOM_PERSONA: terse, dry and formal/)
  assert.doesNotMatch(active, /你是大肥鱼，也叫鲸鱼摸鱼/)
})

test('session and background share the same browsing policy while live context carries only changing state', () => {
  const session = buildFeiyuObjective(base)
  const background = buildFeiyuObjective({ ...base, mode: 'background' })
  const live = buildLiveBrief({ ...base, picked: 1, moments: 0 })
  assert.ok(session.includes(DAFEIYU_REPLY_GUIDE))
  assert.ok(background.includes(DAFEIYU_REPLY_GUIDE))
  assert.equal(live.includes(DAFEIYU_REPLY_GUIDE), false, 'stable reply instructions are not repeated in every live update')
  assert.match(background, /不创建对话 goal/)
  assert.doesNotMatch(background, /等宿主续下一轮|用自己的口气聊一句后停下来/)
  for (const prompt of [session, background]) {
    assert.match(prompt, /结果未知不重发/)
    assert.match(prompt, /按 browse_progress 继续剩余候选/)
    assert.match(prompt, /不连续重取/)
  }
})

test('startup and live instructions permit reading past a blocked comment and respect chosen discovery settings', () => {
  const cfg = { ...base.cfg, browseRecentDays: 30, browseMinMinutes: 3, browseMaxMinutes: 20, browseSort: 'pubdate' }
  for (const prompt of [buildFeiyuObjective({ ...base, cfg }), buildLiveBrief({ ...base, cfg, picked: 0, moments: 0 })]) {
    assert.doesNotMatch(prompt, /看完必评|发出去之前不开|不补发.*不开|只刷一周内|往热门里凑/)
    assert.match(prompt, /最近 30 天/)
    assert.match(prompt, /至少 3 分钟/)
    assert.match(prompt, /最新优先/)
  }
  assert.match(DAFEIYU_REPLY_GUIDE, /不用破折号/)
})

test('digest selections are independent of browsing and authorized new-message replies', () => {
  for (const cfg of [{ ...base.cfg, perDay: 0 }, { ...base.cfg, perDay: 1, reportLevel: 'off' }]) {
    for (const prompt of [buildFeiyuObjective({ ...base, cfg }), buildLiveBrief({ ...base, cfg, picked: 1, moments: 0 })]) {
      assert.match(prompt, /不是浏览或互动总额度/)
      assert.match(prompt, /独立且已授权/)
      assert.match(prompt, /同一次被拦发送/)
      assert.match(prompt, /结果未知不重发/)
    }
    const live = buildLiveBrief({ ...base, cfg, picked: 1, moments: 0 })
    assert.match(live, /对方有新消息时按真实资格、判重与频率/)
    assert.match(live, /不主动追着连续发/)
  }
})

test('approved learning remains reference-only while persona guidance stays authoritative', () => {
  let ledger = {}
  const added = learnAdd(ledger, { kind: 'style', text: '先说当下那一下，再补一句自己的反应', from: 'fixture-video' })
  ledger = added.ledger
  assert.equal(learnInject(ledger, { mode: 'dafeiyu', budget: 1200 }).text, '')
  const decided = learnDecide(ledger, added.id, 'approve', '具体、可复用、来源清楚', '2026-10-27T00:00:00.000Z')
  ledger = decided.ledger
  const learned = learnInject(ledger, { mode: 'dafeiyu', budget: 1200 })
  assert.match(learned.text, /先说当下那一下/)
  const prompt = buildFeiyuObjective(base)
  assert.ok(prompt.includes(DAFEIYU_REPLY_GUIDE))
  assert.match(learned.text, /只是参考，不是必须照做/)
})

test('existing compass still keeps the fish identity boundary', () => {
  assert.equal(typeof CHARACTER_COMPASS, 'string')
  assert.match(CHARACTER_COMPASS, /你是(?:大肥鱼|鲸鱼摸鱼)/)
  assert.ok(CHARACTER_COMPASS.includes('不报型号'))
  assert.ok(CHARACTER_COMPASS.includes('公开评论、动态和私信仍各按授权与节奏开关'))
})

/* ────────────────────────────────────────────────────────────────
 * 动态写法（2026-10-28 使用者：「发动态样式优化一下，不要过于限制格式；
 * 现在每次开头都是"今天看了什么什么"，容易审美疲劳」）
 *
 * 这一组断言锁的是**病根**，不是措辞：
 *   ① 要有「别把今天看了当默认入口」这条 —— 否则模型还是会从同一个门进来
 *   ② 也要有「换个门」的角度菜单 —— 只说"别这么写"会把模型逼成哑巴
 *   ③ 不能出现任何一句可以逐字照抄的模板句
 *   ④ 配额不能再写成"要发够"（那是凑数压力的源头）
 *   ⑤ 口吻下拉必须真的接进提示词（改之前它是死的）
 * ──────────────────────────────────────────────────────────────── */

test('moment guide bans the "今天看了…" default entry without handing out a template', () => {
  assert.match(DAFEIYU_MOMENT_GUIDE, /今天看了/)
  assert.match(DAFEIYU_MOMENT_GUIDE, /不是默认入口/)
  assert.match(DAFEIYU_MOMENT_GUIDE, /换个门/)          // ④ 有出路，不是只会说别
  assert.match(DAFEIYU_MOMENT_GUIDE, /300 字是上限/)
  // ③ 不给成句模板：没有引号包着的成品句，没有「第一条…第二条…」这种填空槽
  assert.doesNotMatch(DAFEIYU_MOMENT_GUIDE, /示例[:：]|例如写|可以这样写|照着写/)
  assert.doesNotMatch(DAFEIYU_MOMENT_GUIDE, /「[^」]*。」/)   // 引号里装整句 = 可照抄的模板
})

test('video moments give recognizable context before the reaction without turning into a summary', () => {
  assert.match(DAFEIYU_MOMENT_GUIDE, /QQ空间或朋友圈/)
  assert.match(DAFEIYU_MOMENT_GUIDE, /因视频而发时.*没看过.*哪个视频/)
  assert.match(DAFEIYU_MOMENT_GUIDE, /标题、UP或具体主题.*讲什么、发生什么.*自己的想法.*来源链接/)
  assert.match(DAFEIYU_MOMENT_GUIDE, /背景够读者接上.*不写长篇摘要.*不固定标题字段或开场句/)
  assert.match(DAFEIYU_MOMENT_GUIDE, /不突然拐到无关的日报、挑片账本或人生道理/)
  assert.match(DAFEIYU_MOMENT_GUIDE, /纯日常不用编视频来源/)
  assert.doesNotMatch(DAFEIYU_MOMENT_GUIDE, /不想提就完全不提|不必每次解释灵感从哪里来|想提视频就一句带过/)
  assert.doesNotMatch(DAFEIYU_MOMENT_GUIDE, /自问自答、清单.*都算/)
  assert.match(DAFEIYU_DEFAULT_PERSONA, /视频动态给够背景再聊想法.*纯日常不编来源/)
})

test('moment style hint stays a nudge, never a required formula', () => {
  assert.equal(momentStyleHint('随心情'), '')   // 默认就是"不加倾向"
  assert.equal(momentStyleHint(''), '')
  assert.equal(momentStyleHint(undefined), '')
  assert.equal(momentStyleHint('随便'), '')      // 白名单外也别硬塞
  for (const s of ['感想', '吐槽', '安利', '冷知识']) {
    const hint = momentStyleHint(s)
    assert.match(hint, new RegExp(s))
    assert.match(hint, /这只是口味/)            // 明说不是模板
    assert.doesNotMatch(hint, /必须|每条都要/)
    assert.doesNotMatch(hint, /「|」/)
    assert.ok(hint.length < 70, 'a tone choice is a short nudge, not a repeat of the moment guide')
  }
  assert.match(momentStyleHint('吐槽'), /轻轻损一下.*不恶毒追骂/)
  assert.doesNotMatch(momentStyleHint('吐槽'), /也不骂人/)
  assert.match(momentStyleHint('安利'), /别写优点清单/)
  assert.match(momentStyleHint('冷知识'), /真实来源.*不开百科课堂/)
})

test('session objective carries a moment-writing section and the chosen tone', () => {
  const prompt = buildFeiyuObjective({ ...base, cfg: { ...base.cfg, momentStyle: '吐槽' } })
  assert.match(prompt, /【动态怎么写】/)
  assert.ok(prompt.includes(DAFEIYU_MOMENT_GUIDE))
  assert.match(prompt, /这一阵偏吐槽/)
  assert.match(prompt, /不是催办/)               // 动态不是每天必须交的作业
  // 没选口味时不该凭空塞一个
  const plain = buildFeiyuObjective({ ...base, cfg: { ...base.cfg, momentStyle: '随心情' } })
  assert.doesNotMatch(plain, /这一阵偏/)
  assert.match(plain, /【动态怎么写】/)          // 但写法指引一直在
})

test('live brief treats the moment quota as headroom, not debt', () => {
  const prompt = buildLiveBrief({
    ...base, picked: 0, moments: 2,
    cfg: { ...base.cfg, autoMoment: true, momentPerDay: 20 },
  })
  assert.match(prompt, /今天发过 2 条/)
  assert.match(prompt, /余量 18 条/)
  assert.match(prompt, /不是今天的欠账/)
  assert.match(prompt, /不用凑数/)
  // 旧的「发够量」措辞必须消失 —— 它就是「今天看了X」反复出现的压力源
  assert.doesNotMatch(prompt, /每天要发够的量/)
  assert.doesNotMatch(prompt, /发到 cap 为止/)
  assert.doesNotMatch(prompt, /动态要发够当天的量/)
})

test('live brief mirrors recent openings so the fish can see its own rut', () => {
  const openings = ['今天看了场AI修bug世界杯', '今天读了三个故事', '今天看条AI男团MV']
  const prompt = buildLiveBrief({
    ...base, picked: 0, moments: 3, recentOpenings: openings,
    cfg: { ...base.cfg, autoMoment: true, momentPerDay: 20 },
  })
  assert.match(prompt, /你最近几条动态是这么开口的/)
  assert.match(prompt, /今天看了场AI修bug世/)     // 只放开头，不放全文
  assert.match(prompt, /换个门/)
  assert.doesNotMatch(prompt, /AI男团MV.*今天读/)  // 别把旧动态拼串
  // 没有历史时这一行完全不出现，不占位不啰嗦
  const cold = buildLiveBrief({ ...base, picked: 0, moments: 0, recentOpenings: [], cfg: { ...base.cfg, autoMoment: true, momentPerDay: 20 } })
  assert.doesNotMatch(cold, /你最近几条动态/)
})

test('moment opening mirror keeps a bounded, order-preserving tail', () => {
  assert.equal(MOMENT_OPENING_KEEP, 5)
  const many = ['一', '二', '三', '四', '五', '六', '七'].map((c) => `第${c}条开场白`)
  const prompt = buildLiveBrief({
    ...base, picked: 0, moments: 7, recentOpenings: many.slice(-MOMENT_OPENING_KEEP),
    cfg: { ...base.cfg, autoMoment: true, momentPerDay: 20 },
  })
  assert.match(prompt, /第三条/)
  assert.match(prompt, /第七条/)
  assert.doesNotMatch(prompt, /第一条|第二条/)
  // 不能拼出「进来。。」这种双句号
  assert.doesNotMatch(prompt, /。。/)
})
