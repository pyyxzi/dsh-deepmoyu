"""Isolated video regressions. No Bili writes, network TTS or model loads."""
from __future__ import annotations

import array
import importlib.util
import json
import math
import shutil
import sys
import tempfile
import unittest
import wave
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from PIL import ImageChops

ROOT = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "lib" / f"{name}.py")
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


pv = module("pv")
planner = module("pv_plan")
gsv = module("pv_gsv")
verifier = module("pv_verify")
editorial = module("pv_editorial")


def write_wave(path, amplitude=2400, duration=.7, rate=24000):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    samples = array.array("h", (int(amplitude * math.sin(2 * math.pi * 220 * i / rate))
                                for i in range(round(rate * duration))))
    with wave.open(str(path), "wb") as handle:
        handle.setparams((1, 2, rate, len(samples), "NONE", "not compressed"))
        handle.writeframes(samples.tobytes())
    return samples


class Sources(unittest.TestCase):
    def test_only_public_report_note_is_adapted(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "out").mkdir()
            (home / "out" / "2026-10-21.md").write_text(
                "# 材料\n### BV1epp96iE6i 《公共测试标题》\n"
                "**这段先举例再解释，容易看出问题究竟出在哪里。**\n"
                "- 私信：绝对不要出现在片子里的秘密\n## 私信\n隐藏正文\n", encoding="utf-8")
            facts = planner.gather(home, "2026-10-21")
            plan = planner.auto_plan(facts, first=True)
            raw = json.dumps(plan, ensure_ascii=False)
            self.assertEqual(len(plan["sources"]), 1)
            self.assertEqual(plan["sources"][0]["line"], 2)
            self.assertEqual(plan["sources"][0]["url"], "https://www.bilibili.com/video/BV1epp96iE6i")
            self.assertNotIn("绝对不要", raw)
            self.assertNotIn("隐藏正文", raw)
            claims = [shot for shot in plan["shots"] if shot["provenance"] == "record-adaptation"]
            self.assertEqual(len(claims), 2)
            self.assertTrue(all(shot["source_ids"] == ["note-1"] for shot in claims))
            self.assertIn("虚构", plan["disclosure"])

    def test_sensitive_lines_are_excluded_before_highlights(self):
        self.assertEqual(planner.public_excerpt("私信：**这段是虚构隐私，不可拿来当公开视频笔记。**"), "")
        self.assertEqual(planner.public_excerpt(r"来源 C:\\private\\voice.wav **这是一段不能进视频的私人路径注释。**"), "")
        self.assertEqual(planner.public_excerpt("- **这行是回复记录，不应被选为笔记正文。**"), "")

    def test_empty_day_never_inherits_old_first_day_facts(self):
        with tempfile.TemporaryDirectory() as directory:
            plan = planner.auto_plan(planner.gather(Path(directory), "2026-10-22"), first=True)
        raw = json.dumps(plan, ensure_ascii=False)
        for false_fact in ("k卷", "746", "麻姑", "岐路九秋风", "午夜", "生鱼片"):
            self.assertNotIn(false_fact, raw)
        self.assertEqual(plan["sources"], [])
        self.assertTrue(all(shot["provenance"] == "original-dialogue" for shot in plan["shots"]))
        self.assertIn("没留下能用的公开选片笔记", raw)

    def test_utc8_midnight(self):
        before = datetime(2026, 10, 20, 15, 59, 59, tzinfo=timezone.utc).timestamp() * 1000
        self.assertEqual(planner.day_of(before), "2026-10-20")
        self.assertEqual(planner.day_of(before + 1000), "2026-10-21")
        self.assertEqual(planner.day_of(float("nan")), "")

    def test_durable_index_rotation_and_clear_archive_deduplicate(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            stamp = datetime(2026, 10, 21, 2, tzinfo=timezone.utc).timestamp() * 1000
            event_id = "a" * 64
            row = {"t": stamp, "seq": 7, "kind": "done", "tool": "bili_search", "text": "公开搜索", "eventId": event_id}
            index = home / "records" / "days" / "2026-10-21.jsonl"
            event = home / "records" / "events" / "aa" / f"{event_id}.json"
            archived = home / "records" / "activity" / "2026-10-21" / "unique.jsonl"
            for path in (index, event, archived):
                path.parent.mkdir(parents=True, exist_ok=True)
            index.write_text(json.dumps({"eventId": event_id, "at": "2026-10-21T02:00:00Z"}) + "\n", encoding="utf-8")
            event.write_text(json.dumps({"type": "activity", "data": row}), encoding="utf-8")
            archived.write_text(json.dumps(row) + "\n", encoding="utf-8")
            (home / "activity.jsonl.2").write_text(json.dumps(row) + "\n", encoding="utf-8")
            (home / "activity.jsonl").write_text("{truncated\n" + json.dumps(row) + "\n", encoding="utf-8")
            rows = planner.load_activity(home, "2026-10-21")
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["_source"]["eventId"], event_id)
            self.assertEqual(planner.gather(home, "2026-10-21")["stats"]["searches"], 1)
            self.assertEqual(planner.load_activity(home, "2026-10-22"), [])


class Audio(unittest.TestCase):
    def test_cache_identity_changes_with_text_voice_and_reference_bytes(self):
        voice = {"name": "a", "rate": "+8%"}
        key = pv.audio_cache_key("一", voice, "edge")
        self.assertNotEqual(key, pv.audio_cache_key("二", voice, "edge"))
        self.assertNotEqual(key, pv.audio_cache_key("一", dict(voice, pitch="+2Hz"), "edge"))
        self.assertEqual(key, pv.audio_cache_key("一", dict(reversed(list(voice.items()))), "edge"))
        with tempfile.TemporaryDirectory() as directory:
            reference = Path(directory) / "ref.wav"
            reference.write_bytes(b"first")
            voice = {"gsvRef": str(reference), "gsvPrompt": "测试"}
            key = pv.audio_cache_key("一", voice, "gsv")
            reference.write_bytes(b"later")
            self.assertNotEqual(key, pv.audio_cache_key("一", voice, "gsv"))

    def test_modified_take_and_reordering_do_not_reuse_numbered_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            (work / "tts").mkdir()
            (work / "wav").mkdir()
            calls = []
            def synth(text, path, *args):
                calls.append(text)
                write_wave(path, duration=.7 if text == "甲" else 1.1)
                return "test-tts"
            def convert(source, destination, _rate=24000):
                shutil.copyfile(source, destination)
                with wave.open(str(destination), "rb") as stream:
                    pcm = array.array("h")
                    pcm.frombytes(stream.readframes(stream.getnframes()))
                    return pcm, stream.getframerate()
            with patch.object(pv, "tts", synth), patch.object(pv, "to_wav", convert):
                first = pv.prepare_audio([{"text": "甲"}, {"text": "乙"}], {}, work, 12)
                second = pv.prepare_audio([{"text": "乙"}, {"text": "甲"}], {}, work, 12)
                third = pv.prepare_audio([{"text": "丙"}, {"text": "甲"}], {}, work, 12)
            self.assertEqual(calls, ["甲", "乙", "丙"])
            self.assertEqual(first[0]["cache_key"], second[1]["cache_key"])
            self.assertAlmostEqual(second[0]["dur"], 1.1)
            self.assertNotEqual(second[0]["cache_key"], third[0]["cache_key"])

    def test_partial_gsv_batch_keeps_full_original_order(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            (work / "wav").mkdir()
            calls = []
            def synth(texts, target, voice):
                calls.append(list(texts))
                for index, text in enumerate(texts):
                    path = target / f"{index:02d}.wav"
                    if not path.exists():
                        write_wave(path, amplitude=1000 + index * 1000, duration=.5 + index * .1)
            def convert(source, destination, _rate=24000):
                shutil.copyfile(source, destination)
                with wave.open(str(destination), "rb") as stream:
                    pcm = array.array("h")
                    pcm.frombytes(stream.readframes(stream.getnframes()))
                    return pcm, stream.getframerate()
            voice = {"gsvRepo": "repo", "gsvRef": "reference", "gsvPrompt": "原话"}
            shots = [{"text": "甲"}, {"text": "乙"}, {"text": "丙"}]
            with patch.object(pv, "gsv_batch", synth), patch.object(pv, "to_wav", convert):
                first = pv.prepare_audio(shots, voice, work, 12)
                middle = next((work / "gsv").glob("*/01.wav"))
                middle.unlink()
                second = pv.prepare_audio(shots, voice, work, 12)
            self.assertEqual(calls, [["甲", "乙", "丙"], ["甲", "乙", "丙"]])
            self.assertEqual([take["dur"] for take in first], [take["dur"] for take in second])

    def test_identical_lines_are_synthesized_once_and_both_shots_reuse_the_take(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            (work / "tts").mkdir()
            (work / "wav").mkdir()
            calls = []
            def synth(text, path, *args):
                calls.append(text)
                write_wave(path, duration=.8)
                return "test-tts"
            def convert(source, destination):
                shutil.copyfile(source, destination)
                with wave.open(str(destination), "rb") as stream:
                    pcm = array.array("h")
                    pcm.frombytes(stream.readframes(stream.getnframes()))
                    return pcm, stream.getframerate()
            shots = [{"text": "同一句话"}, {"text": "隔着的一句"}, {"text": "同一句话"}]
            with patch.object(pv, "tts", synth), patch.object(pv, "to_wav", convert):
                takes = pv.prepare_audio(shots, {}, work, 12)
            self.assertEqual(calls.count("同一句话"), 1, "duplicate lines raced on one .partial.mp3")
            self.assertEqual(takes[0]["cache_key"], takes[2]["cache_key"])
            self.assertAlmostEqual(takes[0]["dur"], takes[2]["dur"])

    def test_inner_speaker_explicitly_selects_edge_voice(self):
        voice = pv.shot_voice({"gsvRepo": "repo", "gsvRef": "ref", "gsvPrompt": "原话"},
                             {"voice": {"mode": "edge", "name": "inner"}})
        self.assertEqual(voice["name"], "inner")
        self.assertFalse(any(key.startswith("gsv") for key in voice))

    def test_pcm_timeline_preserves_tail_and_pause_and_does_not_overlap(self):
        shots = [{"text": "甲", "pause_after": .35}, {"text": "乙"}]
        audios = [{"dur": 1.137, "env": [0, .7, 0]}, {"dur": 2.217, "env": [.2]}]
        starts, total, cues = pv.make_timeline(shots, audios, .18, .12, .5, 12)
        self.assertAlmostEqual(starts[1], .18 + 1.137 + .35)
        self.assertGreaterEqual(total, cues[-1]["end"] + .5)
        self.assertLess(total - (cues[-1]["end"] + .5), 1 / 12)
        self.assertGreater(cues[1]["start"], cues[0]["end"])
        self.assertEqual(cues[0]["mouth_frames"], 1)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "captions.srt"
            pv.write_captions(cues, path)
            self.assertIn("00:00:00,180 --> 00:00:01,317", path.read_text(encoding="utf-8"))

    def test_lip_envelope_responds_to_pcm_silence(self):
        samples = array.array("h", [0] * 6000 + [3000, -3000] * 3000 + [0] * 6000)
        env = pv.envelope(samples, 24000, 12)
        self.assertEqual(env[0], 0)
        self.assertEqual(env[-1], 0)
        self.assertGreater(max(env), .9)


class GsvHelper(unittest.TestCase):
    def test_output_paths_are_fixed_before_model_changes_cwd(self):
        with tempfile.TemporaryDirectory() as directory:
            batch = Path(directory) / "incoming" / "batch.json"
            target = Path(directory) / "audio"
            items = gsv.resolve_items([{"text": "甲", "out": "00.wav"}], batch, str(target))
            self.assertEqual(Path(items[0]["out"]), target / "00.wav")
            items = gsv.resolve_items([{"text": "甲", "out": "00.wav"}], batch)
            self.assertEqual(Path(items[0]["out"]), batch.parent / "00.wav")

    def test_same_output_filename_requires_matching_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "00.wav"
            write_wave(path)
            key = gsv.take_key("甲", {"speed": 1.06})
            self.assertFalse(gsv.cached_take(path, key))
            path.with_suffix(".json").write_text(json.dumps({"key": key}), encoding="utf-8")
            self.assertTrue(gsv.cached_take(path, key))
            self.assertFalse(gsv.cached_take(path, gsv.take_key("乙", {"speed": 1.06})))


class Stage(unittest.TestCase):
    def test_real_editorial_render_has_measured_audio_frames_and_mouth_motion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan = {
                "schema": "deepmoyu-editorial-v2", "theme": "paper",
                "title": "最小真实渲染", "brief": "离线发布探测", "disclosure": "原创测试",
                "lead": .1, "gap": .08, "tail": .25,
                "shots": [
                    {"id": "a", "speaker": "fish", "scene": "hook", "headline": "先抓住问题", "text": "先做第一步。"},
                    {"id": "b", "speaker": "fish", "scene": "compare", "headline": "输入不是行动",
                     "items": [{"label": "收藏", "detail": "留到以后"}, {"label": "尝试", "detail": "现在反馈"}], "text": "试一次，就有反馈。"},
                    {"id": "c", "speaker": "fish", "scene": "outro", "headline": "现在开始", "body": "完成第一步。", "text": "现在开始吧。"},
                ],
            }
            def synth(_text, path, *_args, **_kwargs):
                write_wave(path, amplitude=4200, duration=.45)
                return "offline-test"
            def convert(source, destination, _rate=24000):
                shutil.copyfile(source, destination)
                with wave.open(str(destination), "rb") as stream:
                    pcm = array.array("h")
                    pcm.frombytes(stream.readframes(stream.getnframes()))
                    return pcm, stream.getframerate()
            out, work = root / "movie.mp4", root / "work"
            with patch.object(pv, "tts", synth), patch.object(pv, "to_wav", convert), patch.dict(sys.modules, {"pv_editorial": editorial}):
                pv.build(plan, out, work, fps=4, scale=.2)
            timeline = json.loads((work / "timeline.json").read_text(encoding="utf-8"))
            self.assertEqual(timeline["visual_schema"], "deepmoyu-editorial-v2")
            self.assertEqual(timeline["theme"], "paper")
            self.assertEqual(len(timeline["cues"]), 3)
            self.assertTrue(all(cue["mouth_frames"] > 0 for cue in timeline["cues"]))
            receipt = verifier.verify(out, work / "timeline.json", root / "verified", 10)
            self.assertEqual(receipt["frame_count"], receipt["expected_frame_count"])
            self.assertEqual(receipt["audio_codec"], "aac")
            self.assertGreater(receipt["audio_rms"], .01)

    def test_desk_grain_keeps_top_and_front_opaque(self):
        for camera in ("wide", "insert"):
            with self.subTest(camera=camera):
                desk = pv._draw_desk_front(camera, "note")
                alpha = desk.getchannel("A")
                # Left clear desk avoids the insert shot's large translucent bowl rim.
                self.assertEqual(alpha.crop((40, pv.DESK_TOP + 8, 400, pv.DESK_TOP + 78)).getextrema(), (255, 255))
                self.assertEqual(alpha.crop((40, 996, 400, pv.DH - 2)).getextrema(), (255, 255))
                self.assertEqual(alpha.getpixel((pv.DW - 1, 0)), 0)

    def test_mouth_patch_stays_on_reviewed_source_mouth(self):
        rig = pv.DialoguePortrait()
        self.assertTrue(rig.rigged)
        closed = rig.render(0).convert("RGB")
        opened = rig.render(1).convert("RGB")
        box = ImageChops.difference(closed, opened).getbbox()
        self.assertIsNotNone(box)
        # Original mouth is x505..520/y513..517 in the 1037x1100 source.
        self.assertTrue(330 <= box[0] < box[2] <= 370, box)
        self.assertTrue(335 <= box[1] < box[3] <= 368, box)

    def test_invalid_render_settings_fail_before_starting_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError):
                pv.build({"shots": []}, root / "out.mp4", root)
            with self.assertRaises(ValueError):
                pv.build({"shots": [{}]}, root / "out.mp4", root, fps=0)
            with self.assertRaises(ValueError):
                pv.build({"shots": [{}], "width": 900}, root / "out.mp4", root)


if __name__ == "__main__":
    unittest.main(verbosity=2)
