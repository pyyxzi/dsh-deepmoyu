/** Real React + isolated Chrome menu regression: structure, geometry and delayed previews. */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { makeFixturePage } = require('./ui-browser-fixture.cjs')
const { openChrome } = require('./browser-cdp.cjs')
const { CLIENT, qaOutput } = require('./paths.cjs')
const SOURCE = fs.readFileSync(CLIENT, 'utf8')
const OUTPUT = qaOutput('menu')
const status = {
  ok: true, loggedIn: true, venvReady: true, petShow: true, bgBusy: false, rev: 'fixture-1',
  config: { perDay: 5, sessionModelId: 'fixture/session', sessionTokenBudget: 120000, sessionMaxRounds: 64, backgroundModelId: 'fixture/background', backgroundTokenBudget: 60000, backgroundMinutes: 45, totalTokenBudget: 0, autoComment: false, stickerAutoCollect: false, stickerAutoSend: false },
  feiyu: { active: true, tokens: { thisRun: 1234, budget: 120000 } },
  activity: [{ text: '读完字幕，挑了一条讲本地模型的片子。' }, { text: '记下一种说具体感受的口气。' }],
}
const cases = [
  { name: 'bottom-right', width: 1280, height: 800, position: { x: 'right', y: 'bottom' } },
  { name: 'top-left', width: 1280, height: 800, position: { x: 6, y: 6 } },
  { name: 'top-right', width: 1280, height: 800, position: { x: 'right', y: 6 } },
  { name: 'short-bottom', width: 1000, height: 460, position: { x: 'right', y: 'bottom' } },
  { name: 'short-top', width: 1000, height: 460, position: { x: 6, y: 6 } },
  { name: 'narrow-bottom', width: 390, height: 760, position: { x: 'right', y: 'bottom' } },
  { name: 'narrow-short', width: 390, height: 480, position: { x: 6, y: 6 } },
]
fs.mkdirSync(OUTPUT, { recursive: true })
let browser
;(async () => {
  browser = await openChrome({ output: OUTPUT })
  const records = []
  for (const scenario of cases) {
    const file = path.join(OUTPUT, scenario.name + '.html')
    fs.writeFileSync(file, makeFixturePage({ clientSource: SOURCE, status, target: 'root', position: scenario.position }))
    await browser.size(scenario.width, scenario.height)
    await browser.navigate(file)
    await browser.until(`window.__fixture&&document.querySelector('[data-bd-pet-fish]')`, scenario.name + ' pet')
    const metrics = await browser.driver.evaluate(`(async()=>{
      const F=window.__fixture;await F.ready;
      const issues=[],check=(v,n)=>{if(!v)issues.push(n)},pet=()=>document.querySelector('[data-bd-pet]'),fish=()=>document.querySelector('[data-bd-pet-fish]'),menu=()=>document.querySelector('[data-bd-menu]'),preview=()=>document.querySelector('[data-bd-preview]');
      const context=()=>fish().dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
      check(!document.querySelector('[data-bd-pet-toast]')?.textContent.includes('称号升级'),'Initial status does not invent a title upgrade');
      context();await F.waitFor(menu,'open menu');await F.wait(320); /* >.22s 弹出动画：等它落定再量几何，否则量在过冲半路上，结果看运气 */
      check(document.querySelectorAll('[data-bd-pet]').length===1,'One pet');
      check(pet().contains(menu()),'Menu inside pet positioning box');
      check(pet().contains(document.querySelector('[data-bd-pet-toast]')),'Toast inside pet');
      check(/^\\d+px$/.test(pet().style.left)&&/^\\d+px$/.test(pet().style.top),'Position on pet');
      const keys=[...menu().querySelectorAll('[data-bd-menu-key]')].map(e=>e.dataset.bdMenuKey);
      check(JSON.stringify(keys)===JSON.stringify(['session','background','logs','status','settings','hide']),'Six ordered menu keys');
      const icons=[...menu().querySelectorAll('[data-bd-menu-key] svg')];check(icons.length===6&&icons.every(s=>s.getAttribute('fill')==='none'),'Six outline icons');
      check(menu().querySelector('[data-bd-menu-token]')?.textContent.includes('1,234'),'Current token footer');
      const mrect=F.rect(menu());check(F.inView(mrect),'Menu in viewport');
      const before=menu().scrollTop;menu().scrollTop=9999;check(menu().scrollHeight<=menu().clientHeight||menu().scrollTop>before,'Long menu scrolls');menu().scrollTop=0;
      const requests=F.requests.length,previews=[];
      for(const key of keys){
        const button=menu().querySelector('[data-bd-menu-key='+key+']');button.scrollIntoView({block:'nearest'});F.enter(button);
        await F.wait(75);check(!preview(),key+' waits before opening');await F.wait(150);
        await F.waitFor(()=>preview()?.dataset.bdPreview===key,key+' preview');await F.wait(25);
        const p=preview(),r=F.rect(p),mr=F.rect(menu()),overlap=Math.max(0,Math.min(r.right,mr.right)-Math.max(r.x,mr.x))*Math.max(0,Math.min(r.bottom,mr.bottom)-Math.max(r.y,mr.y));
        check(document.querySelectorAll('[data-bd-preview]').length===1,key+' one preview');check(F.inView(r),key+' preview in viewport');check(overlap<1,key+' preview does not cover menu');
        check(button.getAttribute('aria-describedby')===p.id&&p.getAttribute('role')==='note',key+' described preview');
        check(p.textContent.trim().length>30,key+' content present');
        F.leave(button,p);F.enter(p);await F.wait(150);check(preview()===p,key+' moving into preview keeps open');
        F.leave(p);await F.wait(55);check(Boolean(preview()),key+' close grace');await F.wait(110);check(!preview(),key+' closes after leave');
        previews.push({key,rect:r,menuRect:mr,overlap});
      }
      check(F.requests.length===requests,'Hover performs no network requests');
      const settings=menu().querySelector('[data-bd-menu-key=settings]');settings.blur();settings.focus();await F.wait(230);check(preview()?.dataset.bdPreview==='settings','Keyboard focus opens preview (active='+document.activeElement?.dataset.bdMenuKey+', preview='+preview()?.dataset.bdPreview+')');settings.blur();await F.wait(165);check(!preview(),'Keyboard blur closes preview');
      F.enter(settings);await F.wait(40);context();await F.wait(230);check(!menu()&&!preview(),'Closing menu cancels pending preview timer');
      context();await F.waitFor(menu,'reopen menu');context();await F.wait(40);check(!menu(),'Right click toggles closed');
      check(F.errors.length===0,'No runtime errors');return {issues,viewport:[innerWidth,innerHeight],menu:mrect,previews,requests:F.requests,errors:F.errors};
    })()`)
    assert.deepEqual(metrics.issues, [], scenario.name + ': menu and previews')
    await browser.driver.evaluate(`document.querySelector('[data-bd-pet-fish]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
    await browser.until(`document.querySelector('[data-bd-menu-key=settings]')`, 'screenshot menu')
    await browser.driver.evaluate(`window.__fixture.enter(document.querySelector('[data-bd-menu-key=settings]'))`)
    await browser.until(`document.querySelector('[data-bd-preview=settings]')`, 'screenshot preview')
    await browser.driver.evaluate('new Promise(r=>setTimeout(r,240))') /* 等入场动画（160ms）落定，别拍成半透明 */
    await browser.screenshot(path.join(OUTPUT, scenario.name + '.png'))
    records.push({ name: scenario.name, ...metrics })
    console.log('PASS ' + scenario.name + ': menu ' + JSON.stringify(metrics.menu) + ', six previews within viewport, no hover requests')
  }
  // Check the actual action dispatchers after the hover geometry matrix.
  const actionFile = path.join(OUTPUT, 'actions.html')
  fs.writeFileSync(actionFile, makeFixturePage({ clientSource: SOURCE, status, target: 'root' }))
  await browser.size(1280, 900); await browser.navigate(actionFile)
  await browser.until(`window.__fixture&&document.querySelector('[data-bd-pet-fish]')`, 'action pet')
  const actions = await browser.driver.evaluate(`(async()=>{
    const F=window.__fixture;await F.ready;const issues=[],check=(v,n)=>{if(!v)issues.push(n)},menu=()=>document.querySelector('[data-bd-menu]'),preview=()=>document.querySelector('[data-bd-preview]'),context=()=>document.querySelector('[data-bd-pet-fish]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
    for(const [key,selector] of [['background','[data-bd-pet-card][data-wide]'],['status','[data-bd-pet-card]'],['logs','[data-bd-settings-page=logs]'],['settings','[data-bd-settings-page=run]']]){
      context();await F.waitFor(menu,key+' menu');const button=menu().querySelector('[data-bd-menu-key='+key+']');F.enter(button);await F.wait(35);await F.click(button);await F.waitFor(()=>document.querySelector(selector),key+' action');await F.wait(240);check(!menu()&&!preview(),key+' action removes menu and cancels hover');
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await F.wait(35);
    }
    context();await F.waitFor(menu,'hide menu');await F.click(menu().querySelector('[data-bd-menu-key=hide]'));await F.waitFor(()=>document.querySelector('[data-bd-pet-dot]'),'hide dot');check(!preview(),'Hide clears preview');await F.click(document.querySelector('[data-bd-pet-dot]'));await F.waitFor(()=>document.querySelector('[data-bd-pet-fish]'),'show pet');
    context();await F.waitFor(menu,'unmount menu');F.enter(menu().querySelector('[data-bd-menu-key=session]'));F.root.unmount();await F.wait(250);check(!preview()&&!document.querySelector('[data-bd-pet]'),'Unmount cancels pending preview');check(F.errors.length===0,'No action runtime errors');return {issues,requests:F.requests,errors:F.errors};
  })()`)
  assert.deepEqual(actions.issues, [], 'Menu actions and cleanup')
  fs.writeFileSync(path.join(OUTPUT, 'results.json'), JSON.stringify({ fixtureOnly: true, records, actions }, null, 2))
  console.log('PASS 42 delayed previews, keyboard focus, grace period, geometry, actions, hide/restore and cleanup; isolated fixture only.')
})().catch((error) => { console.error(error.stack); process.exitCode = 1 }).finally(() => browser?.close())
