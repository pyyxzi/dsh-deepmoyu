import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const manifest = () => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

export function npm(args, options = {}) {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]
  const cli = candidates.find(path => path && path.endsWith('.js') && existsSync(path))
  if (!cli && process.platform === 'win32') throw new Error('Cannot locate npm-cli.js. Run this command through npm run.')
  const result = spawnSync(cli ? process.execPath : 'npm', cli ? [cli, ...args] : args,
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed (${result.status}):\n${result.stderr || result.stdout}`)
  return result.stdout
}

export function safeRelative(path) {
  return typeof path === 'string' && path.length > 0 && !path.includes('\\') && !path.startsWith('/')
    && !/^[A-Za-z]:/.test(path) && !path.split('/').some(part => part === '..' || part === '' || part === '.')
}
