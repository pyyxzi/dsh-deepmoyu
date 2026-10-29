"""Deterministic 1080p motion editorial: kinetic short-form studio direction.

No network, external media, or generated code is accepted by this renderer.
Speech remains the source of timing; all visual text is separately authored.
"""
from __future__ import annotations

import math
import os
import random
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

try:
    # pv imports this module lazily during build, so the shared portrait driver
    # is available without creating a second character implementation.
    from pv import Portrait, Fish, DialoguePortrait
except ImportError:  # pragma: no cover - standalone renderer smoke tests
    Portrait = Fish = DialoguePortrait = None

WIDTH, HEIGHT = 1920, 1080
# Keep the three persisted names, but make them bright editorial directions rather
# than three flat color swatches. Each palette has a light canvas, a strong ink
# color and a warm/cool accent pair so a frame stays inviting on a phone screen.
THEMES = {
    "paper": {"bg": "#fff8f3", "ink": "#17243b", "muted": "#6d7482", "accent": "#ed6a57", "accent2": "#4f69b5", "panel": "#fffdfb", "panel2": "#ffe4db", "contrast": "#fff0e9"},
    "midnight": {"bg": "#f2f5ff", "ink": "#192440", "muted": "#68748d", "accent": "#5b63d4", "accent2": "#ed7a6d", "panel": "#ffffff", "panel2": "#e5eaff", "contrast": "#ffefeb"},
    "signal": {"bg": "#fff8e8", "ink": "#2b2230", "muted": "#776d73", "accent": "#de584c", "accent2": "#e1a044", "panel": "#fffdf8", "panel2": "#ffe2c8", "contrast": "#fff0d9"},
}


@lru_cache(maxsize=128)
def font(size, serif=False):
    directory = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
    names = ("NotoSerifSC-VF.ttf", "simhei.ttf", "msyhbd.ttc") if serif else ("NotoSansSC-VF.ttf", "msyhbd.ttc", "simhei.ttf")
    candidates = [directory / name for name in names]
    candidates += [Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc")]
    for candidate in candidates:
        try:
            return ImageFont.truetype(str(candidate), size)
        except OSError:
            pass
    return ImageFont.load_default()


def ease(value):
    return 1 - (1 - max(0, min(1, value))) ** 3


def wrap(draw, text, face, width):
    lines, line = [], ""
    for character in str(text):
        if character == "\n":
            lines.append(line)
            line = ""
        elif line and draw.textlength(line + character, font=face) > width:
            lines.append(line)
            line = character
        else:
            line += character
    if line:
        lines.append(line)
    return lines


def typeset(draw, text, box, color, size=96, minimum=30, serif=False, align="left"):
    """Fit the complete text by measured pixels, without truncation."""
    if not text:
        return
    x, y, width, height = box
    for point in range(size, minimum - 1, -2):
        face = font(point, serif)
        lines = wrap(draw, text, face, width)
        # Include the glyph bearing (CJK fonts have a nonzero top bearing).
        advance = int(point * 1.34)
        if len(lines) * advance <= height and all(draw.textlength(line, font=face) <= width for line in lines):
            break
    else:
        raise ValueError(f"屏幕文字无法完整排入画面，请精简：{text}")
    for index, line in enumerate(lines):
        left = x + (width - draw.textlength(line, font=face)) / 2 if align == "center" else x
        draw.text((int(left), int(y + index * advance)), line, font=face, fill=color, anchor="lt")


def _gradient(top, bottom, width=WIDTH, height=HEIGHT):
    image = Image.new("RGB", (width, height))
    pixels = image.load()
    for y in range(height):
        ratio = y / max(1, height - 1)
        color = tuple(int(top[i] * (1 - ratio) + bottom[i] * ratio) for i in range(3))
        for x in range(width):
            pixels[x, y] = color
    return image


@lru_cache(maxsize=6)
def backdrop(theme):
    colors = THEMES[theme]
    base = tuple(int(colors["bg"][index:index + 2], 16) for index in (1, 3, 5))
    panel = tuple(int(colors["panel"][index:index + 2], 16) for index in (1, 3, 5))
    image = _gradient(tuple(min(255, value + 10) for value in base), base)
    draw = ImageDraw.Draw(image)
    # A fine grid and offset bands create depth without decorative blobs.
    for x in range(0, WIDTH, 80):
        draw.line((x, 0, x, HEIGHT), fill=tuple(min(255, c + 8) for c in panel), width=1)
    for y in range(0, HEIGHT, 80):
        draw.line((0, y, WIDTH, y), fill=tuple(min(255, c + 8) for c in panel), width=1)
    draw.polygon([(0, 760), (560, 430), (1220, 770), (680, 1080), (0, 1080)], fill=colors["panel"])
    draw.polygon([(1510, 0), (1920, 0), (1920, 420), (1730, 300)], fill=colors["panel2"])
    draw.line((112, 136, 1808, 136), fill=colors["muted"], width=2)
    # Sparse print grain, deterministic and low contrast.
    rng = random.Random(187)
    for _ in range(2600):
        x, y = rng.randrange(WIDTH), rng.randrange(HEIGHT)
        draw.point((x, y), fill=colors["panel2"])
    return image


def fish_cameo(canvas, state, x, y, size=380, alpha=255):
    """Let the established fish character appear as a speaker or reaction beat."""
    fish = state.get("fish")
    if fish is None:
        return
    try:
        layer = fish.render(mouth=float(state.get("mouth", 0)), sway=0.18, bounce=0.12)
        layer = layer.resize((size, size), Image.Resampling.LANCZOS)
        if alpha < 255:
            layer.putalpha(layer.getchannel("A").point(lambda value: int(value * alpha / 255)))
        canvas.alpha_composite(layer, (int(x), int(y)))
    except (AttributeError, OSError, ValueError):
        # A missing optional portrait must never stop a text-led production.
        return


def reaction_card(draw, text, colors, x=1260, y=715, width=520):
    """A compact editorial reaction card, separate from the full subtitle lane."""
    draw.rounded_rectangle((x, y, x + width, y + 108), radius=18, fill=colors["contrast"])
    draw.ellipse((x + 24, y + 34, x + 42, y + 52), fill=colors["accent"])
    typeset(draw, text, (x + 68, y + 27, width - 92, 60), colors["bg"], 27, minimum=18)


def motif(draw, center, radius, colors, t, variant="orbit"):
    x, y = center
    for index, factor in enumerate((.48, .74, 1.0)):
        r = radius * factor
        draw.ellipse((x-r, y-r, x+r, y+r), outline=colors["accent"] if index == 1 else colors["muted"], width=2 if index != 1 else 3)
        angle = t * (.22 + index * .06) + index * 2.1
        px, py = x + math.cos(angle)*r, y + math.sin(angle)*r
        dot = 8 if index == 1 else 5
        draw.ellipse((px-dot, py-dot, px+dot, py+dot), fill=colors["accent"])
    if variant == "spark":
        points = []
        for index in range(16):
            angle = index * math.pi / 8 + t * .05
            r = radius * (.43 if index % 2 == 0 else .14)
            points.append((x + math.cos(angle)*r, y + math.sin(angle)*r))
        draw.polygon(points, fill=colors["accent"])
    else:
        typeset(draw, "?", (x-radius*.25, y-radius*.40, radius*.5, radius*.9), colors["accent"], int(radius*.7), align="center", serif=True)


def caption_parts(text, limit=23):
    parts, current = [], ""
    for character in text:
        current += character
        if len(current) >= limit or (character in "，。！？；：!?;" and len(current) >= 7):
            parts.append(current)
            current = ""
    if current:
        parts.append(current)
    return parts


def active_caption(text, t, duration):
    """Phrase timing is proportional within the measured utterance, not ASR."""
    if not text or not 0 <= t < duration:
        return ""
    parts = caption_parts(text)
    position = t / max(.01, duration) * sum(len(part) for part in parts)
    for part in parts:
        position -= len(part)
        if position < 0:
            return part
    return parts[-1]


def contrast_ink(colors):
    """Pick text that stays readable inside the warm caption card."""
    raw = colors.get("contrast", "#ffffff").lstrip("#")
    try:
        luminance = .2126 * int(raw[0:2], 16) + .7152 * int(raw[2:4], 16) + .0722 * int(raw[4:6], 16)
    except (ValueError, IndexError):
        luminance = 255
    # Light editorial caption lanes need the dark ink; the old dark-theme rule
    # selected the canvas color here and made captions nearly disappear.
    return colors["ink"] if luminance > 150 else colors["bg"]


@lru_cache(maxsize=1)
def host_avatar():
    """Load the reviewed rigged portrait so the presenter keeps the mouth animation."""
    if DialoguePortrait is not None:
        return DialoguePortrait()
    if Portrait is not None:
        portrait = Portrait(520)
        if portrait.ok:
            return portrait
    return Fish(520) if Fish is not None else None


def place_host(image, draw, state, t, colors, compact=False):
    """A restrained presenter cameo; mouth follows the measured voice envelope."""
    avatar = state.get("dialogue_portrait") or host_avatar()
    if avatar is None:
        return
    target = 390 if compact else 520
    driven = avatar.render(mouth=state.get("mouth", 0.0), expression="happy" if state.get("mouth", 0) > .45 else "neutral")
    ratio = target / max(1, driven.height)
    driven = driven.resize((max(1, int(driven.width * ratio)), target), Image.Resampling.LANCZOS)
    width, height = driven.size
    x = WIDTH - width - 86
    y = 290 if not compact else 205
    # A quiet stage gives the transparent portrait a deliberate home in the frame.
    draw.rounded_rectangle((x - 34, y + 44, x + width + 34, y + height + 22), radius=28,
                           fill=colors["panel"], outline=colors["muted"], width=2)
    draw.ellipse((x + 28, y + 20, x + 62, y + 54), fill=colors["accent"])
    draw.text((x + 78, y + 17), "大肥鱼在说", font=font(22), fill=colors["muted"])
    image.alpha_composite(driven, (x, y))


def render(shot, t, duration, state):
    theme = state.get("theme", "paper")
    colors = THEMES[theme]
    image = backdrop(theme).copy().convert("RGBA")
    draw = ImageDraw.Draw(image)
    index, count = state.get("shot_index", 0), max(1, state.get("shot_count", 1))
    draw.ellipse((112, 69, 128, 85), fill=colors["accent"])
    draw.text((145, 58), "DeepMoYu / 浪里有料", font=font(26), fill=colors["ink"])
    scene = shot.get("scene", "headline")
    label = {"hook": "先看一个问题", "headline": "换个角度", "compare": "放在一起看", "steps": "拆开来看", "quote": "记住这一句", "spotlight": "值得放大", "outro": "把问题留给你"}.get(scene, "继续看")
    label = shot.get("kicker") or label
    draw.text((112, 174), label, font=font(26), fill=colors["accent"])
    folio = f"{index+1:02d} / {count:02d}"
    draw.text((1808-draw.textlength(folio, font=font(26)), 58), folio, font=font(26), fill=colors["muted"])
    energy = shot.get("energy", "warm")
    energy_amp = {"quiet": 12, "warm": 24, "punchy": 42, "surprise": 58}.get(energy, 24)
    rise = int((1 - ease(t / (.32 if energy in {"punchy", "surprise"} else .48))) * energy_amp)
    headline, body = shot.get("headline", ""), shot.get("body", "")

    if scene in ("hook", "headline", "outro"):
        typeset(draw, headline, (112, 267+rise, 1120, 340), colors["ink"], 118 if scene == "hook" else 106, serif=True)
        typeset(draw, body, (118, 667+rise, 1080, 130), colors["muted"], 34)
        draw.rectangle((114, 623+rise, 294+int(ease(t/.7)*160), 631+rise), fill=colors["accent"])
        motif(draw, (1515, 493), 222 + 5*math.sin(t*.6), colors, t, "orbit" if scene == "hook" else "spark")
        if shot.get("speaker") == "fish":
            place_host(image, draw, state, t, colors)
        if scene == "outro":
            draw.line((1420, 779, 1630, 779), fill=colors["accent"], width=4)
            draw.line((1600, 751, 1630, 779, 1600, 807), fill=colors["accent"], width=4)

    elif scene == "compare":
        typeset(draw, headline, (112, 245+rise, 1650, 130), colors["ink"], 82, serif=True)
        for slot, item in enumerate(shot.get("items", [])):
            x = 112 + slot*876
            y = 405 + int((1-ease((t-slot*.13)/.5))*35)
            draw.rounded_rectangle((x, y, x+820, y+378), radius=14, fill=colors["panel"] if slot == 0 else colors["panel2"])
            ink = colors["ink"]
            accent = colors["accent"] if slot == 0 else colors["accent2"]
            draw.text((x+40, y+28), f"0{slot+1}", font=font(25), fill=accent)
            typeset(draw, item["label"], (x+40, y+108, 740, 150), ink, 66)
            typeset(draw, item.get("detail", ""), (x+40, y+275, 740, 82), ink, 32)
        if shot.get("speaker") == "fish":
            place_host(image, draw, state, t, colors, compact=True)

    elif scene == "steps":
        typeset(draw, headline, (112, 245+rise, 1650, 130), colors["ink"], 82, serif=True)
        items = shot.get("items", [])
        width = (1696 - max(0, len(items)-1)*28) / max(1, len(items))
        for slot, item in enumerate(items):
            x = int(112 + slot*(width+28))
            y = 410 + int((1-ease((t-slot*.16)/.5))*40)
            draw.rectangle((x, y, int(x+width), y+385), fill=colors["panel"])
            draw.rectangle((x, y, int(x+width*ease((t-slot*.16)/.8)), y+5), fill=colors["accent"])
            draw.text((x+28, y+24), f"{slot+1:02d}", font=font(67, True), fill=colors["accent"])
            typeset(draw, item["label"], (x+28, y+140, width-56, 116), colors["ink"], 48)
            typeset(draw, item.get("detail", ""), (x+28, y+273, width-56, 96), colors["muted"], 29, minimum=23)
        if shot.get("speaker") == "fish":
            place_host(image, draw, state, t, colors, compact=True)

    elif scene == "quote":
        draw.text((96, 210+rise), "“", font=font(235, True), fill=colors["accent"], anchor="lt")
        typeset(draw, headline, (270, 325+rise, 1390, 300), colors["ink"], 110, serif=True)
        draw.rectangle((278, 692, 350, 696), fill=colors["accent"])
        typeset(draw, body, (385, 670, 1260, 120), colors["muted"], 32)
        if shot.get("speaker") == "fish":
            place_host(image, draw, state, t, colors, compact=True)

    elif scene == "spotlight":
        draw.ellipse((1190, 245, 1780, 835), fill=colors["panel"])
        motif(draw, (1485, 540), 228, colors, t, "spark")
        typeset(draw, headline, (112, 282+rise, 1030, 300), colors["ink"], 114, serif=True)
        typeset(draw, body, (118, 660, 1010, 130), colors["muted"], 34)
        if shot.get("speaker") == "fish":
            place_host(image, draw, state, t, colors, compact=True)

    # Dedicated caption and source lanes never share the content field.
    caption = active_caption(shot.get("text", ""), t, duration)
    if caption:
        draw.rounded_rectangle((112, 863, 1808, 975), radius=8, fill=colors["contrast"])
        typeset(draw, caption, (145, 891, 1630, 70), contrast_ink(colors), 43, align="center")
    source_ids = shot.get("source_ids", [])
    source = state.get("source_map", {}).get(source_ids[0], {}) if source_ids else {}
    provenance = "逐字引用" if shot.get("provenance") == "source-quote" else "公开来源改编"
    source_text = f"{provenance} / {source.get('title', '')}" if source else ("虚构演绎 / 原创评论" if state.get("mode") == "custom" else "原创评论")
    typeset(draw, source_text, (112, 1000, 1450, 38), colors["muted"], 22, minimum=12)
    draw.rectangle((0, 1068, WIDTH, 1079), fill=colors["panel"])
    progress = (index + max(0, min(1, t/max(.01, duration)))) / count
    draw.rectangle((0, 1068, int(WIDTH*progress), 1079), fill=colors["accent"])
    return image


def cover(title, ratio, theme="paper"):
    """Full-bleed editorial cover, sharing the film's typography and palette."""
    colors = THEMES[theme]
    width = 1920 if ratio == "16x9" else 1440
    image = Image.new("RGB", (width, HEIGHT), colors["bg"])
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 28, HEIGHT), fill=colors["accent"])
    # Decorative geometry contains no extra claims or cover copy.
    motif(draw, (width-150, 720), 340, colors, 1.5, "spark")
    draw.rectangle((90, 170, width-90, 785), fill=colors["bg"])
    typeset(draw, title, (100, 265, width-215, 485), colors["ink"], 150, minimum=38, serif=True)
    draw.rectangle((104, 830, 410, 844), fill=colors["accent"])
    return image.convert("RGBA")
