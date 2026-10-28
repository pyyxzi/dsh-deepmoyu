/**
 * tests/dup-cross-channel.test.mjs —— 「同一条评论只回一次」的回归测试
 * ============================================================================
 * 2026-10-25 使用者报：「有的时候回复动态或者评论，会回一个人一条评论两条消息，修复一下，
 *   不要重复回，一条回一个就行」。
 *
 * 真机根因（state.json + runtime-guard.sqlite3 实测）：同一条评论能从**两条通道**各回一次 ——
 *   · bili_reply(bvid, rpid)        记 `video:<rpid>`
 *   · bili_reply_opus(opus_id, rpid) 记 `opus-reply:<opusId>:<rpid>`
 * 两个键各记各的、谁都不认谁，模型换个工具看到同一条评论就又回一遍。
 * 账本里共有 34 个 rpid 这样重复过，最近一例相隔 4 分 24 秒（rpid 318036124737）。
 *
 * 这个文件钉住两件事：
 *   1. 跨通道能认出来（不再重复回）；
 *   2. 动态楼层在**别的动态**里同号仍然不拦（别把 2026-10-20 那个静默漏回的坑走回去）。
 *
 * 跑：node tests/dup-cross-channel.test.mjs
 * 纯函数、不碰网络和磁盘，随时可跑。
 */

import assert from 'node:assert/strict'
import {
  dupLookupVideoComment, dupLookupOpusComment,
  dupLookup, dupRemember, keyVideoReply, keyOpusReply,
} from '../lib/dup.mjs'

let n = 0
const t = (name, fn) => {
  try { fn(); n++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1 }
}

console.log('dup-cross-channel')

/* ── 1. 视频通道 ───────────────────────────────────────────────────────────── */

t('视频通道：没回过就是没回过', () => {
  assert.equal(dupLookupVideoComment({}, '318036124737').hit, false)
  assert.equal(dupLookupVideoComment(null, '318036124737').hit, false)
})

t('视频通道：自己记过的认得', () => {
  const book = dupRemember({}, keyVideoReply('318036124737'), { at: '2026-10-24T11:01:50.178Z' })
  const hit = dupLookupVideoComment(book, '318036124737')
  assert.equal(hit.hit, true)
  assert.equal(hit.at, '2026-10-24T11:01:50.178Z')
})

t('视频通道：老账本里裸 rpid 的照样认', () => {
  const book = { 318036124737: { bvid: 'BV14AHP6VExR', rpid: '318036124737' } }
  assert.equal(dupLookupVideoComment(book, '318036124737').hit, true)
})

t('🔁 视频通道：动态通道回过的同号 rpid 也认（就是这次的 bug）', () => {
  // 真机账本原文：同一条评论先在视频通道回过，4 分钟后动态通道又记了一次
  const book = {
    'video:318036124737': { bvid: 'BV14AHP6VExR', rpid: '318036124737', at: '2026-10-24T11:01:50.178Z' },
    'opus-reply:1262700971822153744:318036124737': {
      opus_id: '1262700971822153744', rpid: '318036124737', at: '2026-10-24T11:06:14.771Z',
    },
  }
  // 只保留动态那条（模拟"先回动态、再回视频"的顺序）
  const onlyOpus = { 'opus-reply:1262700971822153744:318036124737': book['opus-reply:1262700971822153744:318036124737'] }
  assert.equal(dupLookupVideoComment(onlyOpus, '318036124737').hit, true)
  assert.equal(dupLookupVideoComment(onlyOpus, '318036124737').at, '2026-10-24T11:06:14.771Z')
  assert.equal(dupLookupVideoComment(onlyOpus, '318036124737').key, 'opus-reply:1262700971822153744:318036124737')
})

t('视频通道：别的 rpid 不受影响', () => {
  const book = { 'opus-reply:1262700971822153744:318036124737': { rpid: '318036124737' } }
  assert.equal(dupLookupVideoComment(book, '318036124738').hit, false)
  // 后缀必须整段相等，不能被前半段糊弄
  assert.equal(dupLookupVideoComment(book, '360124737').hit, false)
})

/* ── 2. 动态通道 ───────────────────────────────────────────────────────────── */

t('动态通道：没回过就是没回过', () => {
  assert.equal(dupLookupOpusComment({}, '318036124737', '0', '1262700971822153744').hit, false)
})

t('动态通道：同一层楼回过的认得', () => {
  const book = dupRemember({}, keyOpusReply('318036124737', '0', '1262700971822153744'), {
    opus_id: '1262700971822153744', rpid: '318036124737', at: '2026-10-24T11:06:14.771Z',
  })
  assert.equal(dupLookupOpusComment(book, '318036124737', '0', '1262700971822153744').hit, true)
})

t('🔁 动态通道：视频通道回过的同号 rpid 也认（反过来的那一半）', () => {
  const book = { 'video:318036124737': { bvid: 'BV14AHP6VExR', rpid: '318036124737', at: '2026-10-24T11:01:50.178Z' } }
  const hit = dupLookupOpusComment(book, '318036124737', '0', '1262700971822153744')
  assert.equal(hit.hit, true)
  assert.equal(hit.key, 'video:318036124737')
})

t('🔁 动态通道：老账本裸 rpid（视频通道）也认', () => {
  const book = { 318036124737: { bvid: 'BV14AHP6VExR' } }
  assert.equal(dupLookupOpusComment(book, '318036124737', '0', '1262700971822153744').hit, true)
})

t('⚠️ 动态通道：**别的动态**下同号楼层仍然不拦（别走回 2026-10-20 的坑）', () => {
  const book = { 'opus-reply:1262700971822153744:318036124737': { rpid: '318036124737' } }
  // 同在 B 动态下回过的同号楼层 —— 原来就是这么判的（同一把钥匙），行为不能变
  assert.equal(dupLookupOpusComment(book, '318036124737', '0', '1262700971822153744').hit, true)
  // 换一条动态，同号楼层不受牵连（新层楼照样能回）
  assert.equal(dupLookupOpusComment(book, '318036124737', '0', '1262712387822157856').hit, false)
})

t('楼中楼：同一层楼里的**另一条**评论不算重复（root 只是排版，不是身份）', () => {
  const book = dupRemember({}, keyOpusReply('318036124799', '318036124737', '1262700971822153744'), {
    opus_id: '1262700971822153744', rpid: '318036124799',
  })
  // 老楼层键 `opus:<root>` 只在记录没写 rpid 时才算保守命中；写了 rpid 就要对得上
  assert.equal(dupLookupOpusComment(book, '318036124800', '318036124737', '1262700971822153744').hit, false)
  // 老格式、没写 rpid 的那条（没法自证是哪层）⇒ 保守算回过，宁可不回也别重复刷
  assert.equal(dupLookupOpusComment({ '318036124737': {} }, '318036124800', '318036124737', '1262700971822153744').hit, true)
})

/* ── 3. 边界：坏输入不能变成"拦一切"或"放一切" ─────────────────────────────── */

t('坏 ID：一律当没回过（和 old 的 dupLookup 一致），不抛异常', () => {
  const book = { 'video:318036124737': { rpid: '318036124737' } }
  for (const bad of ['', '0', 'abc', null, undefined, '-1']) {
    assert.equal(dupLookupVideoComment(book, bad).hit, false, `video ${JSON.stringify(bad)}`)
    assert.equal(dupLookupOpusComment(book, bad, '0', '1262700971822153744').hit, false, `opus ${JSON.stringify(bad)}`)
  }
})

t('账本不是对象时也安全', () => {
  for (const junk of [null, undefined, [], 'x', 42]) {
    assert.equal(dupLookupVideoComment(junk, '318036124737').hit, false)
    assert.equal(dupLookupOpusComment(junk, '318036124737', '0', '1262700971822153744').hit, false)
  }
})

t('大数 ID 原样当字符串过（不许转成数字掉尾数）', () => {
  const big = '3180361247371234567'
  const book = { [`opus-reply:1262700971822153744:${big}`]: { rpid: big } }
  assert.equal(dupLookupVideoComment(book, big).hit, true)
  // 少一位就认不出来（不能被 JS number 的精度糊过去）
  assert.equal(dupLookupVideoComment(book, '3180361247371234560').hit, false)
})

/* ── 4. 旧行为没被改坏 ────────────────────────────────────────────────────── */

t('dupLookup 本体行为不变', () => {
  const book = dupRemember({}, 'video:1', { at: 'now' })
  assert.equal(dupLookup(book, 'video:1').hit, true)
  assert.equal(dupLookup(book, 'video:2').hit, false)
  // 传 legacyKeys 时 key 本身必须有值（空 key 直接查不了账）
  assert.equal(dupLookup(book, 'video:2', ['video:1']).hit, true)
  assert.equal(dupLookup(book, '', ['video:1']).hit, false)
})

if (process.exitCode) {
  console.error(`\n${n} passed, some FAILED`)
} else {
  console.log(`\n${n}/${n} passed`)
}
