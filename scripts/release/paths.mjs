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

/**
 * `npm pack --json` 正常给数组；但经 `npm run` 再起一层时，有些 npm 版本会把结果包成
 * `{ "dsh-deepmoyu": {...} }` 或单个 pack 对象 ⇒ 调用方 destructure 会炸
 * （"object is not iterable"）。这里统一成数组，让调用方永远拿得到第一个包。
 */
export function packReport(output) {
  const parsed = JSON.parse(output)
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.files) && typeof parsed.name === 'string') return [parsed]
    const values = Object.values(parsed).filter(value => value && typeof value === 'object' && Array.isArray(value.files))
    if (values.length) return values
  }
  throw new Error('Unexpected `npm pack --json` output shape: expected a pack report array or object')
}
