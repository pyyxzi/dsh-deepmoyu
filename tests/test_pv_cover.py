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


class LongTitles(unittest.TestCase):
    """回归：真机 2026-10-25 因为一条 42 字的长标题封不出图，整天视频被判失败。"""

    LONG = ("24岁白手起家一天赚2亿、中法混血沪二代买99元化妆品？"
            "近期互联网热门奇葩人设赏析！")

    def test_a_full_video_title_still_produces_both_covers(self):
        for ratio in ("16x9", "4x3"):
            image = covers.render_cover(self.LONG, ratio)
            self.assertEqual(image.size, covers.RATIO_SIZES[ratio])
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            covers.generate_covers(out, self.LONG)
            for ratio in ("16x9", "4x3"):
                self.assertTrue(covers.valid_cover(out / covers.COVER_NAMES[ratio], ratio))

    def test_the_full_title_is_kept_whenever_it_fits(self):
        # 16:9 版面宽，42 字降字号后本来就排得下 —— 别为了省事把标题一律截短
        self.assertEqual(covers.fitted_title(self.LONG, "16x9"), self.LONG)

    def test_overlong_headline_is_trimmed_at_a_clause_not_mid_word(self):
        trimmed = covers.fitted_title(self.LONG, "4x3")
        self.assertLess(len(trimmed), len(self.LONG))
        self.assertTrue(trimmed.endswith("…"), trimmed)
        # 截断点必须落在分句标点上，不能把一个词/数字砍成两半
        self.assertIn(trimmed[:-1][-1], "，,、；;：:—–－？！!?。…", trimmed)

    def test_trimming_never_returns_something_shorter_than_a_headline(self):
        trimmed = covers.fitted_title(self.LONG, "4x3")
        self.assertGreaterEqual(len(trimmed), 8)

    def test_fitted_title_is_stable_and_still_validated(self):
        self.assertEqual(covers.fitted_title("三张工牌，同样送外卖", "4x3"), "三张工牌，同样送外卖")
        with self.assertRaises(ValueError):
            covers.fitted_title("2026-10-22 日报", "16x9")

    def test_layout_really_shrinks_the_font_instead_of_aborting(self):
        # 排版搜索必须真的用上降字号：16:9 的 42 字标题只有 3 行 + 降字号排得下
        draw = covers.ImageDraw.Draw(Image.new("RGB", (2, 2)))
        width, height = covers._text_field("16x9")
        font, lines, _lh, _spacing = covers._fit_headline(draw, self.LONG, width, height)
        self.assertLess(font.size, covers.HEADLINE_MAX_SIZE)
        self.assertGreaterEqual(font.size, covers.HEADLINE_MIN_SIZE)
        self.assertEqual(len(lines), 3)
        self.assertEqual("".join(lines), self.LONG)

    def test_a_short_title_stays_at_the_largest_size(self):
        draw = covers.ImageDraw.Draw(Image.new("RGB", (2, 2)))
        width, height = covers._text_field("16x9")
        font, _lines, _lh, _spacing = covers._fit_headline(draw, "三张工牌，同样送外卖", width, height)
        self.assertGreaterEqual(font.size, covers.HEADLINE_READABLE)


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
