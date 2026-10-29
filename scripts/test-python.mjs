import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const probe = spawnSync(python, ['-c', 'import sys, importlib.metadata as m; assert (3, 11) <= sys.version_info < (3, 14), "Python 3.11-3.13 is required"; assert int(m.version("Pillow").split(".")[0]) >= 13, "Pillow 13+ is required; install the locked requirements"'],
  { cwd: root, stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1' } })
if (probe.error) throw new Error('Python is unavailable; set PYTHON to the prepared Python 3.11+ environment', { cause: probe.error })
if (probe.status !== 0) process.exit(probe.status ?? 1)
const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py', '-v'],
  { cwd: root, stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1' } })
if (result.error) throw new Error('Python test runner failed; set PYTHON to a Python 3.11+ executable', { cause: result.error })
process.exit(result.status ?? 1)
