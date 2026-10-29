/** Minimal isolated Chrome CDP driver for frontend regression fixtures. No application server. */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { qaOutput } = require('./paths.cjs')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function executable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile() } catch { return false }
}
function resolveBrowser(env = process.env, platform = process.platform) {
  const names = platform === 'win32' ? ['chrome.exe', 'chromium.exe', 'msedge.exe'] : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
  const searchPath = (name) => String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)
    .map((directory) => path.join(directory, name)).find(executable)
  if (env.CHROME_PATH) {
    const configured = path.resolve(env.CHROME_PATH)
    const found = executable(configured) ? configured : searchPath(env.CHROME_PATH)
    if (!found) throw new Error('CHROME_PATH does not identify an executable Chrome/Chromium browser')
    return found
  }
  const common = platform === 'win32' ? [
    ...[env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)
      .flatMap((directory) => [path.join(directory, 'Google/Chrome/Application/chrome.exe'), path.join(directory, 'Microsoft/Edge/Application/msedge.exe')]),
  ] : platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome']
  const found = common.find(executable) || names.map(searchPath).find(Boolean)
  if (!found) throw new Error('Chrome/Chromium not found. Set CHROME_PATH to its executable; UI QA never installs a browser automatically.')
  return found
}
class CDP {
  constructor(socket) {
    this.socket = socket; this.sequence = 0; this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id); clearTimeout(pending.timer)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    })
  }
  send(method, params = {}) {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 30000)
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + JSON.stringify(result.exceptionDetails.exception))
    return result.result?.value
  }
  dispose() {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('CDP closed')) }
    this.pending.clear(); this.socket.close()
  }
}
async function openChrome({ output = qaOutput('browser'), width = 1280, height = 900 } = {}) {
  const command = resolveBrowser()
  fs.mkdirSync(output, { recursive: true })
  const profile = fs.mkdtempSync(path.join(path.resolve(output), 'chrome-profile-'))
  const args = ['--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files', '--remote-debugging-port=0', '--user-data-dir=' + profile]
  if (process.env.QA_CHROME_NO_SANDBOX === '1') args.push('--no-sandbox')
  args.push('about:blank')
  const chrome = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  let driver, spawnError, exited = false, stderr = '', closing
  const exit = new Promise((resolve) => chrome.once('exit', () => { exited = true; resolve() }))
  chrome.once('error', (error) => { spawnError = error; exited = true })
  chrome.stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-1500) })
  const close = () => closing ||= (async () => {
    if (driver && !exited) await Promise.race([driver.send('Browser.close').catch(() => {}), sleep(2000)])
    driver?.dispose()
    if (!exited) chrome.kill()
    await Promise.race([exit, sleep(2000)])
    if (exited && path.dirname(path.resolve(profile)) === path.resolve(output) && path.basename(profile).startsWith('chrome-profile-')) {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
    }
  })()
  try {
    const portFile = path.join(profile, 'DevToolsActivePort')
    for (let attempt = 0; attempt < 200 && !fs.existsSync(portFile); attempt++) {
      if (spawnError) throw spawnError
      if (exited) throw new Error('Chrome exited before opening its debugging port: ' + stderr)
      await sleep(40)
    }
    assert(fs.existsSync(portFile), 'Chrome debugging port unavailable: ' + stderr)
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0]
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
    const socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    driver = new CDP(socket)
    await driver.send('Page.enable')
    await driver.send('Page.bringToFront')
    await driver.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await driver.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    return {
      driver, profile,
      async size(w, h) { await driver.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }) },
      async navigate(file) { await driver.send('Page.navigate', { url: pathToFileURL(file).href }) },
      async until(expression, label, attempts = 125) { for (let i = 0; i < attempts; i++) { if (await driver.evaluate(`Boolean(${expression})`)) return; await sleep(40) } throw new Error('Browser timed out: ' + label) },
      async screenshot(file) { const result = await driver.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(file, Buffer.from(result.data, 'base64')) },
      close,
    }
  } catch (error) { await close(); throw error }
}
module.exports = { CDP, openChrome, sleep, resolveBrowser }
