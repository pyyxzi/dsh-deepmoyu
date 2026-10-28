import test from 'node:test'
import assert from 'node:assert/strict'
import { DAFEIYU_REPLY_GUIDE, DAFEIYU_REPLY_STYLE_RULES } from '../lib/persona.mjs'
import { CHARACTER_COMPASS } from '../lib/mode.mjs'
import { buildFeiyuObjective, buildLiveBrief } from '../lib/prompts.mjs'
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
