/** Build an isolated real-React memory-center browser QA page. No real host/account data. */
const fs = require('node:fs')
const path = require('node:path')
const { makeFixturePage } = require('./ui-browser-fixture.cjs')
const { CLIENT, qaOutput } = require('./paths.cjs')
const at = '2026-10-29T10:30:00.000Z'
const status = { ok: true, rev: 'memory-qa', config: { learnAutoReview: false, idleChatter: false }, models: [],
  learn: { total: 8, pending: 2, approved: 5, rejected: 1, kinds: ['fact', 'style'], labels: { fact: '场子常识', style: '说话方式' } },
  learnReview: { enabled: false, running: false, pending: 2 },
  soul: { text: '## 最近的心情\n- 纸张动画的留白看着很舒服\n\n## 惦记的事\n- 还想看看那个修表的系列', chars: 48, budget: 900, empty: false, updatedAt: at, filled: ['mood', 'crave'], counts: { mood: 1, crave: 1 } },
  seen: { videos: 159, videosToday: 4, replied: 19 },
  taste: { sample: 5, checked: 3, enough: false, lines: ['目前赞数规模还不够，先不把这几条发言当成规律。'], rows: [], top: [], updatedAt: at },
}
const item = (source, id, label, text, extra = {}) => ({ source, id, label, text, at, from: source === 'learning' ? 'BV1bKJX6mEnY' : source + '.md', version: 'a'.repeat(64), mutable: !['seen', 'history'].includes(source), actions: ['seen', 'history'].includes(source) ? [] : ['forget'], ...extra })
const fixtures = { learn: { ok: true, items: [], matched: 0, more: false }, memory: { items: [
  item('learning', 'fact:one', '场子常识', '纸张动画的留白能让主体更清楚', { state: 'approved', actions: ['revoke', 'forget'] }),
  item('learning', 'style:two', '说话方式', '先说慢一点，再给具体细节', { state: 'pending' }),
  item('soul', 'mood:0', '最近的心情', '纸张动画的留白看着很舒服'),
  item('voice', '2', '语气札记', '真正好玩的细节值得停一下，不用每句都抖机灵'),
  item('taste', '123', '口味样本', '这个旋钮的手感隔着屏幕都想摸摸', { likes: 3, checked: true }),
  item('seen', 'BV1bKJX6mEnY', '浏览历史', 'BV1bKJX6mEnY · 修表的老手艺'),
  item('history', 'old-soul', '记忆版本', 'soul.md · manual-forget · 已保留的旧版本'),
] } }
const probe = String.raw`
const checks=[],check=(label,pass)=>{checks.push({label,pass:Boolean(pass)});if(!pass)throw Error(label)};
const modal=document.querySelector('[data-bd-pet-modal]'),scope=selector=>modal.querySelector(selector),rows=()=>[...modal.querySelectorAll('[data-bd-memory-result]')];
const source=()=>scope('[aria-label="记忆来源"]'),search=()=>scope('[aria-label="搜索所有记忆"]');
const button=(text,within=modal)=>[...within.querySelectorAll('button')].find(el=>el.textContent.trim()===text);
await F.waitFor(()=>rows().length===7,'all memory rows');
check('七类记忆可读，历史只读',rows().length===7&&rows().filter(el=>el.textContent.includes('浏览历史')||el.textContent.includes('记忆版本')).every(el=>!el.querySelector('button')));
await F.change(search(),'纸张');await F.waitFor(()=>rows().length===2,'cross-source search');
check('关键词跨学习和心情命中',rows().some(el=>el.textContent.includes('学习经验'))&&rows().some(el=>el.textContent.includes('心情记录')));
await F.change(source(),'soul');await F.waitFor(()=>rows().length===1,'soul source');
const posts=()=>F.requests.filter(r=>r.path.endsWith('/memory')&&r.method==='POST');
window.confirm=()=>false;await F.click(button('从当前记忆移除'));
check('取消确认没有发送操作',posts().length===0);
window.confirm=()=>true;await F.click(button('从当前记忆移除'));await F.waitFor(()=>rows().length===0,'removed soul row');
check('心情删除绑定当前展示版本',posts().at(-1).body.source==='soul'&&posts().at(-1).body.id==='mood:0'&&posts().at(-1).body.version==='a'.repeat(64));
await F.change(search(),'');await F.change(source(),'learning');await F.waitFor(()=>rows().length===2,'learning records');
await F.click(button('撤销批准'));await F.waitFor(()=>rows().find(el=>el.textContent.includes('纸张动画'))?.textContent.includes('已拒绝'),'revoked projection');
check('撤销后新列表不再显示旧批准与旧操作',!button('撤销批准')&&rows().find(el=>el.textContent.includes('纸张动画')).textContent.includes('已拒绝'));
await F.change(source(),'taste');await F.waitFor(()=>rows().length===1,'taste records');
F.queueReply('POST','/memory',F.reply(409,{ok:false,error:'MEMORY_CHANGED_REFRESH_REQUIRED'}));
await F.click(button('从当前记忆移除'));await F.waitFor(()=>scope('[data-bd-msg][data-warn]')?.textContent.includes('记录已发生变化'),'stale conflict message');
check('并发变化不误删且显示核对提示',rows().length===1&&modal.textContent.includes('记录已发生变化'));
await F.change(source(),'all');await F.waitFor(()=>rows().length===6,'all refreshed after actions');
check('跨来源查询不残留已忘记的心情',!rows().some(el=>el.textContent.includes('心情记录')));
check('无横向页面溢出',document.documentElement.scrollWidth<=innerWidth+1&&modal.getBoundingClientRect().right<=innerWidth+1);
check('原学习审核与soul操作仍可见',Boolean(button('开始批量审核'))&&Boolean(button('清除章节')));
F.finish({checks,ready:true,requests:F.requests,errors:F.errors,unknownRequests:F.unknownRequests});
`
function memoryFixture({ visual = false } = {}) {
  return makeFixturePage({ clientSource: fs.readFileSync(CLIENT, 'utf8'), status, fixtures, tab: 'learning', probe: visual ? '' : probe })
}
if (require.main === module) {
  const output = path.resolve(process.argv[2] || path.join(qaOutput('memory'), 'memory-center.html'))
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, memoryFixture({ visual: process.argv.includes('--visual') }), 'utf8')
  console.log(output)
}
module.exports = { memoryFixture }
