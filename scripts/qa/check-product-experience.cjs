/** Isolated product acceptance. All HTTP and account actions are test doubles. */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { makeFixturePage } = require('./ui-browser-fixture.cjs')
const { openChrome } = require('./browser-cdp.cjs')
const { CLIENT, qaOutput } = require('./paths.cjs')
const output = qaOutput('product-experience')
const clientSource = fs.readFileSync(CLIENT, 'utf8')
fs.mkdirSync(output, { recursive: true })
const status = { ok: true, rev: 'product-fixture', today: '2026-10-29', venvReady: true, loggedIn: true, petShow: true,
  ranToday: 0, pickedToday: 0, tokensToday: 0, tokensTotal: 0, config: { perDay: 5, reportLevel: 'full', dmMode: 'off',
    idleChatter: true, sessionModelId: 'fixture/session', sessionTokenBudget: 120000, backgroundModelId: 'fixture/background', backgroundTokenBudget: 60000 },
  companion: { silenced: false, notificationLevel: 'normal', label: '自然陪伴', reducedMotion: false },
  learn: { approved: 2, pending: 0, total: 2, kinds: [] }, soul: { filled: ['mood', 'next'], empty: false },
  activity: [], models: [], feiyu: { active: false, goal: { phase: 'paused', maxRounds: 64, rounds: 2 }, model: 'fixture/stale-session' },
  retrospective: { totals: { picks: 0, runs: 0, tokens: 0, activeDays: 0 }, days: [], themes: [] }, recovery: { rows: [], needsAction: false } }

const probe = String.raw`
const check=(yes,message)=>{if(!yes)throw Error(message)};
check(document.querySelectorAll('[data-bd-pet-tab]').length===6,'Six primary groups');
check(!F.requests.some(r=>/\/(pv|learn|stickers|memory)$/.test(r.path)),'Initial run page must not eagerly load secondary data');
check(document.querySelector('[data-bd-settings-page=run]'),'Run is the default workspace');
const starts=[...document.querySelectorAll('[data-bd-launch-action]')];
check(starts.length===2&&starts.every(node=>F.inView(F.rect(node))),'Both run actions are visible in first screen');
check(document.querySelector('[data-bd-run-launch=session]').textContent.includes('fixture/session'),'Session launch uses its own model');
check(document.querySelector('[data-bd-run-launch=background]').textContent.includes('60,000'),'Background launch uses its own budget');
document.querySelector('[data-bd-pet-body]').scrollTop=350;
await F.click(document.querySelector('#bd-tab-basic'));
check(document.querySelector('[data-bd-pet-body]').scrollTop===0,'Navigation resets scroll position');
const panel=document.querySelector('[data-bd-companion-settings]');
const selects=panel.querySelectorAll('select');
await F.change(selects[0],'lively');await F.change(selects[1],'minimal');
const focus=[...panel.querySelectorAll('[data-bd-toggle]')].find(n=>n.textContent.includes('工作专注模式'));
await F.click(focus.querySelector('button'));
await F.click(F.textButton('保存陪伴节奏'));
const saved=F.requests.filter(r=>r.path.endsWith('/config')&&r.method==='POST').at(-1)?.body;
check(saved?.focusMode===true&&saved?.chatterFrequency==='lively'&&saved.notificationLevel==='minimal','Draft preferences must save explicitly');
check(!('autoComment' in saved)&&!('backgroundMinutes' in saved),'Companion saving cannot change permissions or run settings');
await F.click([...document.querySelectorAll('[role=tab]')].find(n=>n.textContent.includes('运行方式')));
check(document.querySelector('[data-bd-run-plan]').textContent.includes('fixture/session'),'Idle plan must use selected mode, not stale session model');
await F.click(F.textButton('后台与定时'));
check(document.querySelector('[data-bd-run-plan]').textContent.includes('fixture/background'),'Background plan uses its own model');
check(document.querySelector('[data-bd-run-plan]').textContent.includes('60,000'),'Background plan uses its own budget');
await F.click(document.querySelector('#bd-tab-logs'));
await F.click(document.querySelector('[data-bd-page-target=review]'));
const hero=document.querySelector('[data-bd-today-hero]');
check(hero&&hero.children.length===2,'Review retains its artwork and summary');
check(document.querySelector('[data-bd-today-status]').innerText.includes('0'),'Known zero usage is visible');
await F.click(document.querySelector('#bd-tab-run'));
const body=document.querySelector('[data-bd-pet-body]');body.scrollTop=0;
F.finish({ok:true,checks:14,requests:F.requests.length});`

async function main() {
  const browser = await openChrome({ output, width: 1280, height: 900 })
  try {
    const file = path.join(output, 'dashboard.html')
    fs.writeFileSync(file, makeFixturePage({ clientSource, status, probe, tab: 'run' }))
    await browser.navigate(file)
    await browser.until("document.title==='fixture done'", 'product interaction')
    const result = await browser.driver.evaluate('JSON.parse(document.getElementById("fixture-result").textContent)')
    assert.deepEqual(result.errors, [], JSON.stringify(result))
    assert.equal(result.ok, true)
    await browser.screenshot(path.join(output, 'dashboard-desktop.png'))
    await browser.size(390, 844)
    assert(await browser.driver.evaluate("document.querySelector('[data-bd-pet-modal]').getBoundingClientRect().right<=innerWidth+1"), 'Mobile modal must fit viewport')
    assert(await browser.driver.evaluate("document.querySelector('[data-bd-pet-body]').scrollWidth<=document.querySelector('[data-bd-pet-body]').clientWidth+1"), 'Mobile content must not overflow')
    await browser.screenshot(path.join(output, 'dashboard-mobile.png'))

    const petFile = path.join(output, 'pet.html')
    const petProbe = String.raw`
      F.data.status={...F.data.status,rev:'pet-2',learn:{approved:3,pending:0},companion:{silenced:false,notificationLevel:'normal',reducedMotion:true}};
      const poll=[...F.intervals.values()].find(x=>x.ms===5000);if(!poll)throw Error('Missing shared status poll');await poll.callback();
      await F.waitFor(()=>document.querySelector('[data-bd-pet-reaction]'),'Learning reaction');
      if(!document.querySelector('[data-bd-pet-reaction]').textContent.includes('又懂了一点'))throw Error('Missing context reaction');
      if(!document.querySelector('[data-bd-pet-fish]').hasAttribute('data-reduced-motion'))throw Error('Reduced motion not wired');
      F.data.status={...F.data.status,rev:'pet-3',petEvent:{at:Date.now(),text:'隔离测试：制作完成',tone:'good',kind:'complete'},companion:{silenced:true,notificationLevel:'minimal',reducedMotion:true}};
      await poll.callback();await F.waitFor(()=>document.querySelector('[data-bd-pet-toast]').textContent.includes('隔离测试：制作完成'),'First terminal receipt while focused');
      F.finish({ok:true,checks:4});`
    fs.writeFileSync(petFile, makeFixturePage({ clientSource, status, target: 'root', position: { x: 'right', y: 'bottom' }, probe: petProbe }))
    await browser.size(1280, 900); await browser.navigate(petFile)
    await browser.until("document.title==='fixture done'", 'pet reaction')
    const pet = await browser.driver.evaluate('JSON.parse(document.getElementById("fixture-result").textContent)')
    assert.deepEqual(pet.errors, [], JSON.stringify(pet)); assert.equal(pet.ok, true)
    await browser.screenshot(path.join(output, 'pet-reaction.png'))
    const review = { ok: true, rev: 'review-1', pending: 2, unknown: 1, items: [
      { id: 'sr-one', kind: '视频评论', state: 'pending', hash: 'a'.repeat(64), args: { bvid: 'BV1234567890', text: '镜头停在旋钮上的那一秒，想隔着屏幕摸摸它的质感。' } },
      { id: 'sr-two', kind: '成果私信', state: 'pending', hash: 'b'.repeat(64), args: { text: '这次的精选理由已经整理好了。' }, targetUid: '123' },
      { id: 'sr-unknown', kind: '动态', state: 'unknown', hash: 'c'.repeat(64), args: { text: '这条需要核对结果。' } },
    ] }
    const reviewProbe = String.raw`
      const check=(yes,msg)=>{if(!yes)throw Error(msg)};
      await F.waitFor(()=>document.querySelectorAll('[data-bd-send-review-item]').length===2,'On-demand previews');
      check(F.requests.filter(x=>x.path.endsWith('/send-review')).length===1,'Mount loads the queue once');
      await F.click(document.querySelector('[aria-label="批准并发送：sr-one"]'));
      const posts=()=>F.requests.filter(x=>x.method==='POST'&&x.path.endsWith('/send-review'));
      check(posts().length===1&&posts()[0].body.expectedHash==='a'.repeat(64),'Approval binds displayed hash');
      await F.click(document.querySelector('[aria-label="拒绝发送：sr-two"]'));
      check(posts().length===2&&posts()[1].body.decision==='reject','Rejection uses explicit decision');
      await F.click(F.textButton('全部记录'));
      const unknown=[...document.querySelectorAll('[data-bd-send-review-item]')].find(x=>x.textContent.includes('这条需要核对结果'));
      check(unknown&&!unknown.querySelector('button'),'Unknown outcomes have no retry');
      check(!F.unknownRequests.length,'All routes are declared fixture routes');
      F.finish({ok:true,checks:5});`
    const reviewFile = path.join(output, 'send-review.html')
    fs.writeFileSync(reviewFile, makeFixturePage({ clientSource, status: { ...status, config: { ...status.config, sendReview: true }, sendReview: { ok: true, rev: 'review-1', pending: 2, unknown: 1 } }, fixtures: { sendReview: review }, tab: 'speech', probe: reviewProbe }))
    await browser.navigate(reviewFile)
    await browser.until("document.title==='fixture done'", 'send approval UI')
    const sent = await browser.driver.evaluate('JSON.parse(document.getElementById("fixture-result").textContent)')
    assert.deepEqual(sent.errors, [], JSON.stringify(sent)); assert.equal(sent.ok, true)
    await browser.screenshot(path.join(output, 'send-review-desktop.png'))
    await browser.size(390, 844)
    assert(await browser.driver.evaluate("document.querySelector('[data-bd-pet-body]').scrollWidth<=document.querySelector('[data-bd-pet-body]').clientWidth+1"), 'Send review fits mobile')
    await browser.screenshot(path.join(output, 'send-review-mobile.png'))
    console.log('Product acceptance: 26 checks passed. Isolated fixtures and screenshots: ' + output)
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
