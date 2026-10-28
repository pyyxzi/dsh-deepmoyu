"""Verify an actual local MP4 against measured utterance timing and decoded PCM.

Usage: python verify_pv_sample.py <sample.mp4> <render-directory>
Produces decoded first/middle/last frames, clean speech WAV, audio-check.json.
It does not perform ASR or claim that an agent listened to the audio.
"""
from __future__ import annotations

import argparse
import array
import json
import math
import subprocess
import wave
from pathlib import Path

import imageio_ffmpeg
from PIL import Image


def waveform(path):
    with wave.open(str(path), "rb") as handle:
        assert handle.getsampwidth() == 2, "expected 16-bit PCM"
        samples = array.array("h")
        samples.frombytes(handle.readframes(handle.getnframes()))
        channels, rate, frames = handle.getnchannels(), handle.getframerate(), handle.getnframes()
    peak = max((abs(value) for value in samples), default=0)
    rms = math.sqrt(sum(value * value for value in samples) / max(1, len(samples)))
    return {"duration": frames / rate, "sample_rate": rate, "channels": channels,
            "peak_dbfs": round(20 * math.log10(max(1, peak) / 32768), 3),
            "rms_dbfs": round(20 * math.log10(max(1, rms) / 32768), 3),
            "clipped_samples": sum(abs(value) >= 32767 for value in samples),
            "sample_count": len(samples)}


def verify(video, work):
    timeline = json.loads((work / "timeline.json").read_text(encoding="utf-8"))
    fps, duration = timeline["fps"], timeline["duration"]
    frames_expected = round(fps * duration)
    selected = {max(1, int(timeline["cues"][0]["start"] * fps) + 1): "first",
                frames_expected // 2: "middle", frames_expected - 2: "last"}
    reader = imageio_ffmpeg.read_frames(str(video), pix_fmt="rgb24")
    metadata = next(reader)
    count = 0
    for index, pixels in enumerate(reader):
        count += 1
        if index in selected:
            Image.frombytes("RGB", metadata["size"], pixels).save(work / f"decoded_{selected[index]}.png")
    assert count == frames_expected, (count, frames_expected)
    assert abs(metadata["fps"] - fps) < .001
    assert metadata.get("audio_codec"), "MP4 has no audio stream"

    decoded = work / "decoded_audio.wav"
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-v", "error", "-i", str(video),
                    "-vn", "-acodec", "pcm_s16le", "-ar", "24000", str(decoded)], check=True)
    mixed = waveform(decoded)
    speech = waveform(work / "narr.wav")
    assert abs(mixed["duration"] - duration) < .12, (mixed["duration"], duration)
    assert abs(speech["duration"] - duration) <= 1 / 24000
    assert mixed["clipped_samples"] == 0
    assert mixed["rms_dbfs"] > -40

    checks = []
    previous_end = 0
    for cue in timeline["cues"]:
        take = waveform(work / "wav" / f"{cue['shot']:02d}.wav")
        assert abs(take["duration"] - cue["audio_duration"]) <= 1 / 24000
        assert abs((cue["end"] - cue["start"]) - take["duration"]) < .000002
        assert cue["start"] >= previous_end
        assert cue["mouth_frames"] > 0
        assert take["rms_dbfs"] > -40
        previous_end = cue["end"]
        checks.append({"shot": cue["shot"], "speaker": cue["speaker"], "engine": cue["engine"],
                       "duration": take["duration"], "rms_dbfs": take["rms_dbfs"],
                       "mouth_frames": cue["mouth_frames"]})
    assert duration - previous_end >= .5 - 1 / 24000
    result = {"status": "passed", "video": video.name, "frame_count": count,
              "size": list(metadata["size"]), "fps": metadata["fps"], "duration": duration,
              "audio": mixed, "speech": speech, "cue_checks": checks,
              "limitations": ["Acoustic and timing checks only; no ASR or human listening test.",
                              "Mouth motion uses RMS, not phoneme alignment."]}
    (work / "audio-check.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("video", type=Path)
    parser.add_argument("work", type=Path)
    args = parser.parse_args()
    verify(args.video, args.work)
