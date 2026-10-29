"""Offline CLI contracts for optional ASR and favorites sidecars.

Scripts and fake dependencies are copied into independent temporary directories.
No real credentials, platform requests, model downloads or speech recognition run.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BVID = "BV14AHP6VExR"

ASR_DOWNLOAD_FAKE = r'''
import json, os
from pathlib import Path

def record(kind, **data):
    with open(os.environ['FAKE_LOG'], 'a', encoding='utf-8') as stream:
        stream.write(json.dumps(dict(kind=kind, **data), ensure_ascii=False) + '\n')

class YoutubeDL:
    def __init__(self, options):
        self.options = options
        record('download-options', options=options)
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
    def extract_info(self, url, download=True):
        target = Path(self.options['outtmpl'].replace('%(ext)s', 'm4a'))
        record('download', url=url, download=download, target=str(target))
        target.parent.mkdir(parents=True, exist_ok=True)
        Path(str(target) + '.part').write_text('partial-owned', encoding='utf-8')
        if os.environ.get('ASR_DIRECTORY_SIDECAR'):
            Path(str(target) + '.directory').mkdir()
        if not os.environ.get('ASR_DOWNLOAD_MISSING'):
            target.write_text('synthetic audio', encoding='utf-8')
        if os.environ.get('ASR_DOWNLOAD_FAIL'):
            raise RuntimeError('synthetic download failed')
        self.target = os.environ.get('ASR_DOWNLOAD_OUTSIDE', str(target))
        return {'id': 'synthetic-id', 'ext': 'm4a'}
    def prepare_filename(self, info):
        return self.target
'''

ASR_MODEL_FAKE = r'''
import json, os, time
from pathlib import Path
from types import SimpleNamespace

def record(kind, **data):
    with open(os.environ['FAKE_LOG'], 'a', encoding='utf-8') as stream:
        stream.write(json.dumps(dict(kind=kind, **data), ensure_ascii=False) + '\n')

class WhisperModel:
    def __init__(self, name, **options):
        record('model', name=name, options=options)
        if os.environ.get('ASR_MODEL_FAIL'):
            raise RuntimeError('synthetic model failed')
    def transcribe(self, source, **options):
        record('transcribe', source=source, options=options)
        if os.environ.get('ASR_TRANSCRIBE_FAIL'):
            raise RuntimeError('synthetic transcription failed')
        if os.environ.get('ASR_BARRIER'):
            barrier = Path(os.environ['ASR_BARRIER'])
            (barrier / os.environ['ASR_LABEL']).write_text(source, encoding='utf-8')
            deadline = time.monotonic() + 8
            while len(list(barrier.iterdir())) < 2:
                if time.monotonic() > deadline:
                    raise RuntimeError('synthetic concurrent barrier timed out')
                time.sleep(0.01)
            time.sleep(float(os.environ.get('ASR_DELAY', '0')))
        # Read after the peer may have completed and cleaned its download.
        content = Path(source).read_text(encoding='utf-8')
        record('read', source=source, content=content)
        texts = [] if os.environ.get('ASR_EMPTY') else ['  第一段', '，第二段  ']
        return [SimpleNamespace(text=text) for text in texts], SimpleNamespace(language='zh')
'''

FAV_INIT_FAKE = r'''
import json, os

def record(kind, **data):
    with open(os.environ['FAKE_LOG'], 'a', encoding='utf-8') as stream:
        stream.write(json.dumps(dict(kind=kind, **data), ensure_ascii=False) + '\n')

record('api-import')

class Credential:
    def __init__(self, **kwargs):
        self.data = kwargs
        record('credential', data=kwargs)
'''

FAV_FOLDERS_FAKE = r'''
import os
from . import record

async def get_video_favorite_list(uid, credential=None):
    record('folders', uid=uid)
    mode = os.environ.get('FAV_MODE', '')
    if mode == 'folders-error':
        raise RuntimeError('synthetic folder lookup failed')
    if mode == 'folders-empty':
        return None
    if mode == 'folders-malformed':
        return ['unexpected-list']
    return {'list': [{'id': 7201, 'title': '离线合成收藏夹', 'media_count': 3},
                     {'id': 7202, 'title': '另一个收藏夹'}]}

class FavoriteList:
    def __init__(self, *args, **kwargs):
        raise AssertionError('video aid must not be used as a folder media_id')

class FavoriteListResource:
    def __init__(self, aid, type_, credential=None):
        record('resource', aid=aid, type=type_)
    async def add(self, fid):
        record('add', fid=fid)
        mode = os.environ.get('FAV_MODE', '')
        if mode == 'already-en':
            raise RuntimeError('Resource already collected')
        if mode == 'already-zh':
            raise RuntimeError('已经收藏过了')
        if mode == 'add-error':
            raise RuntimeError('synthetic add failure ' + 'x' * 500)
'''

FAV_VIDEO_FAKE = r'''
import os
from . import record

class Video:
    def __init__(self, bvid, credential=None):
        record('video', bvid=bvid)
    async def get_info(self):
        mode = os.environ.get('FAV_MODE', '')
        if mode == 'video-error':
            raise RuntimeError('synthetic video lookup failed')
        if mode == 'video-malformed':
            return {'unexpected': 'no-aid'}
        return {'aid': 2401}
'''


class SidecarFixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="deepmoyu-sidecar-contract-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.scripts = self.root / "scripts"
        self.scripts.mkdir()
        self.doubles = self.root / "doubles"
        self.doubles.mkdir()
        for name in ("asr", "favops"):
            shutil.copyfile(ROOT / "lib" / f"{name}.py", self.scripts / f"{name}.py")
        (self.doubles / "yt_dlp.py").write_text(textwrap.dedent(ASR_DOWNLOAD_FAKE), encoding="utf-8")
        (self.doubles / "faster_whisper.py").write_text(textwrap.dedent(ASR_MODEL_FAKE), encoding="utf-8")
        package = self.doubles / "bilibili_api"
        package.mkdir()
        for filename, content in (("__init__.py", FAV_INIT_FAKE),
                                  ("favorite_list.py", FAV_FOLDERS_FAKE),
                                  ("video.py", FAV_VIDEO_FAKE)):
            (package / filename).write_text(textwrap.dedent(content), encoding="utf-8")
        self.log = self.root / "fake-calls.jsonl"
        self.tmp = self.scripts / "tmp" / "asr"
        self.tmp.mkdir(parents=True)
        self.credential = self.root / "bili_credential.json"
        self.credential.write_text(json.dumps({
            "sessdata": "synthetic-not-a-session", "bili_jct": "synthetic-not-a-token",
            "buvid3": "synthetic-device", "dedeuserid": "1234567890",
        }), encoding="utf-8")

    def environment(self, **changes):
        # Child-only environment; never patch the test runner's process cache/temp settings.
        env = dict(os.environ, PYTHONPATH=str(self.doubles), PYTHONUTF8="1",
                   PYTHONDONTWRITEBYTECODE="1", FAKE_LOG=str(self.log))
        for key in list(env):
            if key.startswith("ASR_") or key == "FAV_MODE":
                del env[key]
        env.update(changes)
        return env

    def run_sidecar(self, name, *args, **env):
        return subprocess.run([sys.executable, "-B", str(self.scripts / f"{name}.py"), *map(str, args)],
                              cwd=self.root, env=self.environment(**env),
                              encoding="utf-8", capture_output=True, timeout=20)

    def records(self, path=None):
        path = path or self.log
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []

    def json_result(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual(len(lines), 1, result.stdout)
        payload = json.loads(lines[0])
        self.assertIsInstance(payload, dict)
        self.assertNotIn("Traceback", result.stderr)
        self.assertNotIn("synthetic-not-a-session", result.stdout)
        self.assertNotIn("synthetic-not-a-token", result.stdout)
        return payload


class AsrContracts(SidecarFixture):
    def test_import_has_no_temp_cache_or_stream_side_effects(self):
        shutil.rmtree(self.tmp.parent)
        probe = r'''
import importlib.util, json, os, sys, tempfile
from pathlib import Path
keys = ('HF_HOME', 'HF_ENDPOINT', 'HF_HUB_DISABLE_XET')
for key in keys:
    os.environ.pop(key, None)
previous = tempfile.tempdir
encoding = (sys.stdout.encoding, sys.stderr.encoding)
script = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('isolated_asr', script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert tempfile.tempdir == previous
assert (sys.stdout.encoding, sys.stderr.encoding) == encoding
assert not any(key in os.environ for key in keys)
assert not (script.parent / 'tmp').exists()
assert not (script.parent / '.hf-cache').exists()
print(json.dumps({'ok': True}))
'''
        result = subprocess.run([sys.executable, "-B", "-c", textwrap.dedent(probe), str(self.scripts / "asr.py")],
                                cwd=self.root, env=self.environment(), encoding="utf-8", capture_output=True, timeout=15)
        self.assertTrue(self.json_result(result)["ok"])
        self.assertEqual(self.records(), [])

    def test_local_input_inside_download_directory_is_never_cleaned(self):
        source = self.tmp / "clip.m4a"
        source.write_text("local input must survive", encoding="utf-8")
        sibling = self.tmp / "clip.json"
        sibling.write_text("unrelated local metadata", encoding="utf-8")
        result = self.run_sidecar("asr", source)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "第一段，第二段\n")
        self.assertEqual(source.read_text(encoding="utf-8"), "local input must survive")
        self.assertTrue(sibling.exists())
        self.assertFalse(any(item["kind"].startswith("download") for item in self.records()))
        self.assertEqual(self.records()[0], {"kind": "model", "name": "small",
                                           "options": {"device": "cpu", "compute_type": "int8"}})

    def test_local_model_failure_preserves_input_and_siblings(self):
        source = self.tmp / "clip.m4a"
        source.write_text("keep input", encoding="utf-8")
        sibling = self.tmp / "clip.part"
        sibling.write_text("keep unrelated partial", encoding="utf-8")
        result = self.run_sidecar("asr", source, ASR_MODEL_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertTrue(source.exists())
        self.assertTrue(sibling.exists())

    def test_existing_bv_named_local_file_is_not_treated_as_a_remote_target(self):
        source = self.root / f"{BVID}.m4a"
        source.write_text("existing local input", encoding="utf-8")
        result = self.run_sidecar("asr", source.name)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "第一段，第二段\n")
        self.assertEqual(source.read_text(encoding="utf-8"), "existing local input")
        self.assertFalse(any(item["kind"].startswith("download") for item in self.records()))

    def test_output_file_model_and_auto_language_contract(self):
        source = self.root / "本地输入.wav"
        source.write_text("local audio", encoding="utf-8")
        output = self.root / "转写结果.txt"
        result = self.run_sidecar("asr", source, "--model", "tiny", "--lang", "auto", "-o", output)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(output.read_text(encoding="utf-8"), "第一段，第二段")
        records = self.records()
        self.assertEqual(records[0]["name"], "tiny")
        self.assertEqual(records[1]["options"], {"language": None, "vad_filter": True})
        self.assertTrue(source.exists())

    def test_url_cleans_owned_files_only_and_preserves_directories(self):
        unrelated = self.tmp / f"{BVID}.m4a"
        unrelated.write_text("other run or user input", encoding="utf-8")
        other_run = self.tmp / f"{BVID}-other-run.m4a.part"
        other_run.write_text("other run partial", encoding="utf-8")
        url = f"https://www.bilibili.com/video/{BVID}?p=2"
        result = self.run_sidecar("asr", url, ASR_DIRECTORY_SIDECAR="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        records = self.records()
        download = next(item for item in records if item["kind"] == "download")
        self.assertEqual(download["url"], url)
        self.assertIs(download["download"], True)
        downloaded = Path(download["target"])
        self.assertRegex(downloaded.stem, r"-[a-f0-9]{32}$")
        self.assertFalse(downloaded.exists())
        self.assertFalse(Path(str(downloaded) + ".part").exists())
        self.assertTrue(Path(str(downloaded) + ".directory").is_dir())
        self.assertTrue(unrelated.exists())
        self.assertTrue(other_run.exists())
        options = next(item["options"] for item in records if item["kind"] == "download-options")
        self.assertEqual(options["paths"], {"home": str(self.tmp), "temp": str(self.tmp)})
        self.assertFalse(options["cachedir"])
        self.assertTrue(options["noplaylist"])
        self.assertTrue(options["noprogress"])

    def test_bvid_is_converted_to_canonical_video_url(self):
        result = self.run_sidecar("asr", BVID)
        self.assertEqual(result.returncode, 0, result.stderr)
        download = next(item for item in self.records() if item["kind"] == "download")
        self.assertEqual(download["url"], f"https://www.bilibili.com/video/{BVID}")
        self.assertEqual(list(self.tmp.iterdir()), [])

    def test_empty_transcription_outputs_no_progress_on_stdout(self):
        source = self.root / "silent.wav"
        source.write_text("synthetic silence", encoding="utf-8")
        result = self.run_sidecar("asr", source, ASR_EMPTY="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "\n")
        output = self.root / "empty.txt"
        result = self.run_sidecar("asr", source, "--out", output, ASR_EMPTY="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(output.read_bytes(), b"")

    def test_missing_local_input_reports_two_without_touching_files(self):
        sentinel = self.tmp / "missing.keep"
        sentinel.write_text("keep", encoding="utf-8")
        result = self.run_sidecar("asr", self.tmp / "missing.wav")
        self.assertEqual(result.returncode, 2)
        self.assertIn("找不到文件", result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertTrue(sentinel.exists())
        self.assertEqual(self.records(), [])

    def test_missing_download_cleans_its_partial_without_loading_model(self):
        result = self.run_sidecar("asr", BVID, ASR_DOWNLOAD_MISSING="1")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertFalse(any(item["kind"] == "model" for item in self.records()))
        self.assertEqual(list(self.tmp.iterdir()), [])

    def test_download_model_and_transcription_failures_clean_only_owned_files(self):
        sentinel = self.tmp / f"{BVID}.m4a"
        sentinel.write_text("keep unrelated", encoding="utf-8")
        for key in ("ASR_DOWNLOAD_FAIL", "ASR_MODEL_FAIL", "ASR_TRANSCRIBE_FAIL"):
            with self.subTest(failure=key):
                result = self.run_sidecar("asr", BVID, **{key: "1"})
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                self.assertEqual(list(self.tmp.iterdir()), [sentinel])

    def test_download_cleanup_does_not_follow_an_external_returned_path(self):
        outside = self.root / "external-user-input.m4a"
        outside.write_text("must survive", encoding="utf-8")
        result = self.run_sidecar("asr", BVID, ASR_DOWNLOAD_OUTSIDE=str(outside))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(outside.exists())
        self.assertEqual(outside.read_text(encoding="utf-8"), "must survive")
        self.assertEqual(list(self.tmp.iterdir()), [])

    def test_same_video_concurrent_runs_have_independent_downloads_and_cleanup(self):
        barrier = self.root / "barrier"
        barrier.mkdir()
        processes = []
        for label, delay in (("first", "0"), ("second", "0.3")):
            log = self.root / f"{label}.jsonl"
            env = self.environment(FAKE_LOG=str(log), ASR_BARRIER=str(barrier),
                                   ASR_LABEL=label, ASR_DELAY=delay)
            process = subprocess.Popen([sys.executable, "-B", str(self.scripts / "asr.py"), BVID],
                                       cwd=self.root, env=env, encoding="utf-8",
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            processes.append((process, log))
            self.addCleanup(lambda p=process: p.kill() if p.poll() is None else None)
        paths = []
        for process, log in processes:
            stdout, stderr = process.communicate(timeout=20)
            self.assertEqual(process.returncode, 0, stderr)
            self.assertEqual(stdout, "第一段，第二段\n")
            records = self.records(log)
            paths.append(next(item["target"] for item in records if item["kind"] == "download"))
            self.assertEqual(next(item["content"] for item in records if item["kind"] == "read"), "synthetic audio")
        self.assertNotEqual(paths[0], paths[1])
        self.assertEqual(list(self.tmp.iterdir()), [])


class FavoritesContracts(SidecarFixture):
    def test_folder_listing_maps_fields_and_missing_count(self):
        payload = self.json_result(self.run_sidecar("favops", "folders"))
        self.assertEqual(payload, {"ok": True, "folders": [
            {"id": 7201, "title": "离线合成收藏夹", "count": 3},
            {"id": 7202, "title": "另一个收藏夹", "count": 0},
        ]})
        self.assertEqual(next(item["uid"] for item in self.records() if item["kind"] == "folders"), 1234567890)

    def test_empty_folder_result_has_an_explicit_empty_array(self):
        self.assertEqual(self.json_result(self.run_sidecar("favops", "folders", FAV_MODE="folders-empty")),
                         {"ok": True, "folders": []})

    def test_add_uses_video_aid_resource_type_and_requested_folder(self):
        self.assertEqual(self.json_result(self.run_sidecar("favops", "add", BVID, "7201")), {"ok": True})
        records = self.records()
        self.assertEqual([item for item in records if item["kind"] == "video"], [{"kind": "video", "bvid": BVID}])
        self.assertEqual([item for item in records if item["kind"] == "resource"], [{"kind": "resource", "aid": 2401, "type": 2}])
        self.assertEqual([item for item in records if item["kind"] == "add"], [{"kind": "add", "fid": 7201}])

    def test_existing_favorite_is_success_with_explicit_already_flag(self):
        for mode in ("already-en", "already-zh"):
            with self.subTest(mode=mode):
                self.assertEqual(self.json_result(self.run_sidecar("favops", "add", BVID, "7201", FAV_MODE=mode)),
                                 {"ok": True, "already": True})

    def test_invalid_commands_and_parameters_never_import_platform_api(self):
        cases = [(), ("unknown",), ("folders", "unexpected"), ("add",),
                 ("add", BVID), ("add", BVID, "7201", "unexpected"),
                 ("add", "not-a-bvid", "7201"), ("add", "BV/path", "7201")]
        cases += [("add", BVID, fid) for fid in ("0", "-1", "1.5", "1e3", "NaN", "+1", "１２", "")]
        for args in cases:
            with self.subTest(args=args):
                payload = self.json_result(self.run_sidecar("favops", *args))
                self.assertFalse(payload["ok"])
                self.assertTrue(payload["error"])
        self.assertEqual(self.records(), [])

    def test_missing_credentials_is_a_single_json_error(self):
        self.credential.unlink()
        payload = self.json_result(self.run_sidecar("favops", "folders"))
        self.assertFalse(payload["ok"])
        self.assertIn("扫码登录", payload["error"])
        self.assertFalse(any(item["kind"] == "folders" for item in self.records()))

    def test_malformed_credential_json_and_fields_return_structured_errors(self):
        for content in ("{bad json", "null", "[]", "{}",
                        '{"sessdata":"synthetic-not-a-session","bili_jct":"synthetic-not-a-token","dedeuserid":"not-an-int"}'):
            with self.subTest(content=content):
                self.credential.write_text(content, encoding="utf-8")
                payload = self.json_result(self.run_sidecar("favops", "folders"))
                self.assertFalse(payload["ok"])
                self.assertTrue(payload["error"])
        self.assertFalse(any(item["kind"] == "folders" for item in self.records()))

    def test_cwd_credentials_take_priority_over_script_neighbor(self):
        fallback = self.scripts / "bili_credential.json"
        fallback.write_text(self.credential.read_text(encoding="utf-8").replace("1234567890", "1111111111"), encoding="utf-8")
        self.assertTrue(self.json_result(self.run_sidecar("favops", "folders"))["ok"])
        self.assertEqual(next(item["uid"] for item in self.records() if item["kind"] == "folders"), 1234567890)
        self.credential.unlink()
        self.log.unlink()
        self.assertTrue(self.json_result(self.run_sidecar("favops", "folders"))["ok"])
        self.assertEqual(next(item["uid"] for item in self.records() if item["kind"] == "folders"), 1111111111)

    def test_platform_exceptions_and_malformed_payloads_remain_json_errors(self):
        for mode in ("folders-error", "folders-malformed", "video-error", "video-malformed", "add-error"):
            with self.subTest(mode=mode):
                args = ("folders",) if mode.startswith("folders") else ("add", BVID, "7201")
                payload = self.json_result(self.run_sidecar("favops", *args, FAV_MODE=mode))
                self.assertFalse(payload["ok"])
                self.assertTrue(payload["error"])
                self.assertLessEqual(len(payload["error"]), 200 if mode == "add-error" else 300)


if __name__ == "__main__":
    unittest.main()
