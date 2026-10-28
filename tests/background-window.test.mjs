import test from 'node:test'
import assert from 'node:assert/strict'
import { parseHM, backgroundWindowActive, backgroundWindowEndAt, backgroundWindowLaunch } from '../lib/run-settings.mjs'

/* 后台「时段」任务的纯函数（2026-10-28）：指定 start–end，段内一直刷。
 * 单测钉三类边界：常规段 / 跨午夜段（重启后接着刷尾段）/ 非法与相等段。 */
const at = (h, m, day = 28) => new Date(2026, 9, day, h, m, 0, 0) // 2026-10-28（周三）

test('parseHM 只认 00:00–23:59', () => {
  assert.deepEqual(parseHM('20:00'), { h: 20, m: 0 })
  assert.deepEqual(parseHM(' 9:05 '), { h: 9, m: 5 })
  assert.equal(parseHM('24:00'), null)
  assert.equal(parseHM('20:60'), null)
  assert.equal(parseHM('20'), null)
  assert.equal(parseHM(''), null)
  assert.equal(parseHM(null), null)
})

test('常规段：end 在 start 之后 ⇒ 今天结束；段外也已返回今天的 end（由调用方判断是否过期）', () => {
  assert.equal(backgroundWindowEndAt('20:00', '23:00', at(20, 30)), at(23, 0).getTime())
  assert.equal(backgroundWindowEndAt('09:00', '12:00', at(10, 0)), at(12, 0).getTime())
  assert.equal(backgroundWindowEndAt('09:00', '12:00', at(8, 0)), at(12, 0).getTime())
})

test('跨午夜段：晚间主体 ⇒ 结束在次日；半夜重启接着刷尾段 ⇒ 结束就在今天', () => {
  assert.equal(backgroundWindowEndAt('20:00', '02:00', at(20, 30)), new Date(2026, 9, 29, 2, 0).getTime())
  assert.equal(backgroundWindowEndAt('20:00', '02:00', at(23, 59)), new Date(2026, 9, 29, 2, 0).getTime())
  assert.equal(backgroundWindowEndAt('20:00', '02:00', at(1, 30)), at(2, 0).getTime())
  assert.equal(backgroundWindowEndAt('22:00', '00:00', at(22, 5)), new Date(2026, 9, 29, 0, 0).getTime())
  assert.equal(backgroundWindowEndAt('22:00', '00:00', at(0, 10)), at(0, 0).getTime())
})

test('start==end 或解析失败 ⇒ null（视为没配时段）', () => {
  assert.equal(backgroundWindowEndAt('20:00', '20:00', at(20, 0)), null)
  assert.equal(backgroundWindowEndAt('abc', '23:00', at(20, 0)), null)
  assert.equal(backgroundWindowEndAt('', '', at(20, 0)), null)
})

test('backgroundWindowActive：[start, end) 左闭右开，跨午夜两段都算', () => {
  assert.equal(backgroundWindowActive('20:00', '23:00', at(20, 0)), true)
  assert.equal(backgroundWindowActive('20:00', '23:00', at(22, 59)), true)
  assert.equal(backgroundWindowActive('20:00', '23:00', at(23, 0)), false)
  assert.equal(backgroundWindowActive('20:00', '23:00', at(19, 59)), false)
  assert.equal(backgroundWindowActive('20:00', '02:00', at(21, 0)), true)
  assert.equal(backgroundWindowActive('20:00', '02:00', at(0, 30)), true)
  assert.equal(backgroundWindowActive('20:00', '02:00', at(2, 0)), false)
  assert.equal(backgroundWindowActive('20:00', '02:00', at(19, 59)), false)
  assert.equal(backgroundWindowActive('20:00', '20:00', at(20, 0)), false)
  assert.equal(backgroundWindowActive('x', 'y', at(20, 0)), false)
})

test('backgroundWindowLaunch：这一跳要不要拉起鱼（常设时段任务的核心决策）', () => {
  const cfg = { backgroundWindowStart: '20:00', backgroundWindowEnd: '23:00' }
  // 段内、没挂免跑牌 ⇒ 拉起，endAt = 今天 23:00，剩余整算成分钟
  const hit = backgroundWindowLaunch(cfg, {}, at(20, 30))
  assert.equal(hit.endAt, at(23, 0).getTime())
  assert.equal(hit.remainMin, 150)
  // 不在段内（含结束边界）/ 没配 / start==end ⇒ null
  assert.equal(backgroundWindowLaunch(cfg, {}, at(19, 59)), null)
  assert.equal(backgroundWindowLaunch(cfg, {}, at(23, 0)), null)
  assert.equal(backgroundWindowLaunch({}, {}, at(21, 0)), null)
  assert.equal(backgroundWindowLaunch({ backgroundWindowStart: '20:00', backgroundWindowEnd: '20:00' }, {}, at(20, 0)), null)
  // 免跑牌：hold 在未来 ⇒ 不拉（手动停止后调度钩子认账）；hold 已过期 ⇒ 照常拉
  assert.equal(backgroundWindowLaunch(cfg, { bgWindowHold: at(21, 0).getTime() }, at(20, 30)), null)
  const after = backgroundWindowLaunch(cfg, { bgWindowHold: at(20, 0).getTime() }, at(20, 30))
  assert.equal(after.endAt, at(23, 0).getTime())
  // 跨午夜段：半夜尾段 ⇒ endAt 就是今天；晚间主体 ⇒ 次天
  const nightTail = backgroundWindowLaunch({ backgroundWindowStart: '20:00', backgroundWindowEnd: '02:00' }, {}, at(1, 0))
  assert.equal(nightTail.endAt, at(2, 0).getTime())
  const nightMain = backgroundWindowLaunch({ backgroundWindowStart: '20:00', backgroundWindowEnd: '02:00' }, {}, at(21, 0))
  assert.equal(nightMain.endAt, new Date(2026, 9, 29, 2, 0).getTime())
  // 段尾剩余 <1 分钟 ⇒ remainMin 兜底 1（别出 0 分钟的任务）
  const tail = backgroundWindowLaunch(cfg, {}, at(22, 59))
  assert.equal(tail.remainMin, 1)
})
