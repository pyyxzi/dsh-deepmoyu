"""Offline pace boundaries and exact GUI/native receipt reconciliation."""
from __future__ import annotations

import ast
import asyncio
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor" / "bilibili-mcp"
sys.path.insert(0, str(VENDOR))
import runtime_guard  # noqa: E402
from runtime_guard import RuntimeGuard, PACE, RISK_COOLDOWN  # noqa: E402


class RuntimePace(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.home = Path(self.folder.name)
        self.now = [1_760_000_000.0]
        self.guard = RuntimeGuard(self.home, clock=lambda: self.now[0], rand=lambda: 0)

    def tearDown(self):
        self.folder.cleanup()

    def entries(self, home=None):
        with closing(sqlite3.connect((home or self.home) / "runtime-guard.sqlite3")) as conn:
            conn.row_factory = sqlite3.Row
            return [dict(row) for row in conn.execute("SELECT * FROM guard_pace_events ORDER BY at,event_key")]

    def send(self, index):
        self.now[0] += 181
        reservation = self.guard.reserve_send(f"nu:BV{index:010d}")
        self.assertTrue(reservation["allowed"], reservation)
        self.guard.commit_send(reservation)
        return reservation

    def host_record(self, token=None, *, kind="comment", at=None, home=None):
        stamp = (self.now[0] if at is None else at) * 1000
        row = {"k": kind, "t": stamp}
        last = {"at": stamp, "next": stamp + 120_000}
        if token is not None:
            row["token"] = token
            last["token"] = token
        (home or self.home).joinpath("state.json").write_text(json.dumps({
            "pace": {"recent": [row], "last": {kind: last}},
        }), encoding="utf-8")
        return stamp

    def child(self, operation, key="", home=None):
        source = (
            "import json,sys; from runtime_guard import RuntimeGuard; "
            "g=RuntimeGuard(sys.argv[1],clock=lambda:float(sys.argv[2]),rand=lambda:0); "
            + ("print(json.dumps(g.reserve_send(sys.argv[3])))" if operation == "send"
               else "print(json.dumps(g.pace_status('comment')))"))
        env = dict(os.environ, PYTHONPATH=str(VENDOR), PYTHONUTF8="1")
        result = subprocess.run([sys.executable, "-c", source, str(home or self.home), str(self.now[0]), key],
                                cwd=ROOT, env=env, capture_output=True, text=True, timeout=30, check=True)
        return json.loads(result.stdout)

    def test_comment_eight_no_longer_parks_but_sixteen_still_does(self):
        for index in range(16):
            self.send(index)
            if index == 7:
                self.now[0] += 121
                self.assertTrue(self.guard.pace_status("comment")["allowed"])
        self.now[0] += 181
        result = self.guard.reserve_send("nu:BV0000000017")
        self.assertFalse(result["allowed"])
        self.assertEqual(result["reason"], "hour")
        self.assertEqual((result["used"], result["cap"]), (16, 16))
        self.assertEqual(result["wait_ms"], round((self.entries()[0]["at"] + 3600 - self.now[0]) * 1000))

    def test_hour_boundary_is_shared_by_concurrent_fresh_processes(self):
        for index in range(15):
            self.send(index)
        self.now[0] += 181
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda index: self.child("send", f"nu:BV{index:010d}"), (100, 101)))
        self.assertEqual(sum(result["allowed"] for result in results), 1, results)
        blocked = next(result for result in results if not result["allowed"])
        self.assertEqual((blocked["reason"], blocked["used"], blocked["cap"]), ("hour", 16, 16))
        self.assertEqual(len(self.entries()), 16)
        self.assertEqual(self.child("status")["reason"], "hour")

    def test_gui_import_uses_the_same_new_caps_for_every_channel(self):
        expected = {"comment": 16, "reply": 30, "opusReply": 40, "dm": 30, "moment": 2}
        self.assertEqual({kind: spec["hour"] for kind, spec in PACE.items()}, expected)
        for kind, cap in expected.items():
            with self.subTest(kind=kind):
                home = self.home / kind
                guard = RuntimeGuard(home, clock=lambda: self.now[0], rand=lambda: 0)
                rows = [{"k": kind, "t": (self.now[0] - 1200 + index) * 1000} for index in range(cap)]
                file = home / "state.json"
                file.write_text(json.dumps({"pace": {"recent": rows[:-1]}}), encoding="utf-8")
                self.assertTrue(guard.pace_status(kind)["allowed"])
                file.write_text(json.dumps({"pace": {"recent": rows}}), encoding="utf-8")
                result = guard.pace_status(kind)
                self.assertEqual((result["reason"], result["used"], result["cap"]), ("hour", cap, cap))
                self.assertEqual(result["wait_ms"], 2_400_000)

    def test_delayed_receipt_is_one_send_across_repeated_process_imports(self):
        reservation = self.send(1)
        self.now[0] += 3
        stamp = self.host_record(reservation["token"])
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda _: self.child("status"), range(2)))
        rows = self.entries()
        self.assertEqual(len(rows), 1, rows)
        self.assertEqual((rows[0]["status"], rows[0]["token"]), ("sent", reservation["token"]))
        self.assertEqual(rows[0]["next"], stamp / 1000 + 120)
        self.assertEqual(self.guard.pace_status("comment")["wait_ms"], 120_000)

    def test_legacy_without_token_keeps_two_second_compatibility(self):
        self.send(1)
        self.now[0] += 1
        self.host_record()
        self.guard.pace_status("comment")
        self.assertEqual(len(self.entries()), 1)

    def test_tokens_do_not_merge_unrelated_native_events(self):
        for case in ("different-token", "wrong-kind", "invalid-token"):
            with self.subTest(case=case):
                home = self.home / case
                guard = RuntimeGuard(home, clock=lambda: self.now[0], rand=lambda: 0)
                reservation = guard.reserve_send("nu:BV0000000001")
                guard.commit_send(reservation)
                token = ("0" if reservation["token"][0] != "0" else "1") + reservation["token"][1:]
                if case == "wrong-kind":
                    token = reservation["token"]
                elif case == "invalid-token":
                    token = "bad-token"
                self.host_record(token, kind="reply" if case == "wrong-kind" else "comment", home=home)
                guard.pace_status("comment")
                rows = self.entries(home)
                self.assertEqual(len(rows), 2, rows)
                native = next(row for row in rows if row["status"] == "sent")
                self.assertEqual((native["kind"], native["token"], native["next"]),
                                 ("comment", reservation["token"], self.now[0] + 120))
                guard.pace_status("comment")
                self.assertEqual(len(self.entries(home)), 2, "repeated seed import is idempotent")

    def test_unknown_and_pending_receipts_are_not_reclassified_as_sent(self):
        for status in ("pending", "unknown"):
            with self.subTest(status=status):
                home = self.home / status
                guard = RuntimeGuard(home, clock=lambda: self.now[0], rand=lambda: 0)
                reservation = guard.reserve_send("nu:BV0000000001")
                if status == "unknown":
                    guard.mark_unknown(reservation)
                self.host_record(reservation["token"], home=home)
                guard.pace_status("comment")
                duplicate = guard.reserve_send("nu:BV0000000001")
                self.assertFalse(duplicate["allowed"])
                self.assertEqual(duplicate["status"], status)
                self.assertEqual({row["status"] for row in self.entries(home)}, {status, "seed"})

    def test_risk_and_attempt_throttling_remain_unchanged(self):
        self.assertEqual(RISK_COOLDOWN, {-352: 1200, -412: 3600, -509: 1800, -799: 1800})
        self.assertEqual((runtime_guard.BURST_WINDOW, runtime_guard.BURST_MAX, runtime_guard.BURST_EXTRA), (600, 10, 180))
        self.assertEqual((runtime_guard.QUOTA_PARK, runtime_guard.QUOTA_PARK_MAX, runtime_guard.QUOTA_DECAY), (2700, 10800, 7200))
        for code, seconds in RISK_COOLDOWN.items():
            with self.subTest(code=code):
                home = self.home / str(code)
                guard = RuntimeGuard(home, clock=lambda: self.now[0], rand=lambda: 0)
                reservation = guard.reserve_send("nu:BV0000000001")
                guard.reject_send(reservation, code)
                for kind in PACE:
                    result = guard.pace_status(kind)
                    self.assertEqual((result["reason"], result["wait_ms"]), ("cooldown", seconds * 1000))
        reservation = self.guard.reserve_send("nu:BV0000000001")
        self.guard.reject_send(reservation, -403)
        result = self.guard.reserve_send("nu:BV0000000002")
        self.assertEqual(result["reason"], "gap", "known rejection still prevents repeated rapid attempts")


def offline_send_functions(guard):
    """Compile only the send functions against inert SDK doubles; no module startup or credentials."""
    names = {"_guarded_send", "bili_reply", "bili_reply_opus", "bili_send_message", "bili_send_dynamic", "bili_send_opus"}
    tree = ast.parse((VENDOR / "mcp_server.py").read_text(encoding="utf-8"))
    functions = [node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name in names]
    for node in functions:
        node.decorator_list = []

    async def sent(**kwargs):
        return {"rpid": 12345, "dynamic_id": 67890}

    async def target(*args):
        return {"oid": 123, "ctype": 17, "resource": 17}

    class Video:
        def __init__(self, **kwargs):
            pass

        async def get_info(self):
            return {"aid": 123}

    class Dynamic:
        @classmethod
        def empty(cls):
            return cls()

        def add_plain_text(self, text):
            pass

    namespace = {**vars(runtime_guard), "json": json, "asyncio": asyncio, "os": os,
                 "get_cred": lambda: object(), "_get_runtime_guard": lambda: guard,
                 "video": SimpleNamespace(Video=Video),
                 "comment": SimpleNamespace(send_comment=sent, CommentResourceType=SimpleNamespace(VIDEO=1)),
                 "dynamic": SimpleNamespace(BuildDynamic=Dynamic, send_dynamic=sent),
                 "session": SimpleNamespace(send_msg=sent, EventType=SimpleNamespace(TEXT=1)),
                 "_opus_comment_target": target,
                 "_GUARD_LOCKED_ERROR": "offline ledger failure",
                 "_guard_blocked": lambda value, *args: json.dumps(value),
                 "_guard_unavailable": lambda error: json.dumps({"error": str(error)})}
    module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *functions], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), "offline-send-functions", "exec"), namespace)
    return namespace


class SendReceipt(unittest.TestCase):
    def test_all_guarded_success_wrappers_return_the_exact_committed_token(self):
        with tempfile.TemporaryDirectory() as folder:
            now = [1_760_000_000.0]
            guard = RuntimeGuard(folder, clock=lambda: now[0], rand=lambda: 0)
            functions = offline_send_functions(guard)
            calls = [
                ("bili_reply", {"bvid": "BV0000000001", "text": "offline comment"}),
                ("bili_reply", {"bvid": "BV0000000002", "rpid": "101", "text": "offline reply"}),
                ("bili_reply_opus", {"opus_id": "123", "rpid": "102", "text": "offline opus reply"}),
                ("bili_send_message", {"receiver_uid": "123", "msg_seqno": "1", "text": "offline dm"}),
                ("bili_send_dynamic", {"text": "offline dynamic"}),
                ("bili_send_opus", {"title": "offline article", "content": "offline text"}),
            ]
            for name, arguments in calls:
                with self.subTest(name=name, arguments=arguments):
                    now[0] += 3601
                    result = json.loads(asyncio.run(functions[name](**arguments)))
                    self.assertTrue(result.get("success"), result)
                    with closing(sqlite3.connect(Path(folder) / "runtime-guard.sqlite3")) as conn:
                        token, status = conn.execute("SELECT token,status FROM guard_entries ORDER BY updated DESC LIMIT 1").fetchone()
                    self.assertEqual(status, "sent")
                    self.assertEqual(result["pace_token"], token)

    def test_rejected_and_unknown_outcomes_never_supply_a_success_token(self):
        with tempfile.TemporaryDirectory() as folder:
            now = [1_760_000_000.0]
            guard = RuntimeGuard(folder, clock=lambda: now[0], rand=lambda: 0)
            send = offline_send_functions(guard)["_guarded_send"]
            for index, code in enumerate((-403, None)):
                now[0] += 3601
                reservation = guard.reserve_send(f"nu:BV{index:010d}")

                async def failed():
                    error = RuntimeError("offline rejection" if code else "offline network ambiguity")
                    if code is not None:
                        error.code = code
                    raise error

                result = asyncio.run(send(guard, reservation, failed))
                self.assertEqual(result["guard_status"], "rejected" if code else "unknown")
                self.assertNotIn("pace_token", result)


if __name__ == "__main__":
    unittest.main(verbosity=2)
