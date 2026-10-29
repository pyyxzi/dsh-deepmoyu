/** Cheap, read-only environment metadata checks. Never spawn Python during status polling. */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const MAIN_PYTHON_RANGE = '>=3.11,<3.14'
export const MAIN_ENV_PACKAGES = Object.freeze(['bilibili_api', 'mcp', 'qrcode', 'PIL', 'edge_tts', 'imageio_ffmpeg'])
export const PYTHON_COMPATIBILITY_CHECK = 'import sys;sys.exit(0 if (3,11)<=sys.version_info[:2]<(3,14) else 2)'
export const MAIN_RUNTIME_CHECK = 'import sys,PIL,bilibili_api,mcp,qrcode,edge_tts,imageio_ffmpeg;sys.exit(0 if (3,11)<=sys.version_info[:2]<(3,14) and int(PIL.__version__.split(".")[0])>=13 else 2)'
export const ASR_ENV_PACKAGES = Object.freeze(['faster_whisper', 'yt_dlp', 'ctranslate2', 'av'])
export const ASR_RUNTIME_CHECK = 'import faster_whisper,yt_dlp,ctranslate2,av;print("DeepMoYu ASR runtime imports OK")'

const read = file => { try { return readFileSync(file, 'utf8') } catch { return '' } }
const list = folder => { try { return readdirSync(folder) } catch { return [] } }
export const environmentPython = (root, platform = process.platform) => join(root, platform === 'win32' ? 'Scripts' : 'bin', platform === 'win32' ? 'python.exe' : 'python')

export function inspectMainEnvironment(root, { platform = process.platform, ignoreRuntimeFailure = false } = {}) {
  const python = environmentPython(root, platform), exists = existsSync(python)
  const config = read(join(root, 'pyvenv.cfg'))
  const pythonVersion = /^(?:version|version_info)\s*=\s*(\d+\.\d+(?:\.\d+)?)/mi.exec(config)?.[1] || ''
  const version = pythonVersion.split('.').map(Number)
  const pythonCompatible = exists && version[0] === 3 && version[1] >= 11 && version[1] < 14
  const roots = [join(root, 'Lib', 'site-packages'), ...list(join(root, 'lib')).filter(name => /^python\d+\.\d+$/.test(name)).map(name => join(root, 'lib', name, 'site-packages'))]
  const site = roots.find(folder => existsSync(folder)) || roots[0]
  const names = list(site)
  const missing = MAIN_ENV_PACKAGES.filter(name => !names.includes(name) && !names.includes(name + '.py'))
  let pillowVersion = /__version__\s*=\s*["'](\d+\.\d+(?:\.\d+)?)["']/.exec(read(join(site, 'PIL', '_version.py')))?.[1] || ''
  if (!pillowVersion) {
    const candidates = names.filter(name => /^pillow-.+\.dist-info$/i.test(name))
      .map(name => /^Version:\s*(\d+\.\d+(?:\.\d+)?)\s*$/mi.exec(read(join(site, name, 'METADATA')))?.[1]).filter(Boolean)
    if (new Set(candidates).size === 1) pillowVersion = candidates[0]
  }
  const pillowCompatible = /^\d+\.\d+(?:\.\d+)?$/.test(pillowVersion) && Number(pillowVersion.split('.')[0]) >= 13 && !missing.includes('PIL')
  const reasons = []
  if (!exists) reasons.push('尚未创建插件 Python 环境')
  else if (!pythonCompatible) reasons.push(`需要 Python 3.11–3.13（当前 ${pythonVersion || '版本无法确认'}）`)
  if (!pillowCompatible) reasons.push(`需要 Pillow 13.0+（当前 ${pillowVersion || '未安装或版本无法确认'}）`)
  if (missing.length) reasons.push('缺少依赖：' + missing.join(' / '))
  let runtimeFailed = false
  if (!ignoreRuntimeFailure && existsSync(join(root, 'deepmoyu-health.json'))) {
    try { runtimeFailed = JSON.parse(read(join(root, 'deepmoyu-health.json')))?.ok !== true } catch { runtimeFailed = true }
    if (runtimeFailed) reasons.push('上次实际运行校验未通过，请重新安装主依赖以复核')
  }
  return { ready: exists && pythonCompatible && pillowCompatible && missing.length === 0 && !runtimeFailed, exists, python,
    pythonVersion, pythonCompatible, pillowVersion, pillowCompatible, missing, reasons,
    runtimeFailed, upgradeRequired: exists && (!pythonCompatible || !pillowCompatible), upgradeHint: reasons.join('；') }
}

/** Optional ASR remains independent from main Python/Pillow constraints and supports complete legacy envs. */
export function inspectAsrEnvironment(root, { platform = process.platform, installState = null } = {}) {
  const python = environmentPython(root, platform), exists = existsSync(python)
  const roots = [join(root, 'Lib', 'site-packages'), ...list(join(root, 'lib')).filter(name => /^python\d+\.\d+$/.test(name)).map(name => join(root, 'lib', name, 'site-packages'))]
  const site = roots.find(folder => existsSync(folder)) || roots[0], names = list(site)
  const missing = ASR_ENV_PACKAGES.filter(name => !names.includes(name) && !names.includes(name + '.py'))
  const blocked = Boolean(installState && (installState.ok === false || installState.running || ['running', 'failed', 'interrupted'].includes(installState.state)))
  const reasons = []
  if (!exists) reasons.push('尚未创建转写 Python 环境')
  if (missing.length) reasons.push('缺少转写运行依赖：' + missing.join(' / '))
  if (blocked) reasons.push(installState.running ? '转写依赖仍在安装或校验' : String(installState.error || '上次转写安装或校验未通过，请重试'))
  return { ready: exists && missing.length === 0 && !blocked, python, exists, missing, reasons,
    install: installState || { state: 'unknown', ok: null, running: false }, installFailed: blocked && !installState?.running }
}
