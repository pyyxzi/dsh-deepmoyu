import test from 'node:test'
import assert from 'node:assert/strict'
import { DAFEIYU_REPLY_GUIDE, DAFEIYU_REPLY_STYLE_RULES, DAFEIYU_MOMENT_GUIDE, momentStyleHint } from '../lib/persona.mjs'
import { CHARACTER_COMPASS } from '../lib/mode.mjs'
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

test('persona guide encodes natural, content-first fish replies without a catchphrase recipe', () => {
  assert.match(DAFEIYU_REPLY_GUIDE, /先接住/)
  assert.match(DAFEIYU_REPLY_GUIDE, /具体/)
  assert.match(DAFEIYU_REPLY_GUIDE, /客服/)
  assert.match(DAFEIYU_REPLY_GUIDE, /固定口癖/)
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
  assert.match(prompt, /先接住对方或内容里最具体的那一下/)
  assert.match(prompt, /不要复述字幕、评论原话/)
  assert.match(prompt, /不要写成客服/)
  assert.doesNotMatch(prompt, /每条.*本鱼.*呜/)
})

test('live brief keeps the conversational boundary and does not turn into a report template', () => {
  const prompt = buildLiveBrief({ ...base, picked: 1, moments: 0 })
  assert.match(prompt, /输出像聊天/)
  assert.match(prompt, /别说“本轮完成”/)
  assert.match(prompt, /为您总结/)
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
  assert.ok(CHARACTER_COMPASS.includes('你是鲸鱼摸鱼'))
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
  assert.match(DAFEIYU_MOMENT_GUIDE, /默认入口/)
  assert.match(DAFEIYU_MOMENT_GUIDE, /换个门/)          // ④ 有出路，不是只会说别
  assert.match(DAFEIYU_MOMENT_GUIDE, /300 字是上限/)
  // ③ 不给成句模板：没有引号包着的成品句，没有「第一条…第二条…」这种填空槽
  assert.doesNotMatch(DAFEIYU_MOMENT_GUIDE, /示例[:：]|例如写|可以这样写|照着写/)
  assert.doesNotMatch(DAFEIYU_MOMENT_GUIDE, /「[^」]*。」/)   // 引号里装整句 = 可照抄的模板
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
  }
})

test('session objective carries a moment-writing section and the chosen tone', () => {
  const prompt = buildFeiyuObjective({ ...base, cfg: { ...base.cfg, momentStyle: '吐槽' } })
  assert.match(prompt, /【动态怎么写】/)
  assert.ok(prompt.includes(DAFEIYU_MOMENT_GUIDE))
  assert.match(prompt, /这一阵偏「吐槽」/)
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
