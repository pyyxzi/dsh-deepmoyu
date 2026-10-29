"""Verifier regressions with real bundled ffmpeg; no network, ASR or TTS.

Run: python -B tests/test_pv_verify.py
Optional imageio-ffmpeg/Pillow dependencies or a missing ffmpeg skip these tests.
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEPENDENCY_ERROR = ""
try:
    import imageio_ffmpeg
    from PIL import Image
except ImportError as exc:
    DEPENDENCY_ERROR = str(exc)


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "lib" / f"{name}.py")
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


verifier = None if DEPENDENCY_ERROR else module("pv_verify")


def timeline(fps=30, duration=2.0):
    return {
        "schema": "dafeiyu-timeline-v1", "fps": fps, "duration": duration,
        "cues": [
            {"shot": 0, "speaker": "fish", "text": "first", "start": 0.2, "end": 0.65,
             "audio_duration": 0.45, "engine": "test", "mouth_frames": 3},
            {"shot": 1, "speaker": "inner", "text": "second", "start": 1.05, "end": 1.45,
             "audio_duration": 0.4, "engine": "test", "mouth_frames": 2},
        ],
    }


@unittest.skipIf(bool(DEPENDENCY_ERROR), DEPENDENCY_ERROR)
class TimelineTests(unittest.TestCase):
    def test_lead_gap_and_tail_are_valid(self):
        result = verifier._timeline_check(timeline(), 2.0)
        self.assertEqual(result["timeline_fps"], 30)
        self.assertNotIn("fps", result)  # Cannot overwrite measured fps in receipt.
        self.assertEqual(result["cue_count"], 2)
        self.assertEqual(result["last_cue_end"], 1.45)

    def test_accepts_renderer_make_timeline(self):
        try:
            pv = module("pv")
        except ImportError as exc:
            self.skipTest(f"optional renderer dependency missing: {exc}")
        _, total, cues = pv.make_timeline(
            [{"text": "first", "pause_after": 0.35}, {"text": "second"}],
            [{"dur": 1.137, "env": [0, 0.7, 0]}, {"dur": 2.217, "env": [0.2]}],
            0.18, 0.12, 0.5, 12,
        )
        result = verifier._timeline_check(
            {"schema": "dafeiyu-timeline-v1", "fps": 12, "duration": total, "cues": cues}, total
        )
        self.assertEqual(result["cue_count"], 2)
        self.assertGreater(total - result["last_cue_end"], 0.49)

    def test_rejects_nonfinite_or_non_numeric_timing(self):
        bad_values = (float("nan"), float("inf"), float("-inf"), None, "0", True)
        for field in ("fps", "duration", "start", "end", "audio_duration"):
            for value in bad_values:
                with self.subTest(field=field, value=value):
                    plan = timeline()
                    target = plan if field in ("fps", "duration") else plan["cues"][0]
                    target[field] = value
                    with self.assertRaises(ValueError):
                        verifier._timeline_check(plan, 2.0)

    def test_rejects_negative_out_of_bounds_or_overlapping_cues(self):
        changes = ({"start": -0.1, "end": 0.35},
                   {"start": 5.0, "end": 5.45},
                   {"end": 2.1, "audio_duration": 1.9},
                   {"end": 0.2}, {"audio_duration": 0}, {"audio_duration": -0.45})
        for change in changes:
            with self.subTest(change=change):
                plan = timeline()
                plan["cues"][0].update(change)
                with self.assertRaises(ValueError):
                    verifier._timeline_check(plan, 2.0)
        plan = timeline()
        plan["cues"][1].update(start=0.5, end=0.9)
        with self.assertRaises(ValueError):
            verifier._timeline_check(plan, 2.0)

    def test_rejects_bad_schema_or_cue_payload(self):
        plans = ([], {}, dict(timeline(), cues=[]))
        for plan in plans:
            with self.subTest(plan=plan), self.assertRaises(ValueError):
                verifier._timeline_check(plan, 2.0)
        for field, value in (("mouth_frames", float("nan")), ("mouth_frames", True),
                             ("mouth_frames", 0), ("text", ""), ("text", None)):
            with self.subTest(field=field, value=value):
                plan = timeline()
                plan["cues"][0][field] = value
                with self.assertRaises(ValueError):
                    verifier._timeline_check(plan, 2.0)


@unittest.skipIf(bool(DEPENDENCY_ERROR), DEPENDENCY_ERROR)
class RealVideoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            cls.ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
            subprocess.run([cls.ffmpeg, "-version"], capture_output=True, check=True, timeout=15)
        except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
            raise unittest.SkipTest(f"ffmpeg unavailable: {exc}")
        cls.temporary = tempfile.TemporaryDirectory(prefix="pv-verify-")
        cls.root = Path(cls.temporary.name)
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.videos = {}
        for fps in (30, 12, 1):
            path = cls.root / f"real-{fps}.mp4"
            cls.encode(path, fps=fps)
            cls.videos[fps] = path
        cls.silent = cls.root / "silent.mp4"
        cls.noaudio = cls.root / "no-audio.mp4"
        cls.shortaudio = cls.root / "short-audio.mp4"
        cls.lowfps_shortaudio = cls.root / "short-audio-1fps.mp4"
        cls.encode(cls.silent, silent=True)
        cls.encode(cls.noaudio, audio=False)
        cls.encode(cls.shortaudio, audio_duration=0.5)
        cls.encode(cls.lowfps_shortaudio, fps=1, audio_duration=0.5)

    @classmethod
    def encode(cls, path, fps=30, duration=2.0, audio=True, silent=False, audio_duration=None):
        command = [cls.ffmpeg, "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i",
                   f"testsrc2=size=320x180:rate={fps}:duration={duration}"]
        if audio:
            seconds = duration if audio_duration is None else audio_duration
            source = (f"anullsrc=r=24000:cl=mono:d={seconds}" if silent
                      else f"sine=frequency=440:sample_rate=24000:duration={seconds}")
            command += ["-f", "lavfi", "-i", source, "-map", "0:v:0", "-map", "1:a:0",
                        "-c:a", "aac"]
        command += ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(path)]
        result = subprocess.run(command, capture_output=True, check=False, timeout=30)
        if result.returncode:
            raise AssertionError(result.stderr.decode("utf-8", errors="replace"))

    def package(self, plan=None):
        root = self.root / self.id().split(".")[-1]
        root.mkdir(exist_ok=True)
        path = root / "timeline.json"
        path.write_text(json.dumps(plan if plan is not None else timeline()), encoding="utf-8")
        return path, root

    def test_real_h264_aac_cli_at_30_and_12_fps(self):
        for fps in (30, 12):
            with self.subTest(fps=fps):
                timeline_path, root = self.package(timeline(fps))
                outdir = root / str(fps)
                result = subprocess.run(
                    [sys.executable, "-B", str(ROOT / "lib" / "pv_verify.py"),
                     "--video", str(self.videos[fps]), "--timeline", str(timeline_path),
                     "--outdir", str(outdir), "--max-duration", "300"],
                    capture_output=True, check=False, timeout=30,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                receipt = json.loads((outdir / "verification.json").read_text(encoding="utf-8"))
                stdout_receipt = json.loads(result.stdout.decode("utf-8", errors="replace"))
                self.assertTrue(stdout_receipt["ok"])
                self.assertTrue(receipt["ok"])
                self.assertEqual(receipt["fps"], fps)
                self.assertEqual(receipt["timeline_fps"], fps)
                self.assertEqual(receipt["frame_count"], 2 * fps)
                self.assertEqual(receipt["sample_frame_indices"],
                                 {"first": 0, "middle": fps, "last": 2 * fps - 1})
                self.assertEqual(receipt["audio_codec"], "aac")
                self.assertGreater(receipt["audio_rms"], 0.01)
                self.assertAlmostEqual(receipt["audio_duration"], 2.0, delta=0.15)
                self.assert_sample_images(self.videos[fps], outdir, receipt)

    def assert_sample_images(self, video, outdir, receipt):
        # Compare every saved PNG to the same actual decoded frame index. This
        # covers arbitrary binary bytes, exact midpoint and final-frame selection.
        wanted = receipt["sample_frame_indices"]
        reader = imageio_ffmpeg.read_frames(str(video), pix_fmt="rgb24", output_params=["-vsync", "0"])
        try:
            metadata = next(reader)
            for index, pixels in enumerate(reader):
                for label, selected in wanted.items():
                    if index == selected:
                        with Image.open(outdir / f"verify_{label}.png") as image:
                            self.assertEqual(image.size, tuple(metadata["size"]))
                            self.assertEqual(image.convert("RGB").tobytes(), pixels)
        finally:
            reader.close()

    def test_one_fps_and_duplicate_sample_indices(self):
        timeline_path, root = self.package(timeline(1))
        receipt = verifier.verify(self.videos[1], timeline_path, root)
        self.assertEqual(receipt["frame_count"], 2)
        self.assertEqual(receipt["sample_frame_indices"], {"first": 0, "middle": 1, "last": 1})
        self.assert_sample_images(self.videos[1], root, receipt)

    def test_target_duration_boundary_accepts_and_below_rejects(self):
        timeline_path, root = self.package()
        accepted = verifier.verify(self.videos[30], timeline_path, root / "boundary", 300, 2.0 / 0.60)
        self.assertAlmostEqual(accepted["minimum_target_duration"], 2.0, places=6)
        with self.assertRaisesRegex(ValueError, "实测时长.*目标.*60%"):
            verifier.verify(self.videos[30], timeline_path, root / "below", 300, 2.0 / 0.60 + 0.01)

    def test_cli_target_duration_failure_writes_reason_and_old_invocation_still_passes(self):
        timeline_path, root = self.package()
        old = subprocess.run(
            [sys.executable, "-B", str(ROOT / "lib" / "pv_verify.py"),
             "--video", str(self.videos[30]), "--timeline", str(timeline_path),
             "--outdir", str(root / "old")],
            capture_output=True, check=False, timeout=30,
        )
        self.assertEqual(old.returncode, 0, old.stdout + old.stderr)
        failed = subprocess.run(
            [sys.executable, "-B", str(ROOT / "lib" / "pv_verify.py"),
             "--video", str(self.videos[30]), "--timeline", str(timeline_path),
             "--outdir", str(root / "target"), "--target-duration", "10"],
            capture_output=True, check=False, timeout=30,
        )
        self.assertEqual(failed.returncode, 1, failed.stdout + failed.stderr)
        receipt = json.loads((root / "target" / "verification.json").read_text(encoding="utf-8"))
        self.assertFalse(receipt["ok"])
        self.assertRegex(receipt["error"], "实测时长.*目标 10s.*60%")

    def test_rejects_measured_timeline_fps_mismatch(self):
        timeline_path, root = self.package(timeline(24))
        with self.assertRaisesRegex(ValueError, "帧率.*timeline"):
            verifier.verify(self.videos[30], timeline_path, root)

    def test_rejects_frame_count_mismatch_with_close_container_duration(self):
        # The old 0.35s container tolerance accepted this three-frame shortage.
        plan = timeline(12, 2.25)
        timeline_path, root = self.package(plan)
        with self.assertRaisesRegex(ValueError, "实际帧数"):
            verifier.verify(self.videos[12], timeline_path, root)

    def test_rejects_missing_silent_or_short_audio(self):
        for video, message in ((self.noaudio, "音轨"), (self.silent, "静音"),
                               (self.shortaudio, "音轨时长")):
            with self.subTest(video=video.name):
                timeline_path, root = self.package()
                with self.assertRaisesRegex(ValueError, message):
                    verifier.verify(video, timeline_path, root / video.stem)

    def test_low_fps_does_not_permit_missing_audio_seconds(self):
        timeline_path, root = self.package(timeline(1))
        with self.assertRaisesRegex(ValueError, "音轨时长"):
            verifier.verify(self.lowfps_shortaudio, timeline_path, root)

    def test_cli_writes_failed_receipt_and_nonzero_exit(self):
        plan = timeline()
        plan["cues"][0].update(start=5, end=6, audio_duration=1)
        timeline_path, root = self.package(plan)
        result = subprocess.run(
            [sys.executable, "-B", str(ROOT / "lib" / "pv_verify.py"),
             "--video", str(self.videos[30]), "--timeline", str(timeline_path), "--outdir", str(root)],
            capture_output=True, check=False, timeout=30,
        )
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertFalse(json.loads((root / "verification.json").read_text(encoding="utf-8"))["ok"])
        self.assertFalse(json.loads(result.stdout.decode("utf-8", errors="replace"))["ok"])

    def test_nonfinite_duration_budget_is_rejected(self):
        timeline_path, root = self.package()
        for budget in (0, -1, float("nan"), float("inf")):
            with self.subTest(budget=budget), self.assertRaises(ValueError):
                verifier.verify(self.videos[30], timeline_path, root, budget)


if __name__ == "__main__":
    unittest.main(verbosity=2)
