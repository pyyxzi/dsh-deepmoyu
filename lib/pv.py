#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Local Dafeiyu video renderer: Pillow staging, measured speech, ffmpeg output.

Dialogue plans use the reviewed transparent assets/avatar/fish.png portrait,
an explicitly imaginary inner-fish speaker, shot/reverse-shot, gentle pushes,
expression symbols and PCM-RMS mouth timing. Mouth timing is not phoneme alignment.
Legacy card plans remain readable. Unknown portrait assets retain their artwork
without a face repaint; a procedural character is the no-asset fallback.

Audio defaults to edge-tts, with an explicitly recorded Windows SAPI fallback.
Configured GPT-SoVITS runs through pv_gsv.py in its own Python environment;
model synthesis errors fail the render rather than pretending the voice matched.

Usage: pv.py --plan plan.json [--out sample.mp4] [--fps 24] [--scale .75]
       pv.py --plan plan.json --still 0,4,9
Each work directory includes measured timeline.json, captions.srt, mixed WAV,
and first/middle/last rendered verification frames. No publication occurs here.
"""
from __future__ import annotations

import argparse
import array
import hashlib
import json
import math
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time
import wave
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

# 控制台是 GBK / cp936 时，emoji 会把 print 直接打挂 —— 先兜住
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# ───────────────────────────── 全局小工具 ─────────────────────────────

W, H = 1280, 720
FPS = 30
SS = 2  # 超采样倍数（角色先画 2x 再缩小，边缘才不毛）

FONT_DIR = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"


@lru_cache(maxsize=96)
def _font(name: str, size: int) -> ImageFont.FreeTypeFont:
    """按粗/细挑字体；找不到就退到雅黑，再不行退 PIL 默认。

    字体对象很贵（每次 truetype 都要读一遍表），逐帧调用必须缓存。
    """
    for cand in (name, "msyh.ttc", "msyhbd.ttc", "simhei.ttf"):
        p = FONT_DIR / cand
        if p.exists():
            try:
                return ImageFont.truetype(str(p), size)
            except Exception:
                continue
    return ImageFont.load_default()


def F(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return _font("msyhbd.ttc" if bold else "msyh.ttc", size)


NOTO_SANS = FONT_DIR / "NotoSansSC-VF.ttf"
NOTO_SERIF = FONT_DIR / "NotoSerifSC-VF.ttf"


@lru_cache(maxsize=96)
def NF(size: int, weight: str = "Medium") -> ImageFont.FreeTypeFont:
    """思源黑体（可变字重）。屏幕小字比雅黑清楚，字幕正文用它。"""
    try:
        f = ImageFont.truetype(str(NOTO_SANS), size)
        try:
            f.set_variation_by_name(weight)
        except Exception:
            pass
        return f
    except Exception:
        return F(size, bold=weight in ("Medium", "Bold", "Black"))


def clamp(v, a, b):
    return a if v < a else (b if v > b else v)


def lerp(a, b, t):
    return a + (b - a) * t


def ease_out(t):
    return 1 - (1 - t) ** 3


def ease_in_out(t):
    return t * t * (3 - 2 * t)


def hexrgb(h: str):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def mix(c1, c2, t):
    return tuple(int(round(c1[i] + (c2[i] - c1[i]) * t)) for i in range(3))


RGB = lambda c: c if isinstance(c, tuple) else hexrgb(c)


def vgradient(w, h, top, bottom, band=0.0):
    """竖渐变（带一点横向暗角），逐行画 —— 只做一次，很便宜。"""
    top, bottom = RGB(top), RGB(bottom)
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        d.line([(0, y), (w, y)], fill=mix(top, bottom, t))
    if band > 0:
        img = img.filter(ImageFilter.GaussianBlur(0.4))
    # 暗角
    vig = Image.new("L", (w, h), 0)
    dv = ImageDraw.Draw(vig)
    dv.ellipse([-w * 0.25, -h * 0.35, w * 1.25, h * 1.35], fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(int(w * 0.06)))
    dark = Image.new("RGB", (w, h), (6, 10, 24))
    img = Image.composite(img, dark, vig)
    return img


def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return m


def paste_rgba(base: Image.Image, layer: Image.Image, xy):
    base.paste(layer, (int(xy[0]), int(xy[1])), layer if layer.mode == "RGBA" else None)


def draw_text_wrap(draw, text, font, max_w, fill, spacing=1.35):
    """按像素宽度折行（中文按字符断）。返回行列表。"""
    lines, cur = [], ""
    for ch in text:
        if ch == "\n":
            lines.append(cur)
            cur = ""
            continue
        trial = cur + ch
        if draw.textlength(trial, font=font) > max_w and cur:
            lines.append(cur)
            cur = ch
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return lines


# ───────────────────────────── 角色：大肥鱼 ─────────────────────────────

class Fish:
    """Q 版大肥鱼（鲸鱼鳍耳 + 呆毛 + 女仆发箍 + 白围裙 + 银河尾巴）。

    参数（0~1）：
      mouth   张嘴程度（口型，来自音频包络）
      blink   0=睁眼 1=闭眼
      sway    呆毛摆动相位
      tail    尾巴摆动相位
      look    视线左右 (-1~1)
      blush   脸红程度
      bounce  上下呼吸
      mood    1=精神 0=蔫

    几何写在 1000×1000 虚拟画布上（cx=500, cy=500），按 self.s 缩放。
    图层从后往前：尾巴 → 后发 → 侧发 → 脖子 → 裙子 → 手臂 → 脸 → 腮红 →
    眼 → 嘴 → 眉 → 刘海 → 鳍耳 → 发箍 → 呆毛。
    """

    SKIN = (255, 224, 206)
    SKIN_SH = (238, 186, 168)
    HAIR = (168, 200, 240)
    HAIR_SH = (124, 160, 208)
    HAIR_HI = (215, 232, 255)
    IRIS_TOP = (30, 64, 122)
    IRIS_BOT = (86, 186, 245)
    WHITE = (250, 252, 255)
    APRON = (228, 238, 252)
    CLOTH_SH = (208, 222, 244)
    LINE = (58, 74, 104)
    BOW = (74, 123, 208)
    BOW_D = (48, 88, 160)
    BLUSH = (255, 150, 162)

    def __init__(self, size=420):
        self.size = size
        self.s = size * SS
        self._box = None

    # ------------------------------------------------------------------
    def _neutral_box(self):
        """固定裁切框：静止姿势量一次，之后所有帧复用 —— 不然口型/呼吸一变 bbox 就变，
        角色会在画面里抖。"""
        if self._box is None:
            b = self._draw().split()[3].getbbox()
            pad = int(self.s * 0.02)
            x0, y0, x1, y1 = b
            self._box = (max(0, x0 - pad), max(0, y0 - pad),
                         min(self.s, x1 + pad), min(self.s, y1 + pad))
        return self._box

    def render(self, mouth=0.0, blink=0.0, sway=0.0, tail=0.0, look=0.0, blush=0.55,
               bounce=0.0, mood=1.0) -> Image.Image:
        im = self._draw(mouth, blink, sway, tail, look, blush, bounce, mood)
        im = im.crop(self._neutral_box())
        w, h = im.size
        side = max(w, h)
        sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        sq.paste(im, ((side - w) // 2, (side - h) // 2))
        return sq.resize((self.size, self.size), Image.LANCZOS)

    # ------------------------------------------------------------------
    def _draw(self, mouth=0.0, blink=0.0, sway=0.0, tail=0.0, look=0.0, blush=0.55,
              bounce=0.0, mood=1.0) -> Image.Image:
        S = self.s
        img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        d = ImageDraw.Draw(img, "RGBA")
        k = S / 1120.0
        cx = 560.0
        cy = 560.0 + bounce * 14.0
        mood = clamp(mood, 0.0, 1.0)
        lw = max(2, int(5 * k))

        def P(*v):
            return [x * k for x in v]

        # ---------- 尾巴 ----------
        tx = cx + math.sin(tail) * 26
        ty = cy + 470 + (1 - mood) * 40
        d.ellipse(P(tx - 96, ty - 44, tx + 96, ty + 52), fill=self.HAIR_SH)
        for sgn in (-1, 1):
            a = math.sin(tail) * 0.5
            fx = tx + sgn * (120 + 18 * a)
            fy = ty - 34 + sgn * 6 * a + (1 - mood) * 26
            d.ellipse(P(fx - 92, fy - 38, fx + 92, fy + 38), fill=self.HAIR)
            d.ellipse(P(fx - 60, fy - 22, fx + 60, fy + 22), fill=(206, 230, 252))

        # ---------- 后发 ----------
        d.ellipse(P(cx - 242, cy - 330, cx + 242, cy + 190), fill=self.HAIR,
                  outline=self.HAIR_SH, width=lw)
        for sgn in (-1, 1):
            x0 = cx + sgn * 208
            d.ellipse(P(x0 - 68, cy - 300, x0 + 68, cy + 286), fill=self.HAIR_SH)
            d.ellipse(P(x0 - 52, cy - 296, x0 + 52, cy + 256), fill=self.HAIR)

        # ---------- 脖子 ----------
        d.rounded_rectangle(P(cx - 58, cy + 120, cx + 58, cy + 268), radius=36, fill=self.SKIN_SH)
        d.rounded_rectangle(P(cx - 50, cy + 110, cx + 50, cy + 262), radius=32, fill=self.SKIN)

        # ---------- 裙子 ----------
        dress = [P(cx - 150, cy + 206), P(cx + 150, cy + 206),
                 P(cx + 150, cy + 372), P(cx + 232, cy + 524),
                 P(cx - 232, cy + 524), P(cx - 150, cy + 372)]
        d.polygon(dress, fill=self.WHITE)
        d.line(dress + [dress[0]], fill=self.CLOTH_SH, width=lw, joint="curve")
        # 裙摆阴影
        d.polygon(P(cx - 212, cy + 486, cx + 212, cy + 486, cx + 232, cy + 524, cx - 232, cy + 524),
                  fill=self.CLOTH_SH)
        # 围裙
        d.rounded_rectangle(P(cx - 100, cy + 292, cx + 100, cy + 512), radius=24,
                            fill=self.APRON, outline=(198, 214, 240), width=lw)
        # 领口
        d.polygon(P(cx - 92, cy + 204, cx + 92, cy + 204, cx, cy + 302), fill=(212, 228, 247))
        # 领结
        d.polygon(P(cx - 70, cy + 236, cx - 14, cy + 266, cx - 70, cy + 298),
                  fill=self.BOW, outline=self.BOW_D, width=lw)
        d.polygon(P(cx + 70, cy + 236, cx + 14, cy + 266, cx + 70, cy + 298),
                  fill=self.BOW, outline=self.BOW_D, width=lw)
        d.ellipse(P(cx - 22, cy + 252, cx + 22, cy + 282), fill=self.BOW_D)
        # 腰封
        d.rounded_rectangle(P(cx - 106, cy + 370, cx + 106, cy + 396), radius=12, fill=(216, 230, 248))

        # ---------- 手臂 ----------
        for sgn in (-1, 1):
            ax = cx + sgn * 170
            d.rounded_rectangle(P(ax - 30, cy + 234, ax + 30, cy + 418), radius=30,
                                fill=self.WHITE, outline=self.CLOTH_SH, width=lw)
            d.ellipse(P(ax - 36, cy + 400, ax + 36, cy + 474), fill=self.SKIN,
                      outline=self.SKIN_SH, width=lw)

        # ---------- 脸 ----------
        d.ellipse(P(cx - 172, cy - 244, cx + 172, cy + 168), fill=self.SKIN,
                  outline=self.SKIN_SH, width=lw)
        d.ellipse(P(cx - 104, cy + 116, cx + 104, cy + 176), fill=self.SKIN_SH)
        d.ellipse(P(cx - 110, cy + 94, cx + 110, cy + 166), fill=self.SKIN)

        # ---------- 腮红 ----------
        bl = clamp(blush, 0, 1)
        if bl > 0.04:
            for sgn in (-1, 1):
                bx = cx + sgn * 130
                d.ellipse(P(bx - 40, cy + 30, bx + 40, cy + 76), fill=self.BLUSH + (int(120 * bl),))

        # ---------- 眼睛 ----------
        eye_y = cy + 4
        open_k = 1.0 - 0.94 * clamp(blink, 0, 1)
        for sgn in (-1, 1):
            ex = cx + sgn * 94
            ew, eh = 58, 66
            if open_k < 0.18:
                d.arc(P(ex - ew, eye_y - 6, ex + ew, eye_y + 34), 200, 340,
                      fill=self.LINE, width=int(8 * k))
                continue
            d.ellipse(P(ex - ew, eye_y - eh * open_k, ex + ew, eye_y + eh * open_k), fill=(255, 255, 255))
            iy = eye_y + 8 + look * 9
            ir = 46
            d.ellipse(P(ex - ir, iy - ir * 1.02 * open_k, ex + ir, iy + ir * 1.02 * open_k),
                      fill=self.IRIS_BOT)
            d.chord(P(ex - ir, iy - ir * 1.02 * open_k, ex + ir, iy + ir * 0.46 * open_k),
                    180, 360, fill=self.IRIS_TOP)
            d.ellipse(P(ex - 20, iy - 22 * open_k, ex + 20, iy + 20 * open_k), fill=(20, 32, 62))
            d.ellipse(P(ex - 27, iy - 34 * open_k, ex - 6, iy - 10 * open_k), fill=(255, 255, 255))
            d.ellipse(P(ex + 9, iy + 3, ex + 26, iy + 20), fill=(206, 236, 255))
            d.arc(P(ex - ew, eye_y - eh * open_k - 6, ex + ew, eye_y + eh * open_k), 184, 356,
                  fill=self.LINE, width=int(10 * k))
            d.line(P(ex + sgn * ew * 0.76, eye_y - 46, ex + sgn * (ew * 0.76 + 24), eye_y - 74),
                   fill=self.LINE, width=int(8 * k))

        # ---------- 嘴 ----------
        my = cy + 104
        mo = clamp(mouth, 0, 1)
        if mo < 0.12:
            d.arc(P(cx - 34, my - 18, cx, my + 12), 340, 106, fill=self.LINE, width=int(7 * k))
            d.arc(P(cx, my - 18, cx + 34, my + 12), 74, 200, fill=self.LINE, width=int(7 * k))
        else:
            mh = 9 + 36 * mo
            mw = 22 + 16 * mo
            d.ellipse(P(cx - mw, my - 9, cx + mw, my + mh), fill=(120, 52, 66))
            d.ellipse(P(cx - mw * 0.62, my + mh * 0.40, cx + mw * 0.62, my + mh), fill=(240, 130, 142))
            d.ellipse(P(cx - mw * 0.34, my + mh * 0.04, cx + mw * 0.34, my + mh * 0.24),
                      fill=(255, 255, 255, 120))

        # ---------- 眉毛（刘海下面露出来一点点）----------
        for sgn in (-1, 1):
            ex = cx + sgn * 94
            d.arc(P(ex - 40, cy - 84, ex + 40, cy - 50), 202, 338, fill=(118, 146, 184), width=int(6 * k))

        # ---------- 刘海：一整片波浪（不画一根根竖条，免得盖成栅栏）----------
        top = cy - 334
        hem = [(cx - 196, cy - 104), (cx - 150, cy - 74), (cx - 104, cy - 110),
               (cx - 52, cy - 66), (cx + 4, cy - 104), (cx + 58, cy - 62),
               (cx + 110, cy - 106), (cx + 158, cy - 70), (cx + 198, cy - 100)]
        poly = [P(cx - 196, top), P(cx + 196, top)] + [P(x, y) for x, y in reversed(hem)]
        d.polygon(poly, fill=self.HAIR)
        # 刘海下沿勾一道亮边，跟脸分开
        for i in range(len(hem) - 1):
            d.line(P(*hem[i], *hem[i + 1]), fill=self.HAIR_HI, width=max(2, int(4 * k)))
        # 高光
        d.arc(P(cx - 168, cy - 326, cx + 30, cy - 120), 200, 292, fill=self.HAIR_HI, width=int(10 * k))

        # ---------- 鲸鱼鳍耳 ----------
        for sgn in (-1, 1):
            ex = cx + sgn * 176
            ey = cy - 42
            d.polygon(P(ex, ey + 46, ex + sgn * 122, ey - 78, ex + sgn * 102, ey + 98),
                      fill=self.HAIR_SH, outline=self.LINE, width=lw)
            d.polygon(P(ex + sgn * 14, ey + 34, ex + sgn * 98, ey - 54, ex + sgn * 84, ey + 74),
                      fill=self.HAIR)
            d.line(P(ex + sgn * 32, ey + 20, ex + sgn * 86, ey - 32), fill=self.HAIR_HI, width=int(5 * k))

        # ---------- 女仆发箍 ----------
        d.arc(P(cx - 196, cy - 350, cx + 196, cy + 20), 204, 336, fill=self.WHITE, width=int(24 * k))
        for i in range(5):
            a = math.radians(210 + i * 30)
            bx = cx + math.cos(a) * 198
            by = cy - 165 + math.sin(a) * 188
            d.ellipse(P(bx - 14, by - 14, bx + 14, by + 14), fill=self.WHITE,
                      outline=(214, 228, 248), width=lw)

        # ---------- 呆毛 ----------
        base_x, base_y = cx, cy - 336
        pts = []
        for i in range(24):
            t = i / 23.0
            ang = -math.pi / 2 + (0.95 * t) + math.sin(sway * 1.6 + t * 2.4) * 0.42 * t
            r = t * 168 * (0.55 + 0.45 * mood)
            px = base_x + math.cos(ang) * r * 0.62 + math.sin(sway * 1.3 + t * 4) * 16 * mood * t
            py = base_y + math.sin(ang) * r - t * 12 + (1 - mood) * 44 * t
            pts.append((px, py))
        for i in range(len(pts) - 1):
            w = max(3, int((15 - i * 0.5) * k))
            d.line([(pts[i][0] * k, pts[i][1] * k), (pts[i + 1][0] * k, pts[i + 1][1] * k)],
                   fill=self.HAIR, width=w)
        d.ellipse(P(pts[-1][0] - 11, pts[-1][1] - 11, pts[-1][0] + 11, pts[-1][1] + 11), fill=self.HAIR)

        return img


# ─────────────────────── 形象素材（真·大肥鱼立绘） ───────────────────────
# 素材烘法见 `_mkavatar.py`：从 `大肥鱼形象图\1.jpg` 裁圆角取景框，不做抠图。
# 这里只负责「找到一个可用的 PNG」+「把它变成一个能被 _stand() 驱动的角色」。

def avatar_dirs() -> list[Path]:
    """可能放素材的目录，按优先级排（插件里的、家目录里的、环境变量指定的）。"""
    here = Path(__file__).resolve().parent
    ds = [
        here / "assets" / "avatar",           # lib/assets/avatar（包里带的）
        here.parent / "assets" / "avatar",    # <plugin>/assets/avatar
        here.parent.parent / "assets" / "avatar",
    ]
    env = os.environ.get("BILI_PV_AVATAR", "").strip()
    if env:
        ds.insert(0, Path(env))
    try:
        ds.append(Path.cwd() / "assets" / "avatar")
    except Exception:
        pass
    return ds


def load_avatar(name="fish.png"):
    """找一张形象素材；找不到返回 None（调用方退回程序化角色）。"""
    for d in avatar_dirs():
        for cand in (d / name, d / "fish.png", d / "bust.png", d / "face.png"):
            try:
                if cand.exists() and cand.stat().st_size > 20000:
                    return Image.open(cand).convert("RGBA")
            except Exception:
                continue
    return None


class Portrait:
    """把一张立绘当成「可驱动的角色」用。

    接口和 `Fish` 完全一样（`render(**kw)` 返回 size×size 的透明方形 RGBA），
    所以 `draw_avatar()` / `_stand()` / 所有分镜卡一行都不用改。

    照片没有五官可动，动的是**整体**：呼吸的上下浮、说话时的轻微挤压、
    左右轻晃、下巴为轴的极小角度旋转，外加一圈随说话强度呼吸的柔光。
    观众读的是「她在讲」，而不是「一张图贴在那儿」。
    """

    def __init__(self, size=420, img=None, name="fish.png"):
        self.size = int(size)
        self.name = name
        self._src = img if img is not None else load_avatar(name)
        self._base = None
        self.ok = self._src is not None
        # 旋转/柔光都是「同一张图 + 一个角度/一个 alpha」⇒ 按量化后的键缓存，
        # 一镜之内角度来回摆，命中率极高。⭐ 实测：不缓存 122ms/帧，缓存后 ~35ms/帧。
        self._rot = {}
        self._glow = {}

    def _prep(self):
        """预先缩放到 2 倍画布上，之后每帧只做位移，省 CPU。"""
        if self._base is not None:
            return self._base
        im = self._src
        S = self.size * SS
        inner = int(S * 0.99)                       # 透明 PNG，占满即可（四周留 1px 防裁边）
        w = inner
        h = max(1, int(round(inner * im.height / im.width)))
        if h > inner:
            h = inner
            w = max(1, int(round(inner * im.width / im.height)))
        s = im.resize((w, h), Image.LANCZOS)
        # 1.png 是半身取景 —— 底边、左边、右边三条都是硬裁切线。
        # 只做「底边垂直渐隐」的话，左右两条直边还在，观感就是一块方形白布
        # （用户看到的就是这个）。这里四条边一起羽化：底边渐隐最长（16%），
        # 左右各 9%，顶部留 1px。读起来是「人从水雾里浮出来」，不是贴纸。
        # ⚠️ 方向：越靠边越透明；写反会变成「中间透明四周实心」。
        fw = max(2, int(w * 0.09))
        fh = max(2, int(h * 0.30))
        vcol = Image.new("L", (1, h))
        vp = vcol.load()
        for y in range(h):
            if y < h - fh:
                vp[0, y] = 255
            else:
                # smoothstep：起手斜率为 0，看不出「从哪一行开始淡的」
                u = (h - y) / fh
                vp[0, y] = int(255 * (u * u * (3 - 2 * u)))
        hrow = Image.new("L", (w, 1))
        hp = hrow.load()
        for x in range(w):
            if x < fw:
                hp[x, 0] = int(255 * (x / fw) ** 1.2)
            elif x > w - 1 - fw:
                hp[x, 0] = int(255 * ((w - 1 - x) / fw) ** 1.2)
            else:
                hp[x, 0] = 255
        feather = ImageChops.multiply(vcol.resize((w, h), Image.BILINEAR),
                                      hrow.resize((w, h), Image.BILINEAR))
        s.putalpha(ImageChops.multiply(s.getchannel("A"), feather))
        canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        canvas.paste(s, ((S - w) // 2, S - h), s)
        self._base = canvas
        return canvas

    def render(self, mouth=0.0, blink=0.0, sway=0.0, tail=0.0, look=0.0,
               blush=0.55, bounce=0.0, mood=1.0):
        """自然版：只有「呼吸的上下浮」和「说话时极轻的挺胸」。

        用户 2026-10-21 反馈：左右无规律摆动、扭头观感很差。
        ⇒ 旋转、横向挤压全部拿掉；`sway`/`look` 参数保留（老调用不用改）但不再驱动旋转，
        只用呼吸 sin 做一个非常慢、非常小的上下浮动（±1.2%），说话时浮动幅度略大，
        让「她在讲」的感觉来自胸腔的起伏而不是位移。
        """
        base = self._prep()
        S = base.width
        m = clamp(float(mouth), 0.0, 1.0)

        # 慢呼吸（周期 ~6.3s）+ 说话时随音量的轻微起伏
        breath = math.sin(sway * 0.5)
        bob = breath * S * 0.012 + float(bounce) * S * 0.004
        scale = 1.0 + 0.006 * (0.4 * breath + 0.6 * m)

        out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        im = base
        if abs(scale - 1.0) > 1e-4:
            w2 = max(1, int(round(S * scale)))
            h2 = max(1, int(round(base.height * scale)))
            im = base.resize((w2, h2), Image.BILINEAR)
        # 以底边为锚缩放（脚不飘），叠加呼吸位移
        px = (S - im.width) // 2
        py = int(bob) + (S - im.height)
        out.alpha_composite(im, (px, py))

        return out.resize((self.size, self.size), Image.LANCZOS)


# ───────────────────────────── 背景与装饰 ─────────────────────────────

def bg_ocean(seed=7, top="#dff0fb", mid="#c4e2f6", bottom="#a8d2ee",
             rays=True, reef=True, rice=False, sun=True) -> Image.Image:
    """浅水海底：淡蓝白渐变 + 水面光斑 + 气泡 + 远处珊瑚。

    用户要求「背景用淡色的，深色文字看不清」⇒ 从深蓝夜景整体翻成浅水白天。
    深色只留给文字和角色，背景一律浅，保证任何手机上都能读。
    """
    rnd = random.Random(seed)
    base = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(base)
    stops = [(0, hexrgb(top)), (0.52, hexrgb(mid)), (1.0, hexrgb(bottom))]
    for y in range(H):
        k = y / (H - 1)
        for i in range(len(stops) - 1):
            a, ca = stops[i]
            b, cb = stops[i + 1]
            if a <= k <= b:
                tt = (k - a) / (b - a)
                d.line([(0, y), (W, y)], fill=mix(ca, cb, tt))
                break
    base = base.convert("RGBA")
    d = ImageDraw.Draw(base, "RGBA")
    # 水面透下来的光柱（淡黄白，很轻）
    if rays:
        for i in range(5):
            x0 = rnd.uniform(-140, W)
            w0 = rnd.uniform(80, 220)
            tilt = rnd.uniform(70, 180)
            col = (255, 255, 245, rnd.randint(26, 46))
            d.polygon([(x0, -40), (x0 + w0, -40), (x0 + w0 - tilt, H), (x0 - tilt, H)], fill=col)
    # 水面上的太阳亮斑（右上角一团暖光）
    if sun:
        for i in range(3):
            x, y = W * rnd.uniform(0.55, 0.95), H * rnd.uniform(0.02, 0.18)
            r = rnd.randint(90, 190)
            d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 252, 232, rnd.randint(20, 34)))
    # 悬浮的小气泡（浅色背景上用白色 + 细边，才看得见）
    for _ in range(90):
        x, y = rnd.random() * W, rnd.random() * H
        r = rnd.choice([1.0, 1.4, 1.8, 2.4, 3.0])
        a = rnd.randint(60, 150)
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, a))
    # 远处的柔光团（水色分层，给画面一点呼吸）
    for _ in range(8):
        x, y = rnd.random() * W, rnd.random() * H
        r = rnd.randint(90, 240)
        col = rnd.choice([(255, 255, 255, 26), (176, 226, 255, 30), (255, 236, 214, 22)])
        d.ellipse([x - r, y - r, x + r, y + r], fill=col)
    base = base.filter(ImageFilter.GaussianBlur(2.2))
    d2 = ImageDraw.Draw(base, "RGBA")
    # 海底沙地 + 珊瑚剪影（浅色：淡青 / 淡紫，不要黑压压）
    if reef:
        for i in range(3):
            col = (120 - i * 18, 168 - i * 16, 196 - i * 10, 70 + i * 45)
            for _ in range(6 + i * 3):
                x = rnd.random() * W
                hgt = rnd.uniform(50, 150) * (1 + i * 0.4)
                sway_k = rnd.uniform(0.5, 1.1)
                pts = []
                for k in range(9):
                    yy = H - k / 8 * hgt
                    xx = x + math.sin(k / 7 * 2.6 + i * 2 + sway_k) * (5 + k * 2.0)
                    pts.append((xx, yy))
                for k in range(len(pts) - 1):
                    lw = max(1.5, (8 - k) * (0.9 + i * 0.35))
                    d2.line([pts[k], pts[k + 1]], fill=col, width=int(lw))
            for _ in range(3):
                x = rnd.random() * W
                r = rnd.uniform(24, 56) * (1 + i * 0.3)
                d2.ellipse([x - r, H - r * 0.9, x + r, H + r * 0.5], fill=col)
        # 沙地
        pts = [(0, H)]
        for x in range(0, W + 60, 60):
            pts.append((x, H - 26 - 16 * math.sin(x / 210.0)))
        pts.append((W, H))
        d2.polygon(pts, fill=(232, 226, 206, 150))
    # 白饭粒（大肥鱼的执念）—— 浅底上改成暖白带描边
    if rice:
        for _ in range(10):
            x, y = rnd.random() * W, rnd.random() * H
            r = rnd.uniform(3.0, 5.0)
            d2.ellipse([x - r * 1.8, y - r, x + r * 1.8, y + r], fill=(255, 253, 246, 235),
                       outline=(214, 196, 170, 150), width=1)
    return base


def bg_night(seed=7, top="#0b1330", bottom="#243a68") -> Image.Image:
    """旧版星空背景：保留当兜底（bg_ocean 的参数不匹配时用）。"""
    rnd = random.Random(seed)
    base = vgradient(W, H, top, bottom)
    d = ImageDraw.Draw(base, "RGBA")
    # 星星
    for _ in range(150):
        x, y = rnd.random() * W, rnd.random() * H * 0.8
        r = rnd.choice([0.8, 1.0, 1.4, 1.9])
        a = rnd.randint(60, 200)
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, a))
    # 光斑
    for _ in range(9):
        x, y = rnd.random() * W, rnd.random() * H
        r = rnd.randint(60, 200)
        col = rnd.choice([(90, 150, 255, 34), (255, 170, 200, 30), (140, 230, 230, 26)])
        d.ellipse([x - r, y - r, x + r, y + r], fill=col)
    base = base.filter(ImageFilter.GaussianBlur(2.2))
    # 底部深海剪影
    d2 = ImageDraw.Draw(base, "RGBA")
    for i in range(3):
        pts = [(0, H)]
        for x in range(0, W + 40, 40):
            pts.append((x, H - 60 - i * 34 - 28 * math.sin(x / 180.0 + i)))
        pts.append((W, H))
        d2.polygon(pts, fill=(8, 16, 36, 150 - i * 40))
    return base


def bubbles(draw, t, seed=3, n=16, area=(0, 0, W, H)):
    rnd = random.Random(seed)
    for i in range(n):
        x0 = area[0] + rnd.random() * (area[2] - area[0])
        y0 = area[3] + rnd.random() * 300
        sp = rnd.uniform(18, 52)
        r = rnd.uniform(3, 13)
        y = y0 - (t * sp + rnd.random() * 500) % (area[3] - area[1] + 300)
        x = x0 + math.sin(t * 1.6 + i) * 10
        a = int(70 + 80 * min(1, r / 13))
        # 浅底上气泡要「白心 + 淡蓝描边」，不然看不见
        draw.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, int(a * 0.55)),
                     outline=(150, 200, 235, a), width=2)
        draw.ellipse([x - r * 0.4, y - r * 0.55, x - r * 0.05, y - r * 0.2], fill=(255, 255, 255, int(a * 0.95)))


def sakura(draw, t, seed=11, n=14):
    rnd = random.Random(seed)
    for i in range(n):
        x0 = rnd.random() * W
        y = (rnd.random() * H + t * rnd.uniform(26, 60)) % (H + 120) - 60
        x = x0 + math.sin(t * 0.9 + i) * 26
        sz = rnd.uniform(4, 9)
        a = int(110 + 70 * rnd.random())
        rot = t * rnd.uniform(0.6, 1.4) + i
        for k in range(5):
            ang = rot + k * math.pi * 2 / 5
            px, py = x + math.cos(ang) * sz, y + math.sin(ang) * sz
            draw.ellipse([px - sz * 0.7, py - sz * 0.7, px + sz * 0.7, py + sz * 0.7],
                         fill=(255, 178, 200, a))


def vignette(img: Image.Image, strength=0.5) -> Image.Image:
    w, h = img.size
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).ellipse([-w * 0.15, -h * 0.2, w * 1.15, h * 1.2], fill=255)
    m = m.filter(ImageFilter.GaussianBlur(int(w * 0.05)))
    dark = Image.new("RGB", (w, h), (4, 8, 20))
    return Image.composite(img, Image.blend(img, dark, strength), m)


# ───────────────────────────── 音频 ─────────────────────────────

def run(cmd, **kw):
    # ⭐ 2026-10-26：所有短命令兜一个超时（默认 10 分钟）—— 以前一律没有 timeout，
    #   ffmpeg/转换卡死时整条视频任务假死，UI 只能永远显示"正在渲染…"。
    kw.setdefault("timeout", 600)
    try:
        p = subprocess.run(cmd, capture_output=True, **kw)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"命令超时（{kw['timeout']}s）：{str(cmd[:3])[:120]} …")
    if p.returncode != 0:
        raise RuntimeError(f"命令失败 {cmd[:3]} …：{p.stderr.decode('utf-8', 'ignore')[:400]}")
    return p.stdout


def ffmpeg_exe():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg") or "ffmpeg"


def gsv_batch(texts, out_dir: Path, voice: dict, log=print):
    """用 GPT-SoVITS 一次性合成一批句子（真·本鱼音色）。

    `voice` 里要的键：
      gsvRepo    —— GPT-SoVITS 仓库根目录（里面要有 GPT_SoVITS/TTS_infer_pack/TTS.py）
      gsvRef     —— 3~10 秒的参考音频（她的原声）
      gsvPrompt  —— 参考音频的原话（必须逐字对上，否则音色会飘）
      gsvPython  —— 跑 GPT-SoVITS 的那个 python（装了 torch 的环境，不是插件 venv）
    剩下的 speed/seed/topK/... 有默认值。

    为什么要单独一批：GPT-SoVITS 加载模型要 30~50 秒，逐句起进程等于每句都付一次。
    """
    repo = str(voice.get("gsvRepo") or "").strip()
    ref = str(voice.get("gsvRef") or "").strip()
    prompt = str(voice.get("gsvPrompt") or "").strip()
    py = str(voice.get("gsvPython") or "").strip() or sys.executable
    script = Path(__file__).resolve().parent / "pv_gsv.py"
    if not script.exists():
        raise RuntimeError(f"找不到 {script}")
    if not repo or not Path(repo).is_dir():
        raise RuntimeError(f"GPT-SoVITS 仓库不在：{repo or '(空)'}")
    if not ref or not Path(ref).is_file():
        raise RuntimeError(f"参考音频不在：{ref or '(空)'}")
    if not prompt:
        raise RuntimeError("参考音频的原话（gsvPrompt）是空的 —— 没它音色会飘")

    out_dir.mkdir(parents=True, exist_ok=True)
    items = [{"text": t, "out": str((out_dir / f"{i:02d}.wav").resolve())}
             for i, t in enumerate(texts)]
    batch = out_dir / "batch.json"
    batch.write_text(json.dumps(items, ensure_ascii=False, indent=1), "utf-8")

    cmd = [py, str(script), "--repo", repo, "--ref", ref, "--prompt", prompt,
           "--batch", str(batch.resolve()), "--outdir", str(out_dir.resolve()),
           "--speed", str(voice.get("gsvSpeed", 1.06)),
           "--seed", str(voice.get("gsvSeed", 20261020)),
           "--top-k", str(voice.get("gsvTopK", 15)),
           "--top-p", str(voice.get("gsvTopP", 0.9)),
           "--temp", str(voice.get("gsvTemp", 0.75)),
           "--repetition-penalty", str(voice.get("gsvRepPen", 1.3))]
    log(f"🎙  GPT-SoVITS 批处理：{len(texts)} 句（加载模型要 30~50 秒）")
    t0 = time.time()
    # ⚠️ 必须给子进程钉死 UTF-8：它会往管道里打中文和 emoji，Windows 默认 GBK 会炸
    genv = dict(os.environ)
    genv["PYTHONUTF8"] = "1"
    genv["PYTHONIOENCODING"] = "utf-8"
    genv.setdefault("NLTK_ALLOW_PROXIED_URLOPEN", "1")
    # ⭐ 2026-10-26：加 60 分钟超时 —— 加载模型 30~50 秒 + 逐句合成可达几分钟到几十分钟，
    #   但 torch 死锁/坏模型挂住时不能让整条任务无限期假死。
    try:
        p = subprocess.run(cmd, capture_output=True, env=genv, timeout=3600)
    except subprocess.TimeoutExpired:
        raise RuntimeError("GPT-SoVITS 批处理超时（60 分钟）—— 检查它是不是卡在加载模型或 GPU 占用上")
    out = (p.stdout or b"").decode("utf-8", "ignore")
    for line in out.splitlines()[-14:]:
        log("   " + line)
    if p.returncode != 0:
        err = (p.stderr or b"").decode("utf-8", "ignore")[-700:]
        raise RuntimeError(f"GPT-SoVITS 失败（{p.returncode}）：{err}")
    log(f"   ✓ {time.time() - t0:.0f}s")
    miss = [i for i, it in enumerate(items)
            if not Path(it["out"]).exists() or Path(it["out"]).stat().st_size < 4000]
    if miss:
        raise RuntimeError(f"GPT-SoVITS 这几句没出来：{miss}")
    return "gsv"


def tts(text: str, out_mp3: Path, voice="zh-CN-XiaoyiNeural", rate="+8%", pitch="+22Hz"):
    """edge-tts 合成；失败退到 Windows SAPI（离线，音质差但不会没声）。"""
    import asyncio
    try:
        import edge_tts

        async def go():
            c = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
            await c.save(str(out_mp3))

        asyncio.run(go())
        # ⭐ 2026-10-26：阈值 1200→600 —— "嗯。"这种极短句的 mp3 可能不足 1200 字节，
        #   以前会被误判失败、拐去 SAPI（音色突变还叠加编码乱码）。
        if out_mp3.exists() and out_mp3.stat().st_size > 600:
            return "edge-tts"
    except Exception as e:
        print(f"  ! edge-tts 失败（{type(e).__name__}: {e}），退到 SAPI", flush=True)

    # —— SAPI 兜底 ——
    wav = out_mp3.with_suffix(".sapi.wav")
    # ⭐ 2026-10-26 修两处老毛病：
    #   ① 先把 PowerShell 的 stdin 解码钉成 UTF-8 —— 中文 Windows 默认 GBK，
    #     UTF-8 字节按 GBK 解出来 SAPI 念的是乱码（对 GPT-SoVITS 子进程就钉过，这里漏了）；
    #   ② wav 路径按 PS 单引号规则转义 —— 用户名/路径带 ' 时命令会断甚至被注入。
    wav_ps = str(wav).replace("'", "''")
    ps = (
        "[Console]::InputEncoding=[System.Text.Encoding]::UTF8;"
        "Add-Type -AssemblyName System.Speech;"
        "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        "$null=$s.SelectVoice('Microsoft Huihui Desktop');"
        f"$s.SetOutputToWaveFile('{wav_ps}');$s.Speak([Console]::In.ReadToEnd());$s.Dispose()"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                   input=text.encode("utf-8"), check=False, timeout=120)
    if not wav.exists():
        raise RuntimeError("SAPI 也没声")
    subprocess.run([ffmpeg_exe(), "-y", "-loglevel", "error", "-i", str(wav), str(out_mp3)],
                   check=True, timeout=180)
    return "sapi"


def to_wav(src: Path, dst: Path, rate=24000):
    run([ffmpeg_exe(), "-y", "-loglevel", "error", "-i", str(src), "-ac", "1", "-ar", str(rate), str(dst)])
    with wave.open(str(dst), "rb") as w:
        n = w.getnframes()
        sw = w.getsampwidth()
        data = w.readframes(n)
    if sw == 2:
        pcm = array.array("h")
    else:
        raise RuntimeError("只支持 16bit wav")
    pcm.frombytes(data)
    return pcm, rate


def squeeze_silence(pcm, rate, max_gap=0.42, keep=0.30, th=450.0, edge=0.12):
    """把句中过长的静音压短（用户反馈：中间有段时间语音停了）。

    GPT-SoVITS 偶尔会在分句边界吐出好几秒的死寂；这里按 20ms 窗算能量，
    连续静音超过 `max_gap` 秒就压到 `keep` 秒。返回新 pcm（原 pcm 不动）。
    """
    if not pcm:
        return pcm
    win = max(1, int(rate * 0.02))
    n = len(pcm)
    # 每窗 RMS
    flags = []          # True = 静音窗
    for i in range(0, n, win):
        seg = pcm[i:i + win]
        acc = 0
        for v in seg:
            acc += v * v
        rms = math.sqrt(acc / max(1, len(seg)))
        flags.append(rms < th)
    # 找连续静音段（窗口索引）
    runs = []
    i = 0
    m = len(flags)
    while i < m:
        if flags[i]:
            j = i
            while j < m and flags[j]:
                j += 1
            runs.append((i, j))          # [i, j)
            i = j
        else:
            i += 1
    if not runs:
        return pcm
    # 头尾的静音段保留 edge 秒；中间的压到 keep 秒（保留后半，让停顿贴着下一句）
    drop = array.array("b", [0]) * m          # 1 = 这个窗要丢
    for (i0, j0) in runs:
        dur = (j0 - i0) * 0.02
        head = i0 == 0
        tail = j0 == m
        budget = edge if (head or tail) else max(keep, 0.0)
        if dur <= budget:
            continue
        # 保留前 budget 秒，其余丢掉
        keepw = int(budget / 0.02)
        for k in range(i0 + keepw, j0):
            drop[k] = 1
    if not any(drop):
        return pcm
    out = array.array("h")
    for i in range(m):
        if drop[i]:
            continue
        out.extend(pcm[i * win:(i + 1) * win])
    out.extend(pcm[m * win:])
    return out


def envelope(pcm, rate, fps):
    """把波形压成每帧一个 0~1 的响度包络（口型用）。"""
    step = rate / fps
    out = []
    n = len(pcm)
    i = 0
    while i < n:
        j = int(min(n, i + step))
        seg = pcm[i:j]
        if not seg:
            break
        # RMS
        acc = 0
        for v in seg:
            acc += v * v
        rms = math.sqrt(acc / len(seg)) / 32768.0
        out.append(rms)
        i = j
    # 归一化 + 轻轻的平滑
    mx = max(out, default=0.0) or 1.0
    out = [min(1.0, (v / mx) * 1.8) for v in out]
    sm = []
    for k in range(len(out)):
        a = out[max(0, k - 1)]
        b = out[k]
        c = out[min(len(out) - 1, k + 1)]
        sm.append((a + 2 * b + c) / 4)
    return sm


def bgm(duration, rate=24000, path: Path = None):
    """程序化音乐盒 BGM（C 大调五声琶音 + 轻 pad），完全离线。"""
    import struct
    bpm = 92
    beat = 60.0 / bpm
    scale = [523.25, 587.33, 659.25, 783.99, 880.00, 1046.5, 1174.66]
    n = int(duration * rate)
    buf = array.array("h", [0]) * n
    rnd = random.Random(5)
    # 琶音
    t = 0.0
    k = 0
    while t < duration:
        f = scale[k % len(scale)] * (1 if (k // len(scale)) % 2 == 0 else 2)
        i0 = int(t * rate)
        ln = int(min(0.9, duration - t) * rate)
        for j in range(ln):
            e = math.exp(-j / (rate * 0.22))
            v = math.sin(2 * math.pi * f * j / rate) * 0.5 + math.sin(2 * math.pi * f * 2 * j / rate) * 0.12
            idx = i0 + j
            if 0 <= idx < n:
                buf[idx] += int(v * e * 5200)
        t += beat / 2
        k += 1
    # pad
    for f in (130.81, 196.0, 261.63):
        for j in range(n):
            buf[j] += int(math.sin(2 * math.pi * f * j / rate) * 900)
    # 淡入淡出
    fade = int(rate * 1.2)
    for j in range(min(fade, n)):
        buf[j] = int(buf[j] * (j / fade))
        buf[n - 1 - j] = int(buf[n - 1 - j] * (j / fade))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(buf.tobytes())
    return path


# ───────────────────────────── 分镜绘制 ─────────────────────────────

def draw_avatar(base: Image.Image, fish, xy, scale=1.0, **kw):
    av = fish.render(**kw)
    if scale != 1.0:
        av = av.resize((int(av.width * scale), int(av.height * scale)), Image.LANCZOS)
    paste_rgba(base, av, xy)


# ───────────────────── 统一的「讲解位」版式 ─────────────────────
# 用户 2026-10-21 反馈：① 角色别缩在右下角还被字幕压住；② 内容别被大片字幕挡。
# ⇒ 角色抬到右侧竖直居中（脚踩字幕带上方），字幕只占左栏，永不盖到角色。

AV_SCALE = 1.0
AV_SIZE = 470                                    # 立绘方形边长（fish.png 全身）
AV_X = W - AV_SIZE - 26                          # 784
# 底边压到画面外一点（H-46 = 674）：半身像的裁切线落在画外，
# 观众看到的是「人从画面下方长上来」，而不是一块被渐隐切掉的方图。
AV_Y = H - AV_SIZE - 46
CONTENT_X = 58
CONTENT_W = AV_X - CONTENT_X - 30                # 左栏可用宽度（≈696）
SUB_W = CONTENT_W + 6                            # 字幕带宽度（= 左栏，永不越过分界线）

# —— 淡色主题（浅水蓝白）：深色底白字在手机上根本读不清，整体翻成浅底深字 ——
INK = (30, 54, 86)              # 主文字：深蓝墨
INK_SOFT = (82, 112, 146)       # 次文字
INK_FAINT = (132, 160, 190)     # 极弱文字
CARD_BG = (255, 255, 255, 214)  # 卡片底：半透明白
CARD_EDGE = (150, 190, 226, 190)
ACCENT = (240, 132, 72)         # 珊瑚橙（强调）
ACCENT2 = (70, 152, 216)        # 海蓝
BAND = (255, 255, 255, 222)     # 字幕带底


# 内容区上下界：上面留给 kicker（标签），下面留给字幕带。
# 字幕带最高 2 行 ⇒ 顶边约 y=584，所以内容一律不许超过 572。
ZONE_TOP = 96
ZONE_BOT = 572


def vcenter(block_h, top=ZONE_TOP, bot=ZONE_BOT):
    """把高度为 block_h 的内容块在 [top,bot] 里垂直居中。

    为什么要居中没有直接写死 y：卡片的行数不固定（一行大字 vs 两行 + 副题），
    写死就会「有的卡顶到天、有的卡飘在半空」，观众每切一镜眼睛都要重新找焦点。
    """
    return int(top + max(0, (bot - top - block_h) // 2))


def kicker(d, text, y=54, accent=None):
    """左上角小标签：一道暖色竖条 + 一行小字（浅底上用深墨色）。"""
    if not text:
        return
    accent = accent or ACCENT
    d.rounded_rectangle([CONTENT_X, y + 4, CONTENT_X + 8, y + 30], radius=4, fill=accent + (240,))
    d.text((CONTENT_X + 22, y), str(text), font=F(24, True), fill=INK_SOFT + (245,))


def soft_card(img, box, radius=24, fill=None, edge=None, width=2):
    """浅底卡片：白色半透明 + 细边 + 极轻的投影，压在水色上也清爽。"""
    fill = fill or CARD_BG
    edge = edge or CARD_EDGE
    x0, y0, x1, y1 = box
    sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ds = ImageDraw.Draw(sh)
    ds.rounded_rectangle([x0 + 2, y0 + 5, x1 + 2, y1 + 5], radius=radius, fill=(90, 130, 170, 40))
    img.alpha_composite(sh) if img.mode == "RGBA" else paste_rgba(img, sh, (0, 0))
    lay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    dl = ImageDraw.Draw(lay)
    dl.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=fill, outline=edge, width=width)
    img.alpha_composite(lay) if img.mode == "RGBA" else paste_rgba(img, lay, (0, 0))


def _stand(img, st, t, look=-0.18, blush=0.6, ph=0.0, scale=AV_SCALE, xy=None):
    x, y = (AV_X, AV_Y) if xy is None else xy
    draw_avatar(img, st["fish"], (x, y), scale, mouth=st.get("mouth", 0.0), sway=t * 2.9 + ph, tail=t * 2.2 + ph,
                blink=blink_of(t + ph * 0.4), look=look, bounce=math.sin(t * 2.0 + ph) * 0.5,
                blush=blush)


def title_card(shot, t, dur, st) -> Image.Image:
    img = st["bg_title"].copy()
    d = ImageDraw.Draw(img, "RGBA")
    tag = shot.get("tag", "")
    if tag:
        tf = F(25, True)
        a = int(240 * ease_out(clamp(t / 0.7, 0, 1)))
        soft_card(img, [CONTENT_X, 92, CONTENT_X + d.textlength(tag, font=tf) + 56, 146],
                  radius=27, fill=(255, 255, 255, 205), edge=ACCENT + (int(a * 0.75),))
        d = ImageDraw.Draw(img, "RGBA")
        d.text((CONTENT_X + 28, 101), tag, font=tf, fill=ACCENT + (a,))
    p = ease_out(clamp((t - 0.15) / 0.9, 0, 1))
    big = F(74 + int(6 * p), True)
    txt = shot.get("title", "")
    tlines = draw_text_wrap(d, txt, big, CONTENT_W - 8, None)[:2]
    stxt = shot.get("sub", "")
    sl = draw_text_wrap(d, stxt, F(30), CONTENT_W - 20, None)[:2] if stxt else []
    gh = len(tlines) * 92 + 40 + len(sl) * 40
    # 标题卡也居中：大字 + 副题的整体在内容区中间，别贴着上半截
    top = vcenter(gh, top=120, bot=ZONE_BOT) + 18
    y = top - 26 * (1 - p)
    soft_card(img, [CONTENT_X - 24, y - 18, CONTENT_X + CONTENT_W - 8, y + gh],
              radius=34, fill=(255, 255, 255, 196))
    d = ImageDraw.Draw(img, "RGBA")
    for ln in tlines:
        d.text((CONTENT_X, y), ln, font=big, fill=INK + (int(255 * p),))
        y += 92
    if sl:
        pa = clamp((t - 0.6) / 0.8, 0, 1)
        sf = F(30)
        for ln in sl:
            d.text((CONTENT_X, y + 8), ln, font=sf, fill=INK_SOFT + (int(240 * pa),))
            y += 40
    bubbles(d, t, seed=1, n=12)
    _stand(img, st, t, look=0.06, blush=0.7, ph=0.4, scale=1.06)
    return img


def blink_of(t):
    ph = t % 3.4
    return max(0.0, 1 - abs(ph - 0.12) / 0.16) if ph < 0.28 else 0.0


def stats_card(shot, t, dur, st):
    img = st["bg_stats"].copy()
    d = ImageDraw.Draw(img, "RGBA")
    kicker(d, shot.get("header", "昨天 · 数字"), 48)
    items = shot.get("items", [])[:4]
    n = max(1, len(items))
    gap = 20
    card_w = min(200, int((CONTENT_W - gap * (n - 1)) / n))
    card_h = 148
    y0 = 214
    for i, it in enumerate(items):
        p = ease_out(clamp((t - 0.30 - i * 0.14) / 0.55, 0, 1))
        cx0 = CONTENT_X + i * (card_w + gap)
        cy0 = y0 + (1 - p) * 34
        layer = Image.new("RGBA", (card_w, card_h), (0, 0, 0, 0))
        dl = ImageDraw.Draw(layer)
        dl.rounded_rectangle([0, 0, card_w - 1, card_h - 1], radius=24, fill=(255, 255, 255, 216),
                             outline=(150, 190, 226, 190), width=2)
        dl.text((22, 20), str(it.get("label", "")), font=F(23), fill=INK_SOFT + (240,))
        val = str(it.get("value", ""))
        vf = F(58, True)
        dl.text((22, 60), val, font=vf, fill=INK + (252,))
        unit = str(it.get("unit", ""))
        if unit:
            dl.text((22 + dl.textlength(val, font=vf) + 6, 94), unit, font=F(22), fill=ACCENT + (240,))
        dl.rounded_rectangle([22, card_h - 26, card_w - 22, card_h - 22], radius=2, fill=(206, 224, 240, 200))
        dl.rounded_rectangle([22, card_h - 26, 22 + int((card_w - 44) * clamp(p, 0, 1)), card_h - 22],
                             radius=2, fill=ACCENT + (225,))
        if p < 1:
            arr = layer.split()[3].point(lambda v, p=p: int(v * p))
            layer.putalpha(arr)
        paste_rgba(img, layer, (cx0, cy0))
    note = shot.get("note", "")
    if note:
        pn = ease_out(clamp((t - 0.9) / 0.7, 0, 1))
        d.line([CONTENT_X + 4, y0 + card_h + 46, CONTENT_X + 4, y0 + card_h + 118],
               fill=ACCENT + (int(210 * pn),), width=5)
        qf = F(25)
        yy = y0 + card_h + 40
        for ln in draw_text_wrap(d, note, qf, CONTENT_W - 40, None)[:3]:
            d.text((CONTENT_X + 24, yy), ln, font=qf, fill=INK + (int(246 * pn),))
            yy += 38
    bubbles(d, t, seed=6, n=10)
    _stand(img, st, t, look=-0.22, blush=0.62, ph=1.2)
    return img


def video_card(shot, t, dur, st):
    img = st["bg_video"].copy()
    d = ImageDraw.Draw(img, "RGBA")
    kicker(d, shot.get("kicker", "昨天看了"), 42)
    p = ease_out(clamp(t / 0.55, 0, 1))
    idx = shot.get("index")
    if idx:
        bx, by = CONTENT_X, 92
        d.ellipse([bx, by, bx + 58, by + 58], fill=ACCENT + (240,))
        num = str(idx)
        d.text((bx + 29 - d.textlength(num, font=F(32, True)) / 2, by + 9), num,
               font=F(32, True), fill=(255, 255, 255))
    # 封面
    cw, ch = 372, 209
    cx0 = CONTENT_X + 4 + (1 - p) * -60
    # 封面 + 下方「为什么」整块居中，别让整张卡贴在上半截
    why = shot.get("why", "")
    ql = draw_text_wrap(d, why, F(24), CONTENT_W - 64, None)[:3] if why else []
    why_h = (len(ql) * 36 + 26 + 26) if ql else 0
    cy0 = vcenter(ch + why_h)
    card = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    cover = st.get("_cover_cache", {}).get(cover_key(shot)[0])
    if cover is not None:
        card.paste(cover.resize((cw, ch), Image.LANCZOS).convert("RGB"), (0, 0))
        ov = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        ImageDraw.Draw(ov).rectangle([0, ch - 52, cw, ch], fill=(10, 26, 46, 185))
        card.alpha_composite(ov)
    else:
        dc0 = ImageDraw.Draw(card)
        dc0.rectangle([0, 0, cw, ch], fill=(214, 232, 246, 255))
        dc0.text((22, ch / 2 - 26), "🐟", font=F(54), fill=(120, 170, 210, 255))
    dc = ImageDraw.Draw(card)
    up = shot.get("up", "")
    if up:
        dc.text((16, ch - 40), "UP · " + up, font=F(21), fill=(240, 248, 255, 248))
    card.putalpha(rounded_mask((cw, ch), 22))
    glow = Image.new("RGBA", (cw + 22, ch + 22), (0, 0, 0, 0))
    ImageDraw.Draw(glow).rounded_rectangle([0, 0, cw + 21, ch + 21], radius=30,
                                           outline=(255, 255, 255, 210), width=3)
    paste_rgba(img, glow, (cx0 - 11, cy0 - 11))
    paste_rgba(img, card, (cx0, cy0))
    # 右栏文字（和封面同一水平中线起，别一个贴顶一个居中）
    tx = cx0 + cw + 34
    tw_max = CONTENT_X + CONTENT_W - tx
    p2 = ease_out(clamp((t - 0.22) / 0.6, 0, 1))
    tf = F(31, True)
    y = cy0 + 4 + (1 - p2) * 22
    for ln in draw_text_wrap(d, shot.get("title", ""), tf, tw_max, None)[:3]:
        d.text((tx, y), ln, font=tf, fill=INK + (int(250 * p2),))
        y += 42
    meta = shot.get("stat", "")
    if meta:
        d.text((tx, y + 4), meta, font=F(21), fill=INK_SOFT + (int(238 * p2),))
        y += 36
    # 「为什么」—— 封面下方，横跨内容区，压白卡才读得清
    if ql:
        p3 = ease_out(clamp((t - 0.8) / 0.7, 0, 1))
        wy = cy0 + ch + 26
        bh = len(ql) * 36 + 26
        soft_card(img, [CONTENT_X, wy, CONTENT_X + CONTENT_W - 8, wy + bh], radius=22)
        d = ImageDraw.Draw(img, "RGBA")
        d.rounded_rectangle([CONTENT_X + 16, wy + 14, CONTENT_X + 21, wy + bh - 14], radius=3,
                            fill=ACCENT + (int(225 * p3),))
        yy = wy + 11
        for ln in ql:
            d.text((CONTENT_X + 34, yy), ln, font=F(24), fill=INK + (int(248 * p3),))
            yy += 36
    _stand(img, st, t, look=-0.3, blush=0.66, ph=0.7)
    return img


def quote_card(shot, t, dur, st):
    img = st["bg_quote"].copy()
    d = ImageDraw.Draw(img, "RGBA")
    kicker(d, shot.get("header", ""), 44)
    p = ease_out(clamp(t / 0.7, 0, 1))
    txt = shot.get("quote", "")
    tf = F(40)
    lines = draw_text_wrap(d, txt, tf, CONTENT_W - 70, None)[:5]
    src = shot.get("from", "")
    bh = len(lines) * 60 + (58 if src else 26)
    # 垂直居中：一行引言的卡以前死钉在 y=196，下面空掉一大片
    top = vcenter(bh)
    d.text((CONTENT_X - 10, top - 122), "“", font=F(150, True), fill=(150, 196, 232, int(120 * p)))
    soft_card(img, [CONTENT_X - 18, top, CONTENT_X + CONTENT_W - 8, top + bh], radius=28)
    d = ImageDraw.Draw(img, "RGBA")
    y = top + 14 - 16 * (1 - p)
    for i, ln in enumerate(lines):
        pp = ease_out(clamp((t - 0.18 - i * 0.15) / 0.55, 0, 1))
        d.text((CONTENT_X + 34, y), ln, font=tf, fill=INK + (int(252 * pp),))
        y += 60
    if src:
        d.text((CONTENT_X + 38, y + 14), "—— " + src, font=F(24),
               fill=INK_SOFT + (int(240 * clamp((t - 0.8) / 0.6, 0, 1)),))
    bubbles(d, t, seed=12, n=14)
    _stand(img, st, t, look=0.02, blush=0.8, ph=2.1)
    return img


def social_card(shot, t, dur, st):
    img = st["bg_social"].copy()
    d = ImageDraw.Draw(img, "RGBA")
    kicker(d, shot.get("header", ""), 44)
    rows = shot.get("rows", [])[:4]
    roww = CONTENT_W - 6
    note = shot.get("note", "")
    nl = draw_text_wrap(d, note, F(22), CONTENT_W - 30, None)[:2] if note else []
    # 先量总高再居中，免得 2 行 / 4 行两种卡一个贴顶一个压底
    block_h = len(rows) * 96 + (len(nl) * 32 + 18 if nl else 0)
    y = vcenter(block_h)
    for i, r in enumerate(rows):
        p = ease_out(clamp((t - 0.26 - i * 0.13) / 0.5, 0, 1))
        h = 86
        layer = Image.new("RGBA", (roww, h), (0, 0, 0, 0))
        dl = ImageDraw.Draw(layer)
        dl.rounded_rectangle([0, 0, roww, h - 1], radius=20, fill=(255, 255, 255, 218),
                             outline=(150, 190, 226, 185), width=1)
        dl.text((20, 10), str(r.get("who", ""))[:14], font=F(22, True), fill=ACCENT2 + (250,))
        body = str(r.get("text", ""))
        bl = draw_text_wrap(dl, body, F(21), roww - 150, None)[:1]
        dl.text((20, 40), bl[0] if bl else "", font=F(21), fill=INK + (240,))
        side = r.get("side", "")
        if side:
            dl.text((roww - 20 - dl.textlength(side, font=F(19)), 46), side, font=F(19), fill=ACCENT + (240,))
        if p < 1:
            layer.putalpha(layer.split()[3].point(lambda v, p=p: int(v * p)))
        paste_rgba(img, layer, (CONTENT_X, y + (1 - p) * 20))
        y += 96
    if nl:
        yy = y + 4
        for ln in nl:
            d.text((CONTENT_X + 4, yy), ln, font=F(22), fill=INK_SOFT + (245,))
            yy += 32
    _stand(img, st, t, look=-0.34, blush=0.7, ph=1.6)
    return img


def line_card(shot, t, dur, st):
    """一句话卡：给「收工前那点岔子」这类没有列表、只有一句话的场面用。"""
    img = st["bg_quote"].copy()
    d = ImageDraw.Draw(img, "RGBA")
    kicker(d, shot.get("header", ""), 44, accent=ACCENT2)
    p = ease_out(clamp(t / 0.7, 0, 1))
    tf = F(48, True)
    lines = draw_text_wrap(d, shot.get("line", ""), tf, CONTENT_W - 60, None)[:4]
    sub = shot.get("sub", "")
    sl = draw_text_wrap(d, sub, F(24), CONTENT_W - 80, None)[:3] if sub else []
    bh = len(lines) * 66 + (len(sl) * 34 + 34 if sl else 24)
    top = vcenter(bh)
    soft_card(img, [CONTENT_X - 16, top, CONTENT_X + CONTENT_W - 8, top + bh], radius=28)
    d = ImageDraw.Draw(img, "RGBA")
    y = top + 14 - 18 * (1 - p)
    for i, ln in enumerate(lines):
        pp = ease_out(clamp((t - 0.16 - i * 0.14) / 0.5, 0, 1))
        d.text((CONTENT_X + 14, y), ln, font=tf, fill=INK + (int(252 * pp),))
        y += 66
    if sl:
        ps = clamp((t - 0.9) / 0.6, 0, 1)
        d.rounded_rectangle([CONTENT_X + 4, y + 12, CONTENT_X + 9, y + 12 + len(sl) * 34], radius=3,
                            fill=ACCENT2 + (int(215 * ps),))
        yy = y + 8
        for ln in sl:
            d.text((CONTENT_X + 26, yy), ln, font=F(24), fill=INK_SOFT + (int(245 * ps),))
            yy += 34
    bubbles(d, t, seed=15, n=12)
    _stand(img, st, t, look=-0.26, blush=0.5, ph=2.6)
    return img


def outro_card(shot, t, dur, st):
    img = st["bg_title"].copy()
    d = ImageDraw.Draw(img, "RGBA")
    p = ease_out(clamp((t - 0.2) / 0.8, 0, 1))
    f = F(66, True)
    ll = draw_text_wrap(d, shot.get("line", "明天见"), f, CONTENT_W - 40, None)[:2]
    sub = shot.get("sub", "")
    sl = draw_text_wrap(d, sub, F(26), CONTENT_W - 60, None)[:3] if sub else []
    bh = len(ll) * 80 + (len(sl) * 38 + 30 if sl else 24)
    top = vcenter(bh)
    soft_card(img, [CONTENT_X - 16, top, CONTENT_X + CONTENT_W - 8, top + bh], radius=30)
    d = ImageDraw.Draw(img, "RGBA")
    y = top + 16 - 22 * (1 - p)
    for ln in ll:
        d.text((CONTENT_X + 14, y), ln, font=f, fill=INK + (int(252 * p),))
        y += 80
    if sl:
        yy = y + 10
        for ln in sl:
            d.text((CONTENT_X + 16, yy), ln, font=F(26), fill=INK_SOFT + (int(240 * p),))
            yy += 38
    bubbles(d, t, seed=4, n=14)
    _stand(img, st, t, look=0.0, blush=0.85, ph=0.9)
    return img




# ───────────────────── 对话舞台：1080p 暖光书桌 ─────────────────────
#
# 为什么这样画（不是滤镜堆出来的）：
# · 逻辑坐标仍是 1280x720（老卡片继续用它），对话舞台单独按 K=1.5 画到
#   1920x1080 —— 真·高分辨率渲染，不是后期放大。
# · 三层：背景（墙/窗/海/光，轻微虚化 + bloom）→ 立绘（锐利，左缘一圈暖
#   轮廓光）→ 前景（桌面/道具，不透明地盖住下半身）。有前后关系才有「拍出来」
#   的感觉。
# · 光从左边窗户进来：墙面左上亮、右下暗；桌面左暖右冷；暗角把视线收回脸上。

K = 1.5
DW, DH = int(round(W * K)), int(round(H * K))

POSE_ASPECT = 1037 / 1100
EYE_X, EYE_Y = 0.4947, 0.400   # 两眼中间的相对位置：推镜围着它，脸不漂

# 机位：hp=立绘高度（设备像素），ex/ey=眼睛落点，bubble=(中心, 直径)
# 站姿比例是 Q 版（头占 64%），推近时允许呆毛出画；中景保留头顶留白。
CAM = {
    "wide":        dict(hp=900,  ex=1330, ey=420),
    "medium":      dict(hp=950,  ex=1300, ey=448),
    "close":       dict(hp=1300, ex=1246, ey=440),
    "push":        dict(hp=1150, ex=1290, ey=440),
    "reverse":     dict(hp=980,  ex=1668, ey=470, bubble=((575, 430), 610)),
    "close-inner": dict(hp=1050, ex=1640, ey=460, bubble=((556, 420), 660)),
    "insert":      dict(hp=900,  ex=1800, ey=330, blur=1.8),
}

WARM = (255, 214, 158)
SKY_TOP, SKY_MID, SKY_LOW = "#4A749A", "#9FC0D3", "#F3B478"
SEA_NEAR, SEA_FAR = (54, 84, 104), (86, 118, 136)
WOOD_HI, WOOD_MID, WOOD_LO = (176, 128, 88), (136, 94, 62), (84, 56, 36)
WALL_NEAR, WALL_FAR = (198, 172, 142), (92, 74, 58)
WIN_BOX = (110, 70, 930, 604)
DESK_TOP = 792


@lru_cache(maxsize=16)
def _vgrad(w, h, c0, c1):
    top, bottom = hexrgb(c0), hexrgb(c1)
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        d.line([(0, y), (w, y)], fill=mix(top, bottom, y / max(1, h - 1)))
    return img


@lru_cache(maxsize=40)
def _soft_dot(size, color, alpha=255):
    """羽化圆点：粒子 / 光斑 / 柔光罩共用。"""
    s = max(2, int(size))
    img = Image.new("RGBA", (s, s), color + (0,))
    ImageDraw.Draw(img).ellipse((0, 0, s - 1, s - 1), fill=color + (alpha,))
    return img.filter(ImageFilter.GaussianBlur(s * .18))


@lru_cache(maxsize=8)
def _side_mask(w, h, power=1.6, flip=False):
    """一侧亮、一侧黑的横向遮罩（做单侧轮廓光）。"""
    ramp = Image.new("L", (256, 1))
    for x in range(256):
        ramp.putpixel((x, 0), int(255 * (1 - x / 255.0) ** power))
    if flip:
        ramp = ramp.transpose(Image.FLIP_LEFT_RIGHT)
    return ramp.resize((max(1, w), max(1, h)))


@lru_cache(maxsize=8)
def _vignette_mask(w, h):
    """椭圆径向遮罩：边缘压暗，视线收在脸和窗上。"""
    small = Image.new("L", (160, 90), 0)
    ImageDraw.Draw(small).ellipse((-26, -18, 186, 108), fill=255)
    small = small.filter(ImageFilter.GaussianBlur(24))
    return small.resize((max(1, w), max(1, h))).point(lambda v: 96 + int(159 * (v / 255.0) ** 1.5))


def _draw_sky(win):
    """窗外：黄昏渐变 + 落日光晕 + 云 + 海面反光柱。"""
    x0, y0, x1, y1 = win
    w, h = x1 - x0, y1 - y0
    sky = _vgrad(w, h, SKY_TOP, SKY_MID).convert("RGBA")
    low = _vgrad(w, h, SKY_MID, SKY_LOW).convert("RGBA")
    sky = Image.composite(low, sky, Image.linear_gradient("L").resize((w, h)))
    sx, sy = int(w * .30), int(h * .70)
    for size, color in ((.86, (255, 238, 196)), (.30, (255, 244, 214)), (.15, (255, 252, 238))):
        dot = _soft_dot(int(h * size), color, 255)
        sky.alpha_composite(dot, (sx - dot.width // 2, sy - dot.height // 2))
    for cy, cw, ch, al in ((.16, .60, .12, 70), (.30, .42, .10, 52), (.46, .74, .09, 40)):
        cloud = _soft_dot(int(h * ch), (255, 246, 232), al).resize((int(w * cw), int(h * ch)))
        sky.alpha_composite(cloud, (int(w * .10) + int(w * .18 * cy), int(h * cy) - cloud.height // 2))
    horizon = int(h * .74)
    sea = Image.new("RGBA", (w, h - horizon))
    ds = ImageDraw.Draw(sea)
    for i in range(h - horizon):
        ds.line([(0, i), (w, i)], fill=mix(SEA_NEAR, SEA_FAR, i / max(1, h - horizon)) + (255,))
    sky.alpha_composite(sea, (0, horizon))
    d = ImageDraw.Draw(sky, "RGBA")
    for i in range(26):
        t = i / 26
        yy = horizon + int((h - horizon) * (t ** 1.5))
        half = int(w * (.03 + .10 * t))
        d.line([(sx - half, yy), (sx + half, yy)],
               fill=(255, 226, 178, int(96 * (1 - t))), width=max(1, int(3 - 2 * t)))
    d.polygon([(0, horizon), (w * .12, horizon - h * .045), (w * .22, horizon), (w * .58, horizon),
               (w * .70, horizon - h * .028), (w * .80, horizon)], fill=(96, 120, 132, 190))
    return sky.filter(ImageFilter.GaussianBlur(1.1))


def _draw_window(img, box):
    """白木窗框 + 内窗台 + 一盆小植物。"""
    x0, y0, x1, y1 = box
    frame = Image.new("RGBA", img.size, (0, 0, 0, 0))
    fd = ImageDraw.Draw(frame, "RGBA")
    fd.rounded_rectangle((x0 - 26, y0 - 26, x1 + 26, y1 + 26), radius=26, fill=(246, 238, 226, 255))
    fd.rounded_rectangle((x0 - 26, y0 - 26, x1 + 26, y0 + 6), radius=20, fill=(255, 250, 240, 255))
    fd.rounded_rectangle((x0 - 26, y1 - 8, x1 + 26, y1 + 26), radius=18, fill=(206, 190, 172, 255))
    img.alpha_composite(frame)
    win = _draw_sky((x0, y0, x1, y1))
    img.paste(win, (x0, y0), rounded_mask((x1 - x0, y1 - y0), 6))
    d = ImageDraw.Draw(img, "RGBA")
    mx = x0 + int((x1 - x0) * .52)
    my = y0 + int((y1 - y0) * .46)
    d.rectangle((mx - 9, y0, mx + 9, y1), fill=(247, 240, 229, 255))
    d.rectangle((x0, my - 8, x1, my + 8), fill=(247, 240, 229, 255))
    d.line((mx - 9, y0, mx - 9, y1), fill=(255, 252, 245, 210), width=3)
    glass = Image.new("RGBA", (x1 - x0, y1 - y0), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glass, "RGBA")
    for off in (0, 150):
        gd.polygon([(off, y1 - y0), (off + 90, y1 - y0), (off + 300, 0), (off + 210, 0)],
                   fill=(255, 255, 255, 16))
    img.paste(glass, (x0, y0), glass)
    d = ImageDraw.Draw(img, "RGBA")
    d.rounded_rectangle((x0 - 40, y1 + 10, x1 + 40, y1 + 40), radius=8, fill=(236, 224, 208, 255))
    d.line((x0 - 40, y1 + 12, x1 + 40, y1 + 12), fill=(255, 249, 238, 255), width=3)
    px, py = x1 - 90, y1 + 8
    d.ellipse((px - 26, py - 6, px + 26, py + 22), fill=(196, 124, 92, 255))
    for ang in (-52, -18, 14, 46):
        d.line((px, py - 4, px + int(34 * math.sin(math.radians(ang))),
                py - 10 - int(44 * math.cos(math.radians(ang)))), fill=(96, 132, 104, 235), width=6)


def _draw_wall():
    # 暗室内：墙压得很低，窗才是唯一光源 —— 否则整幅画没有暗部锚点，看着就「平」。
    img = _vgrad(DW, DH, "#6E5847", "#41332A").convert("RGBA")
    d = ImageDraw.Draw(img, "RGBA")
    d.rectangle((0, 812, DW, 900), fill=(84, 66, 52, 255))
    d.line((0, 812, DW, 812), fill=(126, 102, 80, 255), width=4)
    d.rectangle((0, 872, DW, 900), fill=(58, 45, 35, 255))
    # 右侧书架剪影（虚化），给纵深一个参照物
    shelf = Image.new("RGBA", (520, 460), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shelf, "RGBA")
    sd.rectangle((10, 300, 510, 316), fill=(96, 72, 52, 255))
    for i, (bw, bh, c) in enumerate(((34, 118, (150, 112, 84)), (26, 96, (108, 92, 110)),
                                     (40, 132, (96, 112, 108)), (24, 88, (158, 132, 96)))):
        bx = 44 + i * 46
        sd.rectangle((bx, 300 - bh, bx + bw, 300), fill=c + (255,))
    sd.rectangle((330, 236, 380, 300), fill=(140, 96, 74, 255))
    for i in range(5):
        sd.line((344, 236, 320 - i * 8, 190 + i * 6), fill=(78, 102, 84, 240), width=7)
    img.alpha_composite(shelf.filter(ImageFilter.GaussianBlur(2.6)), (DW - 540, 336))
    return img


def _draw_light(img, box):
    """从窗口斜射到桌面的光柱 + 窗口暖光晕。"""
    x0, y0, x1, y1 = box
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer, "RGBA")
    d.polygon([(x0, y0), (x1, y0), (x1 + 330, DH), (x0 + 210, DH)], fill=(255, 226, 178, 20))
    d.polygon([(x0 + 120, y0), (x1 - 60, y0), (x1 + 160, DH), (x0 + 300, DH)], fill=(255, 238, 200, 14))
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(46)))
    glow = _soft_dot(760, (255, 219, 168), 74)
    img.alpha_composite(glow, (x0 - 120, y0 - 150))


def _shadow_ellipse(layer, cx, cy, rx, ry, alpha=95, blur=18):
    sh = Image.new("RGBA", (int(rx * 2.4), int(ry * 3.2)), (0, 0, 0, 0))
    ImageDraw.Draw(sh).ellipse((sh.width * .18, sh.height * .30, sh.width * .82, sh.height * .72),
                               fill=(58, 34, 18, alpha))
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    layer.alpha_composite(sh, (int(cx - sh.width / 2), int(cy - sh.height * .5)))


def _draw_bowl(layer, cx, cy, r):
    _shadow_ellipse(layer, cx + 10, cy + int(r * .52), r * 1.02, r * .34, 110, max(10, r * .14))
    d = ImageDraw.Draw(layer, "RGBA")
    d.pieslice((cx - r, cy - int(r * .62), cx + r, cy + int(r * 1.02)), 0, 180,
               fill=(246, 241, 231, 255), outline=(206, 190, 172, 255), width=max(2, int(r * .025)))
    for i in range(9):
        t = i / 9
        d.arc((cx - r + int(r * .12 * t), cy - int(r * .62), cx + r - int(r * .12 * t),
               cy + int(r * 1.02)), 8 + t * 6, 172 - t * 6, fill=(214, 198, 180, 70), width=max(1, int(r * .02)))
    d.ellipse((cx - r, cy - int(r * .74), cx + r, cy + int(r * .18)),
              fill=(250, 246, 238, 255), outline=(212, 196, 176, 255), width=max(2, int(r * .022)))
    d.ellipse((cx - int(r * .82), cy - int(r * .56), cx + int(r * .82), cy + int(r * .04)),
              fill=(253, 251, 245, 255))
    for i in range(26):
        a = i * 2.399
        rr = r * .66 * math.sqrt((i + .5) / 26)
        px, py = cx + math.cos(a) * rr, cy - r * .24 + math.sin(a) * rr * .34
        d.ellipse((px - r * .045, py - r * .022, px + r * .045, py + r * .022), fill=(255, 255, 255, 240))
    d.arc((cx - int(r * .78), cy - int(r * .70), cx + int(r * .20), cy - int(r * .10)),
          180, 300, fill=(255, 255, 255, 210), width=max(2, int(r * .05)))


def _draw_cup(layer, cx, cy, r):
    _shadow_ellipse(layer, cx + 5, cy + int(r * .72), r * 1.1, r * .38, 90, max(8, r * .2))
    d = ImageDraw.Draw(layer, "RGBA")
    d.rounded_rectangle((cx - r * .72, cy - r, cx + r * .72, cy + r * .86), radius=int(r * .22),
                        fill=(238, 230, 216, 250), outline=(206, 190, 172, 255), width=2)
    d.ellipse((cx - r * .72, cy - r * 1.10, cx + r * .72, cy - r * .52), fill=(128, 116, 96, 255))
    d.arc((cx - r * .52, cy - r * 1.02, cx + r * .52, cy - r * .58), 200, 340,
          fill=(255, 244, 222, 190), width=3)


def _draw_chopsticks(layer, cx, cy):
    d = ImageDraw.Draw(layer, "RGBA")
    for off in (0, 16):
        d.line((cx + off, cy + 4, cx + 210 + off, cy - 26), fill=(150, 106, 74, 255), width=8)
        d.line((cx + off, cy + 2, cx + 210 + off, cy - 28), fill=(196, 156, 112, 190), width=3)


def _draw_note(layer, cx, cy):
    d = ImageDraw.Draw(layer, "RGBA")
    pts = [(cx - 118, cy - 34), (cx + 112, cy - 52), (cx + 126, cy + 34), (cx - 104, cy + 52)]
    d.polygon(pts, fill=(250, 246, 232, 255))
    d.line(pts + [pts[0]], fill=(186, 170, 146, 255), width=3)
    for i in range(3):
        d.line((cx - 84, cy - 16 + i * 20, cx + 74, cy - 30 + i * 20), fill=(150, 160, 158, 210), width=3)
    d.rectangle((cx - 34, cy - 58, cx + 30, cy - 40), fill=(226, 178, 112, 235))


def _draw_desk_front(camera, prop):
    """前景层：桌面 + 木纹 + 碗/杯/便签。不透明，会盖住立绘下半身。"""
    layer = Image.new("RGBA", (DW, DH), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer, "RGBA")
    top = DESK_TOP
    for y in range(top, 984):
        d.line([(0, y), (DW, y)], fill=mix(WOOD_HI, WOOD_MID, (y - top) / max(1, 984 - top)) + (255,))
    d.line((0, top, DW, top), fill=(238, 208, 170, 255), width=5)
    # RGBA ImageDraw replaces destination alpha; blend translucent grain separately
    # so the desk still occludes the character and background underneath it.
    grain = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(grain, "RGBA")
    for i in range(9):
        y = top + 14 + i * 7
        gd.line((0, y, DW, y - 2), fill=(150, 105, 68, 26), width=2)
    layer.alpha_composite(grain)
    pool = _soft_dot(980, (255, 226, 176), 120).resize((1180, 300))
    layer.alpha_composite(pool, (60, top - 90))
    for y in range(984, DH):
        d.line([(0, y), (DW, y)], fill=mix(WOOD_MID, WOOD_LO, (y - 984) / max(1, DH - 984)) + (255,))
    d.rectangle((0, 984, DW, 990), fill=(226, 190, 152, 255))
    grain = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(grain, "RGBA")
    for i in range(14):
        x = int(i * DW / 14)
        gd.line((x, 990, x - 26, DH), fill=(90, 60, 38, 30), width=3)
    layer.alpha_composite(grain)
    if camera == "insert":
        _draw_bowl(layer, 720, 940, 250)
        _draw_cup(layer, 1180, 880, 62)
    else:
        _draw_bowl(layer, 1436, 936, 104)
        _draw_cup(layer, 1216, 908, 44)
        if prop == "note":
            _draw_note(layer, 700, 916)
        else:
            _draw_chopsticks(layer, 1580, 930)
    return layer


@lru_cache(maxsize=8)
def _back_plate():
    img = _draw_wall()
    _draw_window(img, WIN_BOX)
    _draw_light(img, WIN_BOX)
    img = img.filter(ImageFilter.GaussianBlur(1.7)).convert("RGB")
    lum = img.convert("L").point(lambda v: 0 if v < 176 else min(255, int((v - 176) * 3.1)))
    bloom = Image.composite(Image.new("RGB", (DW, DH), (255, 236, 206)),
                            Image.new("RGB", (DW, DH), (0, 0, 0)), lum)
    bloom = bloom.filter(ImageFilter.GaussianBlur(30))
    img = ImageChops.screen(img, Image.eval(bloom, lambda v: int(v * .55)))
    dark = Image.new("RGB", (DW, DH), (44, 30, 18))
    img = Image.composite(img, dark, _vignette_mask(DW, DH))
    return img.convert("RGBA")


def _rim(pose):
    """窗光在立绘左缘打出的一圈暖轮廓光 —— 抠图感的最大克星。"""
    a = pose.getchannel("A")
    ring = ImageChops.subtract(a.filter(ImageFilter.MaxFilter(5)), a)
    ring = ImageChops.multiply(ring, _side_mask(*pose.size, power=1.35))
    ring = ring.filter(ImageFilter.GaussianBlur(1.3)).point(lambda v: min(255, int(v * 1.9)))
    warm = Image.new("RGBA", pose.size, WARM + (0,))
    warm.putalpha(ring)
    out = pose.copy()
    out.alpha_composite(warm, (-2, -1))
    ring2 = ImageChops.subtract(a.filter(ImageFilter.MaxFilter(3)), a)
    ring2 = ImageChops.multiply(ring2, _side_mask(*pose.size, power=1.2, flip=True))
    ring2 = ring2.filter(ImageFilter.GaussianBlur(1.0)).point(lambda v: int(v * .55))
    cool = Image.new("RGBA", pose.size, (170, 214, 240, 0))
    cool.putalpha(ring2)
    out.alpha_composite(cool, (2, 0))
    return out


MASTER_HP = 1500   # 轮廓光/锐化的母版高度：这一步最贵，按表情+口型缓存一次，之后只做缩放


def _master_pose(st, level, expression):
    """高分辨率「母版」：锐化 + 羽化 + 轮廓光只在这一步做一次。"""
    key = (level, expression)
    cache = st.setdefault("_master_cache", {})
    hit = cache.get(key)
    if hit is not None:
        return hit
    base = st["dialogue_portrait"].render(level / 4.0, expression)
    w = max(2, int(round(MASTER_HP * POSE_ASPECT)))
    p = base.resize((w, MASTER_HP), Image.Resampling.LANCZOS)
    p = p.filter(ImageFilter.UnsharpMask(radius=1.9, percent=70, threshold=2))
    p.putalpha(p.getchannel("A").filter(ImageFilter.GaussianBlur(.7)))
    out = _rim(p)
    if len(cache) > 7:          # 5 个口型档 + 余量；换表情时整体重算
        cache.clear()
    cache[key] = out
    return out


def _pose_at(st, hp, level, expression):
    """按高度取立绘：母版缩放 + 尺寸量化缓存。

    量化步长取 8px 而不是逐像素：推镜加呼吸每帧都在变高度，逐像素会让每一帧
    都重新做一次 LANCZOS（实测 50ms/次，是整帧最大的开销）。
    """
    hp = max(80, int(round(hp / 8) * 8))
    w = max(2, int(round(hp * POSE_ASPECT)))
    key = (w, hp, level, expression)
    cache = st.setdefault("_pose_cache", {})
    hit = cache.get(key)
    if hit is not None:
        return hit
    if len(cache) > 40:
        cache.clear()
    cache[key] = _master_pose(st, level, expression).resize((w, hp), Image.Resampling.LANCZOS)
    return cache[key]


@lru_cache(maxsize=8)
def _bubble_tile(size, expression):
    """气泡本体：形状固定，只有小鱼的嘴随口型变 —— 除嘴以外全部缓存。"""
    pad = int(size * .34)
    tile_w, tile_h = int(size * 1.30), int(size * 1.16)
    tile = Image.new("RGBA", (tile_w, tile_h), (0, 0, 0, 0))
    sh = Image.new("RGBA", tile.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).ellipse((pad * .70, pad * .86, tile_w - pad * .70, tile_h - pad * .48),
                               fill=(28, 20, 16, 96))
    tile.alpha_composite(sh.filter(ImageFilter.GaussianBlur(size * .085)))
    d = ImageDraw.Draw(tile, "RGBA")
    bx, by, r = tile_w / 2, tile_h / 2, size * .5
    body = (bx - r, by - r * .92, bx + r, by + r * .92)
    d.ellipse(body, fill=(253, 251, 246, 236), outline=(255, 255, 255, 250), width=max(3, int(size * .014)))
    d.arc(body, 196, 344, fill=(176, 206, 226, 200), width=max(2, int(size * .011)))
    d.arc((bx - r * .86, by - r * .84, bx + r * .30, by - r * .10), 182, 306,
          fill=(255, 255, 255, 225), width=max(2, int(size * .020)))
    for ox, oy, rr in ((-r * .92, r * .82, size * .062), (-r * 1.06, r * 1.02, size * .034)):
        d.ellipse((bx + ox - rr, by + oy - rr, bx + ox + rr, by + oy + rr),
                  fill=(253, 251, 246, 224), outline=(255, 255, 255, 240), width=2)

    def box(a, b, c, e):
        return (bx + a * r, by + b * r, bx + c * r, by + e * r)

    d.polygon([(bx - r * .40, by + r * .02), (bx - r * .66, by - r * .26), (bx - r * .66, by + r * .30)],
              fill=(120, 168, 206, 255))
    d.ellipse(box(-.46, -.32, .44, .34), fill=(166, 204, 230, 255),
              outline=(62, 108, 148, 255), width=max(2, int(size * .010)))
    d.arc(box(-.06, -.32, .26, -.02), 196, 344, fill=(40, 76, 114, 255), width=max(2, int(size * .011)))
    if expression == "happy":
        d.arc(box(.14, -.14, .28, .02), 190, 350, fill=(36, 66, 100, 255), width=max(2, int(size * .010)))
    else:
        d.ellipse(box(.17, -.12, .235, -.02), fill=(36, 66, 100, 255))
    if expression == "question":
        d.text((bx + r * .30, by - r * .52), "?", font=F(int(size * .17), True), fill=(70, 122, 164, 235))
    label = "脑内小鱼"
    lf = F(max(17, int(size * .072)), True)
    tw = d.textlength(label, font=lf)
    d.rounded_rectangle((bx - tw / 2 - size * .045, by + r * .64, bx + tw / 2 + size * .045,
                         by + r * .64 + size * .125), radius=int(size * .05), fill=(52, 92, 128, 210))
    d.text((bx - tw / 2, by + r * .665), label, font=lf, fill=(255, 250, 240, 245))
    return tile


def _draw_bubble(img, center, size, mouth, expression, t):
    """「脑内小鱼」：一块真浮在空气里的小气泡，有投影、有呼吸。"""
    cx, cy = center
    cy += math.sin(t * 1.15) * 5.0
    tile = _bubble_tile(int(size), expression).copy()
    bx, by, r = tile.width / 2, tile.height / 2, size * .5
    d = ImageDraw.Draw(tile, "RGBA")
    # 只有嘴跟着音量开合（每帧一个小椭圆，比重新构图便宜得多）
    opening = max(1.0, (2 + mouth * 13) * (size / 220.0))
    d.ellipse((bx + r * .24, by + r * .075 - opening, bx + r * .335, by + r * .085 + opening),
              fill=(96, 58, 84, 255))
    img.paste(tile, (int(cx - tile.width / 2), int(cy - tile.height / 2)), tile)


@lru_cache(maxsize=4)
def _sub_scrim():
    """底部压暗：白字压在任意画面上都能读，又不是一块白板。"""
    h = 360
    img = Image.new("RGBA", (DW, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for y in range(h):
        d.line([(0, y), (DW, y)], fill=(24, 18, 14, int(198 * (y / (h - 1)) ** 1.7)))
    return img


@lru_cache(maxsize=8)
def _dust(size):
    return _soft_dot(size, (255, 236, 205), 210)


@lru_cache(maxsize=64)
def _dust_tint(size, alpha):
    """按 (尺寸, 透明度档) 缓存的浮尘贴图 —— 逐帧只做 paste，不再重算 alpha。"""
    dot = _dust(size).copy()
    dot.putalpha(dot.getchannel("A").point(lambda v: int(v * alpha / 255)))
    return dot


def _draw_dust(img, t, camera):
    """空气里的浮尘：只撒在光柱一侧，慢速上飘、三档大小做视差。"""
    rnd = random.Random({"wide": 3, "medium": 5, "close": 7, "push": 9, "reverse": 11,
                         "close-inner": 13, "insert": 17}.get(camera, 5))
    for _ in range(14):
        bx, by = rnd.uniform(.04, .58) * DW, rnd.uniform(.10, .92) * DH
        sp, ph, s = rnd.uniform(7, 22), rnd.uniform(0, 6.28), rnd.choice((4, 6, 9))
        x = bx + math.sin(t * .5 + ph) * 14
        y = (by - sp * t) % (DH * .96)
        a = int(max(24, min(120, 70 + 60 * math.sin(t * 1.4 + ph))) / 12) * 12
        dot = _dust_tint(s, a)
        img.paste(dot, (int(x), int(y)), dot)


class DialoguePortrait:
    """Quantized portrait rig for the reviewed transparent fish.png asset.

    Mouth anchor belongs to this asset, not arbitrary images. Unknown/custom
    images retain breathing and expression icons without painting on their face.
    """
    def __init__(self):
        self.src = load_avatar("fish.png")
        self.fallback = Fish(590) if self.src is None else None
        self.cache = {}
        self.rigged = bool(self.src is not None and self.src.size == (1037, 1100))

    def render(self, mouth=0.0, expression="neutral", blink=False):
        level = int(clamp(mouth, 0, 1) * 4 + .5)
        key = (level, expression, bool(blink))
        if key in self.cache:
            return self.cache[key]
        if self.src is None:
            result = self.fallback.render(mouth=mouth, blink=float(blink),
                                          blush=.9 if expression == "happy" else .4,
                                          mood=.55 if expression == "worried" else 1)
        else:
            result = self.src.copy()
            d = ImageDraw.Draw(result)
            if self.rigged and level:
                # Cover only the old 18x13 px mouth, then draw a small open vowel.
                skin = result.getpixel((510, 501))[:3]
                d.ellipse((498, 505, 529, 527), fill=skin + (255,))
                w, h = (7 + level * 2, 2 + level * 3)
                d.ellipse((513 - w, 516 - h, 513 + w, 516 + h),
                          fill=(105, 53, 78), outline=(92, 53, 73), width=2)
                if level >= 2:
                    d.ellipse((507, 518, 519, 516 + h - 1), fill=(233, 151, 163))
            # External emotes deliberately avoid repainting the illustration's eyes.
            if expression in ("question", "thinking"):
                d.text((735, 173), "?" if expression == "question" else "…",
                       font=F(115, True), fill=(48, 97, 139), stroke_width=5, stroke_fill="white")
            if expression in ("surprised", "worried"):
                d.ellipse((754, 277, 778, 326), fill=(121, 195, 229), outline="white", width=3)
                d.text((770, 152), "!", font=F(110, True), fill=(235, 143, 81),
                       stroke_width=5, stroke_fill="white")
            if expression == "happy":
                for x, y, r in ((771, 236, 24), (732, 169, 15)):
                    d.polygon([(x, y-r), (x+8, y-7), (x+r, y), (x+8, y+7),
                               (x, y+r), (x-8, y+7), (x-r, y), (x-8, y-7)], fill=(255, 223, 132))
            result.thumbnail((750, 750), Image.Resampling.LANCZOS)
        self.cache[key] = result
        return result


def draw_inner(img, center, size, mouth, expression, t):
    """A visibly imaginary fish in a thought bubble, not a real other person."""
    x, y = center
    d = ImageDraw.Draw(img)
    r = size * .62
    d.ellipse((x-r, y-r*.9, x+r, y+r*.9), fill=(253, 254, 255), outline=(183, 204, 220), width=4)
    for ox, oy, rr in ((-r*.9, r*.76, 15), (-r*1.08, r*.99, 8)):
        d.ellipse((x+ox-rr, y+oy-rr, x+ox+rr, y+oy+rr), fill="white", outline=(183, 204, 220), width=2)
    k = size / 200
    def box(a,b,c,e):
        return (x+a*k,y+b*k,x+c*k,y+e*k)
    d.polygon([(x-62*k,y), (x-112*k,y-42*k), (x-112*k,y+42*k)], fill=(110, 160, 201))
    d.ellipse(box(-83,-55,88,61), fill=(150, 194, 224), outline=(67, 115, 157), width=max(2, int(3*k)))
    d.arc(box(-9,-55,54,-5), 195, 345, fill=(57, 99, 140), width=max(2,int(3*k)))
    if expression == "happy":
        d.arc(box(28,-22,52,0), 190, 350, fill=(35, 64, 99), width=max(2,int(3*k)))
    else:
        d.ellipse(box(35,-17,49,-2), fill=(35, 64, 99))
    opening = 2 + mouth * 14
    d.ellipse(box(52,9-opening/2,66,12+opening), fill=(94, 55, 84))
    if expression == "question":
        d.text((x+size*.12,y-size*.51), "?", font=F(int(size*.23),True), fill=(60,111,150))
    label = "脑内小鱼"
    font = F(max(18,int(size*.1)), True)
    d.text((x-d.textlength(label,font=font)/2, y+size*.36), label, font=font, fill=(72,113,150))


def dialogue_card(shot, t, dur, st):
    camera = shot.get("camera", "medium")
    spec = CAM.get(camera, CAM["medium"])
    inner = shot.get("speaker") == "inner"
    expression = shot.get("expression", "neutral")
    prop = shot.get("prop", "rice") or "rice"

    scenes = st.setdefault("_scenes", {})
    key = (camera, prop)
    if key not in scenes:
        scenes[key] = (_back_plate(), _draw_desk_front(camera, prop))
    back, front = scenes[key]

    img = back.copy()
    # 推镜：围着「眼睛」缩放，脸不漂走
    prog = ease_in_out(clamp(t / max(.1, dur), 0, 1))
    hp = spec["hp"] * (1 + (.030 if camera != "insert" else .016) * prog)
    hp *= 1 + .006 * math.sin(t * 1.55)              # 呼吸
    level = int(clamp(st.get("mouth", 0), 0, 1) * 4 + .5) if not inner else 0
    pose = _pose_at(st, hp, level, expression if not inner else "neutral")
    if spec.get("blur"):
        pose = pose.filter(ImageFilter.GaussianBlur(spec["blur"]))
    px = spec["ex"] + math.sin(t * .43) * 6 - EYE_X * pose.width
    py = spec["ey"] + math.sin(t * 1.55 + 1.1) * 4 - prog * 8 - EYE_Y * pose.height
    img.paste(pose, (int(px), int(py)), pose)

    bubble = spec.get("bubble")
    if bubble:
        _draw_bubble(img, bubble[0], bubble[1], st.get("mouth", 0) if inner else 0,
                     expression if inner else "neutral", t)
    _draw_dust(img, t, camera)
    img.paste(front, (0, 0), front)

    d = ImageDraw.Draw(img, "RGBA")
    d.text((54, 34), "大肥鱼的饭桌", font=NF(26, "Medium"), fill=(255, 246, 232, 190))
    disclosure = st.get("disclosure", "原创对白")
    dfont = NF(23, "Medium")
    d.text((DW - 54 - d.textlength(disclosure, font=dfont), 38), disclosure, font=dfont,
           fill=(255, 244, 228, 150))
    source_ids = shot.get("source_ids", [])
    if source_ids:
        source = st.get("source_map", {}).get(source_ids[0], {})
        d.text((54, 72), f"笔记来源 · {source.get('bvid', '')}", font=NF(22, "Medium"),
               fill=(255, 244, 228, 130))
    return img


def dialogue_subtitle(img, shot, active, local=99.0):
    """字幕：底部压暗 + 白字。只做 180ms 淡入 + 4px 上浮（不做打字机 —— 打字机看不清）。"""
    if not active or not shot.get("text"):
        return img
    fade = clamp(local / .18, 0, 1)
    rise = int((1 - ease_out(fade)) * 5)
    img.alpha_composite(_sub_scrim(), (0, DH - 360))
    d = ImageDraw.Draw(img, "RGBA")
    font = NF(47, "Medium")
    maxw = DW - 260
    lines = draw_text_wrap(d, shot["text"], font, maxw, None)
    while len(lines) > 2 and font.size > 32:
        font = NF(font.size - 2, "Medium")
        lines = draw_text_wrap(d, shot["text"], font, maxw, None)
    lh = int(font.size * 1.40)
    base = DH - 78 - lh * len(lines) + 6 + rise
    name = "脑内小鱼" if shot.get("speaker") == "inner" else "大肥鱼"
    nf = NF(25, "Medium")
    tw = d.textlength(name, font=nf)
    pill_y = base - 54
    a = int(255 * fade)
    d.rounded_rectangle((96, pill_y, 96 + tw + 62, pill_y + 40), radius=20,
                        fill=(22, 18, 14, int(168 * fade)))
    d.ellipse((112, pill_y + 14, 124, pill_y + 26),
              fill=(255, 206, 140, a) if shot.get("speaker") != "inner" else (160, 206, 240, a))
    d.text((134, pill_y + 6), name, font=nf, fill=(255, 248, 236, a))
    for i, line in enumerate(lines):
        y = base + i * lh
        d.text((99, y + 3), line, font=font, fill=(16, 12, 8, int(120 * fade)))
        d.text((97, y + 1), line, font=font, fill=(20, 16, 12, int(150 * fade)))
        d.text((96, y), line, font=font, fill=(255, 250, 242, a))
    return img


CARDS = {
    "dialogue": dialogue_card,
    "title": title_card,
    "stats": stats_card,
    "video": video_card,
    "quote": quote_card,
    "social": social_card,
    "line": line_card,
    "outro": outro_card,
}


# ───────────────────────────── 字幕 ─────────────────────────────

def split_sentences(text, maxlen=18):
    """把一段话切成「一口气能说完」的短句。

    用户说「字幕对不上」⇒ 根因是字幕显示的是摘要、语音念的是全文。
    现在一句话一个镜头、字幕就是这句原话，字幕自然对得上。
    """
    text = str(text or "").strip()
    if not text:
        return []
    # 先按句末标点切
    parts, buf = [], ""
    for ch in text:
        buf += ch
        if ch in "。！？…；!?;":
            parts.append(buf)
            buf = ""
    if buf.strip():
        parts.append(buf)
    out = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        # 太长的再按逗号切，还长就硬切
        while len(p) > maxlen:
            cut = -1
            for i in range(min(len(p), maxlen), 4, -1):
                if p[i - 1] in "，,、：: ":
                    cut = i
                    break
            if cut < 0:
                cut = maxlen
            out.append(p[:cut].strip())
            p = p[cut:].strip()
        if p:
            out.append(p)
    return out


def subtitle(img, text, t, dur, words):
    """底部字幕：只占左栏内容列（SUB_W），永不盖到右侧的角色。

    ⚠️ 「字幕对不上」的根因：以前字幕显示的是整段摘要，语音念的是全文。
    现在按句切分、按字数分配时长，字幕只显示「此刻正在念的那一句」。
    浅色主题 ⇒ 白色圆角条 + 深墨字，念过的字变浅。
    """
    if not text:
        return img
    text = str(text).strip()
    # —— 选出当前这句 ——
    sents = split_sentences(text, maxlen=22) or [text]
    if len(sents) > 1 and dur > 0:
        total_chars = sum(max(1, len(s)) for s in sents)
        acc, cur = 0.0, sents[-1]
        for s in sents:
            span = dur * max(1, len(s)) / total_chars
            if t < acc + span:
                cur = s
                break
            acc += span
    else:
        cur = text
    d = ImageDraw.Draw(img, "RGBA")
    f = F(28)
    lines = draw_text_wrap(d, cur, f, SUB_W - 48, None)[:2]
    lh = 40
    total_h = lh * len(lines)
    bw = SUB_W
    x0 = CONTENT_X - 18
    y0 = H - 42 - total_h
    box = Image.new("RGBA", (bw, total_h + 28), (0, 0, 0, 0))
    db = ImageDraw.Draw(box)
    db.rounded_rectangle([0, 0, bw - 1, total_h + 27], radius=18, fill=(255, 255, 255, 234),
                         outline=(150, 190, 226, 175), width=2)
    paste_rgba(img, box, (x0, y0 - 14))
    done_chars = len(cur)
    if words:
        done_chars = 0
        for wd in words:
            if t * 10_000_000 >= wd["offset"]:
                done_chars = min(len(cur), done_chars + len(wd["text"]))
            else:
                break
    idx = 0
    for i, ln in enumerate(lines):
        yy = y0 + i * lh
        x = x0 + 20
        for ch in ln:
            col = (36, 60, 92, 255) if idx < done_chars else (118, 144, 174, 240)
            d.text((x, yy), ch, font=f, fill=col)
            x += d.textlength(ch, font=f)
            idx += 1
    return img


# ───────────────────────────── 主流程 ─────────────────────────────

def cover_key(shot):
    """video 镜头封面缓存的键与文件名主干。
    ⭐ 2026-10-26：没有 bvid 的镜头以前都落到键 ""、文件 x.jpg —— 后一张封面覆盖前一张。
    现在退回用 cover URL 的哈希，每张封面有自己的坑。"""
    bvid = str(shot.get("bvid") or "").strip()
    if bvid:
        return bvid, bvid
    h = hashlib.md5(str(shot.get("cover") or "").encode("utf-8")).hexdigest()[:12]
    return h, "c" + h


def load_cover(url: str, cache_dir: Path, key: str):
    """下载 B站封面（带 UA），失败返回 None。"""
    if not url:
        return None
    dst = cache_dir / f"{key}.jpg"
    if dst.exists() and dst.stat().st_size > 2000:
        try:
            with Image.open(dst) as im:
                return im.convert("RGB")
        except Exception:
            pass
    try:
        import urllib.request
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Referer": "https://www.bilibili.com/",
        })
        # ⭐ 2026-10-26：urlopen 的 response 用 with 关掉 —— 异常路径以前会漏连接句柄
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read()
        if len(raw) < 1500:
            return None
        dst.write_bytes(raw)
        with Image.open(dst) as im:
            return im.convert("RGB")
    except Exception as e:
        print(f"  ! 封面取不到（{key}: {type(e).__name__}）", flush=True)
        return None


def audio_cache_key(text, voice, engine):
    """A changed utterance/voice/reference must never reuse another take."""
    settings = {key: value for key, value in voice.items()
                if key in ("name", "rate", "pitch", "mode") or key.startswith("gsv")}
    reference = str(voice.get("gsvRef") or "")
    if engine == "gsv" and reference and Path(reference).is_file():
        settings["reference_sha256"] = hashlib.sha256(Path(reference).read_bytes()).hexdigest()
    body = json.dumps({"version": 2, "engine": engine, "text": text, "voice": settings},
                      sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(body).hexdigest()[:24]


def shot_voice(base, shot):
    voice = dict(base)
    voice.update(shot.get("voice") or {})
    if voice.get("mode") == "edge":
        voice = {key: value for key, value in voice.items() if not key.startswith("gsv")}
    return voice


def _synthesize_edge_take(text, voice, work, key):
    """⭐ 2026-10-26：单镜 edge-tts 合成（网络 IO），供线程池并发调用。

    与原串行路径逐字等价：partial → replace(原子落位) → 写 meta。每镜一个
    独立的 content-addressed 文件（key），线程之间零共享写；Windows 上每个
    edge-tts Communicate 各起各的连接（各自 asyncio.run 的事件循环），互不抢。
    """
    source = work / "tts" / f"{key}.mp3"
    partial = source.with_name(source.stem + ".partial.mp3")
    engine = tts(text, partial, voice.get("name", "zh-CN-XiaoyiNeural"),
                 voice.get("rate", "+8%"), voice.get("pitch", "+12Hz"))
    partial.replace(source)
    source.with_suffix(".json").write_text(
        json.dumps({"engine": engine, "text": text, "key": key}, ensure_ascii=False),
        encoding="utf-8")
    return engine


def prepare_audio(shots, base_voice, work, fps):
    effective = [shot_voice(base_voice, shot) for shot in shots]
    groups, gsv_paths = {}, {}
    for index, (shot, voice) in enumerate(zip(shots, effective)):
        text = str(shot.get("text", "")).strip()
        gsv = all(str(voice.get(key) or "").strip() for key in ("gsvRepo", "gsvRef", "gsvPrompt"))
        if text and gsv:
            group = audio_cache_key("", voice, "gsv")
            groups.setdefault(group, []).append((index, text, voice))
    # ⭐ 2026-10-26：GPT-SoVITS **保持串行** —— 本地推理服务的并发行为未知
    #   （显存/锁/batch 内部状态都可能有坑），且 gsv_batch 本来就是「加载一次模型、
    #   整批合成」，批内已无再并行的收益；只有 edge-tts（纯网络 IO）值得并发。
    for group, items in groups.items():
        # The batch hash includes the complete ordered list. Never synthesize a
        # filtered list into numbered destinations belonging to another order.
        batch_key = audio_cache_key(json.dumps([item[1] for item in items],ensure_ascii=False), items[0][2], "gsv")
        directory = work / "gsv" / batch_key
        paths = [directory / f"{local:02d}.wav" for local in range(len(items))]
        if any(not path.exists() or path.stat().st_size < 4000 for path in paths):
            gsv_batch([item[1] for item in items], directory, items[0][2])
        for (index, text, voice), path in zip(items, paths):
            gsv_paths[index] = path

    # ⭐ 2026-10-26：edge-tts 从逐镜串行改并发 —— 一条 10 镜的 plan 串行要
    #   10×RTT（每镜 1~3s 网络），是 prepare_audio 的大头；4 线程并发直砍到 ~1/4。
    #   ① 缓存命中判断在**提交前**做（命中不进池，池里只放真正要联网的）；
    #   ② 各镜写各自的 key.mp3，结果不需要“回填”——下面的串行循环按原顺序
    #      再走一遍缓存命中路径，时间轴语义与串行版完全一致；
    #   ③ 进度打印不逐线程做（避免多线程 print 交错），池子整体完成后由
    #      串行循环按镜序打印；
    #   ④ 失败语义照旧：任一镜合成失败（edge-tts 和 SAPI 兜底都失败）就让整次
    #      渲染失败，按镜序抛**最早**那镜的异常 —— 原串行版就是死在第一句失败上。
    pending = []
    pending_keys = {}
    for index, (shot, voice) in enumerate(zip(shots, effective)):
        if index in gsv_paths:
            continue                       # GSV 镜头走上面的批处理（串行），不进 TTS 池
        text = str(shot.get("text", "")).strip()
        if not text:
            continue
        key = audio_cache_key(text, voice, "edge")
        source = work / "tts" / f"{key}.mp3"
        if source.exists() and source.stat().st_size >= 600:
            continue                       # 缓存命中（判定与下方串行循环逐字一致）
        # Identical lines share one content-addressed file. Submitting both would
        # have two threads writing the same .partial.mp3 and replacing it, which
        # reproducibly raised FileNotFoundError on Windows. Synthesize once per key.
        if key in pending_keys:
            pending_keys[key].append(index)
            continue
        pending_keys[key] = [index]
        pending.append((index, text, voice, key))
    if pending:
        print(f"🎙 edge-tts 并发合成 {len(pending)} 句（{min(4, len(pending))} 线程）…", flush=True)
        failures = {}
        with ThreadPoolExecutor(max_workers=min(4, len(pending))) as pool:
            futures = {key: pool.submit(_synthesize_edge_take, text, voice, work, key)
                       for index, text, voice, key in pending}
            for index, text, voice, key in pending:      # 按提交（镜）序收结果
                try:
                    futures[key].result()
                except Exception as exc:
                    for failed_index in pending_keys[key]:
                        failures[failed_index] = exc
        if failures:
            raise failures[min(failures)]

    result = []
    for index, (shot, voice) in enumerate(zip(shots, effective)):
        text = str(shot.get("text", "")).strip()
        engine, key, dur, env = "none", "", 0.0, []
        wav_path = work / "wav" / f"{index:02d}.wav"
        if text:
            if index in gsv_paths:
                engine = "gsv"
                key = audio_cache_key(text,voice,engine)
                source = gsv_paths[index]
            else:
                key = audio_cache_key(text,voice,"edge")
                source = work / "tts" / f"{key}.mp3"
                meta = source.with_suffix(".json")
                engine = "cached-tts"
                # ⭐ 2026-10-26：新句的合成已挪到上面的并发池；这里到手的要么是
                #   旧缓存、要么是池子刚写好的 key.mp3+meta（engine 从 meta 读出，
                #   和原串行版直接拿 tts() 返回值的记录完全一致）。
                #   下面的 miss 分支留着当串行保底（正常路径走不到）。
                if not source.exists() or source.stat().st_size < 600:
                    partial = source.with_name(source.stem + ".partial.mp3")
                    engine = tts(text,partial,voice.get("name","zh-CN-XiaoyiNeural"),
                                 voice.get("rate","+8%"),voice.get("pitch","+12Hz"))
                    partial.replace(source)
                    meta.write_text(json.dumps({"engine":engine,"text":text,"key":key},ensure_ascii=False),encoding="utf-8")
                elif meta.exists():
                    try:
                        engine = json.loads(meta.read_text(encoding="utf-8")).get("engine",engine)
                    except (ValueError,OSError):
                        pass
            pcm,rate = to_wav(source,wav_path)
            if engine == "gsv":
                # ⭐ 2026-10-26：把 squeeze_silence 真正接上 —— 这个函数当初就是为
                #   「GPT-SoVITS 分句边界偶发几秒死寂」写的，但一直没有任何调用点。
                #   压缩后**写回 wav_path**：timeline 的时长和最终混音（重读 wav/xx.wav）
                #   才会用同一份压过的音频，不会出现"字幕比声音短一截"。
                pcm = squeeze_silence(pcm, rate)
                with wave.open(str(wav_path), "wb") as w:
                    w.setnchannels(1)
                    w.setsampwidth(2)
                    w.setframerate(rate)
                    w.writeframes(pcm.tobytes())
            dur = len(pcm) / rate
            if dur <= .02:
                raise RuntimeError(f"第 {index+1} 句音频为空")
            env = envelope(pcm,rate,fps)
        result.append({"env":env,"dur":dur,"engine":engine,"cache_key":key})
        print(f"   {index+1:02d}/{len(shots)} {dur:5.2f}s [{engine}] {text[:32]}",flush=True)
    return result


def make_timeline(shots, audios, lead, gap, tail, fps):
    starts, cursor, cues = [], lead, []
    for index,(shot,audio) in enumerate(zip(shots,audios)):
        starts.append(cursor)
        end = cursor + audio["dur"]
        cues.append({"shot":index,"speaker":shot.get("speaker","fish"),
                     "text":str(shot.get("text", "")),"start":round(cursor,6),"end":round(end,6),
                     "audio_duration":audio["dur"],"engine":audio.get("engine","unknown"),
                     "cache_key":audio.get("cache_key",""),"camera":shot.get("camera","legacy"),
                     "expression":shot.get("expression","neutral"),
                     "scene":shot.get("scene",""),"headline":shot.get("headline",""),
                     "provenance":shot.get("provenance","user-plan"),"source_ids":shot.get("source_ids",[]),
                     "mouth_frames":sum(value > .05 for value in audio["env"])})
        cursor = end + max(0, float(shot.get("pause_after",gap)))
    last_pause = max(0,float(shots[-1].get("pause_after",gap)))
    total = max(1/fps, cursor-last_pause+tail)
    # Round up, never truncate the final utterance to a frame boundary.
    total = math.ceil(total*fps)/fps
    return starts,total,cues


def write_captions(cues,path):
    def stamp(seconds):
        value = int(round(seconds*1000))
        return f"{value//3600000:02d}:{value//60000%60:02d}:{value//1000%60:02d},{value%1000:03d}"
    lines=[]
    for cue in cues:
        if not cue["text"] or cue["end"] <= cue["start"]:
            continue
        # ⭐ 2026-10-26：SRT 规范是块之间一个**空行** —— 以前 join("\n") 只有一个换行，
        #   多数播放器容忍，但严格解析器会把相邻 cue 串在一起。
        lines.append(f"{len(lines)+1}\n{stamp(cue['start'])} --> {stamp(cue['end'])}\n{cue['text']}")
    path.write_text("\n\n".join(lines) + "\n",encoding="utf-8")


def build(plan: dict, out_path: Path, work: Path, fps=FPS, scale=1.0, still=None):
    if not isinstance(plan.get("shots"),list) or not plan["shots"]:
        raise ValueError("plan.shots must be a nonempty array")
    if not 1 <= fps <= 60 or not .1 <= scale <= 2:
        raise ValueError("fps must be 1..60; scale must be 0.1..2")
    t_start = time.time()
    shots = plan["shots"]
    # Editorial v2 and dialogue plans use the 1080p stage. Legacy cards remain 720p.
    editorial_plan = plan.get("schema") == "deepmoyu-editorial-v2"
    editorial_renderer = None
    if editorial_plan:
        import pv_editorial as editorial_renderer
    NAT_W, NAT_H = (DW, DH) if editorial_plan or plan.get("schema") == "dafeiyu-dialogue-v1" else (W, H)
    if (int(plan.get("width", NAT_W)),int(plan.get("height", NAT_H))) != (NAT_W, NAT_H):
        raise ValueError(f"the current stage supports {NAT_W}x{NAT_H}; resize with --scale")
    W2,H2 = max(2,round(NAT_W*scale/2)*2),max(2,round(NAT_H*scale/2)*2)
    voice = (plan.get("voice") or {})

    work.mkdir(parents=True, exist_ok=True)
    (work / "tts").mkdir(exist_ok=True)
    (work / "wav").mkdir(exist_ok=True)
    covers = work / "covers"
    covers.mkdir(exist_ok=True)

    ff = ffmpeg_exe()
    # 有真立绘就用真立绘，没有才退回程序化角色
    portrait = None if editorial_plan else Portrait(AV_SIZE)
    fish = None if editorial_plan else (portrait if portrait.ok else Fish(AV_SIZE))
    if editorial_plan:
        print(f"🎨 动态短片 · {plan.get('theme', 'paper')} · {len(shots)} 镜", flush=True)
    elif portrait.ok:
        print(f"🐟 形象：真·大肥鱼立绘 {portrait.name}（{portrait.size}px）", flush=True)
    else:
        print("🐟 形象：没找到立绘素材，退回程序化角色", flush=True)

    # Each utterance owns a content-addressed take; captions use its measured PCM length.
    audios = prepare_audio(shots,voice,work,fps)
    gap = max(0.0,float(plan.get("gap",.18)))
    lead = max(0.0,float(plan.get("lead",.18)))
    tail = max(0.0,float(plan.get("tail",.5)))
    starts,total,cues = make_timeline(shots,audios,lead,gap,tail,fps)
    timeline = {"schema":"dafeiyu-timeline-v1","duration":total,"fps":fps,
                "disclosure":plan.get("disclosure",""),"sources":plan.get("sources",[]),
                "visual_schema":plan.get("schema", "legacy"), "theme":plan.get("theme", ""),
                "cues":cues,"timing":"measured PCM utterances; editorial phrase positions proportional within each utterance; RMS mouth animation, not phoneme alignment"}
    (work / "timeline.json").write_text(json.dumps(timeline,ensure_ascii=False,indent=2),encoding="utf-8")
    write_captions(cues,work/"captions.srt")

    # —— 2. 背景（每类一次；淡色海底，不同镜头水色略不同） ——
    st = {
        "fish": fish,
        "dialogue_portrait": DialoguePortrait(),
        "theme": plan.get("theme", "paper"), "mode": plan.get("mode", "custom"), "shot_count": len(shots),
        "disclosure":plan.get("disclosure","原创对白"),
        "source_map":{source["id"]:source for source in plan.get("sources",[]) if "id" in source},
        "bg_title": None if editorial_plan else bg_ocean(7, "#eaf6ff", "#d2eafb", "#b6dcf2", rice=True),
        "bg_stats": None if editorial_plan else bg_ocean(11, "#e6f3fd", "#cfe6f8", "#b2d5ee"),
        "bg_video": None if editorial_plan else bg_ocean(13, "#e8f4fe", "#cde5f7", "#aed2ec"),
        "bg_quote": None if editorial_plan else bg_ocean(17, "#f0f8ff", "#d8ecfa", "#bcdcef", rice=True),
        "bg_social": None if editorial_plan else bg_ocean(19, "#ecf7fd", "#d4ebf9", "#b8d9ee"),
        "_cover_cache": {},
    }
    dialogue_plan = plan.get("schema") == "dafeiyu-dialogue-v1"
    # ⭐ 2026-10-26：封面从串行改 4 线程并发下载 —— 每张封面是独立的 B 站 CDN
    #   请求，串行时 N 张 = N×RTT 干等。load_cover 自带磁盘缓存 + 15s 超时 +
    #   「异常吞掉返回 None」的语义，这里只改调度、不改下载本身；结果仍按
    #   cover_key（bvid/URL 哈希）收进 _cover_cache，渲染侧取图逻辑零变化。
    #   同 key 先去重再提交：两个线程同时写同一个 x.jpg 会互相踩（旧串行版
    #   语义是“后面的覆盖前面的”，去重保第一个即等价）。
    cover_jobs = {}
    for sh in shots:
        if sh.get("kind") == "video" and sh.get("cover"):
            ck, stem = cover_key(sh)
            cover_jobs.setdefault(ck, (sh["cover"], stem))
    if cover_jobs:
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {ck: pool.submit(load_cover, url, covers, stem)
                       for ck, (url, stem) in cover_jobs.items()}
            for ck, future in futures.items():
                st["_cover_cache"][ck] = future.result()

    def shot_frame(index,local):
        shot = shots[index]
        duration = audios[index]["dur"]
        env = audios[index]["env"]
        active = 0 <= local < duration
        st["mouth"] = env[min(len(env)-1,int(local*fps))] if active and env else 0.0
        st["shot_index"] = index
        fn = editorial_renderer.render if editorial_plan else CARDS.get(shot.get("kind","title"),title_card)
        frame = fn(shot,local if editorial_plan else max(0,local),duration,st)
        if editorial_plan:
            pass
        elif shot.get("kind") == "dialogue":
            frame = dialogue_subtitle(frame,shot,active,max(0,local))
        else:
            frame = subtitle(frame,str(shot.get("text","")),max(0,local),duration,shot.get("words"))
            if frame.size != (NAT_W,NAT_H):
                frame = frame.resize((NAT_W,NAT_H),Image.Resampling.LANCZOS)
        if (W2,H2) != (NAT_W,NAT_H):
            frame = frame.resize((W2,H2),Image.Resampling.LANCZOS)
        return frame.convert("RGB")

    if still:
        idxs = range(len(shots)) if still is True else still
        for idx in idxs:
            frame = shot_frame(idx,audios[idx]["dur"]*.5)
            path = work / f"still_{idx:02d}.png"
            frame.save(path)
            print("静帧 →",path,flush=True)
        return None

    # —— 3. 音频：旁白 + BGM ——
    rate = 24000
    total_n = math.ceil(total * rate)
    narr = array.array("h", [0]) * total_n
    for i, a in enumerate(audios):
        if a["dur"] <= 0:
            continue
        _src = work / "wav" / f"{i:02d}.wav"
        _mix = work / "wav" / f"{i:02d}.24k.wav"
        pcm, _ = to_wav(_src, _mix, rate)
        i0 = int(starts[i] * rate)
        for j, v in enumerate(pcm):
            k = i0 + j
            if 0 <= k < total_n:
                narr[k] = v
    with wave.open(str(work / "narr.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(narr.tobytes())

    bgm(work) if False else None
    bg = bgm(total, rate, work / "bgm.wav")

    # —— 4. 逐帧渲染 ——
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_mp4 = work / "video_noaudio.mp4"
    # 调色的一半在构图里（暖高光/冷阴影），这里只做很轻的统一 + 时变颗粒。
    # 颗粒必须 allf=t+u（时变+均匀）：静态噪声会变成脏点。
    vf = "null" if editorial_plan else ("eq=contrast=1.045:saturation=1.05:brightness=-0.004,"
          "curves=master='0/0.012 0.25/0.242 0.75/0.772 1/0.99',"
          "unsharp=5:5:0.35:5:5:0,"
          "noise=alls=4:allf=t+u")
    cmd = [ff, "-y", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W2}x{H2}", "-r", str(fps), "-i", "-",
           "-vf", vf,
           "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
           "-profile:v", "high", "-tune", "film", str(tmp_mp4)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    # ⭐ 2026-10-26：整个渲染循环包进 try/except —— 循环里任何异常（PIL 画错、内存不足、
    #   以及 ffmpeg 提前退出后 stdin.write 抛的 BrokenPipeError）以前会让 ffmpeg
    #   既不被 kill 也不关管道，挂在那儿成为孤儿进程继续吃 CPU。
    try:
        n_frames = int(total * fps)
        print(f"🎬 渲染 {n_frames} 帧（{total:.1f}s @ {fps}fps, {W2}x{H2}）", flush=True)
        t0 = time.time()
        # 镜头之间做 300ms 叠变：不是炫技，是让「同一张桌子上换机位」不跳。
        # 硬切留着给「时间/空间跳跃」（首镜与同机位连续镜不叠）。
        XFADE = .30
        for fi in range(n_frames):
            tnow = fi / fps
            # Use actual next-take boundaries, including per-shot reaction pauses.
            si = next((i for i in range(len(shots)-1) if tnow < starts[i+1]),len(shots)-1)
            local = tnow-starts[si]
            frame = shot_frame(si,local)
            if dialogue_plan and si > 0 and local < XFADE:
                prev_cam = shots[si-1].get("camera", "medium")
                if prev_cam != shots[si].get("camera", "medium"):
                    # 上一镜停在它自己的最后一帧上（只算一次，叠化期间重复用）
                    tails = st.setdefault("_tail", {})
                    if si - 1 not in tails:
                        tails[si-1] = shot_frame(si-1, max(0.0, audios[si-1]["dur"] - .02))
                    prev = tails[si-1]
                    frame = Image.blend(prev, frame, ease_out(clamp(local / XFADE, 0, 1)))
            # Editorial plans author their own transition intent. A short
            # overlap gives the viewer a visual breath between beats while the
            # default cut keeps punchy hooks crisp.
            if editorial_plan and si > 0:
                transition = shots[si].get("transition", "cut")
                blend_window = .24 if transition in {"slide", "match"} else 0.0
                if blend_window and local < blend_window:
                    tails = st.setdefault("_tail", {})
                    if si - 1 not in tails:
                        tails[si-1] = shot_frame(si-1, max(0.0, audios[si-1]["dur"] - .02))
                    prev = tails[si-1]
                    amount = ease_out(clamp(local / blend_window, 0, 1))
                    if transition == "slide":
                        shifted = prev.copy()
                        shifted.paste(frame, (int(frame.width * (1 - amount)), 0))
                        frame = Image.blend(prev, shifted, amount)
                    else:
                        frame = Image.blend(prev, frame, amount)
            # 片头片尾各 600ms 淡入淡出（像一段真正剪过的短片，而不是突然开始）
            if dialogue_plan:
                head = clamp(tnow / .60, 0, 1)
                tailf = clamp((total - tnow) / .60, 0, 1)
                alpha = min(head, tailf)
                if alpha < 1:
                    frame = Image.blend(Image.new("RGB", frame.size, (12, 9, 7)), frame, ease_out(alpha))
            # Skits cut cleanly; legacy report plans retain a short global fade.
            if not editorial_plan and plan.get("schema") != "dafeiyu-dialogue-v1":
                alpha = clamp(min(tnow,total-tnow)/.15,0,1)
                frame = Image.blend(Image.new("RGB",frame.size),frame,alpha)
            if fi in {max(1,int(lead*fps)+1),n_frames//2,max(0,n_frames-2)}:
                label = "first" if fi < n_frames//2 else ("middle" if fi == n_frames//2 else "last")
                frame.save(work / f"verify_{label}.png")
            proc.stdin.write(frame.tobytes())
            if fi % max(1, fps * 5) == 0:
                el = time.time() - t0
                eta = el / max(1, fi + 1) * (n_frames - fi - 1)
                print(f"   {fi}/{n_frames}  {el:.0f}s  ETA {eta:.0f}s", flush=True)
        proc.stdin.close()
        err = proc.stderr.read().decode("utf-8", "ignore")
        proc.stderr.close()
        if proc.wait() != 0:
            raise RuntimeError("ffmpeg 视频编码失败：" + err[:600])
    except BaseException:
        try:
            if proc.stdin and not proc.stdin.closed:
                proc.stdin.close()
        except Exception:
            pass
        try:
            proc.kill()
        except Exception:
            pass
        try:
            proc.wait(timeout=5)
        except Exception:
            pass
        try:
            if proc.stderr and not proc.stderr.closed:
                proc.stderr.close()
        except Exception:
            pass
        raise

    # —— 5. 合音轨 + BGM ——
    print("🔊 混音…", flush=True)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([ff, "-y", "-loglevel", "error",
                    "-i", str(tmp_mp4), "-i", str(work / "narr.wav"), "-i", str(bg),
                    "-filter_complex",
                    # normalize=0 很关键：amix 默认会把两路各压 6dB，旁白会平白小一半。
                    # loudnorm 把整体响度拉到 -16 LUFS（手机/笔记本外放的常见目标），
                    # TP=-1.5 留真峰值余量，最后 resample 回 24k（loudnorm 内部会升到 192k）。
                    "[1:a]aformat=sample_fmts=fltp:channel_layouts=stereo,volume=1.0[n];"
                    "[2:a]aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.16[b];"
                    "[n][b]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,"
                    "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=24000,alimiter=limit=0.97[a]",
                    "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
                    "-shortest", str(out_path)], check=True, timeout=900)
    print(f"✅ {out_path}  ({(time.time()-t_start)/60:.1f} 分钟, {out_path.stat().st_size/1e6:.1f} MB)", flush=True)
    return out_path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", required=True)
    ap.add_argument("--out", default="")
    ap.add_argument("--work", default="")
    ap.add_argument("--fps", type=int, default=FPS)
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--still", default="")
    a = ap.parse_args()
    # ⭐ 2026-10-26：utf-8-sig —— plan 常被人手编辑/另存，带 BOM 时 utf-8 会在第一个字符上炸
    #   （同项目的 pv_cover.py 一直就是这么读的，两边拉齐）。
    plan = json.loads(Path(a.plan).read_text(encoding="utf-8-sig"))
    out = Path(a.out or plan.get("out") or "pv.mp4")
    work = Path(a.work or (out.parent / "_work"))
    still = [int(x) for x in a.still.split(",")] if a.still else None
    if still is not None:
        # ⭐ 2026-10-26：--still 的索引先校验 —— 以前手滑写越界值直接 IndexError 裸崩。
        n = len(plan.get("shots") or [])
        still = [i for i in still if 0 <= i < n]
        if not still:
            raise SystemExit(f"--still 的索引都越界了（这个 plan 一共 {n} 个镜头）")
    build(plan, out, work, a.fps, a.scale, still)


if __name__ == "__main__":
    main()
