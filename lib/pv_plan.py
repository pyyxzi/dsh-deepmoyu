#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Turn dated public activity notes into a source-backed original dialogue.

The second speaker is an imagined inner fish, never a real correspondent.
No private messages, account identities, undated memories or fixed daily facts
are used. Report notes are attributed as notes, not treated as video transcripts.
The --facts/--json/--auto CLI remains compatible with the Node coordinator.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

TZ = timezone(timedelta(hours=8))
BV_RE = re.compile(r"^###\s+(BV[0-9A-Za-z]{10})\b\s*(.*)$")
PRIVATE_RE = re.compile(r"私信|rpid|\buid\b|msg_seqno|[A-Za-z]:[\\/]|/开发者模式|\d{10,}", re.I)


def find_home(explicit: str = "") -> Path:
    if explicit:
        return Path(explicit)
    if os.environ.get("BILI_DUTY_HOME", "").strip():
        return Path(os.environ["BILI_DUTY_HOME"])
    if os.environ.get("DSH_HOME", "").strip():
        return Path(os.environ["DSH_HOME"]) / "bili-duty"
    if os.environ.get("APPDATA"):
        return Path(os.environ["APPDATA"]) / "dsh-desktop" / "harness" / "bili-duty"
    return Path.home() / ".dsh" / "bili-duty"


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def json_lines(path: Path):
    try:
        with path.open(encoding="utf-8", errors="replace") as handle:
            for number, line in enumerate(handle, 1):
                try:
                    row = json.loads(line)
                except (ValueError, TypeError):
                    continue
                if isinstance(row, dict):
                    yield number, row
    except OSError:
        return


def load_activity(home: Path, date: str = "") -> list[dict]:
    """Read durable activity identities plus legacy projections, without mutating them."""
    rows, seen = [], set()

    def accept(raw, path, line_no, event_id=""):
        row = dict(raw)
        stamp = row.get("t")
        if not isinstance(stamp, (int, float)) or isinstance(stamp, bool):
            return
        if date and day_of(stamp) != date:
            return
        event_id = event_id or str(row.get("eventId") or "")
        legacy = ((row.get("seq"), stamp) if row.get("seq") is not None else
                  (stamp, row.get("kind"), row.get("tool"), str(row.get("text"))))
        keys = [("legacy", legacy)] + ([("event", event_id)] if event_id else [])
        if any(key in seen for key in keys):
            return
        seen.update(keys)
        row["_source"] = {"file": path.relative_to(home).as_posix(), "line": line_no}
        if event_id:
            row["_source"]["eventId"] = event_id
        rows.append(row)

    indexes = sorted((home / "records" / "days").glob(f"{date or '*'}.jsonl"))
    for index in indexes:
        for line_no, entry in json_lines(index):
            event_id = str(entry.get("eventId") or "")
            if not re.fullmatch(r"[a-f0-9]{64}", event_id):
                continue
            path = home / "records" / "events" / event_id[:2] / f"{event_id}.json"
            try:
                event = json.loads(read_text(path))
            except (ValueError, TypeError):
                continue
            if not isinstance(event, dict) or event.get("type") != "activity":
                continue
            data = event.get("data")
            if isinstance(data, dict):
                accept(data, index, line_no, event_id)

    candidates = [home / "activity.jsonl"]
    candidates += sorted((p for p in home.glob("activity.jsonl.*")
                          if p.name[len("activity.jsonl."):].isdigit()),
                         key=lambda p: int(p.name[len("activity.jsonl."):]))
    candidates += sorted((home / "records" / "activity").glob(f"{date or '*'}/*.jsonl"))
    for path in candidates:
        for line_no, row in json_lines(path):
            accept(row, path, line_no)
    return sorted(rows, key=lambda row: row["t"])


def day_of(ms: float) -> str:
    try:
        return datetime.fromtimestamp(ms / 1000, TZ).strftime("%Y-%m-%d")
    except (ValueError, OverflowError, OSError):
        return ""


def strip_md(text: str) -> str:
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", str(text or ""))
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"\[?\d{1,2}:\d{2}(?:\.\d+)?\]?", "", text)
    text = re.sub(r"(?<!\w)t\s*=\s*\d+(?:\.\d+)?(?:[–~-]\d+(?:\.\d+)?)?", "", text)
    return re.sub(r"\s+", " ", text.replace("**", "").replace("`", "")).strip(" ·—-|｜")


def clip(text: str, length: int) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= length else text[:length - 1] + "…"


def clean_title(text: str) -> str:
    link = re.match(r"\s*\[([^\]]+)\]\([^)]*\)", text)
    if link:
        return strip_md(link.group(1))[:80]
    quoted = re.match(r"[「《](.+?)[」》](?:\s*[·｜|]|$)", text)
    if quoted:
        return strip_md(quoted[1])[:80]
    text = re.split(r"[｜|]|\s*·\s*|\s+[—–]\s+", text)[0]
    text = re.sub(r"^[（(][^）)]{0,30}[）)]", "", text)
    return strip_md(text).strip("《》\"“” ")[:80]


def public_excerpt(text: str, limit: int = 40) -> str:
    """Select one contiguous public note sentence; never infer missing content."""
    # A bullet often contains replies or private records even inside a BV block.
    for line in text.splitlines():
        if line.lstrip().startswith(("-", "#", ">", "|")) or PRIVATE_RE.search(line):
            continue
        # Emphasized prose is usually the author's actual pick judgment;
        # the first body sentence often contains only title/author/play counts.
        highlighted = [part for part in re.findall(r"\*\*(.+?)\*\*", line)
                       if len(part) >= 10 and not PRIVATE_RE.search(part)]
        if highlighted:
            return clip(strip_md(highlighted[0]), limit)
        if "｜" in line:
            line = line.split("｜", 1)[1]
        elif re.match(r"\s*\[.+?\]\(https?://", line):
            line = re.sub(r"^\s*\[.+?\]\(https?://[^)]*\)", "", line)
        line = re.split(r"评论区|私信|本轮回复|本轮评论", line)[0]
        for sentence in re.split(r"(?<=[。！？!?；])", strip_md(line)):
            sentence = sentence.strip(" ·—-，,：:；;⚠️")
            if not 10 <= len(sentence) <= 200 or PRIVATE_RE.search(sentence):
                continue
            # Avoid reading a bare metadata line as a supposedly meaningful note.
            if len(sentence) < 38 and re.search(r"播放|万播|秒。?$|分钟。?$|UP[:：]", sentence):
                continue
            if len(sentence) > limit:
                stops = [sentence.rfind(mark, 10, limit) for mark in "，,；;：:"]
                end = max(stops)
                sentence = sentence[:end] if end >= 10 else sentence[:limit - 1] + "…"
            return sentence.rstrip("。！？!?；; ") + "。"
    return ""


def parse_report(home: Path, date: str) -> dict:
    path = home / "out" / f"{date}.md"
    text = read_text(path)
    picks, current = [], None
    for number, line in enumerate(text.splitlines(), 1):
        match = BV_RE.match(line)
        if match:
            if current:
                picks.append(current)
            current = {"bv": match[1], "head": match[2], "line": number, "lines": []}
        elif line.startswith("## "):
            if current:
                picks.append(current)
                current = None
        elif current is not None:
            current["lines"].append(line)
    if current:
        picks.append(current)
    best = {}
    for pick in picks:
        body = "\n".join(pick["lines"])
        first = next((line for line in pick["lines"] if line.strip() and not line.startswith(("-", "#"))), "")
        title = clean_title(pick["head"])
        if len(title) < 3 or title.startswith(("（", "(")):
            title = clean_title(first)
        if not title or PRIVATE_RE.search(title):
            continue
        why_match = re.search(r"为什么值得[^：:\n]*[：:]\s*(.+)", body)
        note = public_excerpt(why_match[1] if why_match else body)
        source = {"kind": "public-report-note", "file": f"out/{date}.md",
                  "line": pick["line"], "bvid": pick["bv"],
                  "url": f"https://www.bilibili.com/video/{pick['bv']}",
                  "title": title, "excerpt": note,
                  "digest": hashlib.sha256(body.encode("utf-8")).hexdigest()}
        item = {"bv": pick["bv"], "title": title, "why": note, "source": source}
        if pick["bv"] not in best or (note and not best[pick["bv"]]["why"]):
            best[pick["bv"]] = item
    return {"exists": bool(text), "picks": list(best.values())}


def gather(home: Path, date: str) -> dict:
    day = load_activity(home, date)
    report = parse_report(home, date)
    count = lambda tool: sum(row.get("kind") == "done" and row.get("tool") == tool for row in day)
    stats = {"rows": len(day), "rounds": sum(row.get("kind") == "round" for row in day),
             "picks": len(report["picks"]), "searches": count("bili_search"),
             "fails": sum(row.get("kind") == "fail" for row in day)}
    return {"date": date, "stats": stats, "picks": report["picks"],
            "report_exists": report["exists"],
            "coverage": "仅使用当日公开选片笔记；不含私信、账号归属或未注明日期的心情。"}


def facts_text(g: dict) -> str:
    lines = [f"# {g['date']} 公开视频素材", g["coverage"],
             f"保留的活动记录 {g['stats']['rows']} 条，公开选片 {len(g['picks'])} 条。"]
    for pick in g["picks"]:
        source = pick["source"]
        lines += [f"- {pick['bv']} 《{pick['title']}》", f"  当时的笔记：{pick['why'] or '只有标题，没有可用正文。'}",
                  f"  来源：{source['file']}:{source['line']} · {source['url']}"]
    return "\n".join(lines)


# ─────────────────────── 时长预算：收口到 ~150s ───────────────────────
# ⭐ 2026-10-26：auto_plan 以前没有总时长预算，素材多一天片子就长、少一天就短，
#   片长漂移到哪算哪。现在规划期就收口到 135~165s。中文旁白按 **4.4 字/秒** 估
#   —— 初版用 3.8（教科书语速），实测 19 镜真机 edge-tts（fish +8% / inner +12% rate）
#   逐句 PCM 只有估算的 76%（≈4.2~4.5 字/秒）⇒ 估 143.8s 实拍 109.9s，全线偏短；
#   按 4.4 校准后估算与实测贴齐（±5%）。**正式时长永远以 pv.py 逐句实测的 PCM 为准**
#   （prepare_audio → make_timeline），规划只是收口，两边不共享数值。
TARGET_SECONDS = 150        # 成品目标时长（秒），容差 ±10% ⇒ 135~165s
TOLERANCE = 0.10
SPEECH_RATE = 4.4           # edge-tts zh-CN 实测校准语速（字/秒），改音速记得重校
SHOT_OVERHEAD = 0.35        # 每镜 gap + lead + 换气的近似固定开销（秒）
MIN_SHOT_SPEECH = 2.0       # 再短的台词也按 2s 起算（含起振/收音，别按字数算出 0.5s）
MAX_SHOT_CHARS = 84         # 单镜旁白上限 ≈84 字（84/4.4 + 0.35 ≈ 19.5s ≈ 20s）
CLOSING_LINES = ("所以，这碗白米饭终于能吃了？",      # ⚠️ 收尾两镜的台词在这里和
                 "等本鱼把笔记放好。饭要趁热，脑袋也要开工。")  # auto_plan 各出现一次，改时两处同步


def est_dur(shot: dict) -> float:
    """单镜时长估算：max(2.0, 字数/3.8) + 0.35。"""
    return max(MIN_SHOT_SPEECH, len(str(shot.get("text") or "")) / SPEECH_RATE) + SHOT_OVERHEAD


def plan_seconds(shots: list) -> float:
    return sum(est_dur(shot) for shot in shots)


def _truncate_monologue(text: str, limit: int = MAX_SHOT_CHARS) -> str:
    """超长独白截断到句边界并补“……”表达省略语义 —— 不整句硬切，观众才知道是节选。"""
    text = str(text or "").strip()
    if len(text) <= limit:
        return text
    cut = -1
    for mark in "。！？!?；;…":
        cut = max(cut, text.rfind(mark, 0, limit))
    if cut < limit // 2:                      # 前半句找不到句末标点 ⇒ 退到分句标点
        for mark in "，,、：:":
            cut = max(cut, text.rfind(mark, 0, limit))
    if cut < limit // 2:                      # 连分句都没有 ⇒ 硬截保底，绝不放超长独白
        cut = limit - 2
    return text[:cut + 1].rstrip() + "……"


def _keep_rank(shot: dict, sources_by_id: dict) -> int:
    """砍镜优先级：越大越保命。2=带 BV 视频引用 > 1=引用/数据镜 > 0=纯闲谈。"""
    ids = shot.get("source_ids") or []
    if ids and any(sources_by_id.get(sid, {}).get("bvid") for sid in ids):
        return 2
    if ids or shot.get("provenance") == "record-adaptation":
        return 1
    return 0


def _fit_budget(shots: list, sources: list, spare_picks: list, add_extra, reserved: float = 0.0):
    """生成完 shots 之后做预算收口（原地改 shots/sources）。规则按先后：

    ① 压超长独白：单镜超 ~84 字（≈22s）先截到句边界加“……”——比整镜丢弃更保内容；
    ② 超 165s：按 _keep_rank 砍镜，同类里砍靠后的；首镜（开场）永不砍，砍到只剩
       3 镜就停（宁超时长也不出空片）。砍掉的镜对应的 sources **故意保留**——
       pv_cover.py 会从 sources 里挑封面标题，动它会改变封面选词；孤儿 source 无副作用；
    ③ 低于 135s 且还有没用过的公开笔记：补一组「念笔记 + 接一句」（每组 ≈25s，
       入口阈值 135s ⇒ 最多冲到 ~160s，仍在容差内）；素材用完就停——**宁短勿凑**，
       拿不到素材不硬编内容凑时长。
    """
    hi, lo = TARGET_SECONDS * (1 + TOLERANCE), TARGET_SECONDS * (1 - TOLERANCE)

    def total() -> float:
        return plan_seconds(shots) + reserved     # reserved = 还没 append 的收尾两镜

    for shot in shots:                            # ①
        if len(str(shot.get("text") or "")) > MAX_SHOT_CHARS:
            shot["text"] = _truncate_monologue(shot["text"])

    if total() > hi:                              # ②
        by_id = {source.get("id"): source for source in sources if source.get("id")}
        while total() > hi and len(shots) > 3:
            candidates = sorted(range(1, len(shots)),
                                key=lambda i: (_keep_rank(shots[i], by_id), -i))
            shots.pop(candidates[0])

    while total() < lo and spare_picks:           # ③
        add_extra(spare_picks.pop(0))


def auto_plan(g: dict, out: str = "", no_net: bool = False,
              gsv: dict | None = None, first: bool = False) -> dict:
    """Original skit anchored in dated public notes, with explicit claim sources."""
    shots, sources = [], []
    def add(speaker, text, camera, expression="neutral", source=None, prop="rice", beat=""):
        shot = {"kind": "dialogue", "speaker": speaker, "text": text,
                "camera": camera, "expression": expression, "prop": prop, "beat": beat,
                "pause_after": 0.22 if speaker == "fish" else 0.12,
                "provenance": "record-adaptation" if source else "original-dialogue",
                "source_ids": [source] if source else []}
        if speaker == "inner":
            shot["voice"] = {"name": "zh-CN-YunxiNeural", "rate": "+12%", "pitch": "+0Hz", "mode": "edge"}
        shots.append(shot)
    if first:
        add("fish", "本鱼是大肥鱼。脑袋里还住着一条爱接话的小鱼。", "wide", "happy", beat="开场")
    add("inner", "先交代一下，今天脑袋里装的是知识，还是白米饭？", "reverse", "question", beat="拌嘴")
    add("fish", "饭先放旁边，给知识腾个位置。", "close", "surprised")
    usable = [pick for pick in g.get("picks", []) if pick.get("why")]
    selected, spare = usable[:1], usable[1:]
    if not selected:
        add("fish", "这天没留下能用的公开选片笔记，本鱼先不编故事。", "medium", "worried", beat="空白记录")
        add("inner", "那这个空碗，是不是可以先收起来？", "insert", "question")
        add("fish", "碗留下。脑袋可以空，饭碗不能丢。", "push", "happy")
    for index, pick in enumerate(selected, 1):
        source_id = f"note-{index}"
        sources.append(dict(pick["source"], id=source_id))
        title = clip(pick["title"], 26)
        add("fish", f"这天的记录里，留了《{title}》。", "medium", "neutral", source_id, "note", "翻笔记")
        add("inner", "先别急着点头。你当时记下了什么？", "reverse", "question")
        add("fish", f"当时记的是：{pick['why']}", "push", "thinking", source_id, "note")
        add("inner", "哦，饭可以一口吞，理解还得嚼两下。", "close-inner", "happy")
        add("fish", "这句你说得像个厨子。还挺有道理。", "close", "happy")

    # ⭐ 2026-10-26：时长预算收口 —— 收尾两镜还没生成，先把它们的估算量记进预算
    #   （reserved），收口完成后再 append，这样补的镜头永远落在收尾之前，叙事不乱序。
    def extra_note(pick):
        """预算不足时补的一组镜头：念一条没用过的公开笔记 + 小鱼接一句（两条轮换）。"""
        note_no = len(sources) + 1
        source_id = f"note-{note_no}"
        sources.append(dict(pick["source"], id=source_id))
        note = _truncate_monologue(
            f"另一条笔记写着：《{clip(pick['title'], 26)}》——{pick['why']}")
        add("fish", note, "medium", "thinking", source_id, "note", "翻笔记")
        add("inner", ("嗯，这条也记上，别到时候又说不清。", "又攒一条，慢慢消化，别一口吞。")[note_no % 2 == 0],
            "close-inner", "happy")
    _fit_budget(shots, sources, spare, extra_note,
                reserved=sum(est_dur({"text": line}) for line in CLOSING_LINES))

    add("inner", CLOSING_LINES[0], "insert", "question", beat="回扣")
    add("fish", CLOSING_LINES[1], "wide", "happy")
    voice = {"name": "zh-CN-XiaoyiNeural", "rate": "+8%", "pitch": "+12Hz"}
    if gsv:
        voice.update({key: value for key, value in gsv.items() if value})
    return {"schema": "dafeiyu-dialogue-v1", "date": g["date"], "out": "pv.mp4",
            "voice": voice, "gap": 0.18, "lead": 0.18, "tail": 0.5,
            "disclosure": "据真实记录原创重演 · 小鱼为虚构内心角色",
            "reference": {"url": "https://www.bilibili.com/video/BV1t6nu6bEsf",
                          "status": "网页元信息已核实；未获取原片字幕或连续画面，未复刻其台词、原声与镜头。"},
            "sources": sources, "coverage": g.get("coverage", ""), "shots": shots}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("date", nargs="?", default="")
    ap.add_argument("--date", dest="date_opt", default="")
    ap.add_argument("--facts", action="store_true")
    ap.add_argument("--auto", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("-o", "--out", default="")
    ap.add_argument("--home", default="")
    ap.add_argument("--no-net", action="store_true")
    ap.add_argument("--voice", default="")
    ap.add_argument("--first", action="store_true")
    for option in ("repo", "ref", "prompt", "python"):
        ap.add_argument(f"--gsv-{option}", default="")
    args = ap.parse_args()
    date = args.date_opt or args.date or (datetime.now(TZ) - timedelta(days=1)).strftime("%Y-%m-%d")
    try:
        if datetime.strptime(date, "%Y-%m-%d").strftime("%Y-%m-%d") != date:
            raise ValueError(date)
    except ValueError:
        ap.error("date must be a real YYYY-MM-DD calendar date")
    facts = gather(find_home(args.home), date)
    if args.auto:
        gsv = None
        if args.gsv_repo and args.gsv_ref and args.gsv_prompt:
            gsv = {"gsvRepo": args.gsv_repo, "gsvRef": args.gsv_ref,
                   "gsvPrompt": args.gsv_prompt, "gsvPython": args.gsv_python or sys.executable}
        plan = auto_plan(facts, args.out, no_net=args.no_net, gsv=gsv, first=args.first)
        if args.voice:
            plan["voice"]["name"] = args.voice.strip()
        # ⭐ 2026-10-26：时长收口的估算提示。**必须走 stderr**：--auto 不带 -o 时
        #   stdout 整个是 plan JSON（机器输出），--facts --json 时 stdout 是 facts
        #   JSON —— 这行人字混进 stdout 会污染机器消费方；带 -o 时 stdout 只有
        #   「分镜完成」那行人字，stderr 也不会丢。
        print(f"时长估算：{plan_seconds(plan['shots']):.1f}s"
              f"（目标 {TARGET_SECONDS}s，{len(plan['shots'])} 镜）", file=sys.stderr)
        result = json.dumps(plan, ensure_ascii=False, indent=2)
        if args.out:
            output = Path(args.out)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(result, encoding="utf-8")
            print(f"分镜完成：{len(plan['shots'])} 镜，{len(plan['sources'])} 个公开记录来源。")
        else:
            print(result)
    else:
        print(json.dumps(facts, ensure_ascii=False, indent=2) if args.json else facts_text(facts))


if __name__ == "__main__":
    main()
