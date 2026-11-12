import { createHash } from 'node:crypto'
import { asBook, learningEntrySnapshot, memoryMatchesQuery, readableLearningBook } from './learn.mjs'
import { SOUL_SECTIONS, soulSectionBody } from './persona.mjs'
import { redactRecordText } from './record-privacy.mjs'

export const MEMORY_SOURCES = ['all', 'learning', 'soul', 'voice', 'taste', 'seen', 'history']
export const memoryFingerprint = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const safe = (value, maxLength = 2000) => redactRecordText(String(value ?? ''), { maxLength })
const contentLines = (text) => {
  const raw = String(text || '')
  const visible = raw.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\r\n]/g, ' ')).split(/\r?\n/)
  return raw.split(/\r?\n/).map((line, index) => ({ line, text: visible[index] || '', index }))
    .filter((row) => row.text.trim() && !/^\s*#/.test(row.text))
}

/** Read-only projection with bounded output. A specific source reads/counts only that source. */
export function memoryCenterSnapshot(input = {}, options = {}) {
  const source = MEMORY_SOURCES.includes(options.source) ? options.source : 'all'
  const includes = (name) => source === 'all' || source === name
  const filter = safe(options.query || options.filter || '', 160).trim()
  const offset = Math.max(0, Math.min(10000, Math.floor(Number(options.offset) || 0)))
  const limit = Math.max(1, Math.min(50, Math.floor(Number(options.limit) || 20)))
  const rows = []
  const add = (row) => {
    const text = safe(row.text)
    if (!text.trim()) return
    rows.push({ ...row, text, from: safe(row.from, 300), label: safe(row.label, 80), at: String(row.at || ''), mutable: Boolean(row.mutable) })
  }
  if (includes('learning')) for (const [id, entry] of Object.entries(asBook(readableLearningBook(input.learn).items))) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const row = learningEntrySnapshot({ ...entry, id })
    add({ source: 'learning', id: String(row.id), label: row.label || row.kind || '学习',
    state: row.state, text: row.text, from: row.from, at: row.decidedAt || row.at, example: safe(row.example, 500),
    why: safe(row.why, 500), when: safe(row.when, 200), practice: row.practice,
    sources: row.sources, sourceLinks: row.sourceLinks, availableForRecall: row.availableForRecall,
    version: memoryFingerprint(entry), mutable: true,
    actions: row.state === 'approved' ? ['revoke', 'forget'] : ['forget'] })
  }
  if (includes('soul')) for (const section of SOUL_SECTIONS) {
    const body = soulSectionBody(String(input.soulText || ''), section.key)
    for (const row of contentLines(body)) add({ source: 'soul', id: `${section.key}:${row.index}`, section: section.key,
      index: row.index, label: section.title, text: row.text, version: memoryFingerprint(row.line),
      from: 'soul.md · 自己写下的心情', at: input.soulAt, mutable: true, actions: ['forget'] })
  }
  if (includes('voice')) for (const row of contentLines(input.voiceText).slice(-500)) add({ source: 'voice', id: String(row.index), index: row.index,
    label: '语气札记', text: row.text, from: 'voice.md · 自己整理的表达经验', at: input.voiceAt,
    version: memoryFingerprint(row.line), mutable: true, actions: ['forget'] })
  if (includes('taste')) for (const [key, row] of Object.entries(object(input.taste)).slice(-300)) {
    if (!/^\d{1,32}$/.test(key) || !row || typeof row !== 'object' || typeof row.text !== 'string') continue
    add({ source: 'taste', id: key, label: '口味样本', text: row.text, from: row.bvid || '自己发出的评论',
      at: row.at, likes: Number.isFinite(Number(row.likes)) ? Math.max(0, Math.floor(Number(row.likes))) : 0,
      checked: Boolean(row.likesAt), version: memoryFingerprint(row), mutable: true, actions: ['forget'] })
  }
  if (includes('seen')) for (const [key, value] of Object.entries(object(input.seen)).slice(-5000)) {
    if (!/^BV[0-9A-Za-z]{10}$/.test(key)) continue
    const row = typeof value === 'string' ? { note: value } : object(value)
    add({ source: 'seen', id: key, label: '浏览历史', text: [key, row.title, row.note].filter(Boolean).join(' · '),
      from: key, at: row.at, mutable: false, actions: [] })
  }
  if (includes('history')) for (const event of (Array.isArray(input.events) ? input.events : []).slice(0, 100)) {
    if (!event || !['memory', 'learning'].includes(event.type)) continue
    const data = object(event.data)
    add({ source: 'history', id: String(event.eventId), label: event.type === 'memory' ? '记忆版本' : '审核审计',
      text: event.type === 'memory' ? `${data.name || '记忆'} · ${data.operation || 'snapshot'}\n${data.text || ''}` : JSON.stringify(data),
      from: event.source, at: event.at || event.recordedAt, mutable: false, actions: [] })
  }
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)) || a.source.localeCompare(b.source) || a.id.localeCompare(b.id))
  const counts = Object.fromEntries(MEMORY_SOURCES.slice(1).map((key) => [key, rows.filter((row) => row.source === key).length]))
  const matched = rows.filter((row) => (source === 'all' || row.source === source)
    && memoryMatchesQuery([row.id, row.text, row.when, row.from, row.label, row.example, row.why, row.state], filter))
  const items = matched.slice(offset, offset + limit), more = matched.length > offset + items.length
  return { ok: true, source, filter, query: filter, offset, limit, total: rows.length, matched: matched.length,
    count: items.length, more, hasMore: more, nextOffset: more ? offset + items.length : null, counts, items,
    scope: 'current-snapshots-and-latest-100-audits', historyReadOnly: true }
}
