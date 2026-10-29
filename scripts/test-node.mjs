import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const files = readdirSync(resolve(root, 'tests')).filter(name => name.endsWith('.test.mjs')).sort()
if (!files.length) throw new Error('No Node regression tests found')
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files.map(name => 'tests/' + name)], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
