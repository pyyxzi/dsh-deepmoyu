"""Offline regression for cross-channel reply dedup (2026-10-25).

使用者报：「有的时候回复动态或者评论，会回一个人一条评论两条消息，修复一下，
不要重复回，一条回一个就行」。

真机根因：同一条评论（同一个 rpid）能从两条通道各回一次，两条通道各记各的键、
谁也不认谁 ——

  · bili_reply(bvid, rpid)         → key_video_reply   = video:<rpid>
  · bili_reply_opus(opus_id, rpid) → key_opus_reply    = opus-reply:<opusId>:<rpid>

账本里实测有 34 个 rpid 这样重复过，最近一例相隔 4 分 24 秒（rpid 318036124737）。

这个文件钉住 RuntimeGuard 的跨通道认账：
  · 视频通道：账本里任意 `opus-reply:*:<rpid>` 都算同一条评论；
  · 动态通道：额外认 `video:<rpid>`；
  · 但**别的动态**下同号楼层仍然不拦（别走回 2026-10-20 那个静默漏回的坑）。

时钟是注入的假钟，测判重时把时间推过节奏闸，免得 pace 把结论搅浑。

跑：python tests/test_guard_cross_channel.py      纯 SQLite，不联网、不碰凭证。
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor" / "bilibili-mcp"))

from runtime_guard import (  # noqa: E402
    RuntimeGuard, cross_channel_keys, key_opus_reply, key_video_reply, legacy_opus_keys,
)

RPID = "318036124737"
OPUS = "1262700971822153744"
OTHER_OPUS = "1262712387822157856"
BVID = "BV14AHP6VExR"
HOUR = 3600.0


class Clock:
    """可推进的假钟：判重看的是账本，不是墙上时间。"""

    def __init__(self, t=1_760_000_000.0):
        self.t = t

    def __call__(self):
        return self.t

    def tick(self, seconds=HOUR):
        self.t += seconds
        return self


class CrossChannelDedup(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.clock = Clock()
        self.guard = RuntimeGuard(Path(self._tmp.name), clock=self.clock)

    def tearDown(self):
        self._tmp.cleanup()

    def sent(self, key, legacy=(), meta=None):
        """占一次坑并落成 sent，模拟「这条真的回出去了」。"""
        self.clock.tick()
        res = self.guard.reserve_send(key, list(legacy))
        self.assertTrue(res.get("allowed"), f"占坑被拒：{res}")
        self.guard.commit_send(res, meta or {})
        return res

    # ── 视频通道 ────────────────────────────────────────────────────────────
    def test_video_channel_recognizes_opus_reply_of_same_rpid(self):
        """先回动态、再回视频：同一条评论不许回第二遍（这次的真机事故）。"""
        self.sent(key_opus_reply(OPUS, RPID), meta={"opus_id": OPUS, "rpid": RPID})
        self.clock.tick()
        res = self.guard.reserve_send(key_video_reply(BVID, RPID))
        self.assertFalse(res.get("allowed"), "同一条评论从视频通道又被放行了")
        self.assertEqual(res.get("key"), f"opus-reply:{OPUS}:{RPID}")

    def test_video_channel_allows_different_rpid(self):
        self.sent(key_opus_reply(OPUS, RPID), meta={"opus_id": OPUS, "rpid": RPID})
        self.clock.tick()
        res = self.guard.reserve_send(key_video_reply(BVID, "318036124738"))
        self.assertTrue(res.get("allowed"), f"不相干的评论被拦：{res}")

    def test_video_channel_ignores_rpid_suffix_collision(self):
        """后缀必须整段相等，别被短 rpid 或末尾几位糊弄。"""
        self.sent(key_opus_reply(OPUS, RPID), meta={"opus_id": OPUS, "rpid": RPID})
        for other in ("360124737", "24737", "7", "3180361247"):
            self.clock.tick()
            res = self.guard.reserve_send(key_video_reply(BVID, other))
            self.assertTrue(res.get("allowed"), f"{other} 被误判成回过了")

    # ── 动态通道 ────────────────────────────────────────────────────────────
    def test_opus_channel_recognizes_video_reply_of_same_rpid(self):
        """先回视频、再回动态：反过来的那一半。"""
        self.sent(key_video_reply(BVID, RPID), meta={"bvid": BVID, "rpid": RPID})
        self.clock.tick()
        res = self.guard.reserve_send(
            key_opus_reply(OPUS, RPID),
            [*legacy_opus_keys(RPID, "0"), *cross_channel_keys(RPID)],
        )
        self.assertFalse(res.get("allowed"), "视频通道回过的评论又从动态通道回了一遍")

    def test_opus_channel_still_blocks_same_floor(self):
        self.sent(key_opus_reply(OPUS, RPID), meta={"opus_id": OPUS, "rpid": RPID})
        self.clock.tick()
        res = self.guard.reserve_send(key_opus_reply(OPUS, RPID),
                                      [*legacy_opus_keys(RPID, "0"), *cross_channel_keys(RPID)])
        self.assertFalse(res.get("allowed"))

    def test_opus_channel_does_not_borrow_other_dynamic(self):
        """⚠️ 别的动态下同号楼层仍然不拦 —— 2026-10-20 静默漏回的那个坑。"""
        self.sent(key_opus_reply(OPUS, RPID), meta={"opus_id": OPUS, "rpid": RPID})
        self.clock.tick()
        res = self.guard.reserve_send(key_opus_reply(OTHER_OPUS, RPID),
                                      [*legacy_opus_keys(RPID, "0"), *cross_channel_keys(RPID)])
        self.assertTrue(res.get("allowed"), f"别的动态下的同号楼层被误判成回过了：{res}")

    # ── 边界 ────────────────────────────────────────────────────────────────
    def test_cross_channel_keys_handles_zero_and_bad_ids(self):
        self.assertEqual(cross_channel_keys(0), [])
        self.assertEqual(cross_channel_keys("0"), [])
        self.assertEqual(cross_channel_keys(RPID), ["video:" + RPID])
        with self.assertRaises((TypeError, ValueError)):
            cross_channel_keys("abc")

    def test_new_comment_key_is_not_cross_channel(self):
        """发新评论（rpid=0）走 nu:<bvid>，不该被 rpid 判重串味。"""
        self.sent(key_video_reply(BVID, RPID), meta={"bvid": BVID, "rpid": RPID})
        self.clock.tick()
        res = self.guard.reserve_send(key_video_reply(BVID, 0))
        self.assertTrue(res.get("allowed"), f"发新评论被楼层判重拦了：{res}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
