/**
 * lib/pv.mjs —— 「昨日冲浪报告」PV 视频的 Node 侧编排
 * ============================================================================
 * 它是什么（2026-10-22 使用者要求）：
 *   「每天生成一个视频，讲今天的冲浪情况 —— 今天刷了什么内容、有什么感悟、
 *     私信和评论是什么情况。用鲸鱼摸鱼的虚拟形象讲解，要有声音。」
 *
 * 为什么视频不在 Node 里做：
 *   画 Q 版角色、TTS、逐帧渲染、混音全是 Python 的活（Pillow + edge-tts + imageio-ffmpeg），
 *   见 `lib/pv.py`（渲染器）与 `lib/pv_plan.py`（把某天的日报/流水整理成分镜）。
 *   这一层只负责**编排**：出分镜 → 渲染 → 收成品，全程可看日志。
 *
 * 不变量（改之前先读）：
 *   · 渲染要几分钟 ⇒ **绝不能在工具调用里同步等**。start() 立刻返回，
 *     进度靠 status() 轮询（HTTP /api/bili-duty/pv 与 bili_pv({action:'status'}) 都走它）。
 *   · 成品先写 `*.partial.mp4`，成功了才 rename 成正式名 ——
 *     半截文件永远不能被当成"做好了"（客户端是按文件名认的）。
 *   · 一次只跑一个：两个 ffmpeg 抢 CPU 只会把两边都拖慢，而且中间产物目录会打架。
 *   · 任何失败都只记进日志 + status.error，**绝不抛到宿主**（做视频挂了不能影响刷B站）。
 *   · 输出目录**不写死盘符**：默认取镜像目录反推出的工作区根（见 lib/mirror.mjs），
 *     推不出来才退回家目录的 out/。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 成品文件名前缀：`大肥鱼日报_2026-10-20.mp4` */
export const PV_PREFIX = '大肥鱼日报'
const PV_RE = /^大肥鱼日报_(\d{4}-\d{2}-\d{2})\.mp4$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const COVER_NAMES = { '16x9': '封面_16x9.png', '4x3': '封面_4x3.png' }
const COVER_SIZES = { '16x9': [1920, 1080], '4x3': [1440, 1080] }

export const pvDateOk = (s) => {
  const value = String(s || '')
  if (!DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** 「昨天」= 本地时区的昨天（不能用 toISOString，那是 UTC，东八区早上 8 点前会算错一天） */
export function pvYesterday(now = new Date()) {
  const d = new Date(now.getTime() - 86400_000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 视频放哪儿。
 * @param {string} stateDir 插件家目录
 * @param {{pvDir?:string, mirrorDir?:string, resolveMirror?:(s:string,e:string)=>string}} o
 * @returns {{root:string, out:string, work:string}}
 *   `root` = 反推出的工作区根（推不出来是空串）
 */
export function pvDirs(stateDir, o = {}) {
  const explicit = String(o.pvDir || '').trim()
  if (explicit) {
    return { root: explicit, out: explicit, legacy: explicit, legacyDirs: [explicit], work: join(explicit, '_work') }
  }
  let root = ''
  try { root = String((o.resolveMirror ? o.resolveMirror(stateDir, o.mirrorDir || '') : '') || '').trim() } catch { root = '' }
  if (root) {
    const base = join(root, 'bili-work', 'pv')
    return { root, out: join(base, '日报'), legacy: root, legacyDirs: [root, base], work: base }
  }
  // Keep the same dated structure even when workspace discovery is unavailable.
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

/** Scan canonical YYYY-MM-DD folders and flat legacy files. Canonical wins. */
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
  } catch { /* directory not created yet */ }
  for (const legacyDir of asDirs(legacyDirs)) {
    if (legacyDir === outDir) continue
    try {
      for (const n of readdirSync(legacyDir)) {
        const m = PV_RE.exec(n)
        if (m) add(m[1], join(legacyDir, n), false)
      }
    } catch { /* legacy directory may not exist */ }
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : -1))
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
    if (!statSync(file).isFile() || statSync(file).size === 0) return false
    // PNG IHDR width / height; the helper process also performs full decoding.
    const data = readFileSync(file)
    return data.length > 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && data.readUInt32BE(16) === width && data.readUInt32BE(20) === height
  } catch { return false }
}

const tailOf = (file, n = 2600) => {
  try {
    const s = readFileSync(file, 'utf8')
    return s.length > n ? s.slice(-n) : s
  } catch { return '' }
}

/**
 * 造一个 PV 编排器。
 * @param {{
 *   stateDir: string,
 *   pluginDir: string,
 *   python: () => string,           // 每次现算（cfg 可能被设置页改掉）
 *   dirs: () => {root:string,out:string,work:string},
 *   env?: Record<string,string>,
 *   log?: (s:string)=>void,
 *   timeoutMs?: number,
 * }} o
 */
export function createPv(o) {
  const { stateDir, pluginDir, python, dirs, env = null } = o
  const say = (s) => { try { o.log?.(s) } catch { /* 日志不许炸 */ } }
  const timeoutMs = Number(o.timeoutMs) || 20 * 60_000
  /** 🎙 真·本鱼音色（GPT-SoVITS）：返回 {gsvRepo,gsvRef,gsvPrompt,gsvPython} 或 null */
  const gsvOf = () => { try { return o.gsv?.() || null } catch { return null } }
  /** @type {null | {date:string, stage:string, startedAt:string, t0:number, out:string, log:string, error?:string, file?:string, proc?:any, killed?:boolean}} */
  let job = null
  let depsCache = { at: 0, ok: null }

  const scripts = () => {
    const pick = (name) => {
      const packaged = join(pluginDir, 'lib', name)
      return existsSync(packaged) ? packaged : join(stateDir, name)
    }
    return { plan: pick('pv_plan.py'), render: pick('pv.py'), cover: pick('pv_cover.py') }
  }

  const append = (file, s) => { try { appendFileSync(file, String(s), 'utf8') } catch { /* 日志写不了也不能炸 */ } }

  const run = (cmd, args, logFile, jobRef) => new Promise((resolve) => {
    append(logFile, `\n$ ${cmd} ${args.join(' ')}\n`)
    let c = null
    try { c = spawn(cmd, args, { cwd: stateDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: env || process.env }) }
    catch (e) { append(logFile, `起不来：${e?.message ?? e}\n`); return resolve(1) }
    if (jobRef) jobRef.proc = c
    const w = (b) => append(logFile, String(b))
    c.stdout?.on('data', w)
    c.stderr?.on('data', w)
    const timer = setTimeout(() => {
      append(logFile, `\n--- 超时 ${Math.round(timeoutMs / 60000)} 分钟，强制结束 ---\n`)
      try { c.kill('SIGKILL') } catch { /* 已经没了 */ }
    }, timeoutMs)
    timer.unref?.()
    c.on('close', (code) => { clearTimeout(timer); if (jobRef?.proc === c) jobRef.proc = null; append(logFile, `\n--- exit ${code} ---\n`); resolve(code ?? 1) })
    c.on('error', (e) => { clearTimeout(timer); append(logFile, `起不来：${e?.message ?? e}\n`); resolve(1) })
  })

  const status = () => {
    const d = dirs()
    const running = !!job && (job.stage === 'plan' || job.stage === 'cover' || job.stage === 'render')
    const base = {
      ok: true,
      running,
      stage: job ? job.stage : 'idle',
      date: job ? job.date : '',
      startedAt: job ? job.startedAt : '',
      ms: job ? Date.now() - job.t0 : 0,
      file: job ? (job.file || job.out) : '',
      log: job ? job.log : '',
      plan: job ? job.plan : '',
      timeline: job ? job.timeline : '',
      error: job ? (job.error || '') : '',
      tail: job ? tailOf(job.log) : '',
      out: d.out,
      work: d.work,
      root: d.root,
      videos: listPv(d.out, d.legacyDirs || d.legacy || d.out),
    }
    return base
  }

  /** 依赖探一下（edge-tts / imageio-ffmpeg / Pillow）—— 拿不到就说拿不到，别让它跑到一半才炸 */
  const checkDeps = async (force = false) => {
    if (!force && depsCache.ok !== null && Date.now() - depsCache.at < 60_000) return depsCache.ok
    const py = String(python() || 'python')
    const exit = await new Promise((resolve) => {
      try {
        const c = spawn(py, ['-c', 'import edge_tts, imageio_ffmpeg, PIL'], { windowsHide: true, stdio: 'ignore', env: env || process.env })
        c.on('exit', (n) => resolve(n ?? 1))
        c.on('error', () => resolve(1))
      } catch { resolve(1) }
    })
    depsCache = { at: Date.now(), ok: exit === 0 }
    return depsCache.ok
  }

  const isCoverRepair = (date, force = false) => {
    if (force) return false
    const d = dirs()
    const current = pvFileOf(d.out, date, d.legacyDirs || d.legacy || d.out)
    if (!existsSync(current)) return false
    if (current !== finalOf(d.out, date)) return true
    return !Object.entries(COVER_NAMES).every(([ratio, name]) => validCover(join(dateDir(d.out, date), name), ratio))
  }
  const needsWork = (date) => {
    const d = dirs()
    return !usableVideo(pvFileOf(d.out, date, d.legacyDirs || d.legacy || d.out)) || isCoverRepair(date)
  }
  const checkCoverDeps = async () => {
    const py = String(python() || 'python')
    return new Promise((resolve) => {
      try {
        const c = spawn(py, ['-c', 'import PIL'], { windowsHide: true, stdio: 'ignore', env: env || process.env })
        c.on('exit', (n) => resolve(n === 0))
        c.on('error', () => resolve(false))
      } catch { resolve(false) }
    })
  }

  const copyReport = (date, targetDir, logFile) => {
    const source = join(stateDir, 'out', `${date}.md`)
    if (!existsSync(source)) return
    const target = join(targetDir, '日报.md')
    const ready = `${target}.ready`
    try {
      mkdirSync(targetDir, { recursive: true })
      copyFileSync(source, ready)
      renameSync(ready, target)
      append(logFile, `\n日报副本 → ${target}\n`)
    } catch (e) {
      try { rmSync(ready, { force: true }) } catch { /* best effort */ }
      append(logFile, `\n日报副本未复制（不影响成片）：${e?.message ?? e}\n`)
    }
  }

  const commitOutputs = (tmp, stagedCovers, final, date, outDir) => {
    const targetDir = dateDir(outDir, date)
    mkdirSync(targetDir, { recursive: true })
    const pairs = [{ source: tmp, target: final, ratio: '' },
      ...Object.entries(COVER_NAMES).map(([ratio, name]) => ({ source: join(stagedCovers, name), target: join(targetDir, name), ratio }))]
    const stamp = `${process.pid}-${Date.now()}`
    const ready = pairs.map(({ target }) => ({ target, ready: `${target}.ready-${stamp}`, backup: `${target}.backup-${stamp}` }))
    let backedUp = false
    try {
      for (let i = 0; i < pairs.length; i++) {
        if (pairs[i].ratio && !validCover(pairs[i].source, pairs[i].ratio)) throw new Error(`封面校验失败：${pairs[i].source}`)
        if (!pairs[i].ratio && statSync(pairs[i].source).size < 1024) throw new Error('输出文件为空或不完整')
        copyFileSync(pairs[i].source, ready[i].ready)
      }
      for (const item of ready) if (existsSync(item.target)) copyFileSync(item.target, item.backup)
      backedUp = true
      try {
        for (const item of ready) {
          rmSync(item.target, { force: true })
          renameSync(item.ready, item.target)
        }
      } catch (error) {
        if (backedUp) {
          for (const item of ready) {
            if (existsSync(item.backup)) copyFileSync(item.backup, item.target)
            else rmSync(item.target, { force: true })
          }
        }
        throw error
      }
    } finally {
      for (const item of ready) {
        rmSync(item.ready, { force: true })
        rmSync(item.backup, { force: true })
      }
    }
    rmSync(tmp, { force: true })
  }

  /**
   * Start rendering or repair only missing covers; always returns immediately.
   * @param {string} date YYYY-MM-DD
   * @param {{force?:boolean, noNet?:boolean}} opt
   */
  const start = (date, opt = {}) => {
    const day = String(date || '').trim()
    if (!pvDateOk(day)) return { ok: false, error: `日期得是 YYYY-MM-DD（拿到的是 "${day}"）` }
    if (job && (job.stage === 'plan' || job.stage === 'cover' || job.stage === 'render' || job.proc)) {
      return { ok: false, running: true, date: job.date, error: `正在做 ${job.date} 的视频，等它做完再来` }
    }
    const sc = scripts()
    if (!existsSync(sc.plan) || !existsSync(sc.render) || !existsSync(sc.cover)) {
      const missing = !existsSync(sc.plan) ? 'pv_plan.py' : !existsSync(sc.cover) ? 'pv_cover.py' : 'pv.py'
      return { ok: false, error: `渲染脚本没铺好（缺 ${missing}）—— 重启一次插件会让 lib/state.mjs 铺过去` }
    }
    const py = String(python() || 'python')
    if (!existsSync(py) && py !== 'python' && py !== 'python3') {
      return { ok: false, error: `Python 找不到：${py}（先装依赖 / 检查设置里的 pythonPath）` }
    }
    const d = dirs()
    const current = pvFileOf(d.out, day, d.legacyDirs || d.legacy || d.out)
    const repairOnly = isCoverRepair(day, opt.force === true)
    if (existsSync(current) && !opt.force && !repairOnly) {
      return { ok: true, skipped: true, date: day, file: current, hint: '这天的视频和两张封面都已经有了；要重做传 force:true' }
    }
    const final = finalOf(d.out, day)
    const targetDir = dateDir(d.out, day)
    const plan = join(d.work, `plan_${day}.json`)
    const tmp = join(d.work, `${PV_PREFIX}_${day}.partial.mp4`)
    const stageDir = join(d.work, `_publish_${day}`)
    const coverOut = repairOnly ? targetDir : stageDir
    try {
      mkdirSync(d.out, { recursive: true })
      mkdirSync(d.work, { recursive: true })
      mkdirSync(targetDir, { recursive: true })
      if (!repairOnly) { rmSync(stageDir, { recursive: true, force: true }); mkdirSync(stageDir, { recursive: true }) }
    } catch (e) { return { ok: false, error: `建目录失败：${e?.message ?? e}` } }

    const logFile = join(d.work, `build_${day}.log`)
    try { rmSync(logFile, { force: true }) } catch { /* 清不掉就追加 */ }
    const j = { date: day, stage: repairOnly && existsSync(plan) ? 'cover' : 'plan', startedAt: new Date().toISOString(), t0: Date.now(), out: final, file: final, log: logFile, plan, timeline: join(d.work, `_w${day.replace(/-/g, '')}`, 'timeline.json'), proc: null, killed: false, repairOnly }
    job = j
    append(logFile, `=== ${PV_PREFIX} ${day} ${repairOnly ? '补封面' : '开始'} ${new Date().toLocaleString('zh-CN')} ===\n`)
    say(repairOnly ? `🎬 ${day} 已有成片，只补封面` : `🎬 开始做 ${day} 的视频`)

    const planArgs = [sc.plan, '--auto', day, '-o', plan, '--home', stateDir]
    if (opt.noNet) planArgs.push('--no-net')
    let isFirst = false
    try { isFirst = !listPv(d.out, d.legacy || d.out).some((v) => v.date < day) } catch { isFirst = false }
    if (isFirst) planArgs.push('--first')
    if (opt.voice) planArgs.push('--voice', String(opt.voice))
    const gsv = gsvOf()
    if (gsv) {
      planArgs.push('--gsv-repo', gsv.gsvRepo, '--gsv-ref', gsv.gsvRef, '--gsv-prompt', gsv.gsvPrompt)
      if (gsv.gsvPython) planArgs.push('--gsv-python', gsv.gsvPython)
      append(logFile, `🎙 音色：GPT-SoVITS（参考 ${gsv.gsvRef}）\n`)
    }

    const planRun = repairOnly && existsSync(plan) ? Promise.resolve(0) : run(py, planArgs, logFile, j)
    planRun
      .then((planCode) => {
        if (j.killed) return null
        if (planCode !== 0) throw new Error(`出分镜失败（exit ${planCode}），看日志 ${logFile}`)
        j.stage = 'cover'
        append(logFile, repairOnly ? '\n只补缺失封面，不重做配音或视频。\n' : '\n生成两种比例封面。\n')
        const coverArgs = [sc.cover, '--plan', plan, '--outdir', coverOut]
        if (repairOnly) coverArgs.push('--only-missing')
        return run(py, coverArgs, logFile, j)
      })
      .then((coverCode) => {
        if (j.killed || coverCode === null) return null
        if (coverCode !== 0) throw new Error(`封面生成失败（exit ${coverCode}），看日志 ${logFile}`)
        for (const [ratio, name] of Object.entries(COVER_NAMES)) {
          if (!validCover(join(coverOut, name), ratio)) throw new Error(`封面缺失或尺寸不正确：${join(coverOut, name)}`)
        }
        if (repairOnly) {
          if (!existsSync(final) && existsSync(current)) {
            const ready = `${final}.ready.mp4`
            try { copyFileSync(current, ready); renameSync(ready, final) }
            catch (e) { rmSync(ready, { force: true }); throw new Error(`旧成片归档失败（原文件仍保留）：${e?.message ?? e}`) }
          }
          copyReport(day, targetDir, logFile)
          j.stage = 'done'
          j.file = final
          append(logFile, `\n封面已补齐：${targetDir}\n`)
          say(`🎬 ${day} 的封面已补齐：${targetDir}`)
          return null
        }
        j.stage = 'render'
        say(`🎬 ${day} 封面就绪，开始渲染视频`)
        return run(py, [sc.render, '--plan', plan, '--out', tmp, '--work', join(d.work, `_w${day.replace(/-/g, '')}`)], logFile, j)
      })
      .then((renderCode) => {
        if (j.killed || renderCode === null || repairOnly) return
        if (renderCode !== 0) throw new Error(`渲染失败（exit ${renderCode}），看日志 ${logFile}`)
        if (statSync(tmp).size < 1024) throw new Error('输出文件为空或不完整')
        commitOutputs(tmp, stageDir, final, day, d.out)
        copyReport(day, targetDir, logFile)
        j.stage = 'done'
        j.file = final
        append(logFile, `\n✅ ${final}\n`)
        say(`🎬 ${day} 的视频做好了：${final}`)
      })
      .catch((e) => {
        j.stage = 'failed'
        j.error = String(e?.message ?? e)
        append(logFile, `\n❌ ${j.error}\n`)
        say(`🎬 ${day} 的视频失败：${j.error}`)
      })
      .finally(() => {
        j.proc = null
        if (!repairOnly) { try { rmSync(stageDir, { recursive: true, force: true }) } catch { /* staging cleanup */ } }
        const t = setTimeout(() => { if (job === j) job = null }, 30_000)
        t.unref?.()
      })

    return {
      ok: true, started: true, repairing: repairOnly, date: day, file: final, log: logFile, work: d.work,
      hint: repairOnly ? '正在只补两种比例的封面，不会重做视频或配音。' : '做好了我会写日志；进度用 bili_pv({action:"status"}) 或桌宠 ⚙️ 设置 →「视频 · 模型」里的「做视频」看（一条 2–6 分钟）',
    }
  }

  const stop = () => {
    if (!job) return { ok: true, stopped: false, hint: '现在没有在做视频' }
    const j = job
    j.killed = true
    try { j.proc?.kill('SIGKILL') } catch { /* 已经没了 */ }
    append(j.log, '\n--- 手动停下 ---\n')
    j.stage = 'stopped'
    const day = j.date
    // ⚠️ 必须在 5 秒后才清 —— 不然 stop 刚返回，界面下一次轮询就看不到「停下了」这件事
    const t = setTimeout(() => { if (job === j && !j.proc) job = null }, 5_000)
    t.unref?.()
    say(`🎬 ${day} 的视频手动停了`)
    return { ok: true, stopped: true, date: day }
  }

  return {
    status, start, stop, checkDeps, checkCoverDeps,
    needsCoverRepair: (date) => isCoverRepair(date),
    needsWork: (date) => needsWork(date),
    list: () => { const d = dirs(); return listPv(d.out, d.legacyDirs || d.legacy || d.out) },
    paths: () => dirs(),
    fileOf: (date) => { const d = dirs(); return pvFileOf(d.out, date, d.legacyDirs || d.legacy || d.out) },
    /** 🎙 现在用的是什么音色（设置页要显示「真·本鱼原声」还是「edge-tts 顶班」） */
    voiceMode: () => {
      const g = gsvOf()
      return g ? { mode: 'gsv', repo: g.gsvRepo, ref: g.gsvRef } : { mode: 'edge' }
    },
  }
}
