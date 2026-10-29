/** Real browser page matrix, keyboard semantics and logical-error receipts; no host/account IO. */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { makeFixturePage } = require('./ui-browser-fixture.cjs')
const { demoData } = require('./demo-data.cjs')
const { openChrome } = require('./browser-cdp.cjs')
const { CLIENT, qaOutput } = require('./paths.cjs')
const clientSource = fs.readFileSync(CLIENT, 'utf8')
const output = qaOutput('page-matrix')
const probe = String.raw`
const checks=[],check=(ok,label,detail)=>{checks.push({label,ok:Boolean(ok),detail});if(!ok)throw Error(label+': '+JSON.stringify(detail))};
const modal=document.querySelector('[role=dialog]'),body=modal.querySelector('[data-bd-pet-body]');
const scope=(selector)=>modal.querySelector(selector),button=(text)=>[...modal.querySelectorAll('button')].find(node=>node.textContent.trim()===text);
const group={run:'run',speech:'speech',learning:'learning',stickers:'learning',video:'video',logs:'logs',ledger:'logs',review:'logs',basic:'basic',other:'basic'};
const go=async(key)=>{await F.click(scope('#bd-tab-'+group[key]));const sub=scope('[data-bd-page-target='+key+']');if(sub)await F.click(sub);await F.waitFor(()=>scope('[data-bd-settings-page='+key+']'),key+' page');await F.wait(40)};
const names=(node)=>node.getAttribute('aria-label')||node.getAttribute('title')||(node.getAttribute('aria-labelledby')||'').split(' ').map(id=>document.getElementById(id)?.textContent||'').join(' ').trim()||[...(node.labels||[])].map(label=>label.textContent).join(' ').trim()||(node.tagName==='BUTTON'?node.textContent.trim():'');
check(modal?.getAttribute('aria-modal')==='true'&&names(modal),'Dialog has accessible name');
for(const key of Object.keys(group)){
  await go(key);const page=scope('[data-bd-settings-page='+key+']');
  check(scope('[role=tab][aria-selected=true]')?.id==='bd-tab-'+group[key],key+' selected primary group');
  check(body.scrollWidth<=body.clientWidth+1,key+' content fits viewport',{width:body.clientWidth,scroll:body.scrollWidth});
  const unnamed=[...page.querySelectorAll('input,textarea,select,button')].filter(node=>node.getClientRects().length&&!names(node));
  check(!unnamed.length,key+' controls have accessible names',unnamed.map(node=>node.outerHTML.slice(0,240)));
  const ids=[...modal.querySelectorAll('[id]')].map(node=>node.id);check(ids.length===new Set(ids).size,key+' has no duplicate IDs');
  check(!/undefined|NaN|\[object Object\]/.test(page.textContent),key+' has no invalid value presentation');
}
await go('other');
for(const [route,label,error] of [['/install','安装主依赖','QA_INSTALL_REJECTED'],['/install-asr','安装转写','QA_ASR_REJECTED'],['/check','检查连接','QA_CHECK_REJECTED']]){
  F.queueReply('POST',route,F.reply(200,{ok:false,error}));await F.click(button(label));
  check(scope('[role=alert]')?.textContent.includes(error),route+' logical failure is an alert');
}
await go('video');F.queueReply('GET','/pv',F.reply(503,{ok:false,error:'QA_VIDEO_UNAVAILABLE'}));await F.click(button('刷新'));
check(modal.textContent.includes('QA_VIDEO_UNAVAILABLE'),'Video HTTP failure remains visible');await F.click(button('刷新'));
check(!modal.textContent.includes('QA_VIDEO_UNAVAILABLE'),'Video manual refresh recovers');
await go('stickers');F.queueReply('GET','/stickers',F.reply(404,{ok:false,error:'QA_GALLERY_MISSING'}));await F.click(button('刷新图库'));
check(modal.textContent.includes('重启')&&modal.textContent.includes('图库接口'),'Gallery missing route explains restart');await F.click(button('重试'));
check(scope('[data-bd-sticker-item]'),'Gallery manual retry recovers');
await go('run');const first=scope('#bd-tab-run');first.focus();first.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));await F.wait(30);
check(scope('[role=tab][aria-selected=true]')?.id==='bd-tab-basic','End key selects last primary tab');
document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));await F.wait(30);
check(scope('[role=tab][aria-selected=true]')?.id==='bd-tab-run','Home key selects first primary tab');
const tabbable=[...modal.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex="0"]')].filter(node=>node.tabIndex>=0&&node.getClientRects().length&&node.checkVisibility());
tabbable.at(-1).focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));check(document.activeElement===tabbable[0],'Tab traps forward focus');
tabbable[0].focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));check(document.activeElement===tabbable.at(-1),'Shift-Tab traps reverse focus');
check(!F.unknownRequests.length,'All requested fixture routes are declared',F.unknownRequests);
const before=F.requests.length;F.root.unmount();await F.wait(35);check(!document.querySelector('[data-bd-pet-modal]'),'Unmount removes modal');check(F.intervals.size===0,'Unmount clears interval polling');check(F.requests.length===before,'Unmount issues no new requests');
F.finish({ok:true,checks,errors:F.errors,unknownRequests:F.unknownRequests});
`
async function main() {
  const browser = await openChrome({ output })
  const results = []
  try {
    for (const [name, width, height] of [['desktop', 1280, 900], ['mobile', 390, 844], ['short', 1000, 480]]) {
      const file = path.join(output, name + '.html')
      fs.writeFileSync(file, makeFixturePage({ clientSource, ...demoData(), tab: 'run', probe }))
      await browser.size(width, height); await browser.navigate(file)
      await browser.until("document.title==='fixture done'", name + ' page matrix', 350)
      const result = await browser.driver.evaluate('JSON.parse(document.getElementById("fixture-result").textContent)')
      assert.deepEqual(result.errors, [], JSON.stringify(result))
      assert.equal(result.ok, true, JSON.stringify(result))
      results.push({ name, width, height, ...result })
      console.log('PASS ' + name + ': ' + result.checks.length + ' page, accessibility, error, keyboard and cleanup checks')
    }
    for (const [name, statusFailures, role] of [['loading', 0, 'status'], ['status-failure', 3, 'alert']]) {
      const file = path.join(output, name + '.html')
      const coldProbe = `const modal=document.querySelector('[role=dialog]'),close=modal?.querySelector('[aria-label="关闭设置"]');if(!modal||!close)throw Error('Cold dialog lacks accessible close');if(!modal.querySelector('[role=${role}]'))throw Error('Cold status role missing');if(document.activeElement!==close)throw Error('Cold dialog did not receive focus');close.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));if(F.closedSettings!==1)throw Error('Escape did not close cold dialog');F.finish({ok:true,checks:4});`
      fs.writeFileSync(file, makeFixturePage({ clientSource, status: { ok: false }, statusFailures, probe: coldProbe }))
      await browser.navigate(file); await browser.until("document.title==='fixture done'", name)
      const result = await browser.driver.evaluate('JSON.parse(document.getElementById("fixture-result").textContent)')
      assert.deepEqual(result.errors, [], JSON.stringify(result)); assert.equal(result.ok, true)
      results.push({ name, ...result }); console.log('PASS ' + name + ': 4 loading/error dialog and keyboard checks')
    }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
