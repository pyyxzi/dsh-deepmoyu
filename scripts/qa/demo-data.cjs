const { stickerFixture } = require('./ui-browser-fixture.cjs')

/** Synthetic demonstration records only; no account, credential, local path or real model route. */
function demoData() {
  const day = '2026-10-29', at = day + 'T10:30:00.000Z'
  const learned = Array.from({ length: 8 }, (_, index) => ({ id: 'fact:demo-' + index, kind: 'fact', label: '场子常识',
    text: ['从具体细节理解手工制作过程', '比较不同材料的纹理与光泽', '记录完整观看后的判断', '区分观点和可核对的事实'][index % 4],
    from: '演示素材', at, state: index < 2 ? 'pending' : index === 7 ? 'rejected' : 'approved', version: 1,
    example: '演示例句，仅供界面展示。', why: index > 1 ? '演示审核记录' : '' }))
  const memory = learned.slice(0, 3).map((row) => ({ source: 'learning', ...row, version: 'a'.repeat(64), mutable: true, actions: row.state === 'approved' ? ['revoke', 'forget'] : ['forget'] }))
  memory.push({ source: 'soul', id: 'mood:0', label: '最近的心情', text: '对手工制作中的细节产生了新的兴趣。', from: '角色记忆', at, mutable: true, version: 'b'.repeat(64), actions: ['forget'] })
  const status = { ok: true, rev: 'demonstration', today: day, loggedIn: true, venvReady: true, petShow: true,
    bgBusy: false, ranToday: 2, pickedToday: 3, tokensToday: 18400, tokensTotal: 128400, activeDays: 4,
    config: { perDay: 5, reportLevel: 'full', dmMode: 'off', autoComment: false, replyToComments: false, autoReplyDm: false, autoMoment: false,
      persona: '', keywords: ['科技', '手工制作'], workspace: '', idleChatter: true, interactionStyle: 'companion',
      sessionModelId: '演示模型', sessionTokenBudget: 120000, sessionMaxRounds: 64, sessionMinutes: 0,
      backgroundModelId: '演示模型', backgroundTokenBudget: 60000, backgroundMinutes: 45, backgroundWindowStart: '20:00', backgroundWindowEnd: '22:00',
      totalTokenBudget: 1000000, chatterFrequency: 'normal', notificationLevel: 'normal', quietHoursStart: '23:00', quietHoursEnd: '08:00',
      learnAutoReview: false, learnReviewModelId: '演示模型', stickerReview: true, stickerAutoCollect: false, stickerAutoSend: false },
    models: [{ id: '演示模型', label: '演示模型' }], modelNow: '演示模型',
    feiyu: { active: false, model: '演示模型', goal: null, tokens: { thisRun: 18400, budget: 120000 } },
    companion: { reducedMotion: false, silenced: false, notificationLevel: 'normal', label: '自然陪伴' },
    mood: 'curious', attention: { level: 'none', reasons: [] }, petEvent: null,
    bgWindow: { start: '20:00', end: '22:00', active: false, holdUntil: 0 }, schedule: { inWindow: false },
    learn: { pending: 2, approved: 5, rejected: 1, total: 8, kinds: ['fact'], labels: { fact: '场子常识' } },
    learnReview: { enabled: false, running: false, pending: 2, approved: 0, rejected: 0 },
    soul: { empty: false, filled: ['mood', 'crave'], chars: 58, budget: 900, updatedAt: at,
      text: '## 最近的心情\n- 对手工制作中的细节产生了新的兴趣。\n\n## 惦记的事\n- 继续了解材料和工具的选择。' },
    seen: { videos: 36, videosToday: 4, replied: 0 },
    taste: { sample: 4, checked: 3, enough: false, lines: ['目前样本不足，暂不生成趋势判断。'], rows: [], top: [], updatedAt: at },
    tokenDays: { [day]: 18400, '2026-10-28': 22100, '2026-10-27': 9600 },
    tokenRounds: { ok: true, entries: [{ id: 'demo-session', kind: 'session', label: '会话任务', model: '演示模型', startedAt: at,
      rounds: 2, durationSec: 960, tokens: { total: 18400, input: 16800, output: 1600 }, stopReason: 'user' }] },
    retrospective: { totals: { activeDays: 4, reportDays: 4, picks: 12, runs: 8, tokenDays: 4, tokens: 84500 },
      days: Array.from({ length: 7 }, (_, index) => ({ day: '2026-10-' + String(23 + index), picks: index < 3 ? null : 3, report: index > 2, runs: index > 2 ? 2 : 0, tokenKnown: index > 2, tokens: index > 2 ? 18000 : null })),
      themes: [{ title: '科技与工具', count: 3, sources: [] }, { title: '手工与材料', count: 2, sources: [] }],
      changes: { available: false, coverage: { currentReportDays: 4, previousReportDays: 0 } } },
    recovery: { needsAction: false, rows: [{ id: 'demo-idle', state: 'idle', label: '暂无需要恢复的任务', detail: '会话、后台和视频任务均未运行。', action: 'run', actionLabel: '查看运行方式' }] },
    mirror: { dir: '', auto: true, files: [] },
    sendReview: { ok: true, rev: 'demo-review', pending: 0, unknown: 0 },
  }
  const stickers = stickerFixture(12)
  for (const [index, item] of stickers.stickers.entries()) item.fixtureImage = require('./ui-browser-fixture.cjs').stickerImage(item.name, index)
  const fixtures = { learn: { ok: true, items: learned, matched: learned.length }, memory: { items: memory }, stickers,
    sendReview: { ok: true, rev: 'demo-review', pending: 0, unknown: 0, items: [] },
    activity: { ok: true, rows: [{ id: 'demo-read', uid: 'demo-read', kind: 'done', text: '已读取字幕，整理内容判断。', t: Date.parse(at) }], live: { active: false } },
    logs: { ok: true, rev: 'demo-logs', entries: [{ eventId: 'demo-finished', type: 'bg-end', at, reason: 'exit', model: '演示模型' }] },
    pv: { ok: true, deps: true, yesterday: '2026-10-28', modelId: '演示模型', voice: 'zh-CN-XiaoyiNeural', running: false, productions: [], videos: [], sessions: [], failures: [], auto: false, at: '10:30' },
  }
  return { status, fixtures }
}
module.exports = { demoData }
