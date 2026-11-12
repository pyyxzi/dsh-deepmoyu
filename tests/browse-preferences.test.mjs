import test from 'node:test'
import assert from 'node:assert/strict'
import { browseSettings, clampBrowseSettings, validateBrowsePatch, snapshotBrowseSettings, browsePreferenceBrief, filterBrowseCandidates, videoDurationSeconds, videoViewCount } from '../lib/browse-preferences.mjs'

const now = Date.parse('2026-11-12T12:00:00Z')
const today = now / 1000 - 3600
const video = (bvid, title, extra = {}) => ({ bvid, title, pubdate: today, duration: 600, play: 100000, ...extra })

test('old configurations gain usable viewing defaults without losing other settings', () => {
  assert.deepEqual(browseSettings({}), { browseTopics: [], browseAvoidKeywords: [], browseExplorePercent: 25, browseMinMinutes: 0, browseMaxMinutes: 0, browseRecentDays: 7, browseSort: 'click', browseMinViews: 50000 })
  assert.deepEqual(clampBrowseSettings({ perDay: 5, browseTopics: ['科技', '未知'], browseRecentDays: '30', browseSort: 'bad' }), { perDay: 5, browseTopics: ['科技'], browseRecentDays: 30, browseSort: 'click' })
  assert.equal(browseSettings({ browseMinMinutes: 30, browseMaxMinutes: 3 }).browseMaxMinutes, 30)
})

test('explicit preference writes reject malformed types, values, and inconsistent ranges', () => {
  for (const patch of [
    { browseTopics: '科技' }, { browseTopics: [42] }, { browseTopics: ['不存在'] }, { browseAvoidKeywords: [null] },
    { browseAvoidKeywords: [''] }, { browseAvoidKeywords: ['a\nb'] }, { browseAvoidKeywords: Array(31).fill('a') },
    { browseRecentDays: '30' }, { browseRecentDays: null }, { browseRecentDays: -1 }, { browseRecentDays: 366 },
    { browseExplorePercent: true }, { browseExplorePercent: 101 }, { browseMinMinutes: [] }, { browseMaxMinutes: 5.5 }, { browseSort: 'views' },
    { browseMinViews: '50000' }, { browseMinViews: -1 }, { browseMinViews: 2000000001 }, { browseMinViews: 1.2 },
  ]) assert.throws(() => validateBrowsePatch(patch), { code: 'CONFIG_INPUT', status: 400 }, JSON.stringify(patch))
  assert.throws(() => validateBrowsePatch({ browseMinMinutes: 20 }, { browseMaxMinutes: 15 }), /最短时长/)
  assert.throws(() => validateBrowsePatch({ browseMaxMinutes: 15 }, { browseMinMinutes: 20 }), /最短时长/)
  assert.doesNotThrow(() => validateBrowsePatch({ browseMinMinutes: 20, browseMaxMinutes: 0 }))
})

test('run preference snapshots remain immutable after later settings edits', () => {
  const config = { browseTopics: ['科技'], browseAvoidKeywords: ['剧透'], keywords: ['DeepSeek'], browseRecentDays: 30 }
  const snapshot = snapshotBrowseSettings(config)
  config.browseTopics.push('美食'); config.keywords[0] = '旅行'; config.browseRecentDays = 1
  assert.deepEqual(snapshot.browseTopics, ['科技']); assert.deepEqual(snapshot.keywords, ['DeepSeek']); assert.equal(snapshot.browseRecentDays, 30)
  assert.throws(() => snapshot.browseTopics.push('美食'), TypeError)
})

test('duration formats from search, ranking and user lists share one unit', () => {
  assert.equal(videoDurationSeconds(600), 600); assert.equal(videoDurationSeconds('10:00'), 600)
  assert.equal(videoDurationSeconds('1:02:03'), 3723); assert.equal(videoDurationSeconds('600'), 600)
  for (const value of ['', 0, null, '10:99', 'abc', {}, -1]) assert.equal(videoDurationSeconds(value), null)
})

test('candidate filters apply real exclusions and preserve unknown metadata for verification', () => {
  const rows = [video('ok', '人工智能做饭'), video('short', '短片', { duration: '01:00' }), video('long', '长片', { duration: 4000 }),
    video('old', '老片', { pubdate: today - 31 * 86400 }), video('avoid', '<em>剧透</em>解析'), video('unknown', '无元数据', { duration: '', pubdate: 0 })]
  const result = filterBrowseCandidates(rows, { browseMinMinutes: 5, browseMaxMinutes: 30, browseRecentDays: 30, browseAvoidKeywords: ['剧透'] }, { now })
  assert.deepEqual(result.items.map(item => item.bvid), ['ok', 'unknown'])
  assert.equal(result.excluded.length, 4)
  assert.deepEqual(result.items[1].preference_check, ['duration', 'pubdate'])
  assert.match(result.items[1].preference_hint, /bili_video_info/)
  assert.equal(result.unknown.length, 1)
  assert.ok(!Object.hasOwn(rows.at(-1), 'preference_check'), 'input rows are not mutated')
  assert.equal(filterBrowseCandidates([rows[3]], { browseRecentDays: 0 }, { now }).items.length, 1, 'unlimited age really admits old videos')
})

test('mixed discovery interleaves familiar interests and unfamiliar content without imposing topic bans', () => {
  const rows = [video('other-1', '生活整理', { play: 1_000_000 }), video('tech-1', 'AI 科技'), video('tech-2', 'DeepSeek 更新'), video('other-2', '爬山日记'), video('tech-3', '数码评测')]
  const result = filterBrowseCandidates(rows, { browseTopics: ['科技'], browseExplorePercent: 50, browseSort: 'mixed' }, { now })
  assert.deepEqual(result.items.map(item => item.bvid), ['tech-1', 'other-1', 'tech-2', 'other-2', 'tech-3'])
  assert.equal(result.excluded.length, 0)
  assert.deepEqual(filterBrowseCandidates(rows, { browseTopics: ['科技'], browseExplorePercent: 100, browseSort: 'mixed' }, { now }).items.slice(0, 2).map(item => item.bvid), ['other-1', 'other-2'])
  assert.deepEqual(filterBrowseCandidates(rows, { browseTopics: ['科技'], browseExplorePercent: 0, browseSort: 'mixed' }, { now }).items.slice(0, 3).map(item => item.bvid), ['tech-1', 'tech-2', 'tech-3'])
})

test('explicit sort choices do not get overwritten by mandatory popularity ranking', () => {
  const rows = [video('first', '第一条', { play: 10, pubdate: today - 100 }), video('newest', '新条目', { play: 1, pubdate: today }), video('hot', '热门', { play: 99, pubdate: today - 200 })]
  assert.deepEqual(filterBrowseCandidates(rows, { browseSort: 'totalrank', browseMinViews: 0 }, { now }).items.map(item => item.bvid), ['first', 'newest', 'hot'])
  assert.equal(filterBrowseCandidates(rows, { browseSort: 'pubdate', browseMinViews: 0 }, { now }).items[0].bvid, 'newest')
  assert.equal(filterBrowseCandidates(rows, { browseSort: 'click', browseMinViews: 0 }, { now }).items[0].bvid, 'hot')
  assert.match(browsePreferenceBrief({ browseRecentDays: 0, browseExplorePercent: 50 }), /不限，旧片也可以/)
  assert.match(browsePreferenceBrief({ browseTopics: ['美食'], browseAvoidKeywords: ['剧透'] }), /美食/)
})

test('popular defaults exclude known low views and sort real counts while unknown popularity must be verified', () => {
  const rows = [video('low', '低播放', { play: '4.9万' }), video('zero', '无播放', { play: 0 }),
    video('medium', '热门片', { play: '12.5万' }), video('high', '热榜片', { play: '2,300,000' }),
    video('missing', '待查详情', { play: '--' })]
  const before = structuredClone(rows)
  const result = filterBrowseCandidates(rows, {}, { now })
  assert.deepEqual(result.items.map(row => row.bvid), ['high', 'medium', 'missing'])
  assert.equal(result.items[1].view_count, 125000)
  assert.deepEqual(result.items[2].preference_check, ['views'])
  assert.deepEqual(result.excluded.map(row => row.bvid), ['low', 'zero'])
  assert.ok(result.excluded.every(row => row.reason === '低于设置的最低播放量'))
  assert.deepEqual(rows, before)
  assert.equal(videoViewCount({ play: '1.2亿' }), 120000000)
  assert.equal(videoViewCount({ play: '12.5万次播放' }), 125000)
  assert.equal(videoViewCount({ stat: { view: 50000 } }), 50000)
  assert.equal(videoViewCount({ play: null }), null)
  assert.equal(filterBrowseCandidates([rows[0]], { browseMinViews: 0 }, { now }).items.length, 1)
  assert.match(browsePreferenceBrief({}), /播放量至少 50,000/)
})
