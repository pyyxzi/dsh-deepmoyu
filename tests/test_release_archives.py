"""Exercise archive input validation independently of a release build."""
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('deepmoyu_release_archives', ROOT / 'scripts/release/archives.py')
ARCHIVES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ARCHIVES)


class ReleaseArchiveTests(unittest.TestCase):
    def test_runtime_manifest_removes_unshipped_commands_without_mutating_source(self):
        source = {'name': 'fixture', 'version': '1.0.0', 'devDependencies': {'yaml': '2.9.1'},
                  'dependencies': {'runtime': '1.0.0'}, 'scripts': {'check': 'node selfcheck.mjs', 'test': 'node missing.mjs'}}
        projected = ARCHIVES.runtime_manifest(source)
        self.assertEqual(projected['scripts'], {'check': 'node selfcheck.mjs'})
        self.assertNotIn('devDependencies', projected)
        self.assertIn('test', source['scripts'])
        self.assertIn('devDependencies', source)
        self.assertEqual(projected['dependencies'], source['dependencies'])

    def test_rejects_path_escape_and_private_files(self):
        for name in ('../x', '/x', 'D:/x', 'a\\b', 'a//b', './x', 'config.json',
                     'nested/bili_credential.json', '.env', '.env.production', 'node_modules/p/index.js',
                     '.git/config', 'lib/__pycache__/pv.pyc', 'runtime.sqlite3-wal', 'release/old.tgz'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                ARCHIVES.validate_path(name)

    def test_accepts_source_and_runtime_files(self):
        for name in ('index.js', 'lib/state.mjs', 'prompts/duty.md', 'assets/角色.png',
                     'tests/release-contract.test.mjs', '.github/workflows/ci.yml', 'scripts/release/build.mjs'):
            with self.subTest(name=name):
                ARCHIVES.validate_path(name)

    def test_npm_verifier_checks_actual_bytes_and_rejects_links_duplicates_private_entries(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = json.dumps({'name': 'fixture', 'version': '1.0.0'}).encode()
            (root / 'package.json').write_bytes(package)
            (root / 'index.js').write_bytes(b'export const ok = true\n')

            def archive(entries):
                file = root / 'package.tgz'
                with tarfile.open(file, 'w:gz') as output:
                    for name, value in [('package/package.json', package), *entries]:
                        member = tarfile.TarInfo(name)
                        if value is None:
                            member.type = tarfile.SYMTYPE
                            member.linkname = '../outside'
                            output.addfile(member)
                        else:
                            member.size = len(value)
                            output.addfile(member, io.BytesIO(value))
                return file

            result = ARCHIVES.verify_npm(root, archive([('package/index.js', b'export const ok = true\n')]))
            self.assertEqual(result['version'], '1.0.0')
            self.assertEqual(len(result['files']), 2)
            for entries in [
                [('package/index.js', b'changed bytes')],
                [('package/linked.js', None)],
                [('package/index.js', b'export const ok = true\n')] * 2,
                [('package/config.json', b'{}')],
                [('package/../outside', b'bad')],
            ]:
                with self.subTest(entries=entries), self.assertRaises(ValueError):
                    ARCHIVES.verify_npm(root, archive(entries))

    def test_source_zip_contains_uncommitted_working_files_but_excludes_ignored_runtime_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'repo'
            root.mkdir()
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            (root / '.gitignore').write_text('config.json\n', encoding='utf-8')
            (root / 'index.js').write_bytes(b'new uncommitted implementation')
            (root / 'config.json').write_bytes(b'private runtime data')
            output = Path(temporary) / 'source.zip'
            result = ARCHIVES.build_source(root, output, 'fixture')
            self.assertEqual(result['files'], 2)
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(archive.read('fixture/index.js'), b'new uncommitted implementation')
                self.assertIsNone(archive.testzip())
                self.assertNotIn('fixture/config.json', archive.namelist())
            subprocess.run(['git', 'add', '-f', 'config.json'], cwd=root, check=True)
            with self.assertRaises(ValueError):
                ARCHIVES.build_source(root, output, 'fixture')


if __name__ == '__main__':
    unittest.main()
