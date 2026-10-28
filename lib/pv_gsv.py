#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🐟 大肥鱼 · GPT-SoVITS 配音批处理器（可选，装不上就退回 edge-tts）
================================================================================
它做什么：
  吃一份「句子清单」，用 GPT-SoVITS 的 zero-shot 克隆，把每一句合成成 wav。
  **一次加载模型、循环合成** —— 模型加载要十几秒，逐句起进程太浪费。

为什么要单独一个文件：
  GPT-SoVITS 依赖很重（torch + transformers + G2PW），和插件的 .venv 不是一套环境。
  所以 pv.py 用 subprocess 调**另一个 python**（装了 GPT-SoVITS 的那个）来跑这个脚本，
  插件本身不背这个包袱；没装也不影响出片（pv.py 会自动退回 edge-tts）。

用法：
  python pv_gsv.py --repo <GPT-SoVITS 目录> --ref <参考音频> --prompt "<参考音频里说的话>" \
                   --batch <清单.json> [--speed 1.06] [--seed 20261020]

  清单.json 形如：
      [{"text": "今天本鱼...", "out": "D:/.../00.wav"}, ...]

依赖（都装在跑这个脚本的那个 python 里）：
  torch / torchaudio(cpu) / transformers / pyopenjtalk-prebuilt / numpy<2 / librosa /
  x-transformers / peft / fast-langdetect / split-lang / pytorch-lightning / soundfile
================================================================================
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
import wave
from pathlib import Path


def _setup(repo: Path):
    """把 GPT-SoVITS 的 import 路径和 CWD 摆好（它内部大量相对路径）。"""
    repo = repo.resolve()
    gsv = repo / "GPT_SoVITS"
    if not (gsv / "TTS_infer_pack" / "TTS.py").exists():
        raise SystemExit(f"❌ 不是 GPT-SoVITS 目录：{repo}")
    os.chdir(repo)                       # 权重/G2PW 路径都相对 repo 根
    sys.path.insert(0, str(gsv))
    sys.path.insert(1, str(repo))
    return repo, gsv


def _env_guard():
    """两个环境坑，必须在 import 任何东西之前设好：

    ① `NLTK_ALLOW_PROXIED_URLOPEN=1` —— nltk 3.10 默认拒绝走代理拉语料；
    ② `NLTK_DATA` —— g2p_en 要用 cmudict（英文 G2P），找不到就 LookupError 炸在半路。
       默认指向「脚本旁边的 nltk_data」（装机时用 setup_pv_voice.py 下好）。
    """
    os.environ.setdefault("NLTK_ALLOW_PROXIED_URLOPEN", "1")
    if not os.environ.get("NLTK_DATA"):
        here = Path(__file__).resolve().parent
        for cand in (here / "nltk_data", here.parent / "nltk_data", Path.home() / "nltk_data"):
            if (cand / "corpora" / "cmudict").exists() or (cand / "corpora" / "cmudict.zip").exists():
                os.environ["NLTK_DATA"] = str(cand)
                break


def _patch_torchaudio():
    """torchaudio 2.x 的 load() 只走 torchcodec，而 torchcodec 要 ffmpeg 共享库 ——
    本机只有静态 ffmpeg.exe，所以直接用 soundfile 顶上，等价且更快。"""
    import soundfile as sf
    import torch
    import torchaudio

    def _load(path, **kw):
        data, sr = sf.read(str(path), dtype="float32", always_2d=True)
        return torch.from_numpy(data.T.copy()), sr

    torchaudio.load = _load


def _save_wav(path: Path, sr: int, data) -> None:
    """把 numpy float/int 波形写成 16bit PCM wav（不依赖 torchaudio.save）。"""
    import numpy as np

    path.parent.mkdir(parents=True, exist_ok=True)
    a = np.asarray(data)
    if not a.size or not np.isfinite(a).all():
        raise ValueError("invalid or empty synthesized waveform")
    if a.dtype != np.int16:
        a = np.clip(a, -1.0, 1.0)
        a = (a * 32767.0).astype(np.int16)
    if not a.size or not np.isfinite(a).all() or not 0 < int(sr) <= 192000:
        raise ValueError("invalid or empty synthesized waveform")
    if a.ndim > 1:
        a = a.reshape(-1)
    temporary = path.with_name(path.name + ".partial.wav")
    with wave.open(str(temporary), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(a.tobytes())
    temporary.replace(path)


def resolve_items(items, batch: Path, outdir: str = ""):
    if not isinstance(items, list):
        raise ValueError("batch must be an array")
    base = Path(outdir).resolve() if outdir else batch.resolve().parent
    resolved = []
    for item in items:
        if not isinstance(item, dict) or not item.get("out"):
            raise ValueError("each batch item must contain out")
        destination = Path(item["out"])
        if not destination.is_absolute():
            destination = base / destination.name
        resolved.append(dict(item, out=str(destination.resolve())))
    return resolved


def take_key(text, settings):
    raw = json.dumps({"version": 1, "text": text, "settings": settings},
                     ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def cached_take(path: Path, key: str):
    try:
        meta = json.loads(path.with_suffix(".json").read_text(encoding="utf-8"))
        with wave.open(str(path), "rb") as audio:
            return meta.get("key") == key and audio.getnframes() > 0 and audio.getsampwidth() == 2
    except (OSError, ValueError, EOFError, wave.Error):
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="GPT-SoVITS 仓库根目录")
    ap.add_argument("--ref", required=True, help="参考音频（3~10 秒）")
    ap.add_argument("--prompt", default="", help="参考音频里说的那句话（原文）")
    ap.add_argument("--batch", required=True, help="句子清单 json")
    ap.add_argument("--outdir", default="", help="（可选）所有输出都塞进这个目录，清单里只写文件名")
    ap.add_argument("--speed", type=float, default=1.06)
    ap.add_argument("--seed", type=int, default=20261020)
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--top-k", type=int, default=15)
    ap.add_argument("--top-p", type=float, default=0.9)
    ap.add_argument("--temp", type=float, default=0.75)
    ap.add_argument("--repetition-penalty", type=float, default=1.3)
    a = ap.parse_args()

    # ⚠️ 必须**先**把路径全部绝对化：下面 _setup() 会 os.chdir(repo)，
    #    之后任何相对路径都会变成「相对 GPT-SoVITS 目录」—— 实测就栽在这里
    #    （FileNotFoundError: bili-work\pv\_gtest\batch.json）。
    a.batch = str(Path(a.batch).resolve())
    a.ref = str(Path(a.ref).resolve())
    a.outdir = str(Path(a.outdir).resolve()) if a.outdir else ""
    if not math.isfinite(a.speed) or a.speed <= 0:
        ap.error("speed must be positive and finite")
    items = resolve_items(json.loads(Path(a.batch).read_text(encoding="utf-8")),Path(a.batch),a.outdir)
    settings = {key: getattr(a,key) for key in ("prompt","speed","seed","top_k","top_p","temp","repetition_penalty")}
    settings["reference_sha256"] = hashlib.sha256(Path(a.ref).read_bytes()).hexdigest()
    settings["repo"] = str(Path(a.repo).resolve())

    repo, _ = _setup(Path(a.repo))
    _env_guard()
    _patch_torchaudio()

    import numpy as np
    import torch

    n = a.threads or max(2, (os.cpu_count() or 4) - 2)
    torch.set_num_threads(n)

    t0 = time.time()
    from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

    cfg = TTS_Config("v2")
    cfg.device = "cpu"
    cfg.is_half = False
    pipe = TTS(cfg)
    print(f"[load] {time.time() - t0:.1f}s  threads={n}", flush=True)

    ref = a.ref
    print(f"[ref] {ref}  prompt={a.prompt[:30]}…  {len(items)} 句", flush=True)

    for i, it in enumerate(items):
        text = str(it.get("text", "")).strip()
        out = Path(it["out"])
        if not text:
            continue
        key = take_key(text,settings)
        if not it.get("force") and cached_take(out,key):
            print(f"[{i:02d}] skip（内容指纹相同）{out.name}", flush=True)
            continue
        t1 = time.time()
        gen = pipe.run({
            "text": text,
            "text_lang": "zh",
            "ref_audio_path": ref,
            "prompt_text": a.prompt,
            "prompt_lang": "zh",
            "top_k": a.top_k,
            "top_p": a.top_p,
            "temperature": a.temp,
            "text_split_method": "cut5",
            "batch_size": 1,
            "speed_factor": a.speed,
            "fragment_interval": 0.22,
            "seed": a.seed,
            "parallel_infer": True,
            "repetition_penalty": a.repetition_penalty,
        })
        chunks = []
        sr = 32000
        for part in gen:
            sr2, d = part
            sr = sr2
            chunks.append(np.asarray(d).reshape(-1))
        if not chunks:
            raise RuntimeError(f"[{i:02d}] 没有音频输出")
        audio = np.concatenate(chunks)
        _save_wav(out, sr, audio)
        metadata = out.with_suffix(".json")
        pending = metadata.with_suffix(".partial.json")
        pending.write_text(json.dumps({"key":key,"text":text,"sample_rate":int(sr)},ensure_ascii=False),encoding="utf-8")
        pending.replace(metadata)
        dur = len(audio) / float(sr)
        print(f"[{i:02d}] {dur:5.2f}s  {time.time() - t1:5.1f}s  {out.name}  {text[:26]}", flush=True)

    print(f"[done] 共 {len(items)} 句，总耗时 {(time.time() - t0) / 60:.1f} 分钟", flush=True)


if __name__ == "__main__":
    main()
