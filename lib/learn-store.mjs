/** Shared learning transaction body. Caller owns state.json's cross-process lock. */
import { readJsonFileSync } from './record-storage.mjs'
import { writeJson } from './state.mjs'
import { asBook, learnStats } from './learn.mjs'

export function mutateLearningStateSync(stateFile, mutate) {
  const st = readJsonFileSync(stateFile, {})
  if (!st || typeof st !== 'object' || Array.isArray(st)) throw new Error('STATE_JSON_INVALID: expected an object')
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  // Missing fields belong to old/new books; malformed persisted fields are not an empty book.
  if (st.learn !== undefined && (!object(st.learn)
    || st.learn.items !== undefined && !object(st.learn.items)
    || st.learn.history !== undefined && !Array.isArray(st.learn.history))) {
    throw Object.assign(new Error('LEARN_STATE_INVALID: 学习账本结构损坏，已停止写入并保留原记录'), { code: 'LEARN_STATE_INVALID' })
  }
  const current = asBook(st.learn)
  const r = mutate(current)
  const saved = Boolean(r.ledger && r.ok !== false && r.auditEvent)
  if (saved) {
    st.learn = r.ledger
    st.learnAt = new Date().toISOString()
    st.learnRevision = (Number(st.learnRevision) || 0) + 1
    writeJson(stateFile, st)
  }
  return { ...r, saved, stats: learnStats(saved ? r.ledger : current), revision: Number(st.learnRevision) || 0 }
}
