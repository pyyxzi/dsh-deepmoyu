#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared daily-film cover selection and rendering.

The cover is deliberately a single concrete event headline.  Dates, report
labels, BV identifiers, TODO placeholders, subtitles, and decorative tags do
not belong in the artwork.  The module is importable by devtools and can also
be run as a small CLI:

    python pv_cover.py --plan plan.json --outdir output/2026-10-22
    python pv_cover.py --plan plan.json --outdir output/2026-10-22 --only-missing
"""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFilter

try:  # Loaded as a top-level module by the CLI and tests.
    from pv import F, NF, Fish, Portrait, bg_ocean
except ImportError:  # pragma: no cover - package import fallback
    from .pv import F, NF, Fish, Portrait, bg_ocean


RATIO_SIZES = {
    "16x9": (1920, 1080),
    "4x3": (1440, 1080),
}
COVER_NAMES = {
    "16x9": "封面_16x9.png",
    "4x3": "封面_4x3.png",
}

# These are intentionally conservative: a report label is not a concrete
# event, and putting it on an otherwise valid fallback would hide bad input.
_GENERIC_RE = re.compile(
    r"^(?:标题|title|cover|封面|日报|大肥鱼日报|今日日报|昨日日报|今日冲浪|昨日冲浪|"
    r"冲浪报告|日报视频|视频日报|今天B站刷到了啥|今日B站刷到了啥|daily(?:\s+film|\s+report)?|todo|待定|待补|"
    r"暂无|无标题|未命名|placeholder|unknown|test|测试)(?:[\s:_：-].*)?$",
    re.IGNORECASE,
)
# Numeric dates only use slash/hyphen here: a decimal such as 57.5% must not
# be mistaken for a month/day. Chinese month/day forms also cover text with
# no word boundary, for example ``十月二十二日蜻蜓消失``.
_DATE_RE = re.compile(
    r"(?:"
    r"(?<!\d)\d{4}\s*(?:[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,2}|"
    r"年\s*\d{1,2}\s*月\s*\d{1,2}\s*[日号]?)"
    r"|(?<!\d)\d{8}(?!\d)"
    r"|(?<![\d.])\d{1,2}\s*[-/]\s*\d{1,2}(?![\d.])"
    r"|(?<!\d)\d{1,2}\s*月\s*\d{1,2}\s*[日号]?"
    r"|(?<![A-Za-z0-9])"
    r"[一二两三四五六七八九十百零〇○]{1,8}\s*月\s*"
    r"[一二两三四五六七八九十百零〇○]{1,8}\s*[日号]?"
    r"|[〇零一二两三四五六七八九]{4}\s*年\s*"
    r"[一二两三四五六七八九十百零〇○]{1,3}\s*月\s*"
    r"[一二两三四五六七八九十百零〇○]{1,3}\s*[日号]?"
    r")"
)
_BV_RE = re.compile(r"\bBV[0-9A-Za-z]{8,}\b", re.IGNORECASE)
_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]*\)")


def _clean_text(value: Any) -> str:
    text = str(value or "").replace("\r", " ").replace("\n", " ")
    text = _LINK_RE.sub(r"\1", text)
    text = re.sub(r"[`*_]+", "", text)
    text = re.sub(r"\s+", " ", text).strip(" \t\r\n|｜·—–-\"“”『』「」《》")
    return text


def validate_title(title: Any) -> str:
    """Return a usable headline or raise ``ValueError``.

    Validation is shared by explicit cover metadata and automatic source
    selection.  Explicit metadata is an authoring contract, so callers should
    surface the error instead of silently falling back to a generic label.
    """
    text = _clean_text(title)
    if not text:
        raise ValueError("封面标题不能为空")
    if len(text) > 160:
        raise ValueError("封面标题过长（最多160字）")
    if "日报" in text or re.search(r"todo", text, re.IGNORECASE) or _GENERIC_RE.fullmatch(text) or text.upper() in {"TBD", "N/A"}:
        raise ValueError(f"封面标题过于笼统：{text}")
    if _DATE_RE.search(text):
        raise ValueError("封面标题不能包含日期")
    if _BV_RE.search(text):
        raise ValueError("封面标题不能使用 BV 号")
    if not re.search(r"[^\W\d_]", text, re.UNICODE) and not re.search(r"[\u4e00-\u9fff]", text):
        raise ValueError("封面标题必须是具体事件文字")
    if not re.search(r"[\u4e00-\u9fffA-Za-z]", text):
        raise ValueError("封面标题必须包含可读文字")
    return text


def _candidate(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        if isinstance(value.get("title"), str):
            yield value["title"]


def choose_title(data: dict) -> str:
    """Choose one concrete title from a dated plan/report object.

    Explicit ``cover.title``/``cover`` wins.  Otherwise only actual story,
    list-entry, video, and source titles are considered; opening/outro labels
    and arbitrary prose are intentionally ignored.
    """
    if not isinstance(data, dict):
        raise ValueError("封面计划必须是 JSON 对象")

    if "cover" in data and data.get("cover") not in (None, ""):
        cover = data.get("cover")
        explicit = cover.get("title") if isinstance(cover, dict) else cover
        if not isinstance(explicit, str) or not explicit.strip():
            raise ValueError("cover.title 必须是具体标题")
        return validate_title(explicit)

    candidates = []
    for shot in data.get("shots") or []:
        if not isinstance(shot, dict):
            continue
        kind = str(shot.get("kind") or "").lower()
        if kind in {"story", "video"}:
            candidates.extend(_candidate(shot.get("title")))
        elif kind == "list":
            for entry in shot.get("entries") or []:
                candidates.extend(_candidate(entry))
    for source in data.get("sources") or []:
        candidates.extend(_candidate(source))
    # Brief JSON often wraps source picks under report.picks.
    report = data.get("report")
    if isinstance(report, dict):
        for source in report.get("picks") or []:
            candidates.extend(_candidate(source))

    rejected = []
    for raw in candidates:
        try:
            return validate_title(raw)
        except ValueError as exc:
            rejected.append(str(exc))
    detail = f"（候选均不可用：{rejected[-1]}）" if rejected else ""
    raise ValueError(f"当天没有可用的具体事件标题{detail}")


def _dimensions(ratio: str):
    key = str(ratio or "").lower().replace(":", "x")
    try:
        return RATIO_SIZES[key], key
    except KeyError as exc:
        raise ValueError(f"不支持的封面比例：{ratio!r}（只支持 16x9 / 4x3）") from exc


def valid_cover(path: os.PathLike | str, ratio: str) -> bool:
    """Return whether *path* is a complete PNG with the requested dimensions."""
    try:
        size, _ = _dimensions(ratio)
        target = Path(path)
        if target.suffix.lower() != ".png" or not target.is_file() or target.stat().st_size <= 0:
            return False
        with Image.open(target) as image:
            image.verify()
        with Image.open(target) as image:
            return image.size == size and image.mode in {"RGB", "RGBA", "L", "LA"}
    except (OSError, SyntaxError, ValueError):
        return False


_NO_LINE_START = set("，。！？、；：…,.!?;:)]}）】》」』”’")
_BREAK_COMMA = set("，,")


def _wrap_measured(draw: ImageDraw.ImageDraw, text: str, font, max_width: int, lines_wanted: int):
    """Return a balanced measured layout; drop a comma only at a line break."""
    from functools import lru_cache

    @lru_cache(maxsize=None)
    def solve(start: int, remaining: int):
        if remaining == 1:
            if start >= len(text) or text[start] in _NO_LINE_START:
                return None
            line = text[start:]
            width = draw.textlength(line, font=font)
            if width > max_width:
                return None
            return (0.0, (line,), (width,))

        best = None
        for end in range(start + 1, len(text)):
            line = text[start:end]
            width = draw.textlength(line, font=font)
            if width > max_width:
                break
            next_start = end
            comma_cost = 0.0
            if text[end] in _BREAK_COMMA:
                next_start += 1
                comma_cost = 0.05
            elif text[end] in _NO_LINE_START:
                continue
            if next_start >= len(text) or text[next_start] in _NO_LINE_START:
                continue
            rest = solve(next_start, remaining - 1)
            if rest is None:
                continue
            widths = (width,) + rest[2]
            avg = sum(widths) / lines_wanted
            ends_with_comma = text[end - 1] in _BREAK_COMMA
            # Favor a comma as the actual break and suppress that separator;
            # do not strand it at the end of the previous line.
            punctuation_cost = 10000 if ends_with_comma and text[end] not in _BREAK_COMMA else 0
            score = sum((item - avg) ** 2 for item in widths) + comma_cost + punctuation_cost
            candidate = (score + rest[0], (line,) + rest[1], widths)
            if best is None or candidate[0] < best[0]:
                best = candidate
        return best

    result = solve(0, lines_wanted)
    return list(result[1]) if result else None


def _fit_headline(draw: ImageDraw.ImageDraw, title: str, max_width: int, max_height: int):
    # Prefer a balanced one/two-line layout whenever it remains comfortably
    # readable; only fall back to three lines for headlines that need them.
    probe = NF(90, "Bold")
    preferred = next((count for count in (1, 2, 3)
                      if _wrap_measured(draw, title, probe, max_width, count)), None)
    if preferred is None:
        raise ValueError("标题无法在三行内以可读字号排入封面")
    for size in range(126, 51, -2):
        font = NF(size, "Bold")
        lines = _wrap_measured(draw, title, font, max_width, preferred)
        if not lines:
            continue
        boxes = [draw.textbbox((0, 0), line, font=font, stroke_width=0) for line in lines]
        line_height = max(box[3] - box[1] for box in boxes)
        spacing = max(10, int(size * 0.18))
        total_height = line_height * len(lines) + spacing * (len(lines) - 1)
        if total_height <= max_height:
            return font, lines, line_height, spacing
    raise ValueError("标题无法在封面内完整排版")


def _paint_portrait(canvas: Image.Image, size: int, x: int, y: int):
    portrait = Portrait(size=size)
    if portrait.ok:
        image = portrait.render(mouth=0.0, sway=0.0, bounce=0.0)
    else:
        image = Fish(size).render(mouth=0.0, sway=0.0, bounce=0.0)
    canvas.alpha_composite(image, (x, y))


def render_cover(title: str, ratio: str) -> Image.Image:
    """Render one 16:9 or 4:3 RGBA cover at its exact delivery size."""
    title = validate_title(title)
    (width, height), key = _dimensions(ratio)
    seed = sum((index + 1) * ord(char) for index, char in enumerate(title)) % 997
    base = bg_ocean(seed=seed, top="#eaf6ff", mid="#cfe7f8", bottom="#a8d2ec", rice=True)
    canvas = base.resize((width, height), Image.Resampling.LANCZOS).convert("RGBA")
    draw = ImageDraw.Draw(canvas, "RGBA")

    portrait_size = 720 if key == "16x9" else 650
    portrait_x = width - portrait_size - (52 if key == "16x9" else 34)
    portrait_y = height - portrait_size - 24
    text_left = 90
    text_right = portrait_x - (58 if key == "16x9" else 46)
    text_width = max(420, text_right - text_left)
    text_top = 180
    text_bottom = height - 170

    # A quiet translucent panel gives the measured headline a stable contrast
    # field without introducing another textual label or a subtitle.
    panel = Image.new("RGBA", (text_width + 84, text_bottom - text_top + 70), (0, 0, 0, 0))
    pd = ImageDraw.Draw(panel, "RGBA")
    pd.rounded_rectangle((0, 0, panel.width - 1, panel.height - 1), radius=34,
                         fill=(255, 255, 255, 220), outline=(120, 176, 214, 190), width=3)
    pd.rounded_rectangle((30, 38, 43, panel.height - 38), radius=6, fill=(239, 133, 75, 245))
    panel = panel.filter(ImageFilter.GaussianBlur(0.15))
    canvas.alpha_composite(panel, (text_left - 42, text_top - 35))

    draw = ImageDraw.Draw(canvas, "RGBA")
    font, lines, line_height, spacing = _fit_headline(draw, title, text_width - 42, text_bottom - text_top - 30)
    total = line_height * len(lines) + spacing * (len(lines) - 1)
    y = text_top + max(0, (text_bottom - text_top - total) // 2)
    for line in lines:
        # Strong dark outline keeps the headline readable over the light water.
        draw.text((text_left, y), line, font=font, fill=(29, 57, 92, 255),
                  stroke_width=2, stroke_fill=(255, 255, 255, 190))
        y += line_height + spacing

    _paint_portrait(canvas, portrait_size, portrait_x, portrait_y)
    return canvas


def _atomic_save(image: Image.Image, target: Path):
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(f".{target.name}.partial")
    try:
        image.save(temp, format="PNG", optimize=True)
        os.replace(temp, target)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def generate_covers(outdir: os.PathLike | str, title: str, only_missing: bool = False):
    """Generate both daily covers and return their paths.

    Both images are rendered before either file is replaced, so a rendering
    error cannot leave one newly-written cover paired with one old cover.
    """
    output = Path(outdir)
    headline = validate_title(title)
    rendered = {}
    generated = []
    for ratio, filename in COVER_NAMES.items():
        path = output / filename
        if only_missing and valid_cover(path, ratio):
            continue
        rendered[path] = render_cover(headline, ratio)
    for path, image in rendered.items():
        _atomic_save(image, path)
        generated.append(path)
    paths = {ratio: output / filename for ratio, filename in COVER_NAMES.items()}
    if not all(valid_cover(paths[ratio], ratio) for ratio in RATIO_SIZES):
        raise RuntimeError("封面生成后校验失败")
    return {"title": headline, "paths": paths, "generated": generated}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", required=True, help="JSON plan path")
    parser.add_argument("--outdir", required=True, help="dated output directory")
    parser.add_argument("--only-missing", action="store_true")
    args = parser.parse_args()
    try:
        plan_path = Path(args.plan)
        # Windows 编辑器写出的 JSON 常带 BOM（utf-8-sig），不能因此判失败。
        data = json.loads(plan_path.read_text(encoding="utf-8-sig"))
        title = choose_title(data)
        result = generate_covers(args.outdir, title, only_missing=args.only_missing)
        for ratio, path in result["paths"].items():
            print(f"封面 → {path} {path.stat().st_size:,} B", flush=True)
        print(f"封面文字：{title}", flush=True)
        return 0
    except (OSError, ValueError, TypeError, json.JSONDecodeError, RuntimeError) as exc:
        parser.exit(1, f"封面生成失败：{exc}\n")


if __name__ == "__main__":
    raise SystemExit(main())
