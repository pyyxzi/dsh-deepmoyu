"""Offline MCP regression for bili_reply pictures (2026-10-22, sticker request).

Loads the real vendor mcp_server.py with bilibili_api + guard replaced by fakes,
then pins the pictures rules: floor replies refuse pictures, >2 pictures
refused, missing local file refused, URL entries deferred to load_remote_pictures,
and pic= actually reaches comment.send_comment only for new comments.
No network, no credentials, no real comment API.
"""
from __future__ import annotations

import ast
import asyncio
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MCP = ROOT / "vendor" / "bilibili-mcp" / "mcp_server.py"


def load_mcp_with_fakes():
    """Import mcp_server.py but stub every third-party touchpoint before exec."""
    source = MCP.read_text(encoding="utf-8")
    tree = ast.parse(source)
    # Syntax sanity first: file must parse clean.
    compile(tree, str(MCP), "exec")

    fake = types.ModuleType("fake_bilibili_api")

    class Picture:
        calls: list = []

        def __init__(self, spec):
            self.spec = spec

        @classmethod
        def from_file(cls, path):
            cls.calls.append(("from_file", path))
            return cls(("file", path))

        @classmethod
        async def load_url(cls, url):
            cls.calls.append(("load_url", url))
            return cls(("url", url))

    class CommentResourceType:
        VIDEO = "VIDEO"
        ARTICLE = "ARTICLE"
        AUDIO = "AUDIO"
        DYNAMIC = "DYNAMIC"
        DYNAMIC_DRAW = "DYNAMIC_DRAW"

    fake.Picture = Picture
    fake.CommentResourceType = CommentResourceType

    comment_mod = types.ModuleType("fake_bilibili_api.comment")
    comment_mod.send_comment_calls = []

    async def fake_send_comment(text, oid, type_, root=None, parent=None, credential=None, pic=None):
        comment_mod.send_comment_calls.append(
            {"text": text, "oid": oid, "type": type_, "root": root, "parent": parent, "pic": pic})
        return {"rpid": 4242, "root": root or 0, "parent": parent or 0, "rpid_str": "4242"}

    comment_mod.send_comment = fake_send_comment
    fake.comment = comment_mod

    utils_mod = types.ModuleType("fake_bilibili_api.utils")
    picture_mod = types.ModuleType("fake_bilibili_api.utils.picture")
    picture_mod.Picture = Picture
    utils_mod.picture = picture_mod
    fake.utils = utils_mod

    sentinels: dict = {}

    def install(name: str, **attrs):
        mod = types.ModuleType(name)
        for key, value in attrs.items():
            setattr(mod, key, value)
        sys.modules[name] = mod
        return mod

    def stub_module(name: str, extra_names: tuple = ()) -> types.ModuleType:
        """ModuleType fails `from X import Y` for names not set as attributes; pre-stub them."""
        mod = install(name)
        for attr in extra_names:
            if not hasattr(mod, attr):
                setattr(mod, attr, types.ModuleType(f"{name}.{attr}"))
        return mod

    stub_module("bilibili_api", ("video", "search", "comment", "Credential", "dynamic", "opus",
                                 "hot", "rank", "user", "session", "favorite_list"))
    sys.modules["bilibili_api"].Picture = Picture
    sys.modules["bilibili_api"].CommentResourceType = CommentResourceType
    sys.modules["bilibili_api"].Credential = object  # never constructed in these tests
    comment_pkg = install("bilibili_api.comment", send_comment=fake_send_comment, CommentResourceType=CommentResourceType)
    sys.modules["bilibili_api"].comment = comment_pkg  # `from bilibili_api import comment` reads the parent attr
    install("bilibili_api.utils", picture=picture_mod)
    install("bilibili_api.utils.picture", Picture=Picture)
    sys.modules["bilibili_api.utils"].picture = picture_mod
    stub_module("bilibili_api.video_uploader", ("VideoUploader", "VideoUploaderPage", "VideoMeta", "Lines"))
    login_stub = stub_module("bilibili_api.login_v2")
    # `QrCodeLogin | None` annotations evaluate eagerly at module level → need real classes, not modules.
    class QrCodeLoginStub:  # noqa: D401 - placeholder type
        pass
    class QrCodeLoginEventsStub:  # noqa: D401
        pass
    login_stub.QrCodeLogin = QrCodeLoginStub
    login_stub.QrCodeLoginEvents = QrCodeLoginEventsStub

    # video.get_info must not hit network: module imports `video` and calls video.get_info.
    async def fake_get_info(bvid):
        return {"aid": 12345, "bvid": bvid}

    video_mod = install("bilibili_api.video", get_info=fake_get_info)
    video_mod.video = types.SimpleNamespace(get_info=fake_get_info)

    # Guard: record reservations instead of touching real state files.
    guard_mod = install("bili_guard",
                        reserve_send=lambda key: {"key": key},
                        mark_sent=lambda key: None,
                        mark_unknown=lambda key: None,
                        note_risk=lambda *a, **k: None)
    sentinels["guard"] = guard_mod

    spec = importlib.util.spec_from_file_location("mcp_server_under_test", MCP)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod, Picture, comment_mod


class BiliReplyPictures(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mcp, cls.Picture, cls.comment = load_mcp_with_fakes()
        # mcp.bili_reply may be the raw fn (no BILI_MCP_TOOLS whitelist) or the lossless wrapper.
        # Store as staticmethod: a plain function on the class binds `self` on instance access,
        # which showed up as "got multiple values for argument 'bvid'".
        target = cls.mcp.bili_reply
        target = getattr(target, "fn", target)
        target = getattr(target, "__wrapped__", target)
        cls.reply = staticmethod(target)
        # Neutralize every real-world side channel BEFORE any call:
        # get_cred reads the user's credential file, video.Video reaches the network,
        # _get_runtime_guard writes the home SQLite ledger. None of that may happen here.
        cls.mcp.get_cred = lambda: object()

        class FakeVideo:
            def __init__(self, bvid=None, credential=None):
                self.bvid = bvid

            async def get_info(self):
                return {"aid": 12345, "bvid": self.bvid}

        cls.mcp.video.Video = FakeVideo

        class FakeGuard:
            def __init__(self):
                self.reserved = []

            def reserve_send(self, key, legacy_keys=()):
                # 2026-10-25：mcp_server.py 改成传跨通道 legacy keys 了，
                # 测试桩跟着收第二个参数（收不收都行，这里只关心 key）。
                self.reserved.append(key)
                return {"allowed": True}

            def commit_send(self, *args, **kwargs):
                pass

            def reject_send(self, *args, **kwargs):
                return {}

            def mark_sent(self, *args, **kwargs):
                pass

            def mark_unknown(self, *args, **kwargs):
                pass

            def note_risk(self, *args, **kwargs):
                pass

        cls.guard = FakeGuard()
        cls.mcp._get_runtime_guard = lambda: cls.guard

    def test_01_signature_declares_pictures(self):
        import inspect
        params = inspect.signature(self.reply).parameters
        self.assertIn("pictures", params)
        self.assertEqual(params["pictures"].default, None)

    def test_02_floor_reply_with_pictures_refuses_before_send(self):
        before = len(self.comment.send_comment_calls)
        out = json.loads(asyncio.run(self.reply(bvid="BV1aaaaaaaaa", text="hi", rpid="8001", pictures=["whatever"])))
        self.assertFalse(out.get("success", True))
        self.assertIn("回复楼层", out.get("error", ""))
        self.assertFalse(out.get("retry_blocked", False))
        self.assertEqual(len(self.comment.send_comment_calls), before, "floor refusal must not call send_comment")

    def test_03_too_many_pictures_refused(self):
        out = json.loads(asyncio.run(self.reply(
            bvid="BV1aaaaaaaaa", text="hi", rpid="0",
            pictures=["a.jpg", "b.jpg", "c.jpg"])))
        self.assertFalse(out.get("success", True))
        self.assertIn("最多 2 张", out.get("error", ""))

    def test_04_missing_local_file_refused(self):
        out = json.loads(asyncio.run(self.reply(
            bvid="BV1aaaaaaaaa", text="hi", rpid="0",
            pictures=[r"C:\definitely\not\here.jpg"])))
        self.assertFalse(out.get("success", True))
        self.assertIn("图片不存在", out.get("error", ""))
        self.assertTrue(out.get("invalid_pictures"))

    def test_05_new_comment_local_picture_reaches_send_comment(self):
        self.Picture.calls.clear()
        self.comment.send_comment_calls.clear()
        with tempfile.TemporaryDirectory() as directory:
            picture = Path(directory) / "s.jpg"
            picture.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 12)
            out = json.loads(asyncio.run(self.reply(
                bvid="BV1aaaaaaaaa", text="带上表情", rpid="0", pictures=[str(picture)])))
        self.assertTrue(out.get("success"), out)
        kinds = [kind for kind, _ in self.Picture.calls]
        self.assertIn("from_file", kinds)
        self.assertEqual(len(self.comment.send_comment_calls), 1)
        call = self.comment.send_comment_calls[0]
        self.assertIsNotNone(call["pic"], "pic= must be passed for new comments with pictures")
        self.assertEqual(call["root"], None)
        self.assertEqual(call["parent"], None)

    def test_06_reply_without_pictures_stays_text_only(self):
        self.comment.send_comment_calls.clear()
        asyncio.run(self.reply(bvid="BV1aaaaaaaaa", text="纯文字回复", rpid="8001", root="9001"))
        call = self.comment.send_comment_calls[-1]
        self.assertIsNone(call["pic"], "text floor replies must not pass pic=")
        self.assertEqual(call["parent"], 8001)

    def test_07_url_picture_defers_to_load_url(self):
        self.Picture.calls.clear()
        self.comment.send_comment_calls.clear()
        with tempfile.TemporaryDirectory() as directory:
            out = json.loads(asyncio.run(self.reply(
                bvid="BV1aaaaaaaaa", text="网络表情", rpid="0",
                pictures=["https://i0.hdslb.com/bfs/x.jpg"])))
        self.assertTrue(out.get("success"), out)
        kinds = [kind for kind, _ in self.Picture.calls]
        self.assertIn("load_url", kinds)
        self.assertIn("https://i0.hdslb.com/bfs/x.jpg", [arg for _, arg in self.Picture.calls])


if __name__ == "__main__":
    unittest.main(verbosity=2)
