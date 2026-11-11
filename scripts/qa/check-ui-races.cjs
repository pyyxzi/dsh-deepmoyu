/** Execute deferred HTTP races in real React; all data stays in an isolated browser. */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { makeFixturePage } = require('./ui-browser-fixture.cjs')
const { openChrome } = require('./browser-cdp.cjs')
const { CLIENT, qaOutput } = require('./paths.cjs')
const output = qaOutput('polling-races')
const clientSource = fs.readFileSync(CLIENT, 'utf8')
const base = { ok: true, rev: 'r0', loggedIn: false, venvReady: true, petShow: true, config: { idleChatter: false },
  models: [], activity: [], feiyu: { active: false }, companion: { reducedMotion: true, silenced: false, notificationLevel: 'normal' } }
const probes = [
  { name: 'status', target: 'root', code: String.raw`
    const poll=[...F.intervals.values()].find(x=>x.ms===5000);
    const old=structuredClone(F.data.status),before=F.requests.filter(r=>r.path.endsWith('/status')).length;
    const hold=F.deferReply('GET','/status'),pending=poll.callback();await F.wait(30);await poll.callback();await poll.callback();
    if(F.requests.filter(r=>r.path.endsWith('/status')).length!==before+1)throw Error('Overlapping status requests');
    document.querySelector('[data-bd-pet-fish]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
    await F.waitFor(()=>F.textButton('隐藏桌宠'),'menu');await F.click(F.textButton('隐藏桌宠'));
    await F.waitFor(()=>document.querySelector('[data-bd-pet-dot]'),'local hide save');
    hold.release(200,{...old,petShow:true,rev:'stale'});await pending;await F.wait(30);
    if(!document.querySelector('[data-bd-pet-dot]'))throw Error('Late HTTP reverted local save');
    await poll.callback();await F.wait(30);
    if(!document.querySelector('[data-bd-pet-dot]'))throw Error('Next poll reverted confirmed server save');
    F.finish({ok:true,checks:3});` },
  { name: 'activity', tab: 'logs', logMode: 'activity', code: String.raw`
    const poll=[...F.intervals.values()].find(x=>x.ms===2500);
    const before=F.requests.filter(r=>r.path.endsWith('/activity')&&r.method==='GET').length;
    const hold=F.deferReply('GET','/activity'),pending=poll.callback();await F.wait(30);await poll.callback();
    if(F.requests.filter(r=>r.path.endsWith('/activity')&&r.method==='GET').length!==before+1)throw Error('Overlapping activity requests');
    await F.click(F.textButton('清屏'));
    hold.release(200,{ok:true,rows:[{id:'old-call',uid:'old-cursor',kind:'done',text:'OLD_ACTIVITY_SENTINEL'}],last:'old-cursor',live:{active:true,thinking:true}});
    await pending;await F.wait(30);if(document.querySelector('[data-bd-act]').textContent.includes('OLD_ACTIVITY_SENTINEL'))throw Error('Clear restored an old response');
    await poll.callback();const latest=F.requests.filter(r=>r.path.endsWith('/activity')&&r.method==='GET').at(-1);
    if(latest.search.includes('old-cursor'))throw Error('Activity cursor rolled back after clear');
    F.finish({ok:true,checks:3});` },
  { name: 'login', tab: 'other', code: String.raw`
    let counter=0;F.handlers.set('POST /login/start',()=>F.reply(200,{ok:true,key:'qr-'+(++counter),qr:F.data.face}));
    await F.click(F.textButton('扫码登录'));
    const first=[...F.intervals.values()].find(x=>x.ms===2000),before=F.requests.filter(r=>r.path.endsWith('/login/poll')).length;
    const old=F.deferReply('POST','/login/poll'),pending=first.callback();await F.wait(30);await first.callback();
    if(F.requests.filter(r=>r.path.endsWith('/login/poll')).length!==before+1)throw Error('Overlapping login polls');
    await F.click(F.textButton('扫码登录'));
    const second=[...F.intervals.values()].find(x=>x.ms===2000);
    F.queueReply('POST','/login/poll',F.reply(200,{ok:true,state:'ok'}));await second.callback();await F.wait(30);
    if(!document.querySelector('[data-bd-settings-page=other]').innerText.includes('登录成功'))throw Error('New QR login did not finish');
    old.release(200,{ok:true,state:'expired'});await pending;await F.wait(30);
    const visible=document.querySelector('[data-bd-settings-page=other]').innerText;
    if(!visible.includes('登录成功')||visible.includes('二维码过期'))throw Error('Old QR response overwrote successful login');
    F.finish({ok:true,checks:3});` },
  /* ⭐ P3-40：pv 轮询 dead 链（视频工作室那卡是 setTimeout 自续链，防重叠靠 dead 标志）。
     证明：切走 tab（effect cleanup → dead=true）后，在飞的晚到响应必须被丢弃，
     且 dead 闭包不得再续链补枪 /pv —— 保护被拆掉时旧响应会回写 state 并在 3 秒后
     又发一次 /pv，请求计数立刻露馅。 */
  { name: 'pv-chain', tab: 'video', attempts: 400, fixtures: { pv: { ok: true, deps: true, running: true, yesterday: '2026-10-27', modelId: 'fixture/sky', date: '2026-10-27', stage: 'render', ms: 92000, auto: false, at: '10:30', voice: 'zh-CN-XiaoyiNeural', videos: [], productions: [{ id: 'fixture-pv-a', date: '2026-10-27', mode: 'daily', title: '合成成片 A', file: 'C:/synthetic-fixture/a.mp4', stage: 'done', verification: { ok: true }, sessionId: 'fixture-author-a' }], sessions: [{ sessionId: 'fixture-author-a', productionId: 'fixture-pv-a', date: '2026-10-27', mode: 'daily', model: 'fixture/sky', stage: 'done' }] } }, code: String.raw`
    const count=()=>F.requests.filter(r=>r.path.endsWith('/pv')).length;
    if(count()!==1)throw Error('Expected one mount pull, got '+count());
    const hold=F.deferReply('GET','/pv');
    await F.click(document.querySelector('#bd-tab-logs'));
    await F.click(document.querySelector('#bd-tab-video'));
    await F.waitFor(()=>count()===2,'remount pull in flight');
    await F.click(document.querySelector('#bd-tab-logs'));
    hold.release(200,{ok:true,running:true,deps:true,modelId:'STALE-MODEL',yesterday:'2026-10-27',at:'23:59',voice:'STALE-VOICE',videos:[],productions:[{id:'stale-pv',date:'2026-10-26',mode:'daily',title:'STALE_PV_SENTINEL',file:'C:/stale.mp4',stage:'done',verification:{ok:true}}],sessions:[]});
    await F.wait(3400);
    if(count()!==2)throw Error('Dead pv chain kept polling after cleanup ('+count()+' requests)');
    await F.click(document.querySelector('#bd-tab-video'));
    await F.waitFor(()=>count()===3,'remount pull recorded');
    await F.wait(80);
    const body=document.querySelector('[data-bd-pet-body]').textContent;
    if(body.includes('STALE_PV_SENTINEL')||body.includes('STALE-MODEL'))throw Error('Late response leaked into video page');
    F.finish({ok:true,checks:4});` },
  /* ⭐ P3-40：pet/log 运行日志轮询（同样 setTimeout 自续链 + dead 标志）。
     证明：切走 tab 后在飞的晚到响应被丢弃 —— 关键观察点是 rev 引用不消费旧响应的
     rev（一旦消费，切回来那一拉会带上 &rev=STALE-REV，URL 直接露馅）。 */
  { name: 'pet-log', tab: 'logs', code: String.raw`
    const count=()=>F.requests.filter(r=>r.path.endsWith('/pet/log')).length;
    if(count()!==1)throw Error('Expected one mount pull, got '+count());
    const hold=F.deferReply('GET','/pet/log');
    await F.click(document.querySelector('#bd-tab-run'));
    await F.click(document.querySelector('#bd-tab-logs'));
    await F.waitFor(()=>count()===2,'held pull in flight');
    await F.click(document.querySelector('#bd-tab-run'));
    hold.release(200,{ok:true,rev:'STALE-REV',entries:[{at:'2026-11-12T00:00:00.000Z',type:'call',text:'STALE_LOG_SENTINEL'}]});
    await F.wait(60);
    await F.click(document.querySelector('#bd-tab-logs'));
    await F.waitFor(()=>count()===3,'remount pull recorded');
    const latest=F.requests.filter(r=>r.path.endsWith('/pet/log')).at(-1);
    if(latest.search.includes('STALE-REV'))throw Error('Dead pet/log pull consumed a stale rev into its cursor');
    await F.waitFor(()=>document.querySelector('[data-bd-pet-body]').textContent.includes('还没有运行记录'),'fresh empty log rendered');
    if(document.querySelector('[data-bd-pet-body]').textContent.includes('STALE_LOG_SENTINEL'))throw Error('Stale log rows leaked into view');
    F.finish({ok:true,checks:4});` },
  /* ⭐ P3-40：学习队列的晚到响应（seq 代际 + 视图快照 + 单飞 learnPulling 三重保护）。
     证明：拉取在飞时连续切两次视图 —— 单飞挡板让中间视图不发请求；晚到的旧视图
     响应被 seq/same/dead 丢弃，不把旧视图的行渲染进当前队列。 */
  { name: 'learn-queue', tab: 'learning', code: String.raw`
    const count=()=>F.requests.filter(r=>r.path.endsWith('/learn')).length;
    if(count()!==1)throw Error('Expected one mount pull, got '+count());
    const hold=F.deferReply('GET','/learn');
    await F.click(F.textButton('已批准'));
    await F.waitFor(()=>count()===2,'approved pull in flight');
    await F.click(F.textButton('待审'));
    await F.wait(60);
    if(count()!==2)throw Error('View switch while pulling issued an extra /learn request');
    hold.release(200,{ok:true,state:'approved',filter:'',offset:0,limit:20,matched:1,more:false,items:[{id:'stale-learn-1',kind:'insight',state:'approved',text:'STALE_LEARN_SENTINEL',at:'2026-11-12T00:00:00.000Z',version:1}]});
    await F.wait(120);
    if(count()!==2)throw Error('Stale release triggered an extra /learn request');
    const queue=document.querySelector('[data-bd-learning-queue]');
    if(!queue)throw Error('Learning queue missing');
    if(queue.textContent.includes('STALE_LEARN_SENTINEL'))throw Error('Late response for an old view leaked into the queue');
    if(!queue.textContent.includes('正在读取学习记录'))throw Error('Queue should still be waiting for the pending view pull');
    F.finish({ok:true,checks:4});` },
]
async function main() {
  fs.mkdirSync(output, { recursive: true })
  const browser = await openChrome({ output, width: 1280, height: 900 })
  try {
    for (const row of probes) {
      const file = path.join(output, row.name + '.html')
      fs.writeFileSync(file, makeFixturePage({ clientSource, status: structuredClone(base), ...row, probe: row.code }))
      await browser.navigate(file); await browser.until("document.title==='fixture done'", row.name + ' race', row.attempts)
      const result = await browser.driver.evaluate('JSON.parse(document.getElementById("fixture-result").textContent)')
      assert.deepEqual(result.errors, [], JSON.stringify({ name: row.name, result })); assert.equal(result.ok, true)
      console.log('PASS ' + row.name + ': deferred single-flight and stale-response behavior')
    }
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
