"""Cover selection/render regressions. No network, TTS or rendering loop."""
from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "lib"))


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "lib" / f"{name}.py")
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


covers = module("pv_cover")


class Titles(unittest.TestCase):
    def test_rejects_dates_report_labels_and_placeholders(self):
        for bad in ("2026-10-22 日报", "十月二十二日蜻蜓消失", "在10月22号看见蜻蜓",
                    "2026.10.22 蜻蜓消失", "大肥鱼日报", "今日日报", "TODO 起标题", "BV1abcDEF234"):
            with self.assertRaises(ValueError, msg=bad):
                covers.validate_title(bad)

    def test_keeps_concrete_event_phrases_and_decimal_numbers(self):
        for good in ("蜻蜓的产房没了", "四个字收获746个赞", "三张工牌，同样送外卖",
                     "葡萄酒八年跌七成，扫码价高81倍"):
            self.assertEqual(covers.validate_title(good), good)

    def test_explicit_cover_wins_but_invalid_metadata_is_an_error(self):
        plan = {"date": "2026-10-22", "cover": {"title": "蜻蜓的产房没了"},
                "shots": [{"kind": "story", "title": "别的故事"}]}
        self.assertEqual(covers.choose_title(plan), "蜻蜓的产房没了")
        with self.assertRaises(ValueError):
            covers.choose_title({"cover": {"title": "2026-10-22 日报"}})

    def test_selection_uses_story_then_list_then_sources(self):
        self.assertEqual(covers.choose_title({"shots": [
            {"kind": "title", "title": "大肥鱼日报"},
            {"kind": "story", "title": "蜻蜓的产房没了"},
            {"kind": "list", "entries": [{"title": "别的条目"}]},
        ]}), "蜻蜓的产房没了")
        self.assertEqual(covers.choose_title({"shots": [
            {"kind": "list", "entries": [{"title": "三张工牌，同样送外卖"}]},
        ]}), "三张工牌，同样送外卖")
        self.assertEqual(covers.choose_title({"sources": [{"title": "夜市大哥分了半块饼"}]}),
                         "夜市大哥分了半块饼")
        with self.assertRaises(ValueError):
            covers.choose_title({"shots": [{"kind": "talk", "text": "只有台词没有标题"}]})


class Artwork(unittest.TestCase):
    def test_both_ratios_are_exact_and_headline_fits(self):
        for ratio, size in (("16x9", (1920, 1080)), ("4x3", (1440, 1080))):
            image = covers.render_cover("三张工牌，同样送外卖", ratio)
            self.assertEqual(image.size, size)
            self.assertEqual(image.mode, "RGBA")

    def test_multiline_headline_never_starts_with_punctuation(self):
        draw = covers.ImageDraw.Draw(Image.new("RGB", (2, 2)))
        font = covers.NF(90, "Bold")
        lines = covers._wrap_measured(draw, "三张工牌，同样送外卖", font, 760, 2)
        self.assertTrue(lines)
        for line in lines:
            self.assertNotIn(line[0], "，。！？、；：…", line)

    def test_generation_validates_dimensions_and_preserves_only_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            covers.generate_covers(out, "蜻蜓的产房没了")
            first = (out / "封面_16x9.png").read_bytes()
            (out / "封面_4x3.png").write_bytes(b"broken")
            covers.generate_covers(out, "蜻蜓的产房没了", only_missing=True)
            self.assertEqual((out / "封面_16x9.png").read_bytes(), first)
            self.assertTrue(covers.valid_cover(out / "封面_4x3.png", "4x3"))

    def test_invalid_dimension_is_not_a_valid_cover(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "封面_16x9.png"
            image = covers.render_cover("蜻蜓的产房没了", "4x3")
            image.save(path)
            self.assertFalse(covers.valid_cover(path, "16x9"))
            self.assertTrue(covers.valid_cover(path, "4x3"))


if __name__ == "__main__":
    unittest.main()
