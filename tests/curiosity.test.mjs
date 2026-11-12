import test from 'node:test'
import assert from 'node:assert/strict'
import { curiosityBoard, curiousChange, curiousSnapshot, curiousHint, CURIOSITY_LIMITS } from '../lib/curiosity.mjs'

const A = 'BV14AHP6VExR', B = 'BV14AHP6VExS', C = 'BV14AHP6VExT'
const NOW = Date.parse('2026-11-12T01:00:00Z')
const execute = (board, args, options = {}) => curiousChange(board, args, { readBvids: [A, B, C], now: NOW, ...options })
const open = (board, question = '为什么先焊再钻孔更容易对齐', bvid = A) => execute(board, { action: 'open', question, query: '焊接 钻孔 顺序', bvid })

test('opening a fish lead requires real read evidence supplied by the caller, not self-reported seen state', () => {
  const args = { action: 'open', question: '这个转场为什么要反拍', query: '反拍 转场', bvid: A }
  for (const options of [{ readBvids: [] }, { readBvids: [B] }, { readBvids: { [A]: { note: '读过字幕' } } }]) {
    const result = execute(undefined, args, options)
    assert.equal(result.code, 'CURIOSITY_READ_REQUIRED')
    assert.equal(result.changed, false)
    assert.deepEqual(result.board.items, [])
  }
  assert.equal(execute(undefined, { ...args, actor: 'user' }, { readBvids: [] }).ok, false, 'tool arguments cannot forge caller authorization')
  const added = execute(undefined, args)
  assert.equal(added.ok, true)
  assert.equal(added.item.origin, 'fish')
  assert.equal(added.item.url, `https://www.bilibili.com/video/${A}`)
  const manual = execute(undefined, { action: 'open', question: '哪种纸适合定格动画', query: '纸张 定格动画' }, { actor: 'user', readBvids: [] })
  assert.equal(manual.item.origin, 'user')
  assert.equal(manual.item.bvid, '')
  assert.equal(manual.item.notes.length, 0)
})

test('read findings retain canonical source/time links and deduplicate without changing either revision', () => {
  const first = open(undefined), original = JSON.stringify(first.board)
  const note = execute(first.board, { action: 'note', id: first.id, bvid: B, text: '钻头会沿着已有焊点跑偏', seconds: 62.5 })
  assert.equal(JSON.stringify(first.board), original, 'pure operations never mutate the persisted source snapshot')
  assert.equal(note.item.notes[0].url, `https://www.bilibili.com/video/${B}?t=62.5`)
  assert.equal(note.item.version, 2)
  assert.equal(note.board.revision, 2)
  const duplicate = execute(note.board, { action: 'note', id: first.id, bvid: B, text: '钻头会沿着已有焊点跑偏。', seconds: 62.5 })
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.changed, false)
  assert.equal(duplicate.board.revision, note.board.revision)
  assert.equal(duplicate.item.version, note.item.version)
  const afterReload = curiousSnapshot(JSON.parse(JSON.stringify(note.board)))
  assert.equal(afterReload.finds.length, 1)
  assert.equal(afterReload.finds[0].topicId, first.id)
  assert.equal(afterReload.finds[0].bvid, B)
  assert.equal(afterReload.finds[0].seconds, 62.5)
  afterReload.finds[0].text = 'caller mutation'
  assert.equal(note.board.items[0].notes[0].text, '钻头会沿着已有焊点跑偏')
  const removed = execute(note.board, { action: 'forget', id: first.id })
  assert.equal(curiousSnapshot(removed.board).finds.length, 0, 'the view cannot retain a second hidden copy after an explicit deletion')
})

test('unread, paused, manual or malformed findings never fabricate completed exploration', () => {
  const first = open(undefined)
  for (const options of [{ readBvids: [] }, { actor: 'user' }]) {
    const result = execute(first.board, { action: 'note', id: first.id, bvid: B, text: '实际合成收获' }, options)
    assert.equal(result.code, 'CURIOSITY_READ_REQUIRED')
    assert.deepEqual(result.board, first.board)
  }
  for (const seconds of [-1, 86401, '5', true, NaN, Infinity]) {
    assert.equal(execute(first.board, { action: 'note', id: first.id, bvid: B, text: '合成收获', seconds }).ok, false)
  }
  for (const text of ['', '？？？', null, {}, '一'.repeat(181), '多行\n内容']) {
    assert.equal(execute(first.board, { action: 'note', id: first.id, bvid: B, text }).ok, false)
  }
  const paused = execute(first.board, { action: 'pause', id: first.id })
  assert.equal(execute(paused.board, { action: 'note', id: first.id, bvid: B, text: '合成收获' }).code, 'CURIOSITY_NOT_ACTIVE')
})

test('three active interests are bounded, pause/resume/resolve do not require invented conclusions, and hints are optional', () => {
  let board, ids = []
  for (let i = 0; i < 3; i++) { const result = open(board, `问题${i}有什么区别`); board = result.board; ids.push(result.id) }
  assert.equal(open(board, '第四个问题').code, 'CURIOSITY_ACTIVE_LIMIT')
  const beforeHint = JSON.stringify(board), surfaced = new Set()
  for (let round = 0; round < 30; round++) {
    const hint = curiousHint(board, { rotationKey: `round:${round}` })
    assert.equal(hint.optional, true)
    assert.deepEqual(hint, curiousHint(board, { rotationKey: `round:${round}` }))
    surfaced.add(hint.id)
  }
  assert.equal(surfaced.size, 3)
  assert.equal(JSON.stringify(board), beforeHint)
  board = execute(board, { action: 'pause', id: ids[0] }).board
  const fourth = open(board, '第四个问题'); board = fourth.board
  assert.equal(execute(board, { action: 'resume', id: ids[0] }).code, 'CURIOSITY_ACTIVE_LIMIT')
  board = execute(board, { action: 'resolve', id: fourth.id }).board
  board = execute(board, { action: 'resume', id: ids[0] }).board
  for (const id of ids) board = execute(board, { action: 'resolve', id }).board
  assert.equal(curiousHint(board), null)
  assert.equal(curiousSnapshot(board).counts.resolved, 4)
  assert.equal(curiousSnapshot(board).finds.length, 0, 'closing an interest never invents findings')
  assert.equal(execute(board, { action: 'resolve', id: ids[0] }).changed, false)
  assert.equal(execute(board, { action: 'forget', id: ids[0] }).board.items.length, 3)
})

test('source plus normalized question prevents duplicate boards, including already resolved interests', () => {
  const first = open(undefined, '这个转场为什么要反拍')
  const repeat = open(first.board, '这个转场，为什么要反拍？')
  assert.equal(repeat.duplicate, true)
  assert.equal(repeat.board.revision, first.board.revision)
  const resolved = execute(first.board, { action: 'resolve', id: first.id })
  const again = open(resolved.board, '这个转场为什么要反拍')
  assert.equal(again.item.status, 'resolved', 'a duplicate open does not silently reopen a completed interest')
  assert.equal(open(first.board, '这个转场为什么要反拍', B).changed, true, 'a separate actual source may raise the same question')
})

test('total board and findings limits preserve old entries instead of silently evicting them', () => {
  let board
  for (let i = 0; i < CURIOSITY_LIMITS.total; i++) {
    const added = open(board, `第${i}个实际问题`)
    assert.equal(added.ok, true)
    board = execute(added.board, { action: 'resolve', id: added.id }).board
  }
  assert.equal(open(board, '不该挤掉旧记录的新问题').code, 'CURIOSITY_TOTAL_LIMIT')
  let first = open(undefined)
  for (let i = 0; i < 3; i++) first = execute(first.board, { action: 'note', id: first.id, bvid: B, text: `第${i}条实际收获`, seconds: i })
  const fourth = execute(first.board, { action: 'note', id: first.id, bvid: B, text: '第四条收获' })
  assert.equal(fourth.code, 'CURIOSITY_NOTE_LIMIT')
  assert.equal(curiousSnapshot(fourth.board).finds.length, 3)
})

test('optimistic revisions reject stale state and persisted corruption fails closed', () => {
  const first = open(undefined)
  for (const args of [{ action: 'pause', id: first.id, version: 0 }, { action: 'forget', id: first.id, expectedRevision: 0 }]) {
    const stale = execute(first.board, args)
    assert.equal(stale.code, 'CURIOSITY_STALE')
    assert.deepEqual(stale.board, first.board)
  }
  const damaged = [null, [], { schema: 2, revision: 0, items: [] }, { ...first.board, revision: '1' },
    { ...first.board, items: [first.item, first.item] },
    { ...first.board, items: [{ ...first.item, notes: [{ bvid: A, text: '合成', seconds: -1, url: '', at: new Date(NOW).toISOString() }] }] },
    { ...first.board, items: [{ ...first.item, url: 'https://unrelated.example/' }] }]
  for (const raw of damaged) {
    assert.throws(() => curiousSnapshot(raw), { code: 'CURIOSITY_INVALID' })
    assert.throws(() => execute(raw, { action: 'open', question: '新问题', query: '新搜索', bvid: A }), { code: 'CURIOSITY_INVALID' })
  }
  assert.deepEqual(curiosityBoard(undefined), { schema: 1, revision: 0, items: [] })
})

test('public reference text is bounded and redacted before storage or optional prompt hints', () => {
  const first = open(undefined, '如何处理 SESSDATA=fixture-secret 的登录问题')
  assert.doesNotMatch(JSON.stringify(first.board), /fixture-secret/)
  const note = execute(first.board, { action: 'note', id: first.id, bvid: B, text: '保留自己的理解，demo@example.org 和 13812345678 不进回看板' })
  assert.doesNotMatch(JSON.stringify(curiousSnapshot(note.board)), /demo@example\.org|13812345678/)
  assert.doesNotMatch(JSON.stringify(curiousHint(note.board)), /fixture-secret/)
})

test('one optional hint carries only the latest prior finding without asserting fresh reading or changing UI projections', () => {
  const opened = open(undefined)
  assert.equal(curiousHint(opened.board).noteCount, 0)
  assert.equal(Object.hasOwn(curiousHint(opened.board), 'lastFind'), false)
  const first = execute(opened.board, { action: 'note', id: opened.id, bvid: A, text: '第一条旧收获', seconds: 5 })
  const second = curiousChange(first.board, { action: 'note', id: opened.id, bvid: B, text: '第二条自己的理解', seconds: 12 },
    { readBvids: [B], actor: 'fish', now: NOW + 1000 })
  const before = JSON.stringify(second.board), snapshot = curiousSnapshot(second.board)
  const hint = curiousHint(JSON.parse(before), { rotationKey: 'new-run' })
  assert.equal(hint.optional, true)
  assert.equal(hint.noteCount, 2)
  assert.deepEqual(hint.lastFind, { bvid: B, text: '第二条自己的理解', url: `https://www.bilibili.com/video/${B}?t=12`, at: new Date(NOW + 1000).toISOString() })
  assert.equal(Object.hasOwn(hint, 'readBvids'), false)
  hint.lastFind.text = 'caller changed a display hint'
  assert.equal(JSON.stringify(second.board), before)
  assert.deepEqual(curiousSnapshot(second.board), snapshot, 'existing board and finds UI contracts remain unchanged')
  const paused = execute(second.board, { action: 'pause', id: opened.id })
  assert.equal(curiousHint(paused.board), null)
})

test('find card identities stay stable across ordering and status changes without adding a stored note id', () => {
  const first = open(undefined)
  let board = execute(first.board, { action: 'note', id: first.id, bvid: A, text: '同一视频第一点收获', seconds: 1 }).board
  board = execute(board, { action: 'note', id: first.id, bvid: A, text: '同一视频第二点收获', seconds: 2 }).board
  const second = open(board, '另一个来源问题', B)
  board = execute(second.board, { action: 'note', id: second.id, bvid: A, text: '同一视频第一点收获', seconds: 1 }).board
  const initial = curiousSnapshot(board).finds
  assert.equal(initial.length, 3)
  assert.equal(new Set(initial.map(find => find.id)).size, 3, 'topic, content and time point distinguish cards')
  for (const find of initial) assert.match(find.id, /^cf-[a-f0-9]{16}$/)
  assert.ok(board.items.every(item => item.notes.every(note => !Object.hasOwn(note, 'id'))), 'identity is only a projection, not a second ledger')
  const reversed = structuredClone(board)
  reversed.items.reverse()
  reversed.items.forEach(item => item.notes.reverse())
  const ids = state => new Set(curiousSnapshot(state).finds.map(find => find.id))
  assert.deepEqual(ids(reversed), new Set(initial.map(find => find.id)))
  const resolved = execute(board, { action: 'resolve', id: first.id }).board
  assert.deepEqual(ids(resolved), ids(board), 'changing a topic status does not remount the same find under a new id')
  const removed = execute(resolved, { action: 'forget', id: first.id }).board
  assert.deepEqual(curiousSnapshot(removed).finds.map(find => find.id), initial.filter(find => find.topicId === second.id).map(find => find.id))
})
