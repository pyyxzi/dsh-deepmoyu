/** Small local-only sticker automation. One download at a time; no model or image service required. */
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { listStickers, collectSticker, safeName } from './sticker.mjs'
import { publicImageUrl } from './sticker-download.mjs'
import { withFileLockSync, readJsonFileSync, atomicWriteFileSync } from './record-storage.mjs'

export const STICKER_DEFAULTS = Object.freeze({
  stickerAutoCollect: false, stickerCollectProbability: 35, stickerCollectCooldown: 60,
  stickerAutoSend: false, stickerSendProbability: 30, stickerSendCooldown: 180, stickerCapacity: 60,
})
export const STICKER_LIMITS = Object.freeze({
  stickerCollectProbability: [0, 100], stickerCollectCooldown: [0, 86400],
  stickerSendProbability: [0, 100], stickerSendCooldown: [0, 86400], stickerCapacity: [1, 60],
})
export function clampStickerSettings(patch = {}) {
  const out = { ...patch }
  for (const key of ['stickerAutoCollect', 'stickerAutoSend']) if (key in out) out[key] = out[key] === true
  for (const [key, [lo, hi]] of Object.entries(STICKER_LIMITS)) if (key in out) {
    const n = Number(out[key])
    out[key] = Math.max(lo, Math.min(hi, Math.trunc(Number.isFinite(n) ? n : STICKER_DEFAULTS[key])))
  }
  return out
}
const settingsOf = cfg => {
  const clean = clampStickerSettings(cfg)
  return Object.fromEntries(Object.entries(STICKER_DEFAULTS).map(([key, value]) => [key, clean[key] ?? value]))
}
export const stickerSettings = settingsOf
const stamp = value => Number(value) || 0

/** Only comment pictures qualify; tiny platform emotes and extremely wide/tall scans do not. */
export function commentStickerCandidates(result, bvid = '') {
  const found = [], seen = new Set()
  for (const comment of (Array.isArray(result?.comments) ? result.comments : []).slice(0, 40)) {
    for (const row of [comment, ...(Array.isArray(comment?.top_replies) ? comment.top_replies.slice(0, 2) : [])]) {
      for (const image of (Array.isArray(row?.images) ? row.images : []).slice(0, 3)) {
        const raw = typeof image === 'string' ? image : image?.url
        let url
        try { url = publicImageUrl(raw).href } catch { continue }
        const width = Number(image?.w ?? image?.width), height = Number(image?.h ?? image?.height)
        if (width && height && (width < 48 || height < 48 || width > 2048 || height > 2048 || width / height > 3 || height / width > 3)) continue
        if (seen.has(url)) continue
        seen.add(url)
        const rpid = String(row?.rpid ?? comment?.rpid ?? '').slice(0, 32)
        const suffix = rpid.replace(/\D/g, '').slice(-8) || createHash('sha256').update(url).digest('hex').slice(0, 8)
        found.push({ name: safeName(`评论图-${suffix}`), url, bvid: String(bvid).slice(0, 32), rpid,
          from: `${String(bvid).slice(0, 32)} 评论区`, description: '评论区收集的配图', tags: [], automatic: true })
      }
    }
  }
  return found.slice(0, 30)
}

export function createStickerAutomation({ stateDir, getConfig, now = Date.now, random = Math.random, collect = collectSticker, list = listStickers, onEvent = () => {} }) {
  const bookFile = join(stateDir, 'sticker-automation.json')
  let disposed = false, active = false, immediate = null
  const queue = [], recentUrls = new Map(), controllers = new Set()
  const book = () => readJsonFileSync(bookFile, {})
  const mutate = fn => withFileLockSync(bookFile, () => {
    const value = book()
    const result = fn(value)
    if (result?.write) atomicWriteFileSync(bookFile, JSON.stringify(value, null, 2))
    return result
  })
  const emit = (kind, value) => { try { onEvent(kind, value) } catch { /* observer cannot break collection */ } }
  const config = () => settingsOf(getConfig?.() || {})
  const chance = probability => probability > 0 && (probability >= 100 || random() * 100 < probability)
  const snapshot = () => {
    const saved = book()
    return { collectPending: queue.length + (active ? 1 : 0), lastCollectedAt: stamp(saved.lastCollectedAt), lastSentAt: stamp(saved.lastSentAt) }
  }
  const schedule = () => {
    if (disposed || active || immediate || !queue.length) return
    immediate = setImmediate(() => { immediate = null; void drain() })
    immediate.unref?.()
  }
  const drain = async () => {
    if (active || disposed) return
    active = true
    try {
      while (!disposed && queue.length) {
        const { candidate, signal: sourceSignal } = queue.shift(), cfg = config(), at = now()
        if (sourceSignal?.aborted) continue
        if (!cfg.stickerAutoCollect || cfg.stickerCollectProbability <= 0) { queue.length = 0; break }
        // Reserve the attempt, not just a success, so broken URLs cannot cause a download burst.
        const reserved = mutate(saved => {
          if (stamp(saved.lastCollectAttemptAt) && at - stamp(saved.lastCollectAttemptAt) < cfg.stickerCollectCooldown * 1000) return { write: false }
          saved.lastCollectAttemptAt = at
          return { write: true }
        })
        if (!reserved?.write) continue
        const controller = new AbortController(); controllers.add(controller)
        const abort = () => controller.abort(sourceSignal?.reason || new Error('本轮表情采集已停止'))
        if (sourceSignal?.aborted) abort()
        else sourceSignal?.addEventListener('abort', abort, { once: true })
        try {
          controller.signal.throwIfAborted()
          const result = await collect(stateDir, { ...candidate, capacity: cfg.stickerCapacity, autoName: true, signal: controller.signal,
            shouldCommit: () => !disposed && !sourceSignal?.aborted && config().stickerAutoCollect && config().stickerCollectProbability > 0 })
          if (result.ok && !controller.signal.aborted) {
            mutate(saved => { saved.lastCollectedAt = now(); return { write: true } })
            emit('collected', { name: result.name, bvid: candidate.bvid })
          } else if (!result.duplicate) emit('collect-skipped', { error: String(result.error || '').slice(0, 160) })
        } catch (error) { if (!disposed && !controller.signal.aborted) emit('collect-skipped', { error: String(error?.message || error).slice(0, 160) }) }
        finally { sourceSignal?.removeEventListener('abort', abort); controllers.delete(controller) }
      }
    } catch (error) { emit('collect-skipped', { error: String(error?.message || error).slice(0, 160) }) }
    finally { active = false; schedule() }
  }
  return {
    snapshot,
    /** Fast, bounded enqueue; no DNS or download occurs in the comments tool's response path. */
    offer(result, bvid, { signal } = {}) {
      try {
        const cfg = config(), at = now()
        if (disposed || signal?.aborted || !cfg.stickerAutoCollect || queue.length + Number(active) >= 3 || !chance(cfg.stickerCollectProbability)) return { queued: 0 }
        const saved = book()
        if (stamp(saved.lastCollectAttemptAt) && at - stamp(saved.lastCollectAttemptAt) < cfg.stickerCollectCooldown * 1000) return { queued: 0 }
        for (const [url, time] of recentUrls) if (at - time > 3600_000) recentUrls.delete(url)
        const candidates = commentStickerCandidates(result, bvid).filter(item => !recentUrls.has(item.url))
        if (!candidates.length) return { queued: 0 }
        const picked = candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))]
        recentUrls.set(picked.url, at)
        while (recentUrls.size > 240) recentUrls.delete(recentUrls.keys().next().value)
        queue.push({ candidate: picked, signal }); schedule()
        return { queued: 1 }
      } catch (error) { emit('collect-skipped', { error: String(error?.message || error).slice(0, 160) }); return { queued: 0 } }
    },
    /** Call only after the existing new-comment authorization, quality and pace gates pass. */
    pickForSend(text) {
      const cfg = config(), at = now()
      if (disposed || !cfg.stickerAutoSend || !chance(cfg.stickerSendProbability)) return null
      try {
        const all = list(stateDir)
        if (!all.length) return null
        let choice
        const token = randomUUID()
        const reserved = mutate(saved => {
          if ((stamp(saved.lastSentAt) && at - stamp(saved.lastSentAt) < cfg.stickerSendCooldown * 1000) || stamp(saved.sendReservedUntil) > at) return { write: false }
          const recent = Array.isArray(saved.recentNames) ? saved.recentNames : []
          const fresh = all.filter(item => !recent.includes(item.name)), pool = fresh.length ? fresh : all
          const body = String(text || '').toLowerCase()
          const ranked = pool.map(item => {
            const terms = [item.name, ...(item.tags || [])].flatMap(term => String(term).toLowerCase().match(/[\p{Script=Han}]{2,}|[a-z]{3,}/gu) || [])
            return { item, score: terms.reduce((n, term) => n + (body.includes(term) ? 1 : 0), 0) }
          })
          const highest = Math.max(...ranked.map(item => item.score)), best = ranked.filter(item => item.score === highest)
          choice = best[Math.min(best.length - 1, Math.floor(random() * best.length))].item
          saved.sendReservation = token; saved.sendReservedUntil = at + 120_000
          return { write: true }
        })
        if (!reserved?.write) return null
        return { name: choice.name, file: choice.file, finish(sent) {
          try { mutate(saved => {
            if (saved.sendReservation !== token) return { write: false }
            delete saved.sendReservation; delete saved.sendReservedUntil
            if (sent) { saved.lastSentAt = now(); saved.recentNames = [choice.name, ...(saved.recentNames || []).filter(name => name !== choice.name)].slice(0, 4) }
            return { write: true }
          }) } catch (error) { emit('send-state-error', { error: String(error?.message || error).slice(0, 160) }) }
        } }
      } catch (error) { emit('send-state-error', { error: String(error?.message || error).slice(0, 160) }); return null }
    },
    stop() { disposed = true; queue.length = 0; if (immediate) clearImmediate(immediate); immediate = null; for (const controller of controllers) controller.abort(new Error('表情采集已停止')) },
  }
}
