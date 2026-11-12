import test from 'node:test'
import assert from 'node:assert/strict'
import { commentQuality, templateCheck } from '../lib/comment.mjs'
import { DAFEIYU_DEFAULT_PERSONA, DAFEIYU_SHARED_STYLE_GUIDE, DAFEIYU_REPLY_GUIDE, DAFEIYU_MOMENT_GUIDE, DAFEIYU_REPLY_STYLE_RULES } from '../lib/persona.mjs'

test('public writing prompts ask for the fish reaction rather than quoted source text', () => {
  for (const guide of [DAFEIYU_SHARED_STYLE_GUIDE, DAFEIYU_REPLY_GUIDE, DAFEIYU_MOMENT_GUIDE]) {
    assert.match(guide, /公开评论和动态|用自己的话随意表态/)
    assert.match(guide, /不用「」摘抄/)
    assert.match(guide, /不.*照搬/)
    assert.doesNotMatch(guide, /准确引用保留原格式|代码、链接、准确引用/)
  }
  assert.equal(DAFEIYU_REPLY_STYLE_RULES.noSourceQuote, true)
  assert.equal(DAFEIYU_REPLY_STYLE_RULES.noCopyingSource, true)
  assert.match(DAFEIYU_SHARED_STYLE_GUIDE, /不把它当成公开日常摘抄的例外/)
  assert.match(DAFEIYU_DEFAULT_PERSONA, /公开发言用自己的话/)
})

test('casual opinions avoid summary and lecture recipes without banning serious discussion', () => {
  for (const guide of [DAFEIYU_SHARED_STYLE_GUIDE, DAFEIYU_MOMENT_GUIDE]) {
    assert.match(guide, /默认不总结、不分点、不说教/)
  }
  assert.match(DAFEIYU_SHARED_STYLE_GUIDE, /认真求助和严肃问题正常认真答/)
  assert.doesNotMatch(DAFEIYU_MOMENT_GUIDE, /清单.*都算|自问自答.*都算/)
  for (const body of ['这就开始指挥我了？你那块都还拼反着呢', '我还是喜欢后面那个笨办法，至少这次真没歪']) {
    assert.equal(commentQuality(body).ok, true, 'natural disagreement needs no fixed cute vocabulary')
  }
})

test('specific reactions pass without signature vocabulary; style shapes give advice', () => {
  for (const body of ['这个锅盖居然还能用来滤水', '先焊再钻孔，我终于知道为什么总歪了']) {
    assert.deepEqual(commentQuality(body), { ok: true })
  }
  for (const [body, warning] of [
    ['01:20「这锅不能洗」给我看愣了', 'source-quote'],
    ['UP那句「先下锅再点火」我差点照做', 'source-quote'],
    ['13赞那条把我的问题问出来了', 'like-count-opening'],
    ['这个讲解把部署时丢的那个参数补上了', 'formal-wording'],
    ['我还以为成功了——锅底已经糊了', 'em-dash'],
  ]) {
    const result = commentQuality(body)
    assert.equal(result.ok, true, body)
    assert.ok(result.warnings.includes(warning), body)
  }
})

test('empty, symbols, URLs, excessive length and actual copied bodies stay blocked', () => {
  for (const body of ['', '   ', '？？？', '😂', '(๑•̀ㅂ•́)و✧', 'https://www.bilibili.com', '字'.repeat(151)]) {
    assert.equal(commentQuality(body).ok, false, body)
  }
  assert.equal(templateCheck('先焊再钻孔，我终于知道为什么总歪了', ['先焊再钻孔 我终于知道为什么总歪了']).ok, false)
  const long = commentQuality('字'.repeat(151))
  assert.doesNotMatch(long.hint, /拆成回复别人/)
})

test('short reactions and unlisted memes pass without padding or required signature words', () => {
  for (const body of ['哈哈', '典', '绷', '对', '好耶', '笑死', '666', '有被', '蚌埠住了', '有被笑到', '哈哈哈哈666', '太强了', 'awsl', '尊嘟假嘟', '不是哥们']) {
    for (const kind of ['comment', 'reply']) assert.equal(commentQuality(body, { kind }).ok, true, `${kind}: ${body}`)
  }
  assert.equal(templateCheck('这是同一个较长的正文', ['这是同一个较长的正文']).ok, false)
})

test('long low-content feedback asks to shorten instead of expanding a joke into analysis', () => {
  const result = commentQuality('哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈')
  assert.equal(result.ok, false)
  assert.match(result.hint, /收短.*短梗、笑一下都可以/)
  assert.match(result.hint, /不用补细节、解释笑点或讲道理.*不发/)
  assert.doesNotMatch(result.hint, /哪个镜头|哪句台词|比如|例如|「|」/)
})
