/** Isolated real React fixture. Runtime dependencies resolve from this repository. */
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { ROOT } = require('./paths.cjs')
const MODULES = {
  react: ['react', 'cjs/react.production.js'],
  scheduler: ['scheduler', 'cjs/scheduler.production.js'],
  'react-dom': ['react-dom', 'cjs/react-dom.production.js'],
  'react-dom/client': ['react-dom', 'cjs/react-dom-client.production.js'],
}
let runtime = null
function localReactRuntime() {
  if (runtime) return runtime
  const factories = Object.entries(MODULES).map(([name, [dependency, file]]) => {
    const packageFile = path.join(ROOT, 'node_modules', dependency, 'package.json')
    if (!fs.existsSync(packageFile)) throw new Error('UI QA dependency missing: ' + dependency + '. Install this repository with dev dependencies before running browser checks.')
    const source = fs.readFileSync(path.join(path.dirname(packageFile), file), 'utf8')
    return JSON.stringify(name) + ':function(require,module,exports){\n' + source + '\n}'
  }).join(',\n')
  runtime = `const factories={${factories}},cache={};function localRequire(name){if(cache[name])return cache[name].exports;if(!factories[name])throw Error('Unexpected fixture dependency '+name);const module={exports:{}};cache[name]=module;factories[name](localRequire,module,module.exports);return module.exports}`
  return runtime
}
function stickerImage(name, index = 0) {
  const colors = ['#d5edf4', '#e7e4f0', '#dfece2', '#f0e5d8']
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="200" viewBox="0 0 240 200"><rect width="240" height="200" rx="20" fill="${colors[index % colors.length]}"/><path d="M42 108Q72 36 148 60Q175 64 190 95L211 75V130L190 112Q165 161 94 148Q50 141 42 108Z" fill="#5e99aa"/><circle cx="166" cy="92" r="4" fill="#1b414b"/><path d="M120 56Q112 31 135 29" stroke="#5e99aa" stroke-width="8" fill="none"/><text x="120" y="181" text-anchor="middle" font-family="sans-serif" font-size="17" fill="#365966">${name.replace(/[<>&]/g, '')}</text></svg>`
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
}
function stickerFixture(count = 56) {
  const stickers = Array.from({ length: count }, (_, i) => {
    const builtin = i < 6
    const name = (builtin ? '内置鲸鱼' : '收藏鲸鱼') + String(i + 1).padStart(2, '0')
    const source = builtin ? 'builtin' : 'collected'
    return { name, source, addedAt: '2026-10-27T09:00:00.000Z', from: 'synthetic-fixture', sourceUrl: 'https://fixture.invalid/sticker-' + i + '.png', bvid: '', rpid: '', bytes: 16384 + i, mime: 'image/png', imageUrl: '/api/bili-duty/stickers/image?name=' + encodeURIComponent(name) + '&source=' + source, removable: !builtin, description: '合成夹具：' + (i % 2 ? '适合表达认真观察后的轻松回应。' : '安静看看，喜欢时再自然地接话。'), tags: i % 2 ? ['回应', '轻松'] : ['观察', '鲸鱼'] }
  })
  return { ok: true, stickers, counts: { total: count, builtin: Math.min(count, 6), collected: Math.max(0, count - 6) }, capacity: 60,
    settings: { stickerAutoCollect: false, stickerCollectProbability: 35, stickerCollectCooldown: 60, stickerAutoSend: false, stickerSendProbability: 30, stickerSendCooldown: 180, stickerCapacity: 60 }, automation: { collectPending: 0, lastCollectedAt: '', lastSentAt: '' } }
}
function videoFixture() {
  return { ok: true, deps: true, yesterday: '2026-10-27', modelId: 'fixture/sky', running: true, stage: 'render', ms: 92000, date: '2026-10-27', auto: false, at: '10:30',
    productions: [
      { id: 'fixture-completed-a', date: '2026-10-27', mode: 'daily', title: '合成成片 A', file: 'C:/synthetic-fixture/a.mp4', stage: 'done', verification: { ok: true }, sessionId: 'fixture-author-a' },
      { id: 'fixture-completed-b', date: '2026-10-27', mode: 'custom', title: '合成成片 B', file: 'C:/synthetic-fixture/b.mp4', stage: 'done', verification: { ok: true }, sessionId: 'fixture-author-b' },
      { id: 'fixture-rendering', date: '2026-10-27', mode: 'daily', title: '未完成的合成片', file: 'C:/synthetic-fixture/pending.mp4', stage: 'render' },
      { id: 'fixture-unverified', date: '2026-10-27', mode: 'daily', title: '未通过校验的合成片', file: 'C:/synthetic-fixture/invalid.mp4', stage: 'done', verification: { ok: false } },
    ], videos: [{ date: '2026-10-26', file: 'C:/synthetic-fixture/legacy.mp4' }],
    sessions: [
      { sessionId: 'fixture-author-a', productionId: 'fixture-completed-a', date: '2026-10-27', mode: 'daily', model: 'fixture/sky', stage: 'done' },
      { sessionId: 'fixture-author-b', productionId: 'fixture-completed-b', date: '2026-10-27', mode: 'custom', model: 'fixture/ocean', stage: 'done' },
      { sessionId: 'fixture-rendering-session', date: '2026-10-27', mode: 'custom', model: 'fixture/sky', stage: 'render' },
      { sessionId: 'fixture-cover-session', date: '2026-10-27', mode: 'daily', model: 'fixture/ocean', stage: 'cover' },
    ] }
}
function reviewStickerFixture(count = 56) {
  const result = stickerFixture(count)
  for (const [index, item] of result.stickers.entries()) { item.status = 'approved'; item.hash = String(index + 1).padStart(64, '0') }
  for (let index = 1; index <= 2; index++) {
    const name = '待审核鲸鱼' + index, hash = String(100 + index).padStart(64, '0')
    result.stickers.push({ name, source: 'collected', status: 'pending', hash, description: '人工审核合成图片', removable: true, mime: 'image/png', bytes: 20000, tags: ['待审核'],
      imageUrl: '/api/bili-duty/stickers/image?name=' + encodeURIComponent(name) + '&source=collected&status=pending&hash=' + hash })
  }
  result.counts.total += 2; result.counts.collected += 2; result.counts.pending = 2
  result.counts.approved = count; result.settings.stickerReview = true
  return result
}
function makeFixturePage({ clientSource, status = {}, fixtures = {}, target = 'settings', tab = 'basic', runMode = 'session', logMode = 'events', focus = false, position = null, probe = '', full = false, statusFailures = 0 }) {
  const face = pathToFileURL(path.join(ROOT, 'assets/avatar/face.png')).href
  const pet = pathToFileURL(path.join(ROOT, 'assets/pet/pet.png')).href
  const data = { status, fixtures: { ...fixtures, stickers: fixtures.stickers || stickerFixture() }, target, tab, runMode, logMode, focus, position, full, face, pet, statusFailures }
  const script = `${localReactRuntime()}
const DATA=${JSON.stringify(data)},SOURCE=${JSON.stringify(clientSource)};
const F=window.__fixture={requests:[],creations:[],errors:[],openedSessions:[],unknownRequests:[],toasts:[],closedSettings:0,data:DATA};
// These are explicit test doubles, not evidence that the host registered an endpoint.
// Host route registration is exercised separately by tests/pv-session-routes.test.mjs.
F.reply=(status,body)=>({ok:status>=200&&status<300,status,json:async()=>structuredClone(body),text:async()=>JSON.stringify(body)});
F.handlers=new Map();F.replyQueues=new Map();
F.queueReply=(method,route,response)=>{const key=method+' '+route,queue=F.replyQueues.get(key)||[];queue.push(response);F.replyQueues.set(key,queue)};
F.deferReply=(method,route)=>{let release,reject;const promise=new Promise((a,b)=>{release=a;reject=b});F.queueReply(method,route,()=>promise);return {release:(status,body)=>release(F.reply(status,body)),reject}};
F.change=async(el,value)=>{if(!el)throw Error('Missing fixture input');const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,String(value));el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));await F.wait(25)};
addEventListener('error',e=>F.errors.push(e.message));addEventListener('unhandledrejection',e=>F.errors.push(String(e.reason?.stack||e.reason)));
const RealReact=localRequire('react'),React={...RealReact,createElement(type,props,...children){
 F.creations.push({type:typeof type==='function'?type.name:typeof type==='string'?type:'memo',page:props?.['data-bd-settings-page']||'',at:performance.now()});
 if(type==='img'&&props?.src){const src=String(props.src);if(src.includes('/pet/image'))props={...props,src:src.includes('name=face')?DATA.face:DATA.pet};else if(src.includes('/stickers/image')){const q=new URL(src,'http://fixture.local').searchParams,name=q.get('name');const row=DATA.fixtures.stickers.stickers.find(s=>s.name===name);props={...props,src:row?.fixtureImage||DATA.fixtures.stickerFallback||DATA.face}}}
 return RealReact.createElement(type,props,...children)
}};
const nativeInterval=window.setInterval.bind(window),nativeClearInterval=window.clearInterval.bind(window);F.intervals=new Map();
window.setInterval=(callback,ms,...args)=>{const id=nativeInterval(callback,ms,...args);F.intervals.set(id,{callback,ms,args});return id};window.clearInterval=id=>{F.intervals.delete(id);nativeClearInterval(id)};
const wait=F.wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
F.waitFor=async(predicate,label,limit=2400)=>{const until=performance.now()+limit;while(performance.now()<until){if(predicate())return;await wait(16)}throw Error('Fixture timed out: '+label)};
F.enter=el=>el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,relatedTarget:null}));
F.leave=(el,to=null)=>el.dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:to}));
F.click=async el=>{if(!el)throw Error('Fixture click target missing');el.click();await wait(24)};
F.textButton=text=>[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===text);
F.rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}};
F.inView=r=>r.x>=-1&&r.y>=-1&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;
F.finish=result=>{document.getElementById('fixture-result').textContent=JSON.stringify({...result,errors:F.errors});document.title='fixture done'};
window.confirm=()=>true;
const recountStickers=()=>{const gallery=DATA.fixtures.stickers,rows=gallery.stickers;gallery.counts={total:rows.length,builtin:rows.filter(x=>x.source==='builtin').length,collected:rows.filter(x=>x.source==='collected').length,pending:rows.filter(x=>x.status==='pending').length,approved:rows.filter(x=>x.status!=='pending').length}};
window.fetch=async(url,init)=>{const u=new URL(String(url),'http://fixture.local'),requestBody=init?.body?JSON.parse(init.body):{},method=init?.method||'GET';const request={path:u.pathname,search:u.search,method,body:requestBody,at:performance.now()};F.requests.push(request);let body;
 const route=u.pathname.replace('/api/bili-duty',''),key=method+' '+route,queue=F.replyQueues.get(key);
 if(queue?.length){const next=queue.shift();return typeof next==='function'?await next(request):next}
 if(F.handlers.has(key))return await F.handlers.get(key)(request);
 const exactKeys=(keys)=>JSON.stringify(Object.keys(requestBody).sort())===JSON.stringify(keys.slice().sort());
 if(key==='GET /status')body=u.searchParams.get('rev')===DATA.status.rev&&DATA.status.rev?{ok:true,unchanged:true,rev:DATA.status.rev}:structuredClone(DATA.status);
 else if(key==='GET /feiyu')body=DATA.status.feiyu||{};
 else if(key==='GET /activity')body=DATA.fixtures.activity||{ok:true,rows:[]};
 else if(key==='POST /activity'&&requestBody.clear===true){DATA.fixtures.activity={ok:true,rows:[],last:'',live:{active:false,thinking:false}};body={ok:true,cleared:true};}
 else if(key==='GET /pet/log')body=DATA.fixtures.logs||{ok:true,entries:[]};
 else if(key==='GET /learn'||key==='POST /learn'){
   const book=DATA.fixtures.learn||{ok:true,items:[]},all=book.items||[],view=method==='POST'?requestBody:Object.fromEntries(u.searchParams);
   if(method==='POST'){
     const row=all.find(item=>item.id===requestBody.id);if(!row)return F.reply(404,{ok:false,error:'fixture learning record missing'});
     if(requestBody.decision==='forget')book.items=all.filter(item=>item!==row);
     else if(['approve','reject'].includes(requestBody.decision)){row.state=requestBody.decision==='approve'?'approved':'rejected';row.version=(row.version||1)+1;row.why='演示审核决定'}
     else return F.reply(400,{ok:false,error:'fixture invalid learning decision'});
   }
   const state=view.state||'pending',filter=String(view.filter||'').toLowerCase(),offset=Number(view.offset)||0,limit=Number(view.limit)||20;
   const rows=(book.items||[]).filter(row=>(state==='all'||row.state===state)&&(!view.kind||row.kind===view.kind)&&(!filter||[row.text,row.example,row.from,row.why].join(' ').toLowerCase().includes(filter)));
   body={ok:true,state,filter,offset,limit,items:rows.slice(offset,offset+limit),matched:rows.length,more:offset+limit<rows.length};
 }
 else if(key==='POST /learn/review'){DATA.status.learnReview={...DATA.status.learnReview,running:requestBody.action!=='stop'};body={ok:true,started:requestBody.action!=='stop',learnReview:DATA.status.learnReview};}
 else if(key==='POST /soul'){DATA.status.soul={...DATA.status.soul,filled:(DATA.status.soul?.filled||[]).filter(value=>value!==requestBody.section)};body={ok:true,...DATA.status.soul,cleared:requestBody.section};}
 else if(key==='POST /install'){body={ok:true,started:true,hint:'演示：依赖安装请求已接受'};}
 else if(key==='POST /install-asr'){body={ok:true,started:true};}
 else if(key==='POST /check'){body={ok:true,steps:['演示：登录检查','演示：搜索检查']};}
 else if(key==='GET /diag'){body={ok:true,text:'演示诊断信息，不含凭证或真实路径。'};}
 else if(key==='POST /mirror'){body={ok:true,mirror:{ok:true,copied:[]}};}
 else if(key==='POST /open'){if(!['home','out','pv','mirror'].includes(requestBody.what))return F.reply(400,{ok:false,error:'fixture invalid folder'});body={ok:true,opened:'演示目录'};}
 else if(key==='POST /verify'){body={ok:true,checked:[{visible:true}]};}
 else if(key==='POST /login/start'){body={ok:true,key:'fixture-qr',qr:DATA.face};}
 else if(key==='POST /login/poll'){body={ok:true,state:'waiting'};}
 else if(key==='GET /send-review')body=DATA.fixtures.sendReview||{ok:true,rev:'empty',pending:0,items:[]};
 else if(key==='POST /send-review'){
   if(!exactKeys(['id','decision','expectedHash']))return F.reply(400,{ok:false,error:'fixture approval must bind hash'});
   const rows=DATA.fixtures.sendReview?.items||[],row=rows.find(x=>x.id===requestBody.id);
   if(!row||row.hash!==requestBody.expectedHash||row.state!=='pending')return F.reply(409,{ok:false,error:'fixture stale preview'});
   if(!['approve','reject'].includes(requestBody.decision))return F.reply(400,{ok:false,error:'fixture invalid decision'});
   row.state=requestBody.decision==='approve'?'sent':'rejected';
   DATA.fixtures.sendReview.pending=rows.filter(x=>x.state==='pending').length;
   body={...DATA.fixtures.sendReview,ok:true,sent:row.state==='sent',item:row};
 }
 else if(key==='GET /memory'){
   const source=u.searchParams.get('source')||'all',filter=(u.searchParams.get('filter')||'').toLowerCase(),offset=Number(u.searchParams.get('offset'))||0,limit=Number(u.searchParams.get('limit'))||20;
   const rows=(DATA.fixtures.memory?.items||[]).filter(row=>(source==='all'||row.source===source)&&(!filter||[row.text,row.from,row.why].join(' ').toLowerCase().includes(filter)));
   body={ok:true,source,filter,offset,limit,items:rows.slice(offset,offset+limit),matched:rows.length,more:rows.length>offset+limit};
 }
 else if(key==='POST /memory'){
   if(!exactKeys(['source','id','version','action']))return F.reply(400,{ok:false,error:'fixture memory request contract changed'});
   const rows=DATA.fixtures.memory?.items||[],row=rows.find(item=>item.source===requestBody.source&&item.id===requestBody.id);
   if(!row||row.version!==requestBody.version)return F.reply(409,{ok:false,error:'MEMORY_CHANGED_REFRESH_REQUIRED'});
   if(requestBody.action==='revoke'){row.state='rejected';row.actions=['forget'];row.version='c'.repeat(64);row.why='使用者从记忆中心撤销批准'}
   else if(requestBody.action==='forget')DATA.fixtures.memory.items=rows.filter(item=>item!==row);
   else return F.reply(400,{ok:false,error:'fixture invalid memory action'});
   body={ok:true,auditRetained:true};
 }
 else if(key==='GET /pv')body=DATA.fixtures.pv||{ok:true,videos:[],productions:[],sessions:[],yesterday:'2026-10-27',deps:true};
 else if(key==='POST /pv/session-new'){
   if(!exactKeys(['sourceSessionId','workspaceId','date','mode','brief','targetDurationSec','model']))return F.reply(400,{ok:false,error:'fixture video request contract changed'});
   body={ok:true,sessionId:'fixture-video-created',accepted:true,model:requestBody.model,date:requestBody.date,mode:requestBody.mode};
   if(DATA.fixtures.pv)DATA.fixtures.pv.sessions.unshift({...requestBody,sessionId:body.sessionId,stage:'authoring'});
 }
 else if(key==='POST /pv'){
   if(!exactKeys(['action','sessionId'])||requestBody.action!=='stop')return F.reply(400,{ok:false,error:'fixture stop requires exact sessionId and action'});
   const session=DATA.fixtures.pv?.sessions?.find(x=>x.sessionId===requestBody.sessionId);
   if(!session)return F.reply(404,{ok:false,error:'fixture video session missing'});
   session.stage='stopped';body={ok:true,stopped:true,sessionId:requestBody.sessionId,stage:'stopped'};
 }
 else if(key==='GET /stickers'){
   const state=u.searchParams.get('status')||'approved';if(!['approved','pending','all'].includes(state))return F.reply(400,{ok:false,error:'fixture invalid sticker state'});
   body=structuredClone(DATA.fixtures.stickers);body.stickers=body.stickers.filter(x=>state==='all'||(x.status||'approved')===state);
 }
 else if(key==='POST /stickers/approve'||key==='POST /stickers/reject'){
   if(!exactKeys(['name','expectedHash'])||!/^[a-f0-9]{64}$/.test(requestBody.expectedHash||''))return F.reply(400,{ok:false,code:'STICKER_INPUT',error:'fixture requires expectedHash'});
   const row=DATA.fixtures.stickers.stickers.find(x=>x.name===requestBody.name&&x.source==='collected'&&x.status==='pending');
   if(!row)return F.reply(404,{ok:false,code:'STICKER_NOT_FOUND',error:'fixture pending sticker missing'});
   if(row.hash!==requestBody.expectedHash)return F.reply(409,{ok:false,code:'STICKER_CHANGED',error:'fixture image changed; review again'});
   if(key.endsWith('/approve'))row.status='approved';else DATA.fixtures.stickers.stickers=DATA.fixtures.stickers.stickers.filter(x=>x!==row);
   recountStickers();body={ok:true,name:row.name,status:key.endsWith('/approve')?'approved':'rejected'};
 }
 else if(key==='POST /stickers/forget'){
   if(!exactKeys(['name']))return F.reply(400,{ok:false,error:'fixture forget request contract changed'});
   DATA.fixtures.stickers.stickers=DATA.fixtures.stickers.stickers.filter(x=>x.name!==requestBody.name||x.source!=='collected');recountStickers();body={ok:true};
 }
 else if(key==='POST /stickers/collect'||key==='POST /stickers/upload'){
   const keys=key.endsWith('/upload')?['name','filename','dataBase64','description']:['name','url','description'];
   if(!exactKeys(keys))return F.reply(400,{ok:false,error:'fixture sticker request contract changed'});
   const state=DATA.status.config.stickerReview?'pending':'approved',name=requestBody.name,hash='e'.repeat(64);
   DATA.fixtures.stickers.stickers.push({name,source:'collected',status:state,hash,removable:true,description:requestBody.description,tags:[],imageUrl:'/api/bili-duty/stickers/image?name='+encodeURIComponent(name)+'&source=collected'+(state==='pending'?'&status=pending&hash='+hash:''),fixtureImage:DATA.fixtures.stickerFallback||DATA.face});recountStickers();body={ok:true,name,status:state};
 }
 else if(key==='POST /pet/session-new')body={ok:true,sessionId:'fixture-new-session'};
 else if(key==='POST /pet/start')body={ok:true,started:true,tokenBudgetEnforcement:requestBody.mode==='background'?'advisory':'round-boundary'};
 else if(key==='POST /config'){
   Object.assign(DATA.status.config,requestBody);DATA.status.rev=String(DATA.status.rev||'fixture')+'c';
   if('petShow' in requestBody)DATA.status.petShow=requestBody.petShow;
   if(DATA.fixtures.pv){for(const [configKey,pvKey] of [['videoModelId','modelId'],['pvAuto','auto'],['pvAt','at'],['pvVoice','voice']])if(configKey in requestBody)DATA.fixtures.pv[pvKey]=requestBody[configKey]}
   body={ok:true,config:{...DATA.status.config}};
 }
 else{F.unknownRequests.push(request);return F.reply(404,{ok:false,error:'Unknown fixture route: '+key})}
 return F.reply(200,body);
};
if(DATA.position){const p=DATA.position,x=p.x==='right'?innerWidth-134:p.x,y=p.y==='bottom'?innerHeight-134:p.y;localStorage.setItem('dafeiyu.pet.pos',JSON.stringify({x,y}))}
let moduleInfo;window.__ModuleLoader__={load(m){moduleInfo=m}};
new Function('require',SOURCE)(name=>name==='react'?React:localRequire(name));
const api=moduleInfo.factory(name=>name==='react'?React:localRequire(name));
const css=(SOURCE.match(/const CSS = \x60([\\s\\S]*?)\x60/)||[,''])[1];
const style=document.createElement('style');style.textContent=css;document.head.appendChild(style);
const ctx={get(name){if(name==='uiWorkspace')return {selection:{getSnapshot:()=>({sessionId:'fixture-source'})},workspaces:{list:{getSnapshot:()=>({items:[{workspaceId:'fixture-workspace',sessionIds:['fixture-source']} ]})}},openSession:async id=>F.openedSessions.push(id)}},effect(fn){return fn()}};
function Settings(){const [st,setSt]=React.useState(DATA.status);return React.createElement(api.debugParts.PetSettingsModal,{initialTab:DATA.tab,status:[st,setSt,DATA.statusFailures],ctx,onClose:()=>{F.closedSettings++},toast:(...args)=>F.toasts.push(args)})}
const root=localRequire('react-dom/client').createRoot(document.getElementById('fixture-root'));F.root=root;
root.render(React.createElement(DATA.target==='root'?api.debugParts.PetRoot:Settings,{ctx}));
F.ready=(async()=>{await F.waitFor(()=>document.querySelector(DATA.target==='root'?'[data-bd-pet]':'[data-bd-pet-modal]'),'initial mount');await wait(50);
 if(DATA.target!=='root'){if(DATA.tab==='run'&&DATA.runMode==='background')await F.click(F.textButton('后台与定时'));if(DATA.tab==='logs'&&DATA.logMode==='activity')await F.click(F.textButton('实时动态'));if(DATA.focus)await F.click(F.textButton('截图视图'));await wait(50)}
})();
(async()=>{await F.ready;${probe || "F.finish({ready:true,requests:F.requests,creations:F.creations.length})"}})().catch(e=>{F.errors.push(String(e.stack||e));F.finish({issues:['Browser fixture failed']})});`
  const fullCss = full ? '[data-bd-pet-modal]{height:auto!important;max-height:none!important}[data-bd-pet-body]{overflow:visible!important;flex:none!important;max-height:none!important}' : ''
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>Isolated Dafeiyu frontend fixture</title><style>html,body{margin:0;padding:0;background:#e4ebec;font:13px/1.5 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif}#fixture-root{position:fixed;inset:0;z-index:2147483000}${target === 'root' ? '#fixture-root{width:0;height:0;overflow:visible}' : ''}${fullCss}</style></head><body><div id="fixture-root" data-bd-pet-host></div><pre id="fixture-result" hidden>PENDING</pre><script>${script.replace(/<\/script/gi, '<\\/script')}</script></body></html>`
}
module.exports = { makeFixturePage, stickerFixture, reviewStickerFixture, videoFixture, stickerImage }
