/** Local PV coordinator: authored productions, isolated jobs and verified publication. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { normalizeProduction } from './pv-production.mjs'

export const PV_PREFIX = '大肥鱼日报'
const PV_RE = /^大肥鱼日报_(\d{4}-\d{2}-\d{2})\.mp4$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const PRODUCTION_ID_RE = /^\d{8}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const COVER_NAMES = { '16x9': '封面_16x9.png', '4x3': '封面_4x3.png' }
const COVER_SIZES = { '16x9': [1920, 1080], '4x3': [1440, 1080] }
const ACTIVE_STAGES = new Set(['plan', 'cover', 'render', 'verify', 'publish'])
export const PV_RUNTIME_CHECK = 'import sys,PIL,edge_tts,imageio_ffmpeg;sys.exit(0 if (3,11)<=sys.version_info[:2]<(3,14) and int(PIL.__version__.split(".")[0])>=13 else 2)'
export const PV_COVER_RUNTIME_CHECK = 'import sys,PIL;sys.exit(0 if (3,11)<=sys.version_info[:2]<(3,14) and int(PIL.__version__.split(".")[0])>=13 else 2)'

export const pvDateOk = (s) => {
  const value = String(s || '')
  if (!DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export const PV_FAILURES_FILE = 'pv-failures.json'
export const FAILURE_KEEP = 20
export function readPvFailures(stateDir, keep = FAILURE_KEEP) {
  try {
    const list = JSON.parse(readFileSync(join(stateDir, PV_FAILURES_FILE), 'utf8'))
    return Array.isArray(list) ? list.slice(-keep).reverse() : []
  } catch { return [] }
}
function appendPvFailure(stateDir, entry) {
  try {
    const file = join(stateDir, PV_FAILURES_FILE)
    let list = []
    try { const parsed = JSON.parse(readFileSync(file, 'utf8')); if (Array.isArray(parsed)) list = parsed } catch { /* first failure */ }
    list.push(entry)
    mkdirSync(stateDir, { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(list.slice(-FAILURE_KEEP), null, 2), 'utf8')
    renameSync(tmp, file)
  } catch { /* Failure history cannot break the host. */ }
}

/** Yesterday in the local timezone. */
export function pvYesterday(now = new Date()) {
  const d = new Date(now.getTime() - 86400_000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
export function pvDirs(stateDir, o = {}) {
  const explicit = String(o.pvDir || '').trim()
  if (explicit) return { root: explicit, out: explicit, legacy: explicit, legacyDirs: [explicit], work: join(explicit, '_work') }
  let root = ''
  try { root = String((o.resolveMirror ? o.resolveMirror(stateDir, o.mirrorDir || '') : '') || '').trim() } catch { /* no mirror */ }
  if (root) {
    const base = join(root, 'bili-work', 'pv')
    return { root, out: join(base, '日报'), legacy: root, legacyDirs: [root, base], work: base }
  }
  const base = join(stateDir, 'out')
  return { root: '', out: join(base, '日报'), legacy: base, legacyDirs: [base], work: join(stateDir, 'pv') }
}
const dateDir = (outDir, date) => join(outDir, date)
const finalOf = (outDir, date) => join(dateDir(outDir, date), `${PV_PREFIX}_${date}.mp4`)
const legacyFinalOf = (outDir, date) => join(outDir, `${PV_PREFIX}_${date}.mp4`)
const asDirs = (value) => [...new Set((Array.isArray(value) ? value : [value]).map((item) => String(item || '').trim()).filter(Boolean))]
const usableVideo = (file) => {
  try { const s = statSync(file); return s.isFile() && s.size > 1024 } catch { return false }
}

/** Keep the historical date-indexed list compatible; studio jobs have productions(). */
export function listPv(outDir, legacyDirs = outDir) {
  const byDate = new Map()
  const add = (date, file, canonical) => {
    if (!pvDateOk(date) || !usableVideo(file)) return
    const old = byDate.get(date)
    if (!old || (!old.canonical && canonical)) {
      const s = statSync(file)
      byDate.set(date, { date, file, size: s.size, at: s.mtime.toISOString(), canonical })
    }
  }
  try {
    for (const n of readdirSync(outDir)) {
      const m = PV_RE.exec(n)
      if (m) add(m[1], join(outDir, n), false)
      if (DATE_RE.test(n) && pvDateOk(n)) add(n, finalOf(outDir, n), true)
    }
  } catch { /* directory not created */ }
  for (const legacyDir of asDirs(legacyDirs)) {
    if (legacyDir === outDir) continue
    try {
      for (const n of readdirSync(legacyDir)) {
        const m = PV_RE.exec(n)
        if (m) add(m[1], join(legacyDir, n), false)
      }
    } catch { /* optional legacy directory */ }
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date))
}
export function pvFileOf(outDir, date, legacyDirs = outDir) {
  if (!pvDateOk(date)) return ''
  const canonical = finalOf(outDir, date)
  if (usableVideo(canonical)) return canonical
  for (const legacyDir of asDirs(legacyDirs)) {
    const file = legacyFinalOf(legacyDir, date)
    if (usableVideo(file)) return file
  }
  return canonical
}
const validCover = (file, ratio) => {
  try {
    const [width, height] = COVER_SIZES[ratio]
    if (!statSync(file).isFile()) return false
    const data = readFileSync(file)
    return data.length > 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && data.readUInt32BE(16) === width && data.readUInt32BE(20) === height
  } catch { return false }
}
const tailOf = (file, n = 2600) => {
  try { const s = readFileSync(file, 'utf8'); return s.length > n ? s.slice(-n) : s } catch { return '' }
}
const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}
const verificationOk = (file) => readJson(file)?.ok === true
const atomicJson = (file, data) => {
  const tmp = `${file}.tmp-${randomUUID()}`
  try { writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8'); renameSync(tmp, file) }
  finally { rmSync(tmp, { force: true }) }
}
const within = (root, file) => {
  const rel = relative(root, file)
  return rel !== '..' && !rel.startsWith(`..\\`) && !rel.startsWith('../') && !isAbsolute(rel)
}
/** Refuse symlinks/junction escapes for the HTTP-serving production index. */
const confinedProduction = (outDir, id) => {
  if (typeof id !== 'string' || !PRODUCTION_ID_RE.test(id)) return ''
  try {
    const studio = resolve(outDir, 'studio')
    if (lstatSync(studio).isSymbolicLink()) return ''
    const path = resolve(studio, id)
    if (!within(studio, path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) return ''
    const realStudio = realpathSync(studio)
    if (!within(realStudio, realpathSync(path))) return ''
    for (const name of ['production.json', 'video.mp4', 'verification.json']) {
      const file = join(path, name)
      if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile() || !within(realStudio, realpathSync(file))) return ''
    }
    return path
  } catch { return '' }
}
const productionRow = (outDir, id) => {
  const path = confinedProduction(outDir, id)
  if (!path) return null
  const metadata = readJson(join(path, 'production.json'))
  const file = join(path, 'video.mp4')
  if (!metadata || metadata.id !== id || metadata.status !== 'done' || !verificationOk(join(path, 'verification.json')) || !usableVideo(file)) return null
  return { id, mode: String(metadata.mode || ''), title: String(metadata.title || ''), date: String(metadata.date || ''),
    status: 'done', stage: 'done', path, metadata: join(path, 'production.json'), file, size: statSync(file).size,
    at: String(metadata.completedAt || metadata.startedAt || ''), plan: join(path, 'plan.json'), timeline: join(path, 'timeline.json'),
    log: join(path, 'build.log'), verification: join(path, 'verification.json'), targetDurationSec: metadata.targetDurationSec,
    maxDurationSec: metadata.maxDurationSec, covers: Object.fromEntries(Object.entries(COVER_NAMES).map(([ratio, name]) => [ratio, join(path, name)])) }
}

/**
 * No model calls occur here. render() consumes a complete model-authored plan.
 * @param {{stateDir:string,pluginDir:string,python:()=>string,dirs:()=>object,env?:object,log?:(s:string)=>void,timeoutMs?:number,gsv?:()=>object}} o
 */
export function createPv(o) {
  const { stateDir, pluginDir, python, dirs, env = null } = o
  const say = (s) => { try { o.log?.(s) } catch { /* host logger */ } }
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 20 * 60_000
  const gsvOf = () => { try { return o.gsv?.() || null } catch { return null } }
  let job = null
  const settledListeners = new Set()
  const onSettled = (listener) => { settledListeners.add(listener); return () => settledListeners.delete(listener) }
  let depsCache = { at: 0, ok: null }
  const scripts = () => {
    const pick = (name) => existsSync(join(pluginDir, 'lib', name)) ? join(pluginDir, 'lib', name) : join(stateDir, name)
    return { plan: pick('pv_plan.py'), render: pick('pv.py'), cover: pick('pv_cover.py'), verify: pick('pv_verify.py') }
  }
  const append = (file, s) => { try { appendFileSync(file, String(s), 'utf8') } catch { /* disk/log failure */ } }
  const busy = () => Boolean(job && (job.active || job.proc || job.killProc || ACTIVE_STAGES.has(job.stage)))
  const productions = () => {
    const d = dirs()
    try { return readdirSync(join(d.out, 'studio')).map((id) => productionRow(d.out, id)).filter(Boolean).sort((a, b) => b.at.localeCompare(a.at)) }
    catch { return [] }
  }
  const productionOf = (j) => j?.production ? { ...j.production, status: j.stage, stage: j.stage,
    error: j.error || '', ...(j.completedAt ? { completedAt: j.completedAt } : {}) } : null
  const persist = (j) => {
    if (!j.metadata) return
    atomicJson(j.metadata, j.production ? productionOf(j) : { date: j.date, status: j.stage, stage: j.stage,
      startedAt: j.startedAt, completedAt: j.completedAt || '', repairOnly: j.repairOnly,
      verificationSkipped: j.verificationSkipped || false, error: j.error || '', plan: j.plan, timeline: j.timeline, verification: j.verification, file: j.file, log: j.log })
  }
  const recordFailure = (j, failedStage) => {
    if (j.failureRecorded) return
    j.failureRecorded = true
    appendPvFailure(stateDir, { at: new Date().toISOString(), date: j.date, id: j.id || '', stage: failedStage,
      repairOnly: Boolean(j.repairOnly), error: j.error, log: j.log })
  }
  const terminate = (j) => {
    const child = j.proc
    if (!child || j.killProc) return
    if (process.platform === 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) {
      let killer
      try { killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore', env: env || process.env }) }
      catch { try { child.kill('SIGKILL') } catch { /* already exited */ }; return }
      j.killProc = killer
      j.killPromise = new Promise((resolveKill) => {
        let done = false
        const finish = (code) => {
          if (done) return
          done = true
          if (j.killProc === killer) j.killProc = null
          if (code !== 0) { try { child.kill('SIGKILL') } catch { /* exited */ } }
          resolveKill()
        }
        killer.once('close', finish)
        killer.once('error', () => finish(1))
      })
    } else { try { child.kill('SIGKILL') } catch { /* exited */ } }
  }
  const cancel = (j, timedOut = false) => {
    if (j.killed) return
    const priorStage = j.stage
    j.killed = true // Set before terminating any child or notifying observers.
    j.stage = timedOut ? 'failed' : 'stopped'
    j.error = timedOut ? `制作任务总时限已到（${timeoutMs}ms）` : ''
    append(j.log, timedOut ? `\n--- ${j.error}，终止进程树 ---\n` : '\n--- 手动停下；等待子进程退出 ---\n')
    try { persist(j) } catch { /* cancellation must remain immediate */ }
    if (timedOut) recordFailure(j, priorStage)
    terminate(j)
  }
  const alive = (j) => {
    if (j.killed) throw new Error('PV_JOB_CANCELLED')
    if (Date.now() >= j.deadline) { cancel(j, true); throw new Error('PV_JOB_CANCELLED') }
  }
  const run = (cmd, args, j) => new Promise((resolveRun) => {
    if (j.killed) return resolveRun(null)
    try { alive(j) } catch { return resolveRun(null) }
    append(j.log, `\n$ ${cmd} ${args.join(' ')}\n`)
    let child
    try { child = spawn(cmd, args, { cwd: stateDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: env || process.env }) }
    catch (e) { append(j.log, `起不来：${e?.message ?? e}\n`); return resolveRun(1) }
    j.proc = child
    child.stdout?.on('data', (b) => append(j.log, b.toString()))
    child.stderr?.on('data', (b) => append(j.log, b.toString()))
    // close, not exit: stdout/stderr and grandchildren must have finished first.
    child.once('error', (e) => append(j.log, `起不来：${e?.message ?? e}\n`))
    child.once('close', (code) => {
      if (j.proc === child) j.proc = null
      append(j.log, `\n--- exit ${code} ---\n`)
      resolveRun(code ?? 1)
    })
  })
  const phase = (j, stage) => { alive(j); j.stage = stage; persist(j) }
  const requireExit = (code, message) => { if (code !== 0) throw new Error(`${message}（exit ${code}）`) }
  const status = () => {
    const d = dirs()
    return { ok: true, running: busy(), stopping: Boolean(job?.killed && (job?.proc || job?.killProc || job?.active)),
      stage: job?.stage || 'idle', date: job?.date || '', id: job?.id || '', startedAt: job?.startedAt || '',
      ms: job ? Date.now() - job.t0 : 0, file: job ? (job.file || job.out) : '', log: job?.log || '',
      plan: job?.plan || '', timeline: job?.timeline || '', verification: job?.verification || '',
      verificationSkipped: Boolean(job?.verificationSkipped), repairOnly: Boolean(job?.repairOnly),
      production: productionOf(job), productions: productions(), error: job?.error || '', tail: job ? tailOf(job.log) : '',
      out: d.out, work: d.work, root: d.root, videos: listPv(d.out, d.legacyDirs || d.legacy || d.out), failures: readPvFailures(stateDir) }
  }
  const checkImport = (imports) => new Promise((resolveCheck) => {
    try {
      const child = spawn(String(python() || 'python'), ['-c', imports], { windowsHide: true, stdio: 'ignore', env: env || process.env })
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* exited */ } }, Math.min(timeoutMs, 30_000))
      timer.unref?.()
      child.once('close', (code) => { clearTimeout(timer); resolveCheck(code === 0) })
      child.once('error', () => { clearTimeout(timer); resolveCheck(false) })
    } catch { resolveCheck(false) }
  })
  const checkDeps = async (force = false) => {
    if (!force && depsCache.ok !== null && Date.now() - depsCache.at < 60_000) return depsCache.ok
    const ok = await checkImport(PV_RUNTIME_CHECK)
    depsCache = { at: Date.now(), ok }
    return ok
  }
  const checkCoverDeps = () => checkImport(PV_COVER_RUNTIME_CHECK)
  const isCoverRepair = (date, force = false) => {
    if (force || !pvDateOk(date)) return false
    const d = dirs()
    const current = pvFileOf(d.out, date, d.legacyDirs || d.legacy || d.out)
    if (!usableVideo(current)) return false
    return current !== finalOf(d.out, date) || !Object.entries(COVER_NAMES).every(([ratio, name]) => validCover(join(dateDir(d.out, date), name), ratio))
  }
  const needsWork = (date) => {
    const d = dirs()
    return !usableVideo(pvFileOf(d.out, date, d.legacyDirs || d.legacy || d.out)) || isCoverRepair(date)
  }
  const copyReport = (date, targetDir, logFile) => {
    const source = join(stateDir, 'out', `${date}.md`)
    if (!existsSync(source)) return
    const target = join(targetDir, '日报.md')
    const ready = `${target}.ready`
    try { copyFileSync(source, ready); renameSync(ready, target) }
    catch (e) { try { rmSync(ready, { force: true }) } catch { /* cleanup */ }; append(logFile, `\n日报副本未复制：${e?.message ?? e}\n`) }
  }
  /** Transactional replacement preserves a previously published daily package. */
  const commitOutputs = (pairs) => {
    const stamp = randomUUID()
    const ready = pairs.map(({ target }) => ({ target, ready: `${target}.ready-${stamp}`, backup: `${target}.backup-${stamp}`, existed: existsSync(target) }))
    let changing = false
    try {
      for (let i = 0; i < pairs.length; i++) copyFileSync(pairs[i].source, ready[i].ready)
      for (const item of ready) if (item.existed) copyFileSync(item.target, item.backup)
      changing = true
      for (const item of ready) { rmSync(item.target, { force: true }); renameSync(item.ready, item.target) }
    } catch (e) {
      if (changing) for (const item of ready) {
        if (item.existed && existsSync(item.backup)) copyFileSync(item.backup, item.target)
        else if (!item.existed) rmSync(item.target, { force: true })
      }
      throw e
    } finally { for (const item of ready) { rmSync(item.ready, { force: true }); rmSync(item.backup, { force: true }) } }
  }
  const setupCheck = (sc, names) => {
    const missing = names.find((name) => !existsSync(sc[name]))
    if (missing) return { ok: false, error: `渲染脚本没铺好（缺 ${missing === 'render' ? 'pv.py' : `pv_${missing}.py`}）` }
    const py = String(python() || 'python')
    if (!existsSync(py) && py !== 'python' && py !== 'python3') return { ok: false, error: `Python 找不到：${py}（检查设置里的 pythonPath）` }
    return { ok: true, py }
  }
  const busyError = () => ({ ok: false, running: true, date: job.date, id: job.id || '', production: productionOf(job), error: `正在做 ${job.date} 的视频或等待子进程退出，等它结束再来` })
  const execute = (j, task) => {
    job = j
    j.active = true
    j.deadline = j.t0 + timeoutMs
    j.timer = setTimeout(() => cancel(j, true), Math.max(1, j.deadline - Date.now()))
    j.timer.unref?.()
    // Start on a microtask so callers always receive the job before child work starts.
    Promise.resolve().then(() => { alive(j); return task() })
      .catch((e) => {
        if (j.killed) return
        const failedStage = j.stage
        j.stage = 'failed'
        j.error = String(e?.message ?? e)
        append(j.log, `\n❌ ${j.error}\n`)
        try { persist(j) } catch { /* original failure remains */ }
        recordFailure(j, failedStage)
        say(`🎬 ${j.date} 的视频失败：${j.error}`)
      })
      .finally(async () => {
        clearTimeout(j.timer)
        if (j.killPromise) await j.killPromise
        j.active = false
        // Observers receive only a settled job, never a partially published artifact.
        const settled = { ok: j.stage === 'done', id: j.id || '', date: j.date, stage: j.stage, error: j.error || '',
          file: j.file, plan: j.plan, timeline: j.timeline, verification: j.verification, log: j.log,
          production: productionOf(j), verificationSkipped: Boolean(j.verificationSkipped) }
        for (const listener of settledListeners) {
          try { Promise.resolve(listener(settled)).catch(error => say(`🎬 制作回执未送达：${String(error?.message || error)}`)) }
          catch (error) { say(`🎬 制作回执未送达：${String(error?.message || error)}`) }
        }
        // Keep failures/stops visible. A successful job may be released later.
        if (j.stage !== 'done') return
        const timer = setTimeout(() => { if (job === j && !busy()) job = null }, 30_000)
        timer.unref?.()
      })
  }
  const covers = async (j, sc, py, out, repair = false) => {
    phase(j, 'cover')
    const args = [sc.cover, '--plan', j.plan, '--outdir', out]
    if (repair) args.push('--only-missing')
    const code = await run(py, args, j)
    alive(j)
    requireExit(code, '封面生成失败')
    for (const [ratio, name] of Object.entries(COVER_NAMES)) if (!validCover(join(out, name), ratio)) throw new Error(`封面缺失或尺寸不正确：${join(out, name)}`)
  }
  const renderVerify = async (j, sc, py) => {
    phase(j, 'render')
    const code = await run(py, [sc.render, '--plan', j.plan, '--out', j.tmp, '--work', j.renderWork], j)
    alive(j)
    requireExit(code, '渲染失败')
    if (!usableVideo(j.tmp)) throw new Error('输出文件为空或不完整')
    if (!existsSync(j.renderTimeline)) throw new Error('渲染器没有生成 timeline.json')
    copyFileSync(j.renderTimeline, j.timeline)
    phase(j, 'verify')
    // No stale/forged receipt may authorize a later render.
    rmSync(j.verification, { force: true })
    const verifyArgs = [sc.verify, '--video', j.tmp, '--timeline', j.timeline, '--outdir', j.packageDir, '--max-duration', String(j.maxDurationSec)]
    if (Number(j.targetDurationSec) > 0) verifyArgs.push('--target-duration', String(j.targetDurationSec))
    const verifyCode = await run(py, verifyArgs, j)
    alive(j)
    requireExit(verifyCode, '成片校验失败')
    const receipt = readJson(j.verification)
    if (receipt?.ok !== true) throw new Error('成片校验失败：verification.json 缺失或未明确给出 ok:true')
    // Publication preserves the exact validated bytes by renaming the temporary
    // file. Expose the durable final path; keep only the relative input name as
    // provenance because the temporary absolute path stops existing after rename.
    atomicJson(j.verification, { ...receipt, video: j.file, verifiedVideo: j.file,
      verificationInput: relative(j.packageDir, receipt.video || j.tmp) })
    phase(j, 'publish')
  }
  const done = (j) => {
    alive(j)
    j.stage = 'done'
    j.completedAt = new Date().toISOString()
    persist(j)
    append(j.log, `\n✅ ${j.file}\n`)
    say(`🎬 ${j.date} 的视频做好了：${j.file}`)
  }

  /** Legacy date-based path, retained for scheduled daily films and cover repairs. */
  const start = (date, opt = {}) => {
    const day = String(date || '').trim()
    if (!pvDateOk(day)) return { ok: false, error: `日期得是 YYYY-MM-DD（拿到的是 "${day}"）` }
    if (busy()) return busyError()
    const d = dirs()
    const current = pvFileOf(d.out, day, d.legacyDirs || d.legacy || d.out)
    const repairOnly = isCoverRepair(day, opt.force === true)
    if (usableVideo(current) && !opt.force && !repairOnly) return { ok: true, skipped: true, date: day, file: current, hint: '这天的视频和两张封面都已经有了；要重做传 force:true' }
    const sc = scripts()
    const check = setupCheck(sc, repairOnly ? ['plan', 'cover'] : ['plan', 'cover', 'render', 'verify'])
    if (!check.ok) return check
    const { py } = check
    const runDir = join(d.work, 'runs', `${day.replace(/-/g, '')}-${randomUUID()}`)
    const packageDir = join(runDir, 'package')
    const renderWork = join(runDir, 'media')
    const targetDir = dateDir(d.out, day)
    const plan = join(packageDir, 'plan.json')
    try {
      mkdirSync(packageDir, { recursive: true })
      mkdirSync(targetDir, { recursive: true })
    } catch (e) { return { ok: false, error: `建目录失败：${e?.message ?? e}` } }
    const j = { date: day, stage: 'plan', startedAt: new Date().toISOString(), t0: Date.now(), file: finalOf(d.out, day),
      out: finalOf(d.out, day), log: join(packageDir, 'build.log'), plan, timeline: join(packageDir, 'timeline.json'),
      verification: join(packageDir, 'verification.json'), metadata: join(packageDir, 'job.json'), renderWork,
      renderTimeline: join(renderWork, 'timeline.json'), tmp: join(packageDir, 'video.partial.mp4'), packageDir,
      maxDurationSec: 300, proc: null, killed: false, repairOnly, verificationSkipped: repairOnly }
    append(j.log, `=== ${PV_PREFIX} ${day} ${repairOnly ? '仅补封面（旧成片未重新校验）' : '开始'} ===\n`)
    try { persist(j) } catch (e) { return { ok: false, error: `任务记录写入失败：${e?.message ?? e}` } }
    const planArgs = [sc.plan, '--auto', day, '-o', plan, '--home', stateDir]
    if (opt.noNet) planArgs.push('--no-net')
    if (!listPv(d.out, d.legacyDirs || d.legacy || d.out).some((v) => v.date < day)) planArgs.push('--first')
    if (opt.voice) planArgs.push('--voice', String(opt.voice))
    const gsv = gsvOf()
    if (gsv) {
      planArgs.push('--gsv-repo', gsv.gsvRepo, '--gsv-ref', gsv.gsvRef, '--gsv-prompt', gsv.gsvPrompt)
      if (gsv.gsvPython) planArgs.push('--gsv-python', gsv.gsvPython)
    }
    execute(j, async () => {
      const previousPlan = [join(targetDir, 'plan.json'), join(d.work, `plan_${day}.json`)].find((file) => existsSync(file))
      if (repairOnly && previousPlan) copyFileSync(previousPlan, plan)
      else {
        const code = await run(py, planArgs, j)
        alive(j)
        requireExit(code, '出分镜失败')
      }
      await covers(j, sc, py, repairOnly ? targetDir : packageDir, repairOnly)
      alive(j)
      if (repairOnly) {
        if (!usableVideo(j.file) && usableVideo(current)) commitOutputs([{ source: current, target: j.file }])
        copyReport(day, targetDir, j.log)
        append(j.log, '\n仅补封面：原成片未重新校验；不据此声称旧影片通过验证。\n')
        done(j)
        return
      }
      await renderVerify(j, sc, py)
      alive(j)
      const names = ['plan.json', 'timeline.json', 'verification.json', ...Object.values(COVER_NAMES)]
      commitOutputs([{ source: j.tmp, target: j.file }, ...names.map((name) => ({ source: join(packageDir, name), target: join(targetDir, name) }))])
      copyReport(day, targetDir, j.log)
      done(j)
      // The completed, validated package retains its provenance and build log beside the film.
      copyFileSync(j.log, join(targetDir, 'build.log'))
      copyFileSync(j.metadata, join(targetDir, 'job.json'))
    })
    say(repairOnly ? `🎬 ${day} 已有成片，只补封面（不重新校验旧影片）` : `🎬 开始做 ${day} 的视频`)
    return { ok: true, started: true, repairing: repairOnly, verificationSkipped: repairOnly, date: day, file: j.file,
      log: j.log, work: runDir, plan, timeline: j.timeline, verification: j.verification,
      hint: repairOnly ? '只补两种比例封面；已有影片未重新校验。' : '正在制作；渲染后必须通过音视频校验才会替换正式成片。' }
  }

  /** Start an authored production immediately; options are trusted host configuration. */
  const render = (production, opt = {}) => {
    if (busy()) return busyError()
    let plan
    try { plan = normalizeProduction(production, { date: opt.date, voice: opt.voice, gsv: opt.gsv === undefined ? gsvOf() : opt.gsv }) }
    catch (e) { return { ok: false, error: String(e?.message ?? e) } }
    const sc = scripts()
    const check = setupCheck(sc, ['cover', 'render', 'verify'])
    if (!check.ok) return check
    const d = dirs()
    const id = `${plan.date.replace(/-/g, '')}-${randomUUID()}`
    const studio = join(d.out, 'studio')
    const path = join(studio, id)
    try {
      mkdirSync(studio, { recursive: true })
      if (lstatSync(studio).isSymbolicLink()) throw new Error('studio 不能是符号链接或目录联接')
      mkdirSync(path) // Exclusive UUID folder: never reuse or overwrite another output.
    } catch (e) { return { ok: false, error: `建制作目录失败：${e?.message ?? e}` } }
    const renderWork = join(path, 'media')
    const j = { id, date: plan.date, stage: 'cover', startedAt: new Date().toISOString(), t0: Date.now(),
      out: join(path, 'video.mp4'), file: join(path, 'video.mp4'), log: join(path, 'build.log'), plan: join(path, 'plan.json'),
      timeline: join(path, 'timeline.json'), verification: join(path, 'verification.json'), metadata: join(path, 'production.json'),
      packageDir: path, renderWork, renderTimeline: join(renderWork, 'timeline.json'), tmp: join(path, 'video.partial.mp4'),
      proc: null, killed: false, repairOnly: false, targetDurationSec: plan.targetDurationSec, maxDurationSec: plan.maxDurationSec }
    j.production = { id, mode: plan.mode, title: plan.title, date: plan.date, path, metadata: j.metadata,
      file: j.file, plan: j.plan, timeline: j.timeline, log: j.log, verification: j.verification, startedAt: j.startedAt,
      targetDurationSec: plan.targetDurationSec, maxDurationSec: plan.maxDurationSec, estimatedDurationSec: plan.estimatedDurationSec }
    try {
      atomicJson(j.plan, plan)
      append(j.log, `=== studio ${id} · ${plan.mode} · ${plan.title} ===\n`)
      persist(j)
    } catch (e) { return { ok: false, error: `制作计划写入失败：${e?.message ?? e}` } }
    execute(j, async () => {
      await covers(j, sc, check.py, path)
      await renderVerify(j, sc, check.py)
      alive(j)
      renameSync(j.tmp, j.file)
      try { done(j) }
      catch (e) {
        // Failed metadata commit cannot leave a publicly named successful movie.
        renameSync(j.file, j.tmp)
        throw e
      }
    })
    say(`🎬 制作会话交来的《${plan.title}》开始渲染`)
    return { ok: true, started: true, id, date: plan.date, stage: j.stage, production: productionOf(j), file: j.file,
      log: j.log, work: path, plan: j.plan, timeline: j.timeline, verification: j.verification,
      hint: '已接收完整原创分镜；封面、渲染、实测校验完成后才会出现在成片列表。' }
  }
  const stop = () => {
    if (!job || !busy()) return { ok: true, stopped: false, hint: '现在没有在做视频' }
    const j = job
    cancel(j)
    say(`🎬 ${j.date} 的视频手动停了`)
    return { ok: true, stopped: true, date: j.date, id: j.id || '', stage: j.stage,
      stopping: Boolean(j.active || j.proc || j.killProc), production: productionOf(j) }
  }
  return {
    status, start, render, stop, checkDeps, checkCoverDeps, productions, onSettled,
    productionFileOf: (id) => productionRow(dirs().out, id)?.file || '',
    needsCoverRepair: (date) => isCoverRepair(date), needsWork,
    list: () => { const d = dirs(); return listPv(d.out, d.legacyDirs || d.legacy || d.out) },
    paths: () => dirs(),
    fileOf: (date) => { const d = dirs(); return pvFileOf(d.out, date, d.legacyDirs || d.legacy || d.out) },
    voiceMode: () => { const g = gsvOf(); return g ? { mode: 'gsv', repo: g.gsvRepo, ref: g.gsvRef } : { mode: 'edge' } },
  }
}
