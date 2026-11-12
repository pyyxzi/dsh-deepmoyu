"""Offline search pagination contracts; executes the real function with a synthetic SDK."""
import ast
import json
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_search(response, calls):
    tree = ast.parse((ROOT / "vendor" / "bilibili-mcp" / "mcp_server.py").read_text(encoding="utf-8"))
    function = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "bili_search")
    function.decorator_list = []

    async def search_by_type(**kwargs):
        calls.append(kwargs)
        return response

    search = types.SimpleNamespace(search_by_type=search_by_type,
                                   OrderVideo=types.SimpleNamespace(TOTALRANK="totalrank", CLICK="click", PUBDATE="pubdate", DM="dm"),
                                   SearchObjectType=types.SimpleNamespace(VIDEO="video"))
    namespace = {"search": search, "json": json, "stringify_ids": lambda value: value, "StrictInt": int}
    exec(compile(ast.Module(body=[function], type_ignores=[]), "synthetic-search-module", "exec"), namespace)
    return namespace["bili_search"]


class SearchPagination(unittest.IsolatedAsyncioTestCase):
    async def test_second_page_reaches_the_actual_sdk_and_preserves_pagination_evidence(self):
        calls = []
        search = load_search({"numPages": 3, "numResults": 60, "result": [
            {"bvid": "BV14AHP6VExR", "title": "第二页合成视频", "pubdate": 1760000000},
        ]}, calls)
        out = json.loads(await search("合成关键词", num=1, page=2))
        self.assertEqual(calls[0]["page"], 2)
        self.assertEqual(out["page"], 2)
        self.assertTrue(out["has_more"])
        self.assertEqual(out["videos"][0]["title"], "第二页合成视频")
        last = json.loads(await search("合成关键词", page=3))
        self.assertFalse(last["has_more"])

    async def test_invalid_pages_are_rejected_before_any_network_call(self):
        calls = []
        search = load_search({"result": []}, calls)
        for page in [0, -1, 51, True, False, 1.5, "2", None, float("inf")]:
            out = json.loads(await search("合成关键词", page=page))
            self.assertFalse(out["ok"], page)
            self.assertIn("page", out["error"])
        self.assertEqual(calls, [])

    async def test_missing_metadata_is_unknown_and_filtering_does_not_invent_exhaustion(self):
        calls = []
        search = load_search({"result": []}, calls)
        out = json.loads(await search("合成关键词"))
        self.assertEqual(calls[0]["page"], 1)
        self.assertIsNone(out["has_more"])
        search = load_search({"numPages": "4", "result": [
            {"bvid": "BV14AHP6VExR", "pubdate": 1},
        ]}, calls)
        out = json.loads(await search("合成关键词", days=1, page=2))
        self.assertTrue(out["filtered_out_all"])
        self.assertTrue(out["has_more"])

    async def test_result_count_requires_real_page_size_and_local_page_cap_is_respected(self):
        for metadata, page, expected in [
            ({"numResults": 41, "pagesize": 20}, 2, True),
            ({"numResults": "40", "pagesize": 20}, 2, False),
            ({"numResults": 41}, 2, None),
            ({"numResults": 0}, 1, False),
            ({"numPages": 100}, 50, False),
            ({"numPages": True, "numResults": "bad"}, 1, None),
        ]:
            calls = []
            out = json.loads(await load_search({**metadata, "result": []}, calls)("合成关键词", page=page))
            self.assertIs(out["has_more"], expected, metadata)


if __name__ == "__main__":
    unittest.main(verbosity=2)
