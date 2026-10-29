/** Write a self-contained, interactive real-React settings fixture for Chrome screenshots.
 * node shot-modal.cjs <client.js> [out.html] [scenario]
 * Data: SHOT_DATA_DIR or .shot. All requests are intercepted inside the isolated page.
 */
const fs = require('node:fs')
const path = require('node:path')
const { makeFixturePage, stickerFixture, stickerImage } = require('./ui-browser-fixture.cjs')
const CLIENT = process.argv[2] || require('./paths.cjs').CLIENT
const OUT = process.argv[3] || path.join(require('./paths.cjs').qaOutput('shots'), 'panel.html')
const SCENARIO = process.argv[4] || 'normal'
const DATA_DIR = process.env.SHOT_DATA_DIR || require('./paths.cjs').qaOutput('shots')
if (!CLIENT || !fs.existsSync(CLIENT)) { console.error('usage: node shot-modal.cjs <client.js> [out.html] [normal|fresh|blocked|budget|empty]'); process.exit(2) }
const pick = (name, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name + '.json'), 'utf8').replace(/^\uFEFF/, '')) }
  catch { return fallback }
}
const status = pick('status', { ok: true, config: {}, petShow: true })
status.config ||= {}
status.feiyu ||= pick('feiyu', { active: false })
const fixtures = {
  activity: pick('activity', { ok: true, rows: [] }),
  learn: pick('learn', { ok: true, items: [], matched: 0 }),
  logs: pick('logs', { ok: true, entries: [] }),
  pv: pick('pv', { ok: true, videos: [], yesterday: '2026-10-27', deps: true }),
  stickers: pick('stickers', stickerFixture()),
  stickerFallback: stickerImage('表情预览'),
}
for (const [i, row] of fixtures.stickers.stickers.entries()) row.fixtureImage = stickerImage(row.name, i)
if (process.env.SHOT_DEMO === '1') {
  const now = Date.now()
  const day = (n) => { const d = new Date(now - n * 864e5); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }
  Object.assign(status, {
    tokensTotal: 1234567, tokensToday: 45678, totalTokenBudget: 3000000, activeDays: 3,
    tokenRounds: { ok: true, sums: { tasks: 3, input: 190001, output: 27202, total: 217203, unknown: 1 }, entries: [
      { id: 'tok-a', kind: 'session', label: '鲸鱼摸鱼会话', model: 'fixture/flash', rounds: 6, budget: 500000, startedAt: new Date(now - 50 * 6e4).toISOString(), durationSec: 1240, tokens: { input: 102001, output: 15202, total: 117203 }, stopReason: 'user' },
      { id: 'tok-b', kind: 'background', label: '后台轮 · 定时', model: 'fixture/flash', rounds: 4, budget: 300000, startedAt: new Date(now - 4 * 36e5).toISOString(), durationSec: 2610, tokensUnknown: true, stopReason: 'exit' },
      { id: 'tok-c', kind: 'background', label: '后台轮 · 手动', model: 'fixture/flash', rounds: 9, budget: 300000, startedAt: new Date(now - 9 * 36e5).toISOString(), durationSec: 3960, tokens: { input: 88000, output: 12000, total: 100000 }, stopReason: 'token-budget' },
    ] },
    tokenDays: { [day(0)]: 45678, [day(1)]: 12345, [day(2)]: 67890, [day(4)]: 23456, [day(5)]: 8901 },
  })
  status.config.totalTokenBudget = 3000000
  Object.assign(status.feiyu, { active: true, goal: { id: 'g-demo', phase: 'active', activation: 'armed', rounds: 3, maxRounds: 64 }, roundsThisRun: 3, modelActive: 'fixture/flash',
    tokens: { ...(status.feiyu.tokens || {}), thisRun: 30456, budget: 500000, left: 469544, today: 45678, totalAll: 1234567, totalBudget: 3000000 }, pickedToday: 5, momentsToday: 1 })
  Object.assign(fixtures.activity, { ok: true, rows: [
    { seq: 1, uid: 'aa-1', t: now - 61e3, kind: 'start', text: '开刷：最多 64 轮 · 模型 fixture/flash' },
    { seq: 2, uid: 'aa-2', t: now - 55e3, kind: 'call', text: '去搜「本地模型」（近 7 天）', id: 't2', tool: 'bili_search' },
    { seq: 3, uid: 'aa-3', t: now - 51e3, kind: 'done', text: '去搜「本地模型」（近 7 天） → 1 条', id: 't2', tool: 'bili_search', ms: 3955 },
    { seq: 4, uid: 'aa-4', t: now - 48e3, kind: 'say', text: '这一轮挑了讲本地模型的片子，想看看实际运行表现。' },
    { seq: 5, uid: 'aa-5', t: now - 43e3, kind: 'call', text: '读这条视频的字幕', id: 't9', tool: 'bili_subtitle' },
    { seq: 6, uid: 'aa-6', t: now - 37e3, kind: 'done', text: '字幕 → 149 段 · 528 秒', id: 't9', tool: 'bili_subtitle', ms: 5830 },
    { seq: 7, uid: 'aa-7', t: now - 30e3, kind: 'round', text: '第 3 轮游完啦（上限 64）' },
  ], last: 'aa-7', lastSeq: 7, live: { active: true, thinking: true, round: 4, maxRounds: 64, since: 92000 } })
}
if (SCENARIO === 'fresh') Object.assign(status, { venvReady: false, loggedIn: false, installTail: '' })
if (SCENARIO === 'blocked') Object.assign(status.feiyu, { active: false, goal: { phase: 'blocked', rounds: 64, maxRounds: 64 } })
if (SCENARIO === 'budget') status.feiyu.tokens = { ...(status.feiyu.tokens || {}), left: 0, budget: 500000 }
if (SCENARIO === 'empty') { status.feiyu.active = false; fixtures.activity.rows = []; fixtures.stickers = stickerFixture(0) }
let html = makeFixturePage({ clientSource: fs.readFileSync(CLIENT, 'utf8'), status, fixtures,
  tab: process.env.SHOT_TAB || 'basic', runMode: process.env.SHOT_RUN_MODE || 'session', logMode: process.env.SHOT_LOG_MODE || 'events', focus: process.env.SHOT_FOCUS === '1', full: process.env.SHOT_FULL === '1' })
// Install controlled HTTP failures and local-upload responses before the actual client executes.
// All bytes and rows stay in this isolated page; no real account, filesystem upload or host route.
const routeFixture = String.raw`
F.stickerControl={getMode:'normal',uploadError:'',holdUpload:false,releaseUpload:null};
const originalFixtureFetch=window.fetch;
const fixtureReply=(status,body)=>({ok:status>=200&&status<300,status,json:async()=>structuredClone(body),text:async()=>JSON.stringify(body)});
window.fetch=async(url,init)=>{
 const u=new URL(String(url),'http://fixture.local'),route=u.pathname.replace('/api/bili-duty',''),method=init?.method||'GET';
 const handled=route==='/stickers/upload'||(route==='/stickers'&&method==='GET'&&F.stickerControl.getMode!=='normal');
 if(!handled)return originalFixtureFetch(url,init);
 const body=init?.body?JSON.parse(init.body):{};
 F.requests.push({path:u.pathname,search:u.search,method,body,at:performance.now()});
 if(route==='/stickers'){
  if(F.stickerControl.getMode==='missing')return fixtureReply(404,{ok:false,error:'fixture图库接口未挂载',code:'NOT_FOUND'});
  if(F.stickerControl.getMode==='plain404')return {ok:false,status:404,json:async()=>{throw Error('HTML 404 page')},text:async()=>'<h1>Not Found</h1>'};
  return fixtureReply(503,{ok:false,error:'fixture图库存储暂不可用',code:'STORAGE_UNAVAILABLE'});
 }
 if(F.stickerControl.holdUpload)await new Promise(resolve=>{F.stickerControl.releaseUpload=resolve});
 if(F.stickerControl.uploadError)return fixtureReply(422,{ok:false,error:F.stickerControl.uploadError,code:'UPLOAD_REJECTED'});
 const rows=DATA.fixtures.stickers.stickers;
 const mime=body.filename?.toLowerCase().endsWith('.webp')?'image/webp':body.filename?.toLowerCase().endsWith('.gif')?'image/gif':/\.jpe?g$/i.test(body.filename||'')?'image/jpeg':'image/png';
 const item={name:body.name,source:'collected',description:body.description,removable:true,from:'本地上传（合成夹具）',mime,bytes:atob(body.dataBase64||'').length,filename:body.filename,addedAt:new Date().toISOString(),imageUrl:'/api/bili-duty/stickers/image?name='+encodeURIComponent(body.name)+'&source=collected',fixtureImage:'data:'+mime+';base64,'+body.dataBase64};
 rows.push(item);DATA.fixtures.stickers.counts={total:rows.length,builtin:rows.filter(x=>x.source==='builtin').length,collected:rows.filter(x=>x.source==='collected').length};
 return fixtureReply(200,{ok:true,item,name:item.name,source:'collected'});
};
`
const marker = 'let moduleInfo;window.__ModuleLoader__='
if (!html.includes(marker)) throw Error('Browser fixture changed: install controlled routes before client load')
html = html.replace(marker, routeFixture + '\n' + marker)
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, html, 'utf8')
console.log('Wrote real-React fixture: ' + OUT + ' (' + html.length + ' chars)')
