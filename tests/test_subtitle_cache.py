"""Offline transcript recovery: actual MCP functions + SQLite, synthetic fetches only."""
import ast
import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor" / "bilibili-mcp"
sys.path.insert(0, str(VENDOR))
import runtime_guard
from runtime_guard import RuntimeGuard, key_video_reply, stringify_ids

BVID = "BV14AHP6VExR"


def subtitle_tools(guard, fetch):
    """Compile real function bodies without importing any SDK or user credentials."""
    source = ast.parse((VENDOR / "mcp_server.py").read_text(encoding="utf-8"))
    names = {"bili_subtitle", "_subtitle_view", "_guard_blocked"}
    functions = [node for node in source.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
    for node in functions:
        node.decorator_list = []
    namespace = {"asyncio": asyncio, "json": json, "stringify_ids": stringify_ids,
                 "READ_TIMEOUT_SECONDS": 1, "_get_runtime_guard": lambda: guard, "_fetch_subtitle": fetch}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(VENDOR / "mcp_server.py"), "exec"), namespace)
    return namespace


class SubtitleRecovery(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.now = [1_760_000_000.0]
        self.guard = RuntimeGuard(self.home, clock=lambda: self.now[0])
        self.calls = []

        async def fetch(bvid, with_time):
            self.calls.append((bvid, with_time))
            return json.dumps({"bvid": bvid, "title": "合成视频", "segments": 2,
                               "text": "[00:01.0] 第一段\n[01:02.5] 第二段",
                               "segments_detail": [{"t": 1, "to": 2, "s": "第一段"},
                                                   {"t": 62.5, "to": 64, "s": "第二段"}]})
        self.fetch = fetch
        self.tools = subtitle_tools(self.guard, fetch)

    async def read(self, timed=False, tools=None):
        return json.loads(await (tools or self.tools)["bili_subtitle"](BVID, timed))

    async def test_first_plain_read_then_timed_reread_uses_same_snapshot_across_instances(self):
        plain = await self.read()
        self.assertEqual(plain["text"], "第一段\n第二段")
        self.assertNotIn("segments_detail", plain)
        self.assertFalse(plain["cached"])
        second = RuntimeGuard(self.home, clock=lambda: self.now[0])
        timed = await self.read(True, subtitle_tools(second, self.fetch))
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(self.calls[0][1], "the first fetch must retain timeline information")
        self.assertIn("[01:02.5] 第二段", timed["text"])
        self.assertTrue(timed["cached"])
        self.assertTrue(timed["already_seen"])
        self.assertFalse(timed["seen_recorded"])
        self.assertEqual(second.snapshot()["counts"]["seen"], 1)

    async def test_legacy_seen_without_snapshot_can_recover_but_send_history_stays_locked(self):
        old = self.guard.reserve_read(BVID)
        self.guard.commit_read(old, {"bvid": BVID, "at": "2025-01-01T00:00:00Z"})
        sent = self.guard.reserve_send(key_video_reply(BVID, "0"))
        self.guard.mark_unknown(sent)
        result = await self.read(True)
        self.assertIn("第一段", result["text"])
        self.assertEqual(self.guard.snapshot()["seenVideos"][BVID]["at"], "2025-01-01T00:00:00Z")
        duplicate = self.guard.reserve_send(key_video_reply(BVID, "0"))
        self.assertFalse(duplicate["allowed"])
        self.assertEqual(duplicate["status"], "unknown")

    async def test_concurrent_fetch_lease_does_not_become_seen_and_releases_on_cancel(self):
        entered = asyncio.Event()

        async def slow_fetch(*args):
            entered.set()
            await asyncio.Event().wait()

        tools = subtitle_tools(self.guard, slow_fetch)
        task = asyncio.create_task(self.read(True, tools))
        await entered.wait()
        blocked = await self.read(True)
        self.assertEqual(blocked["guard_status"], "pending")
        self.assertFalse(blocked["already_seen"])
        self.assertEqual(blocked["next_action"], "read-another-candidate")
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        recovered = await self.read()
        self.assertIn("第一段", recovered["text"])
        self.assertEqual(len(self.calls), 1)

    async def test_empty_and_partial_errors_do_not_enter_cache_or_seen_history(self):
        for payload in [{"message": "没有字幕"}, {"segments": 0, "text": "   "},
                        {"error": "synthetic failure", "text": "partial"}]:
            async def failed(*args):
                return json.dumps(payload)
            await self.read(True, subtitle_tools(self.guard, failed))
            self.assertIsNone(self.guard.cached_subtitle(BVID))
            self.assertEqual(self.guard.snapshot()["counts"]["seen"], 0)
        self.assertIn("第一段", (await self.read())["text"])

    async def test_expired_lease_cannot_overwrite_a_new_reader_or_release_its_lease(self):
        stale = self.guard.reserve_subtitle(BVID)
        self.now[0] += 601
        current = self.guard.reserve_subtitle(BVID)
        payload = {"bvid": BVID, "text": "新快照"}
        with self.assertRaises(RuntimeError):
            self.guard.commit_subtitle(stale, payload)
        self.assertFalse(self.guard.release(stale))
        self.assertFalse(self.guard.reserve_subtitle(BVID)["allowed"])
        self.guard.commit_subtitle(current, payload)
        self.assertEqual(self.guard.cached_subtitle(BVID)["text"], "新快照")

    async def test_a_legacy_reader_keeps_its_live_lease_and_expired_reads_can_recover(self):
        legacy = self.guard.reserve_read(BVID)
        blocked = await self.read(True)
        self.assertEqual(blocked["guard_status"], "pending")
        self.assertEqual(self.calls, [])
        self.now[0] += 601
        self.assertIn("第一段", (await self.read())["text"])
        self.assertFalse(self.guard.release(legacy))
        self.assertEqual(self.guard.snapshot()["counts"]["seen"], 1)

    async def test_oversized_or_corrupted_cache_never_looks_like_missing_history(self):
        with patch.object(runtime_guard, "SUBTITLE_CACHE_BYTES", 10):
            result = await self.read()
            self.assertFalse(result["cache_stored"])
            self.assertIsNone(self.guard.cached_subtitle(BVID))
            self.assertEqual(self.guard.snapshot()["counts"]["seen"], 1)
        await self.read()
        with self.guard._transaction() as conn:
            conn.execute("UPDATE subtitle_cache SET payload='not valid json' WHERE bvid=?", (BVID,))
        self.assertIsNone(self.guard.cached_subtitle(BVID))
        self.assertIn("第一段", (await self.read())["text"])
        self.assertEqual(self.guard.snapshot()["counts"]["seen"], 1)

    async def test_bounded_cache_eviction_keeps_permanent_seen_history(self):
        with patch.object(runtime_guard, "SUBTITLE_CACHE_MAX", 2):
            for i in range(3):
                bvid = "BV" + str(i).zfill(10)
                self.now[0] += 1
                lease = self.guard.reserve_subtitle(bvid)
                self.guard.commit_subtitle(lease, {"bvid": bvid, "text": "合成字幕"})
            self.assertIsNone(self.guard.cached_subtitle("BV0000000000"))
            self.assertIsNotNone(self.guard.cached_subtitle("BV0000000002"))
            self.assertEqual(self.guard.snapshot()["counts"]["seen"], 3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
