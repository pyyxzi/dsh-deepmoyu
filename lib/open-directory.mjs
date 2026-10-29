import { spawn as nodeSpawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { resolve, win32 } from 'node:path'

const failure = (code, error, extra = {}) => ({ ok: false, code, error, ...extra })

function windowsOpenArguments(directory) {
  // Only base64 data is interpolated into this fixed script. Quotes, Unicode and
  // PowerShell metacharacters in a directory can never become executable code.
  const encodedDirectory = Buffer.from(directory, 'utf8').toString('base64')
  const script = `$ErrorActionPreference = 'Stop'
$encodedDirectory = '${encodedDirectory}'
try {
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($encodedDirectory))
  $startInfo.UseShellExecute = $true
  $null = [System.Diagnostics.Process]::Start($startInfo)
  exit 0
} catch {
  exit 1
}`
  // Windows PowerShell expects UTF-16LE for -EncodedCommand. The short-lived
  // helper acknowledges ShellExecute; it never waits for or kills the GUI app.
  return ['-NoProfile', '-NonInteractive', '-NoLogo', '-WindowStyle', 'Hidden',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

/** Ask the platform directory launcher to open an existing directory.
 * Exit 0 acknowledges the launcher/helper request, not a GUI window appearing.
 * The HTTP caller owns its out/home/mirror/pv allowlist and never accepts a raw path.
 */
export async function openDirectory(directory, {
  platform = process.platform, spawnImpl = nodeSpawn, timeoutMs = 5000,
  env = process.env, statImpl = statSync,
} = {}) {
  if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) {
    return failure('OPEN_DIRECTORY_INVALID', '目录路径无效')
  }
  const commands = {
    win32: () => win32.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    darwin: () => 'open',
    linux: () => 'xdg-open',
  }
  if (!Object.hasOwn(commands, platform)) return failure('OPEN_PLATFORM_UNSUPPORTED', '当前平台不支持打开目录')
  const opened = resolve(directory)
  try {
    if (!statImpl(opened).isDirectory()) return failure('OPEN_NOT_DIRECTORY', '目标不是目录')
  } catch (error) {
    return failure('OPEN_DIRECTORY_UNAVAILABLE', '目录不存在或不可读取', { causeCode: String(error?.code || '') })
  }
  const via = commands[platform]()
  const args = platform === 'win32' ? windowsOpenArguments(opened)
    : platform === 'darwin' ? ['--', opened] : [opened]
  const requestedTimeout = Number(timeoutMs)
  const deadline = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? Math.max(1, Math.min(30000, Math.floor(requestedTimeout))) : 5000
  return new Promise((complete) => {
    let child, timer, done = false, timedOut = false
    const remove = (event, listener) => {
      try { child?.removeListener?.(event, listener) } catch { /* cleanup must not replace the launch result */ }
    }
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      remove('error', onError); remove('exit', onExit); remove('close', onExit)
      try { child?.unref?.() } catch { /* the process may already be gone */ }
      complete(result)
    }
    const timeoutResult = () => failure('OPEN_TIMEOUT', '目录打开程序响应超时', { via, timeoutMs: deadline })
    const onError = (error) => finish(timedOut ? timeoutResult()
      : failure('OPEN_SPAWN_FAILED', '目录打开程序启动失败：' + String(error?.message || error), { via, causeCode: String(error?.code || '') }))
    const onExit = (code, signal) => {
      if (timedOut) return finish(timeoutResult())
      if (code !== 0 || signal) return finish(failure('OPEN_EXIT_FAILED', '目录打开程序未成功退出', { via, exitCode: code ?? null, signal: signal || null }))
      finish({ ok: true, opened, via, acknowledged: true })
    }
    try {
      child = spawnImpl(via, args, {
        shell: false, stdio: 'ignore', detached: false,
        // Only the short-lived helper is our child; the ShellExecute GUI is not.
        windowsHide: true, windowsVerbatimArguments: false,
      })
      if (!child || typeof child.once !== 'function') throw new Error('invalid child process')
      child.once('error', onError); child.once('exit', onExit); child.once('close', onExit)
      timer = setTimeout(() => {
        if (done) return
        timedOut = true
        try { child.kill?.('SIGKILL') } catch { /* only this launcher/helper is targeted, never the opened GUI */ }
        finish(timeoutResult())
      }, deadline)
    } catch (error) { onError(error) }
  })
}
