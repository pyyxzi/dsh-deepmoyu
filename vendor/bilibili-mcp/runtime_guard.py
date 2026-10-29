"""Durable, cross-process deduplication for both Bilibili MCP entry paths.

Only state.json and seen.md are read for migration. No credential or message body
is read into this database. Send reservations never expire automatically: after a
crash or an ambiguous network outcome, retrying could publish a second message.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time
import uuid
import math
import random
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

BV_RE = re.compile(r"^BV[0-9A-Za-z]{10}$")
READ_LEASE_SECONDS = 600
READ_TIMEOUT_SECONDS = 180

# Same limits as lib/pace.mjs; SQLite is the common floor for GUI and native MCP.
PACE = {
    "comment": {"gap": 120, "jitter": 60, "hour": 8},
    "reply": {"gap": 60, "jitter": 30, "hour": 15},
    "opusReply": {"gap": 20, "jitter": 10, "hour": 30},
    "dm": {"gap": 30, "jitter": 15, "hour": 20},
    "moment": {"gap": 600, "jitter": 300, "hour": 1},
}
BURST_WINDOW, BURST_MAX, BURST_EXTRA = 600, 10, 180
PACE_KEEP = 7200
RISK_COOLDOWN = {-352: 1200, -412: 3600, -509: 1800, -799: 1800}
QUOTA_PARK, QUOTA_PARK_MAX, QUOTA_DECAY = 2700, 10800, 7200


def _finite(value, default=0):
    try:
        result = float(value) if not isinstance(value, bool) else float(default)
        return result if math.isfinite(result) else float(default)
    except (TypeError, ValueError, OverflowError):
        return float(default)


def pace_kind(key):
    prefix = str(key).split(":", 1)[0]
    return {"nu": "comment", "video": "reply", "opus": "opusReply",
            "opus-reply": "opusReply", "opus-new": "opusReply", "dm": "dm",
            "dm-content": "dm", "moment": "moment"}.get(prefix, "")


def key_moment(channel, payload):
    """Only a content hash is persisted, never message bodies or image paths."""
    packed = json.dumps({"channel": str(channel), "payload": payload}, ensure_ascii=False,
                        sort_keys=True, separators=(",", ":"))
    return "moment:" + hashlib.sha256(packed.encode("utf-8")).hexdigest()


def _quota_reset(now):
    # datetime is local here, just like JavaScript Date.setHours(0, 5, 0, 0).
    local = datetime.fromtimestamp(now)
    until = local.replace(hour=0, minute=5, second=0, microsecond=0)
    while until.timestamp() <= now:
        until += timedelta(days=1)
    return until.timestamp()


def _home(home=None):
    return Path(home or os.environ.get("BILI_GUARD_HOME") or Path(__file__).resolve().parent)


def _iso(stamp):
    return datetime.fromtimestamp(float(stamp), timezone.utc).isoformat().replace("+00:00", "Z")


MAX_SAFE_INTEGER = 9007199254740991


def normalize_id(value, *, allow_zero=True):
    """Validate JSON input before any int coercion; large IDs must be strings."""
    if isinstance(value, bool):
        raise ValueError("ID must be a decimal string or a safe integer")
    if isinstance(value, int):
        if value < 0 or value > MAX_SAFE_INTEGER:
            raise ValueError("ID number must be a non-negative safe integer; pass large IDs as decimal strings")
        text = str(value)
    elif isinstance(value, str):
        text = value.strip()
        if not re.fullmatch(r"[0-9]+", text):
            raise ValueError("ID must be a decimal string or a safe integer")
    else:
        raise ValueError("ID must be a decimal string or a safe integer")
    canonical = text.lstrip("0") or "0"
    if not allow_zero and canonical == "0":
        raise ValueError("ID must be greater than zero")
    return canonical


def _number(value):
    """Legacy/result inspection only: invalid metadata is not a target to send to."""
    try:
        return normalize_id(value, allow_zero=False)
    except (TypeError, ValueError):
        return ""


def stringify_ids(value):
    """Preserve exact SDK integers as decimal strings before JSON reaches JavaScript."""
    id_names = {"id", "rpid", "rpid_str", "root", "parent", "root_rpid", "reply_rpid",
                "oid", "aid", "cid", "uid", "mid", "opus_id", "dynamic_id", "dynamic_id_str",
                "comment_id", "comment_id_str", "msg_seqno", "talker_id", "sender_uid",
                "receiver_uid", "receiver_id", "msg_key", "session_id", "target_id", "item_id",
                "source_id", "root_id", "subject_id", "media_id", "dedeuserid", "rid", "sid"}
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if key in id_names:
                if isinstance(item, int) and not isinstance(item, bool) and item >= 0:
                    result[key] = str(item)  # Python SDK integers are exact, unlike JSON numbers in JS.
                elif isinstance(item, str) and re.fullmatch(r"[0-9]+", item.strip()):
                    result[key] = item.strip().lstrip("0") or "0"
                else:
                    result[key] = ""  # unavailable/malformed is never guessed as another ID
            else:
                result[key] = stringify_ids(item)
        return result
    if isinstance(value, list):
        return [stringify_ids(item) for item in value]
    return value


def key_video_reply(bvid, rpid=0):
    target = normalize_id(rpid)
    if target != "0":
        return "video:" + target
    bvid = str(bvid).strip()
    if not BV_RE.fullmatch(bvid):
        raise ValueError("invalid bvid")
    return "nu:" + bvid


def key_opus_reply(opus_id, rpid=0):
    oid = normalize_id(opus_id, allow_zero=False)
    target = normalize_id(rpid)
    return f"opus-reply:{oid}:{target}" if target != "0" else f"opus-new:{oid}"


def legacy_opus_keys(rpid=0, root=0):
    target = normalize_id(rpid)
    floor = normalize_id(root)
    if target == "0":
        return []
    return list(dict.fromkeys([f"opus-reply:{target}", f"opus:{floor if floor != '0' else target}",
                               f"opus:{target}"]))


def cross_channel_keys(rpid=0):
    """跨通道判重（2026-10-25 修「回一个人一条评论两条消息」）

    同一条评论能从两条路回，以前两条路各记各的键、谁也不认谁：
      · bili_reply(bvid, rpid)         → video:<rpid>
      · bili_reply_opus(opus_id, rpid) → opus-reply:<opusId>:<rpid>
    模型在一条路上回过，换个工具又看到同一条 ⇒ 同一个人收到两条。

    这里给出「同一条评论在**另一条**路上可能叫的名字」，让占坑时一起查。
    视频通道那次查不了 opusId，所以 `RuntimeGuard._reserve` 里还会按
    rpid 后缀扫一遍 opus-reply 键（见 `_cross_channel_row`）。
    """
    target = normalize_id(rpid)
    return [] if target == "0" else ["video:" + target]


def key_dm_reply(uid, text, msg_seqno=0):
    receiver = normalize_id(uid, allow_zero=False)
    seq = normalize_id(msg_seqno)
    if seq != "0":
        return f"dm:{receiver}:{seq}"
    digest = hashlib.sha256(str(text).strip().encode("utf-8")).hexdigest()
    return f"dm-content:{receiver}:{digest}"


def legacy_dm_keys(msg_seqno=0):
    seq = normalize_id(msg_seqno)
    return ["dm:" + seq] if seq != "0" else []


def _safe_meta(record):
    if not isinstance(record, dict):
        return {}
    result = {}
    for name in ("bvid", "title", "uid", "msg_seqno", "opus_id", "rpid", "at"):
        value = record.get(name)
        if isinstance(value, (str, int, float)) and not isinstance(value, bool):
            result[name] = str(value)[:180]
    return result


def _metadata(row):
    try:
        return json.loads(row["meta"] or "{}")
    except (ValueError, TypeError):
        return {}


def _public(row):
    meta = _metadata(row)
    return {**meta, "key": row["key"], "kind": row["kind"], "status": row["status"],
            "at": meta.get("at") or _iso(row["updated"])}


class RuntimeGuard:
    def __init__(self, home=None, read_lease_seconds=READ_LEASE_SECONDS, *, clock=None, rand=None):
        self.home = _home(home)
        self.db_path = self.home / "runtime-guard.sqlite3"
        self.read_lease_seconds = max(1, float(read_lease_seconds))
        self._clock = clock or time.time
        self._rand = rand or random.random
        self.home.mkdir(parents=True, exist_ok=True)
        conn = self._connect()
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("CREATE TABLE IF NOT EXISTS guard_entries ("
                         "key TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, "
                         "token TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL, "
                         "expires REAL, meta TEXT NOT NULL DEFAULT '{}')")
            conn.execute("CREATE TABLE IF NOT EXISTS guard_sources ("
                         "name TEXT PRIMARY KEY, stamp TEXT NOT NULL)")
            conn.execute("CREATE TABLE IF NOT EXISTS guard_pace_events ("
                         "event_key TEXT PRIMARY KEY, kind TEXT NOT NULL, at REAL NOT NULL, "
                         "next REAL NOT NULL, status TEXT NOT NULL, token TEXT NOT NULL DEFAULT '')")
            conn.execute("CREATE INDEX IF NOT EXISTS guard_pace_kind_at ON guard_pace_events(kind,at)")
            conn.execute("CREATE TABLE IF NOT EXISTS guard_pace_state ("
                         "name TEXT PRIMARY KEY, value TEXT NOT NULL)")
        finally:
            conn.close()

    def _connect(self):
        conn = sqlite3.connect(str(self.db_path), timeout=15, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=15000")
        conn.execute("PRAGMA synchronous=FULL")
        return conn

    @contextmanager
    def _transaction(self):
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _pace_factor(self):
        try:
            config = json.loads((self.home / "config.json").read_text(encoding="utf-8-sig"))
            value = config.get("paceFactor", 1) if isinstance(config, dict) else 1
        except (OSError, UnicodeError, ValueError):
            value = 1
        return min(3, max(0.3, _finite(value, 1)))

    @staticmethod
    def _pace_state(conn):
        row = conn.execute("SELECT value FROM guard_pace_state WHERE name='book'").fetchone()
        book = json.loads(row["value"]) if row else {}
        if not isinstance(book, dict):
            raise RuntimeError("invalid shared pace state; refusing an unsafe send")
        return {"cooldown_until": _finite(book.get("cooldown_until")),
                "cooldown_code": str(book.get("cooldown_code") or ""),
                "quota_until": _finite(book.get("quota_until")),
                "quota_strikes": max(0, int(_finite(book.get("quota_strikes"))))}

    @staticmethod
    def _store_pace_state(conn, book):
        conn.execute("INSERT OR REPLACE INTO guard_pace_state(name,value) VALUES ('book',?)",
                     (json.dumps(book, ensure_ascii=False),))

    def _seed_pace(self, conn, raw):
        if not isinstance(raw, dict):
            return
        now, factor = self._clock(), self._pace_factor()

        # JS pins the actual next free time into last[kind].next using the factor that
        # was active when that send happened. Re-deriving it from `recent` with the
        # *current* factor made "switch to careful" lengthen waits that were already
        # fixed (observed: 115s became 355s). Keep the recorded value authoritative.
        last = raw.get("last")
        stored = []
        for kind, row in (last.items() if isinstance(last, dict) else []):
            if isinstance(row, dict):
                at = _finite(row.get("at"))
                nxt = _finite(row.get("next"))
                stored.append((kind, at, nxt if nxt > 0 else None))
            else:
                stored.append((kind, _finite(row), None))

        def recorded_next(kind, at):
            for s_kind, s_at, s_next in stored:
                if s_kind == kind and s_next and abs(s_at - at) <= 2000:
                    return s_next
            return None

        def event(kind, stamp, next_stamp=None, pinned=False):
            at = _finite(stamp) / 1000
            if kind not in PACE or at <= 0:
                return
            free = _finite(next_stamp) / 1000 if next_stamp is not None else at + PACE[kind]["gap"] * factor
            free = max(at, free)
            if at < now - PACE_KEEP and free <= now:
                return
            # GUI records success just after Python does. Reconcile that one event,
            # not a second send; distinct pre-upgrade seed records remain distinct.
            native = conn.execute("SELECT event_key,next FROM guard_pace_events "
                                  "WHERE kind=? AND status='sent' AND token<>'' AND ABS(at-?)<=2 "
                                  "ORDER BY ABS(at-?) LIMIT 1", (kind, at, at)).fetchone()
            if native:
                # The host already pinned this interval (one random draw, shown in the GUI).
                # Python's own independent draw must not silently lengthen it — otherwise the
                # UI says "40s left" while the native guard still waits 90s.
                if pinned:
                    conn.execute("UPDATE guard_pace_events SET next=? WHERE event_key=?",
                                 (free, native["event_key"]))
                else:
                    conn.execute("UPDATE guard_pace_events SET next=MAX(next,?) WHERE event_key=?",
                                 (free, native["event_key"]))
                return
            key = f"seed:{kind}:{int(round(at * 1000))}"
            conn.execute("INSERT INTO guard_pace_events(event_key,kind,at,next,status,token) "
                         "VALUES (?,?,?,?,'seed','') ON CONFLICT(event_key) DO UPDATE SET next=MAX(next,excluded.next)",
                         (key, kind, at, free))

        recent = raw.get("recent")
        for row in (recent[-200:] if isinstance(recent, list) else []):
            if isinstance(row, dict):
                kind, at = str(row.get("k") or ""), _finite(row.get("t"))
                nxt = recorded_next(kind, at)
                event(kind, at, nxt, pinned=nxt is not None)
        for kind, at, nxt in stored:
            event(kind, at, nxt, pinned=nxt is not None)
        book = self._pace_state(conn)
        cool = _finite(raw.get("cooldownUntil")) / 1000
        if cool > book["cooldown_until"]:
            book["cooldown_until"], book["cooldown_code"] = cool, str(raw.get("cooldownCode") or "")
        quota, strikes = raw.get("quota"), raw.get("quotaStrikes")
        until = _finite(quota.get("comment")) / 1000 if isinstance(quota, dict) else 0
        n = _finite(strikes.get("comment")) if isinstance(strikes, dict) else 0
        book["quota_until"] = max(book["quota_until"], until)
        book["quota_strikes"] = max(book["quota_strikes"], max(0, int(n)))
        self._store_pace_state(conn, book)

    def _seed_native_pace(self, conn, now):
        if conn.execute("SELECT 1 FROM guard_sources WHERE name='pace-sqlite-v1'").fetchone():
            return
        factor = self._pace_factor()
        rows = conn.execute("SELECT * FROM guard_entries WHERE kind='send' AND token<>'' AND updated>=?",
                            (now - PACE_KEEP,)).fetchall()
        for row in rows:
            action = pace_kind(row["key"])
            if not action:
                continue
            spec = PACE[action]
            delay = (spec["gap"] + spec["jitter"] * min(1, max(0, _finite(self._rand())))) * factor
            conn.execute("INSERT OR IGNORE INTO guard_pace_events(event_key,kind,at,next,status,token) "
                         "VALUES (?,?,?,?,?,?)", ("send:" + row["token"], action, row["updated"],
                         row["updated"] + delay, row["status"], row["token"]))
        conn.execute("INSERT INTO guard_sources(name,stamp) VALUES ('pace-sqlite-v1','1')")

    @staticmethod
    def _pace_check(conn, action, now):
        if action not in PACE:
            return {"allowed": True}
        book = RuntimeGuard._pace_state(conn)
        events = conn.execute("SELECT kind,at,next FROM guard_pace_events WHERE at>=? OR next>? ORDER BY at",
                              (now - PACE_KEEP, now)).fetchall()
        gates = []
        if book["cooldown_until"] > now:
            gates.append(("cooldown", book["cooldown_until"]))
        if action in ("comment", "reply") and book["quota_until"] > now:
            gates.append(("quota", book["quota_until"]))
        burst = [row for row in events if row["at"] >= now - BURST_WINDOW]
        if len(burst) >= BURST_MAX:
            free = burst[-BURST_MAX]["at"] + BURST_WINDOW + (BURST_EXTRA if len(burst) >= BURST_MAX + 3 else 0)
            if free > now:
                gates.append(("burst", free))
        same = [row for row in events if row["kind"] == action]
        hourly = [row for row in same if row["at"] >= now - 3600]
        if len(hourly) >= PACE[action]["hour"]:
            free = hourly[-PACE[action]["hour"]]["at"] + 3600
            if free > now:
                gates.append(("hour", free))
        free = max((row["next"] for row in same), default=0)
        if free > now:
            gates.append(("gap", free))
        if not gates:
            return {"allowed": True}
        retry = max(until for _, until in gates)
        wait_ms = int(math.ceil(max(0, retry - now) * 1000))
        return {"allowed": False, "status": "paced", "pace": True, "pace_kind": action,
                "reason": gates[0][0], "retry_at": _iso(retry), "retryAt": _iso(retry),
                "wait_ms": wait_ms, "waitMs": wait_ms,
                "wait_seconds": int(math.ceil(wait_ms / 1000)), "waitSec": int(math.ceil(wait_ms / 1000)),
                "used": len(hourly), "cap": PACE[action]["hour"],
                "cooldown_code": book["cooldown_code"] if gates[0][0] == "cooldown" else ""}

    def _note_rejection(self, conn, code, now):
        book = self._pace_state(conn)
        code = int(code) if code is not None else None
        if code == 12014:
            previous = book["quota_until"]
            strikes = (0 if previous > 0 and now - previous > QUOTA_DECAY else book["quota_strikes"]) + 1
            delay = min(QUOTA_PARK * 2 ** (min(6, strikes) - 1), QUOTA_PARK_MAX)
            book["quota_until"] = max(previous, min(now + delay, _quota_reset(now)))
            book["quota_strikes"] = strikes
        elif code in RISK_COOLDOWN:
            book["cooldown_until"] = max(book["cooldown_until"], now + RISK_COOLDOWN[code])
            book["cooldown_code"] = str(code)
        self._store_pace_state(conn, book)

    @staticmethod
    def _import_one(conn, key, kind, record):
        now = time.time()
        meta = json.dumps(_safe_meta(record), ensure_ascii=False)
        conn.execute("INSERT OR IGNORE INTO guard_entries "
                     "(key,kind,status,token,created,updated,expires,meta) "
                     "VALUES (?,?,?,'',?,?,NULL,?)",
                     (key, kind, "seen" if kind == "read" else "sent", now, now, meta))

    def _import_state(self, conn, data):
        if not isinstance(data, dict):
            raise ValueError("state.json must contain an object")
        self._seed_pace(conn, data.get("pace"))
        for bvid, rec in (data.get("seenVideos") or {}).items():
            if BV_RE.fullmatch(str(bvid)):
                self._import_one(conn, "seen:" + bvid, "read", {**_safe_meta(rec), "bvid": bvid})
        for key, rec in (data.get("repliedComments") or {}).items():
            key = str(key)
            if key.isdigit():
                key = "video:" + key
            if key.startswith(("video:", "nu:", "opus:", "opus-reply:", "opus-new:")):
                self._import_one(conn, key, "send", rec)
        for key, rec in (data.get("dmReplied") or {}).items():
            key = str(key)
            if key.isdigit():
                key = "dm:" + key
            if not key.startswith(("dm:", "dm-content:")):
                continue
            # Old records with a known receiver can retain per-conversation scope.
            seq = key[3:] if key.startswith("dm:") else ""
            receiver = _number(rec.get("uid")) if isinstance(rec, dict) else ""
            if seq.isdigit() and receiver:
                key = f"dm:{receiver}:{seq}"
            self._import_one(conn, key, "send", rec)

    def _import_markdown(self, conn, text):
        comment_table = False
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                comment_table = False
            if not stripped.startswith("|"):
                continue
            cells = [cell.strip() for cell in stripped.strip("|").split("|")]
            if cells and cells[0] == "BV":
                comment_table = any("rpid" in cell.lower() for cell in cells[1:3])
                continue
            if not cells or not BV_RE.fullmatch(cells[0]):
                continue
            bvid = cells[0]
            match = re.search(r"20\d{2}-\d{2}-\d{2}", line)
            record = {"bvid": bvid, "at": match.group() if match else ""}
            self._import_one(conn, "seen:" + bvid, "read", record)
            # Markdown rpid is our published comment ID, not the replied-to ID.
            # Only a row with no root safely proves a new top-level comment.
            if comment_table and len(cells) > 2 and _number(cells[1]) and not _number(cells[2]):
                self._import_one(conn, "nu:" + bvid, "send", record)

    def _import_legacy(self, conn):
        for name in ("state.json", "seen.md"):
            source = self.home / name
            try:
                stat = source.stat()
            except FileNotFoundError:
                continue
            stamp = f"{stat.st_mtime_ns}:{stat.st_size}"
            previous = conn.execute("SELECT stamp FROM guard_sources WHERE name=?", (name,)).fetchone()
            if previous and previous["stamp"] == stamp:
                continue
            # A concurrent partial legacy write must fail closed, never erase imports.
            try:
                text = source.read_text(encoding="utf-8-sig")
                if name == "state.json":
                    self._import_state(conn, json.loads(text))
                else:
                    self._import_markdown(conn, text)
            except (OSError, UnicodeError, ValueError, AttributeError, TypeError) as exc:
                raise RuntimeError(f"cannot import {name}: {type(exc).__name__}") from exc
            conn.execute("INSERT OR REPLACE INTO guard_sources(name,stamp) VALUES (?,?)", (name, stamp))

    def refresh_legacy(self):
        with self._transaction() as conn:
            self._import_legacy(conn)

    def _cross_channel_row(self, conn, key):
        """同一条评论换个通道记过的行（2026-10-25 跨通道判重）。

        · 视频通道（`video:<rpid>`）：视频评论没有「哪条动态」这层，
          账本里**任意** `opus-reply:*:<rpid>` 都算同一条评论 ⇒ 按 rpid 对称扫。
        · 动态通道（`opus-reply:<opusId>:<rpid>`）：只额外认 `video:<rpid>`
          （由调用方作为 legacy key 传入），**不**认别的动态下的 `opus-reply:<别的opus>:<rpid>` ——
          动态楼层在别处同号是可能的，认了就会静默漏回（2026-10-20 的那个坑）。

        宁可判成「回过了」不要判成「没回过」：重复回是对着同一个人刷屏。
        """
        parts = key.split(":")
        if len(parts) == 2 and parts[0] == "video":
            target = parts[1]
            # 后缀比较必须整段相等：'opus-reply:<opusId>:<rpid>' 的末尾正好是 ':rpid'。
            # （别写成 substr(key, -length(?)-1) —— 那会整体错一位，取到 '4' 这种碎片，
            #   结果就是对谁都不拦，跟没改一样。）
            row = conn.execute(
                "SELECT * FROM guard_entries WHERE key LIKE 'opus-reply:%' AND "
                "(key = ? OR substr(key, -length(?)) = ?) LIMIT 1",
                ("opus-reply:" + target, ":" + target, ":" + target)).fetchone()
            if row is not None:
                return row
        return None

    def _reserve(self, key, kind, legacy_keys=()):
        now = self._clock()
        with self._transaction() as conn:
            self._import_legacy(conn)
            self._seed_native_pace(conn, now)
            conn.execute("DELETE FROM guard_pace_events WHERE at<? AND next<=?", (now - PACE_KEEP, now))
            candidates = list((key, *legacy_keys))
            if kind == "send":
                extra = self._cross_channel_row(conn, key)
                if extra is not None:
                    candidates.append(extra["key"])
            for candidate in candidates:
                row = conn.execute("SELECT * FROM guard_entries WHERE key=?", (candidate,)).fetchone()
                if row is None:
                    continue
                if candidate != key:
                    parts = key.split(":")
                    meta = _metadata(row)
                    if len(parts) == 3 and parts[0] == "opus-reply":
                        oid, target = _number(meta.get("opus_id")), _number(meta.get("rpid"))
                        if (oid and oid != parts[1]) or (target and target != parts[2]):
                            continue
                    if len(parts) == 3 and parts[0] == "dm":
                        uid, seq = _number(meta.get("uid")), _number(meta.get("msg_seqno"))
                        if (uid and uid != parts[1]) or (seq and seq != parts[2]):
                            continue
                    # Unknown legacy scope is kept conservative: do not replay an uncertain send.
                if (kind == "read" and candidate == key and row["kind"] == "read"
                        and row["status"] == "pending" and (row["expires"] or 0) <= now):
                    conn.execute("DELETE FROM guard_entries WHERE key=? AND token=?", (key, row["token"]))
                    continue
                return {"allowed": False, **_public(row)}
            action = pace_kind(key) if kind == "send" else ""
            pace = self._pace_check(conn, action, now)
            if not pace["allowed"]:
                return {**pace, "key": key, "kind": kind}
            token = uuid.uuid4().hex
            expires = now + self.read_lease_seconds if kind == "read" else None
            conn.execute("INSERT INTO guard_entries "
                         "(key,kind,status,token,created,updated,expires,meta) "
                         "VALUES (?,?,'pending',?,?,?,?, '{}')", (key, kind, token, now, now, expires))
            if action:
                spec = PACE[action]
                delay = (spec["gap"] + spec["jitter"] * min(1, max(0, _finite(self._rand())))) * self._pace_factor()
                conn.execute("INSERT INTO guard_pace_events(event_key,kind,at,next,status,token) "
                             "VALUES (?,?,?,?,'pending',?)", ("send:" + token, action, now, now + delay, token))
            return {"allowed": True, "key": key, "kind": kind, "status": "pending", "token": token}

    def reserve_read(self, bvid):
        bvid = str(bvid).strip()
        if not BV_RE.fullmatch(bvid):
            raise ValueError("invalid bvid")
        return self._reserve("seen:" + bvid, "read")

    def reserve_send(self, key, legacy_keys=()):
        if not key:
            raise ValueError("empty send key")
        return self._reserve(str(key), "send", legacy_keys)

    def _finish(self, reservation, status, record=None):
        meta = json.dumps(_safe_meta(record), ensure_ascii=False)
        now = self._clock()
        with self._transaction() as conn:
            changed = conn.execute("UPDATE guard_entries SET status=?,updated=?,expires=NULL,meta=? "
                                   "WHERE key=? AND token=? AND status='pending'",
                                   (status, now, meta, reservation["key"], reservation["token"])).rowcount
            if changed != 1:
                raise RuntimeError("guard reservation was lost; refusing an unsafe retry")
            action = pace_kind(reservation["key"]) if reservation.get("kind") == "send" else ""
            if action:
                event_key = "send:" + reservation["token"]
                event = conn.execute("SELECT at,next FROM guard_pace_events WHERE event_key=?", (event_key,)).fetchone()
                delay = max(0, event["next"] - event["at"]) if event else PACE[action]["gap"] * self._pace_factor()
                conn.execute("INSERT INTO guard_pace_events(event_key,kind,at,next,status,token) "
                             "VALUES (?,?,?,?,?,?) ON CONFLICT(event_key) DO UPDATE SET "
                             "at=excluded.at,next=excluded.next,status=excluded.status",
                             (event_key, action, now, now + delay, status, reservation["token"]))

    def commit_read(self, reservation, record=None):
        self._finish(reservation, "seen", record)

    def commit_send(self, reservation, record=None):
        self._finish(reservation, "sent", record)

    def mark_unknown(self, reservation, record=None):
        self._finish(reservation, "unknown", record)

    def release(self, reservation):
        """Only use for failed reads or a send proven not to have started."""
        with self._transaction() as conn:
            changed = conn.execute("DELETE FROM guard_entries WHERE key=? AND token=? AND status='pending'",
                                   (reservation["key"], reservation["token"])).rowcount == 1
            if changed:
                conn.execute("DELETE FROM guard_pace_events WHERE event_key=? AND status='pending'",
                             ("send:" + reservation["token"],))
            return changed

    def reject_send(self, reservation, code=None):
        """Explicit remote rejection: release dedup + slot, persist risk/quota atomically."""
        now = self._clock()
        with self._transaction() as conn:
            changed = conn.execute("DELETE FROM guard_entries WHERE key=? AND token=? AND status='pending'",
                                   (reservation["key"], reservation["token"])).rowcount
            if changed != 1:
                raise RuntimeError("guard reservation was lost; refusing an unsafe retry")
            conn.execute("DELETE FROM guard_pace_events WHERE event_key=?", ("send:" + reservation["token"],))
            self._note_rejection(conn, code, now)
            return self._pace_check(conn, pace_kind(reservation["key"]), now)

    def pace_status(self, action):
        """Read the current common floor without reserving or consuming a send slot."""
        with self._transaction() as conn:
            self._import_legacy(conn)
            self._seed_native_pace(conn, self._clock())
            return self._pace_check(conn, action, self._clock())

    def snapshot(self, bvids=None, limit=200):
        return guard_snapshot(self.home, bvids=bvids, limit=limit)


def guard_snapshot(home=None, bvids=None, limit=200):
    """Read-only bounded view; never creates a database or touches legacy files."""
    db = _home(home) / "runtime-guard.sqlite3"
    result = {"storage": "sqlite3", "counts": {"seen": 0, "sent": 0, "pending": 0, "unknown": 0},
              "seenVideos": {}, "activeReads": [], "recentSends": []}
    if not db.is_file():
        return result
    limit = max(1, min(int(limit or 200), 500))
    conn = sqlite3.connect(db.resolve().as_uri() + "?mode=ro", uri=True, timeout=15)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA query_only=ON")
        conn.execute("BEGIN")
        for row in conn.execute("SELECT status,COUNT(*) AS n FROM guard_entries GROUP BY status"):
            result["counts"][row["status"]] = row["n"]
        if bvids is None:
            rows = conn.execute("SELECT * FROM guard_entries WHERE kind='read' AND status='seen' "
                                "ORDER BY updated DESC LIMIT ?", (limit,)).fetchall()
        else:
            keys = list(dict.fromkeys("seen:" + str(b).strip() for b in bvids
                                      if BV_RE.fullmatch(str(b).strip())))[:500]
            rows = (conn.execute("SELECT * FROM guard_entries WHERE status='seen' AND key IN ("
                                 + ",".join("?" for _ in keys) + ")", keys).fetchall() if keys else [])
        for row in rows:
            public = _public(row)
            result["seenVideos"][row["key"][5:]] = {"at": public["at"], "title": public.get("title", "")}
        now = time.time()
        result["activeReads"] = [row["key"][5:] for row in conn.execute(
            "SELECT key FROM guard_entries WHERE kind='read' AND status='pending' AND expires>? LIMIT ?",
            (now, limit))]
        result["recentSends"] = [_public(row) for row in conn.execute(
            "SELECT * FROM guard_entries WHERE kind='send' ORDER BY updated DESC LIMIT ?", (limit,))]
        tables = {row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if {"guard_pace_events", "guard_pace_state"} <= tables:
            result["pace"] = {action: RuntimeGuard._pace_check(conn, action, now) for action in PACE}
    finally:
        conn.close()
    return result


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Read a bounded, credential-free guard snapshot")
    parser.add_argument("--home")
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--bvid", action="append", dest="bvids")
    args = parser.parse_args()
    print(json.dumps(guard_snapshot(args.home, args.bvids, args.limit), ensure_ascii=False))
