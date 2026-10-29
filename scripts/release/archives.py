"""Build a source ZIP and independently verify npm/source archive contents."""
import argparse
import copy
import io
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import uuid
import zipfile


PRIVATE_NAMES = {'.npmrc', 'bili_credential.json', 'config.json', 'state.json', 'feiyu.json',
                 'token-ledger.json', 'activity.jsonl', 'pet-log.jsonl', 'soul.md', 'voice.md', 'seen.md'}
GENERATED = {'.git', 'node_modules', '__pycache__', '.pytest_cache', '.tmp', '.qa-output'}


def runtime_manifest(source):
    """Keep runtime metadata while omitting commands whose implementation is source-only."""
    package = copy.deepcopy(source)
    package.pop('devDependencies', None)
    if 'scripts' in package:
        package['scripts'] = {'check': package['scripts']['check']} if package['scripts'].get('check') else {}
    return package


def project_runtime_manifest(root, file):
    package = json.loads((root / 'package.json').read_text(encoding='utf-8'))
    data = (json.dumps(runtime_manifest(package), ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    temporary = file.with_name(file.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with tarfile.open(file, 'r:gz') as original, tarfile.open(temporary, 'w:gz') as output:
            for member in original.getmembers():
                if member.name == 'package/package.json':
                    member.size = len(data)
                    output.addfile(member, io.BytesIO(data))
                else:
                    output.addfile(member, original.extractfile(member) if member.isfile() else None)
        os.replace(temporary, file)
    finally:
        temporary.unlink(missing_ok=True)


def safe_path(value):
    parts = value.split('/')
    return bool(value) and '\\' not in value and not value.startswith('/') and ':' not in parts[0] \
        and all(part not in ('', '.', '..') for part in parts)


def validate_path(value):
    if not safe_path(value):
        raise ValueError(f'Unsafe archive path: {value!r}')
    path = PurePosixPath(value)
    if path.parts[0] in {'release', 'dist', 'coverage'} or set(path.parts) & GENERATED or any(part.startswith('.venv') for part in path.parts):
        raise ValueError(f'Generated directory in archive: {value}')
    if path.name in PRIVATE_NAMES or path.name == '.env' or path.name.startswith('.env.') and path.name != '.env.example':
        raise ValueError(f'Private runtime data in archive: {value}')
    if path.suffix.lower() in {'.pyc', '.pyo', '.tgz', '.zip', '.key', '.pem'} or '.sqlite' in path.name:
        raise ValueError(f'Generated or credential file in archive: {value}')


def build_source(root, destination, prefix):
    result = subprocess.run(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
                            cwd=root, check=True, stdout=subprocess.PIPE)
    names = sorted(set(result.stdout.decode('utf-8').split('\0')) - {''})
    files = []
    for name in names:
        validate_path(name)
        path = root / name
        if not path.exists():
            continue  # A deliberate working-tree deletion must not resurrect an old tracked file.
        if path.is_symlink() or not path.is_file():
            raise ValueError(f'Source package requires a regular file: {name}')
        files.append(name)
    if not files:
        raise ValueError('Source archive would be empty')
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in files:
            archive.write(root / name, prefix + '/' + name)
    with zipfile.ZipFile(destination) as archive:
        if archive.testzip() is not None:
            raise ValueError('Source ZIP CRC verification failed')
        if set(archive.namelist()) != {prefix + '/' + name for name in files}:
            raise ValueError('Source ZIP file list mismatch')
        for name in files:
            if archive.read(prefix + '/' + name) != (root / name).read_bytes():
                raise ValueError('Source ZIP bytes differ: ' + name)
    return {'files': len(files), 'bytes': destination.stat().st_size,
            'sha256': hashlib.sha256(destination.read_bytes()).hexdigest()}


def verify_npm(root, archive_path):
    files = []
    with tarfile.open(archive_path, 'r:gz') as archive:
        names = set()
        for member in archive.getmembers():
            if member.isdir():
                if member.name.rstrip('/') != 'package':
                    if not member.name.startswith('package/'):
                        raise ValueError('Unexpected npm directory: ' + member.name)
                    validate_path(member.name[len('package/'):].rstrip('/'))
                continue
            if not member.isfile() or not member.name.startswith('package/'):
                raise ValueError('Npm archive contains a link or unexpected entry: ' + member.name)
            name = member.name[len('package/'):]
            validate_path(name)
            if name in names:
                raise ValueError('Duplicate npm archive entry: ' + name)
            names.add(name)
            expected = root / name
            actual = archive.extractfile(member).read()
            if name == 'package.json':
                if json.loads(actual) != runtime_manifest(json.loads(expected.read_text(encoding='utf-8'))):
                    raise ValueError('Npm runtime manifest differs from its expected projection')
            elif not expected.is_file() or actual != expected.read_bytes():
                raise ValueError('Npm archive differs from source: ' + name)
            files.append({'path': name, 'size': member.size})
        package = json.loads(archive.extractfile('package/package.json').read())
    return {'name': package['name'], 'version': package['version'], 'files': files,
            'manifestProjection': 'Runtime keeps check only; development scripts and devDependencies remain in source ZIP.',
            'bytes': archive_path.stat().st_size, 'sha256': hashlib.sha256(archive_path.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--npm', type=Path, required=True)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    package = json.loads((args.root / 'package.json').read_text(encoding='utf-8'))
    project_runtime_manifest(args.root, args.npm)
    report = {'npm': verify_npm(args.root, args.npm),
              'source': build_source(args.root, args.source, package['name'])}
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'npmFiles': len(report['npm']['files']), 'sourceFiles': report['source']['files']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
