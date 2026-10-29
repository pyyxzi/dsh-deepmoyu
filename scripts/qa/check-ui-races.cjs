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
]
async function main() {
  fs.mkdirSync(output, { recursive: true })
  const browser = await openChrome({ output, width: 1280, height: 900 })
  try {
    for (const row of probes) {
      const file = path.join(output, row.name + '.html')
      fs.writeFileSync(file, makeFixturePage({ clientSource, status: structuredClone(base), ...row, probe: row.code }))
      await browser.navigate(file); await browser.until("document.title==='fixture done'", row.name + ' race')
      const result = await browser.driver.evaluate('JSON.parse(document.getElementById("fixture-result").textContent)')
      assert.deepEqual(result.errors, [], JSON.stringify({ name: row.name, result })); assert.equal(result.ok, true)
      console.log('PASS ' + row.name + ': deferred single-flight and stale-response behavior')
    }
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
