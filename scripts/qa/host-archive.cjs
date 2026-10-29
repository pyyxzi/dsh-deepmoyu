/** Read-only host discovery. An explicit invalid override is a test failure, never a skip. */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

function discoverHostArchive(options = {}) {
  const env = options.env || process.env, platform = options.platform || process.platform
  const file = value => { try { return fs.statSync(value).isFile() } catch { return false } }
  const isHostArchive = value => {
    let fd
    try {
      if (!file(value)) return false
      fd = fs.openSync(value, 'r')
      const prefix = Buffer.alloc(16); if (fs.readSync(fd, prefix, 0, 16, 0) !== 16) return false
      const length = prefix.readUInt32LE(12); if (!length || length > 32 * 1024 * 1024) return false
      const bytes = Buffer.alloc(length); if (fs.readSync(fd, bytes, 0, length, 16) !== length) return false
      return Boolean(JSON.parse(bytes.toString()).files?.node_modules?.files?.['@deepseek-ai']?.files?.dsh?.files?.['package.json'])
    } catch { return false } finally { if (fd !== undefined) fs.closeSync(fd) }
  }
  if (env.DSH_HOST_ASAR) {
    const explicit = path.resolve(env.DSH_HOST_ASAR)
    if (!isHostArchive(explicit)) throw new Error('DSH_HOST_ASAR was explicitly supplied but is not a readable DSH archive: ' + explicit)
    return explicit
  }
  const executable = options.execPath || process.execPath
  const candidates = [options.resourcesPath || process.resourcesPath].filter(Boolean).map(dir => path.join(dir, 'app.asar'))
  for (const base of [path.dirname(executable), path.dirname(path.dirname(executable))]) candidates.push(path.join(base, 'resources', 'app.asar'))
  if (platform === 'win32') {
    for (const base of [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
      for (const name of ['DSH Desktop', 'DeepSeek Harness', 'DSH']) candidates.push(path.join(base, name, 'resources', 'app.asar'))
    }
    // Custom installation directories are authoritative only when recorded by
    // the OS installer. This command reads uninstall metadata and runs no app.
    if (options.registry !== false) try {
      const command = "$ErrorActionPreference='SilentlyContinue'; @(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object { $_.DisplayName -match '^(DSH|DeepSeek Harness)' } | Select-Object InstallLocation,DisplayIcon,UninstallString) | ConvertTo-Json -Compress"
      const shell = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const json = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      const rows = json ? JSON.parse(json) : []
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        if (row.InstallLocation) candidates.push(path.join(row.InstallLocation, 'resources', 'app.asar'))
        for (const value of [row.DisplayIcon, row.UninstallString].filter(Boolean)) {
          const match = /^"([^"]+\.exe)"|^(.+?\.exe)(?:,\d+|\s|$)/i.exec(value)
          if (match) candidates.push(path.join(path.dirname(match[1] || match[2]), 'resources', 'app.asar'))
        }
      }
    } catch { /* Absence of installer metadata is reported as an explicit skip. */ }
  } else if (platform === 'darwin') {
    for (const base of ['/Applications', path.join(os.homedir(), 'Applications')]) for (const name of ['DSH Desktop.app', 'DeepSeek Harness.app']) candidates.push(path.join(base, name, 'Contents', 'Resources', 'app.asar'))
  } else {
    for (const base of ['/opt/dsh-desktop', '/opt/DSH Desktop', '/usr/lib/dsh-desktop']) candidates.push(path.join(base, 'resources', 'app.asar'))
  }
  return [...new Set(candidates)].find(isHostArchive) || null
}

function extractHostModules(archive, destination) {
  const fd = fs.openSync(archive, 'r')
  try {
    const prefix = Buffer.alloc(16); fs.readSync(fd, prefix, 0, 16, 0)
    const headerBytes = Buffer.alloc(prefix.readUInt32LE(12)); fs.readSync(fd, headerBytes, 0, headerBytes.length, 16)
    const header = JSON.parse(headerBytes.toString())
    const start = 8 + prefix.readUInt32LE(4), targetRoot = path.resolve(destination)
    let files = 0
    const walk = (entry, parts) => {
      for (const [name, item] of Object.entries(entry.files || {})) {
        if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) throw new Error('unsafe archive entry')
        const next = [...parts, name], target = path.resolve(targetRoot, ...next)
        if (!target.startsWith(targetRoot + path.sep)) throw new Error('archive target escaped temporary extraction')
        if (item.link) throw new Error('host archive links are unsupported by this offline gate: ' + next.join('/'))
        if (item.files) { fs.mkdirSync(target, { recursive: true }); walk(item, next); continue }
        fs.mkdirSync(path.dirname(target), { recursive: true })
        if (item.unpacked) fs.copyFileSync(path.join(archive + '.unpacked', 'node_modules', ...next), target)
        else {
          if (!Number.isSafeInteger(item.size) || item.size < 0 || !/^\d+$/.test(String(item.offset))) throw new Error('invalid archive range')
          const out = fs.openSync(target, 'wx', item.executable ? 0o755 : 0o600)
          try {
            const bytes = Buffer.alloc(Math.min(1024 * 1024, item.size))
            for (let offset = 0; offset < item.size;) {
              const n = fs.readSync(fd, bytes, 0, Math.min(bytes.length, item.size - offset), start + Number(item.offset) + offset)
              if (!n) throw new Error('truncated host archive')
              fs.writeSync(out, bytes, 0, n); offset += n
            }
          } finally { fs.closeSync(out) }
        }
        files++
      }
    }
    fs.mkdirSync(targetRoot, { recursive: true })
    if (!header.files?.node_modules?.files) throw new Error('host archive has no bundled node_modules')
    walk(header.files.node_modules, [])
    return { files, directory: targetRoot }
  } finally { fs.closeSync(fd) }
}

module.exports = { discoverHostArchive, extractHostModules }
