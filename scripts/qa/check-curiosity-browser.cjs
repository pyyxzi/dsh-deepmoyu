/** Real React journal acceptance with synthetic local records and mocked host routes. */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { makeFixturePage } = require('./ui-browser-fixture.cjs')
const { openChrome } = require('./browser-cdp.cjs')
const { CLIENT, qaOutput } = require('./paths.cjs')
const output = qaOutput('curiosity')
const clientSource = fs.readFileSync(CLIENT, 'utf8')
const at = '2026-11-12T10:00:00Z'
const status = { ok: true, rev: 'curiosity-fixture', loggedIn: true, venvReady: true, ranToday: 1, bgBusy: false,
  config: { sessionModelId: 'fixture/session', sessionTokenBudget: 120000, sessionMaxRounds: 64, learnAutoReview: false },
  feiyu: { active: false }, models: [], toolScope: { checked: true, supported: true } }
const fixtures = { curiosity: { revision: 1, items: [
  { id: 'curiosity-fish', origin: 'fish', status: 'active', question: '老电影里的雨声是怎么做出来的？', query: '电影 拟音 雨声', bvid: 'BV1bKJX6mEnY', version: 3, createdAt: at, updatedAt: at,
    notes: [
      { bvid: 'BV1bKJX6mEnY', text: '录音师抖动一张薄金属片，听起来居然像远处的雷声。', seconds: 83, url: 'https://www.bilibili.com/video/BV1bKJX6mEnY?t=83', at },
      { bvid: 'BV1bKJX6mEnY', text: '雨声也会分近处的水滴和远处的环境声，叠在一起才有空间感。', seconds: 147, url: 'https://www.bilibili.com/video/BV1bKJX6mEnY?t=147', at },
    ] },
  { id: 'curiosity-user', origin: 'user', status: 'paused', question: '手工修表时怎么判断零件磨损？', query: '修表 磨损', version: 1, createdAt: at, updatedAt: at, notes: [] },
] } }
const probe = String.raw`
let ran=0;const check=(yes,label)=>{ran++;if(!yes)throw Error(label)};
const journal=()=>document.querySelector('[data-bd-curiosity-journal]'),summary=()=>journal().querySelector(':scope>summary');
const calls=(route,method)=>F.requests.filter(request=>request.path.endsWith(route)&&(!method||request.method===method));
const rows=()=>[...document.querySelectorAll('[data-bd-curiosity-id]')],row=id=>rows().find(node=>node.getAttribute('data-bd-curiosity-id')===id);
const button=(label,within=journal())=>[...within.querySelectorAll('button')].find(node=>node.textContent.trim()===label);
const input=()=>document.querySelector('[aria-label="留一个好奇的问题"]');
check(document.querySelectorAll('[data-bd-pet-tab]').length===6,'Journal does not add a navigation group');
check(!journal().open&&calls('/curiosity').length===0,'Closed journal does not fetch or eagerly create its content');
check([...document.querySelectorAll('[data-bd-launch-action]')].every(node=>F.inView(F.rect(node))),'Both launch actions stay visible before the journal');
summary().focus();check(document.activeElement===summary(),'Journal disclosure is keyboard focusable');
await F.click(summary());await F.waitFor(()=>rows().length===2,'journal loaded');
check(calls('/curiosity','GET').length===1&&![...F.intervals.values()].some(timer=>timer.ms===15000),'Expanded journal pulls once without idle polling');
check(row('curiosity-fish').textContent.includes('她从看过的内容里想到的')&&row('curiosity-user').textContent.includes('你留下的问题'),'Question provenance is explicit');
check(row('curiosity-fish').querySelector('[data-bd-journal-source]').getAttribute('href')==='https://www.bilibili.com/video/BV1bKJX6mEnY','A fish-origin topic links its actual source video');
check(journal().textContent.includes('管理手帐只影响之后选题')&&journal().textContent.includes('运行控制中暂停'),'Journal management does not pretend to stop an already frozen exploration goal');
check(row('curiosity-user').querySelector('[data-bd-curiosity-explore]').disabled,'Paused questions do not start until resumed');
await F.change(input(),'为什么面包放久了会变硬？');await F.click(button('留个问题'));
await F.waitFor(()=>rows().length===3,'new question created');
const opened=calls('/curiosity','POST').at(-1).body;
check(JSON.stringify(opened)==='{"action":"open","question":"为什么面包放久了会变硬？","query":"为什么面包放久了会变硬？"}','A single question field creates the local topic without a second query editor');
check(input().value===''&&calls('/pet/start').length===0,'Leaving a question clears the draft and does not start or send anything');
const fish=row('curiosity-fish');await F.click(fish.querySelector('[data-bd-journal-manage]>summary'));await F.click(button('先放一放',fish));
check(calls('/curiosity','POST').at(-1).body.version===3&&row('curiosity-fish').querySelector('[data-bd-curiosity-explore]').disabled,'Pause binds the displayed version and updates the launch state');
await F.click(row('curiosity-fish').querySelector('[data-bd-journal-manage]>summary'));
if(!row('curiosity-fish').querySelector('[data-bd-journal-manage]').open)await F.click(row('curiosity-fish').querySelector('[data-bd-journal-manage]>summary'));
await F.click(button('接着惦记',row('curiosity-fish')));
check(calls('/curiosity','POST').at(-1).body.version===4&&!row('curiosity-fish').querySelector('[data-bd-curiosity-explore]').disabled,'Resume uses the newer version');
const beforeFinds=F.requests.length;await F.click(document.querySelector('[data-bd-journal-pane=finds]'));
const find=document.querySelector('[data-bd-find-id]'),firstFind=find.getAttribute('data-bd-find-id');
check(/^cf-[a-f0-9]{16}$/.test(firstFind)&&journal().textContent.includes('不代表逐句核验'),'Find identity is derived from real note fields and provenance does not claim verified truth');
check(find.textContent.includes('1:23')&&find.querySelector('a').getAttribute('href').includes('?t=83'),'Keepsake carries real video evidence and a timestamp link');
await F.click(button('再翻一张'));
check(document.querySelector('[data-bd-find-id]').getAttribute('data-bd-find-id')!==firstFind&&F.requests.length===beforeFinds,'Turning a keepsake stays local and does not call a model or API');
await F.click(document.querySelector('[data-bd-journal-pane=explore]'));
F.queueReply('POST','/pet/start',F.reply(200,{ok:false,error:'QA_EXPLORATION_START_FAILED'}));
await F.click(row('curiosity-fish').querySelector('[data-bd-curiosity-explore]'));
await F.waitFor(()=>document.querySelector('[data-bd-pet-modal]').textContent.includes('QA_EXPLORATION_START_FAILED'),'launch failure feedback');
const launch=calls('/pet/start','POST').at(-1).body;
check(launch.mode==='session'&&launch.curiosityId==='curiosity-fish'&&launch.model==='fixture/session'&&launch.tokenBudget===120000,'Exploring reuses actual session launch and existing run parameters');
check(row('curiosity-fish')&&document.querySelector('[data-bd-pet-modal]').textContent.includes('fixture-new-session'),'Failed start preserves both the local topic and the created session receipt');
check(!F.requests.some(request=>/comment|moment|send-review/.test(request.path)),'Journal actions do not enable or invoke platform sending');
await F.click(row('curiosity-fish').querySelector('[data-bd-curiosity-explore]'));await F.waitFor(()=>F.openedSessions.includes('fixture-new-session'),'successful exploration opens its real session');
check(calls('/pet/session-new','POST').length===2&&calls('/pet/start','POST').length===2,'Explore has an actual creation and start round-trip');
const managed=row('curiosity-fish').querySelector('[data-bd-journal-manage]');if(!managed.open)await F.click(managed.querySelector('summary'));
F.queueReply('POST','/curiosity',F.reply(409,{ok:false,code:'CURIOSITY_STALE',error:'这条记录已经变化，请刷新后重试'}));
await F.click(button('这次先到这',row('curiosity-fish')));
check(journal().textContent.includes('刷新后核对')&&row('curiosity-fish'),'Stale record conflicts explain refresh without deleting the displayed topic');
await F.click(button('刷新手帐'));await F.waitFor(()=>!journal().textContent.includes('刷新后核对'),'explicit refresh recovers conflict');
const finishMenu=row('curiosity-fish').querySelector('[data-bd-journal-manage]');if(!finishMenu.open)await F.click(finishMenu.querySelector('summary'));
await F.click(button('这次先到这',row('curiosity-fish')));
check(row('curiosity-fish').textContent.includes('已收起')&&!row('curiosity-fish').textContent.includes('想明白')&&row('curiosity-fish').querySelector('[data-bd-curiosity-explore]').disabled,'Closing an unresolved lead does not claim its question was answered');
const hold=F.deferReply('GET','/curiosity'),beforeHold=calls('/curiosity','GET').length;
await F.click(button('刷新手帐'));await F.waitFor(()=>calls('/curiosity','GET').length===beforeHold+1,'held refresh');
check(button('刷新手帐').disabled,'Reading is single-flight');
await F.click(summary());await F.click(summary());
check(calls('/curiosity','GET').length===beforeHold+1,'Collapse and reopen do not overlap the in-flight request');
hold.release(200,{ok:true,revision:999,counts:{active:1},items:[{id:'stale',question:'STALE_CURIOSITY_SENTINEL',status:'active',origin:'user',notes:[],version:1}],finds:[]});
await F.waitFor(()=>calls('/curiosity','GET').length===beforeHold+2&&rows().length===3,'fresh read after stale request');
check(!journal().textContent.includes('STALE_CURIOSITY_SENTINEL'),'A late closed-view response never replaces fresh journal entries');
F.queueReply('GET','/curiosity',F.reply(404,{ok:false,error:'QA_JOURNAL_NOT_LOADED'}));await F.click(button('刷新手帐'));
check(journal().textContent.includes('QA_JOURNAL_NOT_LOADED')&&rows().length===3,'Read failures retain existing notes and show an error');
await F.click(button('刷新手帐'));await F.waitFor(()=>!journal().textContent.includes('QA_JOURNAL_NOT_LOADED'),'read manually recovered');
const keep=row('curiosity-user');await F.click(keep.querySelector('[data-bd-journal-manage]>summary'));
window.confirm=()=>false;const beforeForget=calls('/curiosity','POST').length;await F.click(button('忘记这条',keep));
check(calls('/curiosity','POST').length===beforeForget,'Cancelled forgetting does not write');
window.confirm=()=>true;await F.click(button('忘记这条',keep));
check(!row('curiosity-user')&&calls('/curiosity','POST').at(-1).body.version===1,'Forgetting only removes the selected versioned local topic');
await F.change(input(),'提交期间也想接着写的问题');const saveDraft=F.deferReply('POST','/curiosity');await F.click(button('留个问题'));
await F.waitFor(()=>button('正在记下…'),'question submission in flight');
await F.change(input(),'保存期间新写的第二个问题');
const heldBook=F.data.fixtures.curiosity;
heldBook.items.unshift({id:'cq-0000000000000001',question:'提交期间也想接着写的问题',query:'提交期间也想接着写的问题',status:'active',origin:'user',version:1,notes:[],createdAt:'2026-11-12T10:00:00.000Z',updatedAt:'2026-11-12T10:00:00.000Z'});heldBook.revision++;
const heldCounts={active:0,paused:0,resolved:0,total:heldBook.items.length};for(const item of heldBook.items)heldCounts[item.status]++;
const heldFinds=heldBook.items.flatMap(item=>(item.notes||[]).map(note=>({...note,id:F.data.curiosityFindIds[JSON.stringify([item.id,note.bvid,note.text,note.seconds])],topicId:item.id,question:item.question,status:item.status})));
saveDraft.release(200,{ok:true,items:structuredClone(heldBook.items),counts:heldCounts,finds:heldFinds,revision:heldBook.revision});
await F.waitFor(()=>button('留个问题')&&!button('留个问题').disabled,'question submission completed');
check(input().value==='保存期间新写的第二个问题','A completed save only clears its submitted question and preserves a newer draft');
const readsBeforeLeave=calls('/curiosity','GET').length;await F.click(summary());await F.click(document.querySelector('#bd-tab-basic'));await F.wait(40);
check(calls('/curiosity','GET').length===readsBeforeLeave&&!document.querySelector('[data-bd-curiosity-journal]'),'Collapsing and leaving cause no new journal calls');
check(!F.unknownRequests.length,'All fixture routes are explicit');
F.finish({ok:true,checks:ran,requests:F.requests.length});
`
async function main() {
  fs.mkdirSync(output, { recursive: true })
  const browser = await openChrome({ output })
  try {
    for (const [name, width, height] of [['desktop', 1280, 900], ['mobile', 390, 844]]) {
      const file = path.join(output, name + '.html')
      fs.writeFileSync(file, makeFixturePage({ clientSource, status, fixtures: structuredClone(fixtures), tab: 'run', probe }))
      await browser.size(width, height); await browser.navigate(file)
      await browser.until("document.title==='fixture done'", 'curiosity ' + name, 300)
      const result = await browser.driver.evaluate('JSON.parse(document.getElementById("fixture-result").textContent)')
      assert.deepEqual(result.errors, [], JSON.stringify(result)); assert.equal(result.ok, true, JSON.stringify(result))
      fs.writeFileSync(path.join(output, name + '-results.json'), JSON.stringify(result, null, 2))
      console.log('PASS curiosity ' + name + ': ' + result.checks + ' local topics, evidence, launches, version conflicts and lifecycle checks')
    }
    for (const [name, overrides] of [['running', { feiyu: { active: true } }], ['unsupported', { toolScope: { checked: true, supported: false } }]]) {
      const file = path.join(output, name + '.html')
      const blockedProbe = String.raw`const journal=document.querySelector('[data-bd-curiosity-journal]');await F.click(journal.querySelector('summary'));await F.waitFor(()=>document.querySelector('[data-bd-curiosity-explore]'),'blocked topic loaded');const launch=document.querySelector('[data-bd-curiosity-explore]');if(!launch.disabled)throw Error('Unavailable exploration is not disabled');await F.click(launch);if(F.requests.some(row=>/\/pet\/(start|session-new)$/.test(row.path)))throw Error('Unavailable exploration created a task');F.finish({ok:true,checks:2});`
      fs.writeFileSync(file, makeFixturePage({ clientSource, status: { ...status, ...overrides }, fixtures: structuredClone(fixtures), tab: 'run', probe: blockedProbe }))
      await browser.navigate(file); await browser.until("document.title==='fixture done'", name)
      const result = await browser.driver.evaluate('JSON.parse(document.getElementById("fixture-result").textContent)')
      assert.deepEqual(result.errors, [], JSON.stringify(result)); assert.equal(result.ok, true, JSON.stringify(result))
      console.log('PASS curiosity ' + name + ': ' + result.checks + ' unavailable-launch checks')
    }
  } finally { await browser.close() }
}
module.exports = { curiosityFixture: (options = {}) => makeFixturePage({ clientSource, status, fixtures: structuredClone(fixtures), tab: 'run', ...options }) }
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
