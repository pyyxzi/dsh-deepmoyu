"""Validate a locally rendered PV package without ASR or human-listening claims.

Usage: python pv_verify.py --video movie.mp4 --timeline timeline.json --outdir package [--max-duration 300] [--target-duration 90]
Writes outdir/verification.json and exits nonzero for a failed check.
"""
from __future__ import annotations

import argparse
import array
import json
import math
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg
from PIL import Image


def _probe(video: Path) -> tuple[dict, int]:
    # imageio-ffmpeg bundles ffmpeg, not ffprobe. Decode without frame duplication
    # so nb_frames is an observed count rather than fps * container duration.
    frame_count = 0
    reader = imageio_ffmpeg.read_frames(
        str(video), pix_fmt="rgb24", input_params=["-xerror"], output_params=["-vsync", "0"]
    )
    try:
        metadata = next(reader)
        for _ in reader:
            frame_count += 1
    except Exception as exc:
        raise ValueError(f"视频无法完整解码：{str(exc)[-300:]}") from exc
    finally:
        reader.close()
    if not metadata or frame_count <= 0:
        raise ValueError("视频没有可解码画面")
    fps = _duration(metadata.get("fps"))
    width, height = metadata.get("size", (0, 0))
    duration = _duration(metadata.get("duration"))
    audio_codec = str(metadata.get("audio_codec") or "")
    streams = [{"codec_type": "video", "width": int(width), "height": int(height),
                "r_frame_rate": str(fps), "nb_frames": str(frame_count)}]
    if audio_codec:
        streams.append({"codec_type": "audio", "codec_name": audio_codec})
    return {"streams": streams, "format": {"duration": str(duration)}}, frame_count


def _stream(streams: list[dict], kind: str) -> dict | None:
    return next((row for row in streams if row.get("codec_type") == kind), None)


def _duration(value: object) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return 0.0
    return number if math.isfinite(number) and number >= 0 else 0.0


def _number(value: object, field: str) -> float:
    # Do not silently turn negative/NaN/missing cue times into zero, or accept
    # JSON booleans and numeric strings as measured timeline values.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} 必须是有限数值")
    try:
        number = float(value)
    except OverflowError as exc:
        raise ValueError(f"{field} 必须是有限数值") from exc
    if not math.isfinite(number):
        raise ValueError(f"{field} 必须是有限数值")
    return number


def _decode_frames(video: Path, outdir: Path, width: int, height: int, frame_count: int) -> dict:
    # Select by actual decoded indices, including the final frame at low fps.
    # Raw RGB bytes never pass through text-mode subprocess capture.
    indices = {"first": 0, "middle": frame_count // 2, "last": frame_count - 1}
    selected = sorted(set(indices.values()))
    expression = "+".join(f"eq(n\\,{index})" for index in selected)
    try:
        result = subprocess.run(
            [imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-v", "error", "-xerror",
             "-i", str(video), "-map", "0:v:0", "-vf", f"select={expression}",
             "-vsync", "0", "-pix_fmt", "rgb24", "-vcodec", "rawvideo", "-f", "rawvideo", "pipe:1"],
            capture_output=True, check=False, timeout=120,
        )
    except subprocess.TimeoutExpired as exc:
        raise ValueError("视频抽帧超时") from exc
    if result.returncode != 0:
        error = result.stderr.decode("utf-8", errors="replace").strip()[-300:]
        raise ValueError("视频抽帧失败：" + (error or f"exit {result.returncode}"))
    frame_bytes = width * height * 3
    if len(result.stdout) != frame_bytes * len(selected):
        raise ValueError("视频缺少可解码的首帧、中帧或末帧")
    for offset, source_index in enumerate(selected):
        pixels = result.stdout[offset * frame_bytes:(offset + 1) * frame_bytes]
        image = Image.frombytes("RGB", (width, height), pixels)
        for label, index in indices.items():
            if index == source_index:
                image.save(outdir / f"verify_{label}.png")
    return indices


def _timeline_check(timeline: dict, duration: float) -> dict:
    if not isinstance(timeline, dict) or timeline.get("schema") != "dafeiyu-timeline-v1":
        raise ValueError("timeline schema 不匹配")
    fps = _number(timeline.get("fps"), "timeline.fps")
    planned = _number(timeline.get("duration"), "timeline.duration")
    if not 1 <= fps <= 60 or planned <= 0:
        raise ValueError("timeline 的 fps 或 duration 无效")
    cues = timeline.get("cues")
    if not isinstance(cues, list) or not cues:
        raise ValueError("timeline 缺少有效 cues")
    previous = 0.0
    for index, cue in enumerate(cues):
        field = f"timeline.cues[{index}]"
        if not isinstance(cue, dict):
            raise ValueError(f"{field} 无效")
        for key in ("shot", "speaker", "text", "start", "end", "audio_duration", "engine", "mouth_frames"):
            if key not in cue:
                raise ValueError(f"{field} 缺少 {key}")
        start = _number(cue["start"], f"{field}.start")
        end = _number(cue["end"], f"{field}.end")
        audio = _number(cue["audio_duration"], f"{field}.audio_duration")
        if start < 0 or end > planned + 1e-6 or end <= start or audio <= 0:
            raise ValueError(f"{field} 时间超出 timeline 范围或为空")
        if abs((end - start) - audio) > 0.15 or start + 1e-6 < previous:
            raise ValueError(f"{field} 时间重叠或与音频时长不一致")
        mouth = cue["mouth_frames"]
        if (not isinstance(cue["text"], str) or not cue["text"].strip()
                or isinstance(mouth, bool) or not isinstance(mouth, int) or mouth <= 0):
            raise ValueError(f"{field} 缺少有效对白或口型帧")
        previous = end
    if abs(planned - duration) > max(0.35, 2 / fps):
        raise ValueError(f"视频时长 {duration:.3f}s 与 timeline {planned:.3f}s 不一致")
    return {"timeline_fps": fps, "timeline_duration": planned,
            "cue_count": len(cues), "last_cue_end": previous}


def _decode_audio(video: Path, duration: float) -> dict:
    # Decode to mono signed 16-bit PCM. Capture bytes, not locale-decoded text;
    # this is an acoustic sanity check, not speech recognition or a listening test.
    rate = 16000
    try:
        result = subprocess.run(
            [imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-v", "error", "-xerror",
             "-i", str(video), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(rate),
             "-acodec", "pcm_s16le", "-f", "s16le", "pipe:1"],
            capture_output=True, check=False, timeout=60,
        )
    except subprocess.TimeoutExpired as exc:
        raise ValueError("音轨解码超时") from exc
    if result.returncode != 0:
        error = result.stderr.decode("utf-8", errors="replace").strip()[-300:]
        raise ValueError("音轨解码失败：" + (error or f"exit {result.returncode}"))
    if not result.stdout or len(result.stdout) % 2:
        raise ValueError("音轨没有可解码的 PCM 样本")
    samples = array.array("h")
    samples.frombytes(result.stdout)
    if sys.byteorder != "little":
        samples.byteswap()
    audio_duration = len(samples) / rate
    # AAC padding at the renderer's 24 kHz is under 0.1s and is independent
    # of video fps; a low-fps movie must not permit seconds of missing audio.
    if abs(audio_duration - duration) > 0.15:
        raise ValueError(f"音轨时长 {audio_duration:.3f}s 与 timeline {duration:.3f}s 不一致")
    peak = max(abs(value) for value in samples)
    rms = math.sqrt(sum(value * value for value in samples) / len(samples))
    # One PCM least-significant bit tolerates codec noise without accepting an
    # otherwise silent AAC stream. Normalized levels are recorded for inspection.
    if peak <= 1 or rms <= 1:
        raise ValueError("音轨为空或静音")
    return {"audio_duration": round(audio_duration, 6), "audio_sample_count": len(samples),
            "audio_peak": round(peak / 32768, 8), "audio_rms": round(rms / 32768, 8)}


def verify(video: Path, timeline_file: Path, outdir: Path, max_duration: float = 300.0,
           target_duration: float | None = None) -> dict:
    max_duration = _number(max_duration, "max-duration")
    if max_duration <= 0:
        raise ValueError("max-duration 必须大于零")
    if target_duration is not None:
        target_duration = _number(target_duration, "target-duration")
        if target_duration <= 0:
            raise ValueError("target-duration 必须大于零")
    if not video.is_file() or video.stat().st_size <= 1024:
        raise ValueError("视频文件不存在或为空")
    outdir.mkdir(parents=True, exist_ok=True)
    try:
        timeline = json.loads(timeline_file.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError("timeline.json 不是有效 JSON") from exc
    streams_info, frame_count = _probe(video)
    streams = streams_info.get("streams") or []
    video_stream = _stream(streams, "video")
    audio_stream = _stream(streams, "audio")
    if not video_stream or not audio_stream:
        raise ValueError("成片必须同时包含视频和非空音轨")
    width, height = int(video_stream.get("width") or 0), int(video_stream.get("height") or 0)
    if width < 320 or height < 180 or width > 4096 or height > 4096:
        raise ValueError("视频尺寸不在允许范围")
    duration = _duration((streams_info.get("format") or {}).get("duration"))
    if not duration or duration > max_duration + 0.35:
        raise ValueError(f"视频时长 {duration:.3f}s 超过 {max_duration:g}s 预算")
    minimum_duration = target_duration * 0.60 if target_duration is not None else None
    if minimum_duration is not None and duration + 1e-9 < minimum_duration:
        raise ValueError(
            f"视频实测时长 {duration:.3f}s 低于目标 {target_duration:g}s 的60%"
            f"（至少 {minimum_duration:.3f}s）"
        )
    timeline_info = _timeline_check(timeline, duration)
    fps = _duration(video_stream.get("r_frame_rate"))
    if not 1 <= fps <= 60:
        raise ValueError("视频帧率不在允许范围")
    if abs(fps - timeline_info["timeline_fps"]) > 0.001:
        raise ValueError(f"视频帧率 {fps:g} 与 timeline {timeline_info['timeline_fps']:g} 不一致")
    expected_frames = round(timeline_info["timeline_duration"] * timeline_info["timeline_fps"])
    # The renderer uses int(total * fps); a floating-point frame-boundary roundoff
    # can remove one frame. Larger differences indicate truncated/extra footage.
    if abs(frame_count - expected_frames) > 1:
        raise ValueError(f"视频实际帧数 {frame_count} 与 timeline {expected_frames} 不一致")
    sample_indices = _decode_frames(video, outdir, width, height, frame_count)
    audio_info = _decode_audio(video, timeline_info["timeline_duration"])
    receipt = {
        "ok": True,
        "video": str(video),
        "timeline": str(timeline_file),
        "width": width,
        "height": height,
        "fps": round(fps, 6),
        "duration": round(duration, 6),
        "frame_count": frame_count,
        "expected_frame_count": expected_frames,
        "sample_frame_indices": sample_indices,
        "audio_codec": audio_stream.get("codec_name", ""),
        **audio_info,
        **timeline_info,
        "limitations": ["仅验证画面解码、音轨解码与非静音、时长及时间轴一致；不进行 ASR，也不声称有人听过音频。"],
    }
    if target_duration is not None:
        receipt["target_duration"] = round(target_duration, 6)
        receipt["minimum_target_duration"] = round(minimum_duration, 6)
    (outdir / "verification.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True, type=Path)
    parser.add_argument("--timeline", required=True, type=Path)
    parser.add_argument("--outdir", required=True, type=Path)
    parser.add_argument("--max-duration", type=float, default=300.0)
    parser.add_argument("--target-duration", type=float)
    args = parser.parse_args()
    try:
        result = verify(args.video, args.timeline, args.outdir, args.max_duration, args.target_duration)
    except Exception as exc:
        args.outdir.mkdir(parents=True, exist_ok=True)
        (args.outdir / "verification.json").write_text(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
