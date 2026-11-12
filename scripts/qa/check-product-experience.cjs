/** Isolated product acceptance. All HTTP and account actions are test doubles. */
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
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
let ran=0;const check=(yes,message)=>{if(!yes)throw Error(message);ran++};
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
check(document.querySelectorAll('[data-bd-basic-grid]>[data-bd-sec]').length===3,'Basic preferences have three coherent groups');
check(!document.querySelector('[data-bd-persona-card]')&&!document.querySelector('[aria-label="大肥鱼的全局人格"]'),'Basic preferences do not duplicate the global persona editor');
const companionDetails=document.querySelector('[data-bd-companion-details]');
check(companionDetails&&!companionDetails.open&&companionDetails.querySelector('summary').textContent.includes('闲聊'),'Collapsed companion settings disclose the active reminder style');
companionDetails.querySelector('summary').focus();check(document.activeElement===companionDetails.querySelector('summary'),'Companion disclosure is keyboard focusable');
await F.click(companionDetails.querySelector('summary'));check(companionDetails.open,'Companion disclosure opens its preserved editor');
const panel=document.querySelector('[data-bd-companion-settings]');
const selects=panel.querySelectorAll('select');
await F.change(selects[0],'lively');await F.change(selects[1],'minimal');
const focus=[...panel.querySelectorAll('[data-bd-toggle]')].find(n=>n.textContent.includes('工作专注模式'));
await F.click(focus.querySelector('button'));
await F.click(F.textButton('保存陪伴节奏'));
const saved=F.requests.filter(r=>r.path.endsWith('/config')&&r.method==='POST').at(-1)?.body;
check(saved?.focusMode===true&&saved?.chatterFrequency==='lively'&&saved.notificationLevel==='minimal','Draft preferences must save explicitly');
check(!('autoComment' in saved)&&!('backgroundMinutes' in saved),'Companion saving cannot change permissions or run settings');
const browse=document.querySelector('[data-bd-browse-settings]');
check(Boolean(browse),'Viewing preferences are visible in basic settings');
check(browse.querySelector('[aria-label="最低播放量"]').value==='50000','Default viewing threshold favors popular videos');
check(document.querySelectorAll('[aria-label="长期偏好关键词"]').length===1,'Viewing keywords have one authoritative editor');
const refine=browse.querySelector('[data-bd-browse-refine]');
check(refine&&!refine.open&&refine.querySelector('summary').textContent.includes('避开 0 个词'),'Collapsed viewing limits remain discoverable in their summary');
await F.click(refine.querySelector('summary'));check(refine.open,'Detailed viewing choices can be opened');
const input=(label)=>browse.querySelector('[aria-label="'+label+'"]');
const configPosts=()=>F.requests.filter(r=>r.path.endsWith('/config')&&r.method==='POST');
const beforeBrowse=configPosts().length;
await F.click([...browse.querySelectorAll('button')].find(node=>node.textContent==='科技'));
await F.change(input('视频发布时间'),'0');await F.change(input('最短时长（分钟）'),'5');await F.change(input('最长时长（分钟）'),'30');
await F.change(input('探索陌生内容的比例'),'50');await F.change(input('避开关键词'),'剧透\n营销号');
await F.change(input('长期偏好关键词'),'DeepSeek\n手工');
await F.click([...browse.querySelectorAll('[aria-label="播放量快捷选择"] button')].find(node=>node.textContent==='10 万'));
check(input('最低播放量').value==='100000'&&browse.querySelector('[data-bd-browse-refine] summary').textContent.includes('至少 100,000 播放'),'Popularity presets update draft and collapsed summary');
await F.click(refine.querySelector('summary'));await F.click(refine.querySelector('summary'));
check(input('最长时长（分钟）').value==='30'&&input('避开关键词').value==='剧透\n营销号','Closing and reopening preserves unsaved viewing edits');
check(configPosts().length===beforeBrowse,'Viewing drafts do not save or change a running task');
await F.click(F.textButton('保存刷视频偏好'));
const viewing=configPosts().at(-1).body;
check(viewing.browseRecentDays===0&&viewing.browseMinMinutes===5&&viewing.browseMaxMinutes===30&&viewing.browseExplorePercent===50,'Viewing ranges save as numeric values');
check(viewing.browseMinViews===100000,'Minimum views saves as a numeric field with viewing preferences');
check(JSON.stringify(viewing.browseTopics)==='["科技"]'&&JSON.stringify(viewing.browseAvoidKeywords)==='["剧透","营销号"]','Viewing categories and exclusions save');
check(JSON.stringify(viewing.keywords)==='["DeepSeek","手工"]','Favorite keywords save with viewing preferences');
check(!('autoComment' in viewing)&&!('backgroundMinutes' in viewing)&&!('browseSort' in viewing),'Viewing save only sends changed preferences');
const afterBrowse=configPosts().length;await F.click(F.textButton('保存刷视频偏好'));
check(configPosts().length===afterBrowse,'Unchanged viewing preferences are not submitted again');
await F.change(input('最长时长（分钟）'),'2');await F.click(F.textButton('保存刷视频偏好'));
check(configPosts().length===afterBrowse&&document.querySelector('[data-bd-pet-modal]').textContent.includes('最短时长不能大于最长时长'),'Invalid viewing range is explained without saving');
await F.change(input('最长时长（分钟）'),'60');await F.click(F.textButton('保存刷视频偏好'));
check(JSON.stringify(configPosts().at(-1).body)==='{"browseMaxMinutes":60}','A subsequent edit patches only its own field');
const beforeThreshold=configPosts().length;await F.change(input('最低播放量'),'-1');await F.click(F.textButton('保存刷视频偏好'));
check(configPosts().length===beforeThreshold&&document.querySelector('[role=alert]')?.textContent.includes('最低播放量'),'Invalid popularity threshold is explained without saving');
await F.change(input('最低播放量'),'0');await F.click(F.textButton('保存刷视频偏好'));
check(JSON.stringify(configPosts().at(-1).body)==='{"browseMinViews":0}','Disabling the threshold patches only that preference');
await F.click([...document.querySelectorAll('[role=tab]')].find(n=>n.textContent.includes('运行方式')));
const resource=document.querySelector('[data-bd-run-resources]');
check(resource&&!resource.open&&resource.querySelector('summary').textContent.includes('120,000 token'),'Resource limits collapse with the effective budget visible');
await F.click(resource.querySelector('summary'));
check([...resource.querySelectorAll('input')].length===2,'Opening resource limits preserves session rounds and budget editors');
const resourceInputs=resource.querySelectorAll('input');await F.change(resourceInputs[0],'17');await F.change(resourceInputs[1],'130000');
await F.click(resource.querySelector('summary'));await F.click(resource.querySelector('summary'));
check(resourceInputs[0].value==='17'&&resourceInputs[1].value==='130000','Resource drafts survive closing and reopening');
await F.click(F.textButton('保存默认设置'));
check(configPosts().at(-1).body.sessionMaxRounds===17&&configPosts().at(-1).body.sessionTokenBudget===130000,'Resource editors still save through the run settings authority');
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
F.finish({ok:true,checks:ran,requests:F.requests.length});`

async function main() {
  const browser = await openChrome({ output, width: 1280, height: 900 })
  try {
    /* P3-41：总数实测 —— node 侧断言逐条计入 must()，浏览器探针回传的 checks 实跑数求和 */
    let nodeChecks = 0
    let browserChecks = 0
    const must = (yes, label) => { nodeChecks++; assert.ok(yes, label) }
    const addProbe = (r) => { browserChecks += Number(r && r.checks) || 0 }
    const file = path.join(output, 'dashboard.html')
    fs.writeFileSync(file, makeFixturePage({ clientSource, status, probe, tab: 'run' }))
    await browser.navigate(file)
    await browser.until("document.title==='fixture done'", 'product interaction')
    const result = await browser.driver.evaluate('JSON.parse(document.getElementById("fixture-result").textContent)')
    must(result.errors.length === 0, 'dashboard fixture errors: ' + JSON.stringify(result))
    must(result.ok === true, 'dashboard fixture finished ok')
    addProbe(result)
    await browser.screenshot(path.join(output, 'dashboard-desktop.png'))
    await browser.size(390, 844)
    must(await browser.driver.evaluate("document.querySelector('[data-bd-pet-modal]').getBoundingClientRect().right<=innerWidth+1"), 'Mobile modal must fit viewport')
    must(await browser.driver.evaluate("document.querySelector('[data-bd-pet-body]').scrollWidth<=document.querySelector('[data-bd-pet-body]').clientWidth+1"), 'Mobile content must not overflow')
    await browser.screenshot(path.join(output, 'dashboard-mobile.png'))

    const personaProbe = String.raw`
      let ran=0;const check=(yes,message)=>{if(!yes)throw Error(message);ran++};
      const card=()=>document.querySelector('[data-bd-persona-card]'),input=()=>card().querySelector('textarea'),save=()=>F.textButton('保存全局人格'),posts=()=>F.requests.filter(row=>row.path.endsWith('/config')&&row.method==='POST');
      check(Boolean(card())&&!card().closest('details')&&F.inView(F.rect(input())),'Global persona is a visible first-screen editor');
      check(input().rows>=8&&input().getBoundingClientRect().height>=160&&input().maxLength===4000,'Persona editor has room for a full character');
      check(input().value===''&&save().disabled&&card().textContent.includes('内置默认')&&card().textContent.includes('普通会话不受影响'),'An empty persona uses the default within fish mode');
      check(['聊天及所有 AI 发言','会话','后台刷站','评论与回复','动态','私信','本地状态通知使用固定文案'].every(text=>card().textContent.includes(text)),'Persona scope lists AI channels and local notification behavior');
      check(posts().length===0,'Viewing the default does not save a replacement');
      await F.change(input(),'自定义全局人格：闲聊活泼，严肃时认真');
      check(!save().disabled&&card().textContent.includes('有未保存修改'),'Editing creates a visible unsaved draft');
      await F.click(save());
      check(JSON.stringify(posts().at(-1).body)==='{"persona":"自定义全局人格：闲聊活泼，严肃时认真"}','Persona saving patches only its own field');
      check(save().disabled&&card().textContent.includes('已保存自定义人格'),'A confirmed save updates the visible authority');
      await F.click(document.querySelector('#bd-tab-basic'));check(!document.querySelector('[data-bd-persona-card]'),'There is only one persona editing location');
      await F.click(document.querySelector('#bd-tab-speech'));
      check(input().value==='自定义全局人格：闲聊活泼，严肃时认真','Saved persona survives navigation');
      await F.change(input(),'等待回执的旧草稿');const hold=F.deferReply('POST','/config');await F.click(save());
      await F.change(input(),'请求期间继续写的新草稿');
      F.data.status.config={...F.data.status.config,persona:'等待回执的旧草稿'};hold.release(200,{ok:true,config:F.data.status.config});await F.wait(50);
      check(input().value==='请求期间继续写的新草稿'&&!save().disabled&&card().textContent.includes('有未保存修改'),'A late save receipt preserves newer edits');
      F.queueReply('POST','/config',F.reply(200,{ok:false,error:'QA_PERSONA_SAVE_FAILED'}));await F.click(save());
      check(input().value==='请求期间继续写的新草稿'&&!save().disabled&&document.querySelector('[role=alert]')?.textContent.includes('QA_PERSONA_SAVE_FAILED'),'Logical save failures remain visible without discarding the draft');
      await F.click(save());check(save().disabled&&card().textContent.includes('已保存自定义人格'),'Saving can recover after failure');
      await F.change(input(),'');await F.click(save());
      check(posts().at(-1).body.persona===''&&save().disabled&&card().textContent.includes('当前使用内置默认人格'),'Saving an empty persona restores the installed default');
      check(document.querySelectorAll('[aria-label="大肥鱼的全局人格"]').length===1&&!F.unknownRequests.length,'The persona flow uses one editor and declared routes');
      F.finish({ok:true,checks:ran});`
    for (const [name, width, height] of [['desktop',1280,900],['mobile',390,844]]) {
      const personaFile = path.join(output, 'persona-' + name + '.html')
      fs.writeFileSync(personaFile, makeFixturePage({ clientSource, status, tab: 'speech', probe: personaProbe }))
      await browser.size(width,height); await browser.navigate(personaFile)
      await browser.until("document.title==='fixture done'", 'persona ' + name)
      const result = await browser.driver.evaluate('JSON.parse(document.getElementById("fixture-result").textContent)')
      must(result.errors.length === 0, 'persona ' + name + ': ' + JSON.stringify(result)); must(result.ok === true, 'persona ' + name + ' completed'); addProbe(result)
      await browser.screenshot(path.join(output, 'persona-' + name + '.png'))
    }

    const future = Date.now() + 15 * 60_000
    const runCases = [
      { name: 'session-budget', feiyu: { active: false, stopReason: 'token-budget', goal: { phase: 'paused', activation: 'disarmed', rounds: 3, maxRounds: 64 } }, label: '已暂停', note: '本趟 token 预算已用完' },
      { name: 'session-disarmed', feiyu: { active: true, goal: { phase: 'active', activation: 'disarmed', rounds: 3, maxRounds: 64 } }, label: '需要处理', note: '自动续刷已停用' },
      { name: 'session-retry', feiyu: { active: false, goal: { phase: 'active', activation: 'armed' }, continuation: { state: 'waiting-retry', reason: 'max-tokens', nextAt: future, retries: 1 } }, label: '等待自动续刷', note: '稍后自动接着刷', waiting: true },
      { name: 'session-attention', feiyu: { active: false, goal: { phase: 'paused', activation: 'disarmed' }, continuation: { state: 'needs-attention', reason: 'model-error' } }, label: '需要处理', note: '模型请求失败' },
      { name: 'daily-window', config: { scheduleEnabled: true, scheduleAllDay: true }, schedule: { inWindow: true, nextRunAt: future }, plan: '每日定时已安排', next: '下次定时检查' },
      { name: 'daily-error', config: { scheduleEnabled: true, scheduleAllDay: false, scheduleStart: '18:00', scheduleEnd: '09:00' }, schedule: { inWindow: false, lastError: 'QA_SCHEDULE_RETRY' }, plan: '每日定时已安排', next: 'QA_SCHEDULE_RETRY' },
      { name: 'natural-rest', mode: 'background', bgWindow: { start: '00:00', end: '23:59', active: true, holdUntil: future, holdReason: 'rest' }, label: '自然休息中', note: '之后在有效时段内自动恢复' },
      { name: 'legacy-hold', mode: 'background', bgWindow: { start: '00:00', end: '23:59', active: true, holdUntil: future }, label: '自动运行已暂停', note: '暂停至' },
      { name: 'queued-relay', mode: 'background', backgroundRun: { active: false, continuationPending: true, nextStartAt: future, model: 'fixture/background' }, label: '等待后台接力', note: '接力任务已排队', waiting: true },
    ]
    for (const row of runCases) {
      const runProbe = 'const expected=' + JSON.stringify(row) + ';' + String.raw`
        let ran=0;const check=(yes,message)=>{if(!yes)throw Error(message);ran++};
        const mode=expected.mode||'session',panel=document.querySelector('[data-bd-run-state='+mode+']'),plan=document.querySelector('[data-bd-run-plan]');
        check(Boolean(panel)&&Boolean(plan),'Run status and plan exist');
        if(expected.label){check(panel.textContent.includes(expected.label),'Accurate '+expected.name+' state');check(panel.querySelector('[data-bd-run-state-note]').textContent.includes(expected.note),'Accurate '+expected.name+' reason');}
        if(expected.plan){check(plan.textContent.includes(expected.plan)&&plan.textContent.includes(expected.next),'Daily schedule uses actual status');check(!plan.textContent.includes('等待手动开始')&&!plan.textContent.includes('现在未安排'),'Enabled daily schedule never appears unarranged');}
        if(expected.waiting){check(document.querySelector('[data-bd-launch-action='+mode+']').disabled,'Queued work cannot be started twice');check(Boolean(F.textButton(mode==='session'?'暂停':'停止后台任务')),'Queued work has a stop control');}
        if(expected.name==='legacy-hold')check(!panel.textContent.includes('手动停止'),'Old hold state never invents a manual reason');
        check(panel.querySelector('[data-bd-last-action]').textContent.includes('AUDIT_REAL_SUBTITLE'),'Run status shows a real tool snapshot');
        check(!panel.querySelector('[data-bd-last-action]').textContent.includes('AUDIT_STATIC_NOTICE'),'Static notification never masquerades as activity');
        check(!F.unknownRequests.length,'Run state uses declared fixture routes');F.finish({ok:true,checks:ran});`
      const runFile = path.join(output, 'run-' + row.name + '.html')
      const runStatus = { ...status, config: { ...status.config, backgroundWindowStart: '', backgroundWindowEnd: '', ...row.config }, feiyu: row.feiyu || { active: false },
        bgBusy: false, backgroundRun: row.backgroundRun || null, bgWindow: row.bgWindow || { start: '', end: '', active: false, holdUntil: 0 }, schedule: row.schedule || {},
        activity: [{ id: 'run-audit', kind: 'done', text: 'AUDIT_REAL_SUBTITLE', tool: 'bili_subtitle' }], petEvent: { at: Date.now(), text: 'AUDIT_STATIC_NOTICE', kind: 'chatter' } }
      fs.writeFileSync(runFile, makeFixturePage({ clientSource, status: runStatus, tab: 'run', runMode: row.mode || 'session', probe: runProbe }))
      await browser.size(1280,900);await browser.navigate(runFile);await browser.until("document.title==='fixture done'", row.name)
      const result = await browser.driver.evaluate('JSON.parse(document.getElementById("fixture-result").textContent)')
      must(result.errors.length === 0, row.name + ': ' + JSON.stringify(result)); must(result.ok === true, row.name + ' completed');addProbe(result)
    }
    const windowProbe = String.raw`
      let ran=0;const check=(yes,message)=>{if(!yes)throw Error(message);ran++};
      const panel=()=>document.querySelector('[data-bd-settings-page=background]'),times=()=>[...panel().querySelectorAll('input[type=time]')];
      await F.change(times()[0],'20:00');await F.change(times()[1],'23:00');
      check(panel().querySelector('[data-bd-window-draft]').textContent.includes('未保存')&&panel().textContent.includes('时段草稿（未生效）'),'Unsaved windows clearly remain drafts');
      const starts=()=>F.requests.filter(r=>r.path.endsWith('/pet/start')),posts=()=>F.requests.filter(r=>r.path.endsWith('/config')&&r.method==='POST');
      await F.click(document.querySelector('[data-bd-launch-action=background]'));
      check(starts().length===1&&starts()[0].body.durationMinutes===45&&!('windowStart' in starts()[0].body)&&!('backgroundWindowStart' in starts()[0].body),'Manual start preserves the host request contract');
      check(posts().length===0&&panel().textContent.includes('直接开始后台刷仍使用已保存的时段'),'Starting does not silently persist a draft window');
      await F.click(F.textButton('保存默认设置'));
      check(posts().at(-1).body.backgroundWindowStart==='20:00'&&posts().at(-1).body.backgroundWindowEnd==='23:00','Window persistence uses config');
      check(!panel().querySelector('[data-bd-window-draft]')&&panel().textContent.includes('已保存时段：20:00–23:00'),'Saved window replaces the draft notice');
      check(!F.unknownRequests.length,'Window flow uses declared routes');F.finish({ok:true,checks:ran});`
    const windowFile = path.join(output, 'run-window-draft.html')
    fs.writeFileSync(windowFile, makeFixturePage({ clientSource, status: { ...status,config:{...status.config,backgroundMinutes:45,backgroundWindowStart:'',backgroundWindowEnd:''},feiyu:{active:false} },tab:'run',runMode:'background',probe:windowProbe }))
    await browser.navigate(windowFile);await browser.until("document.title==='fixture done'",'window draft')
    const windowResult=await browser.driver.evaluate('JSON.parse(document.getElementById("fixture-result").textContent)')
    must(windowResult.errors.length===0,'window draft: '+JSON.stringify(windowResult));must(windowResult.ok===true,'window draft completed');addProbe(windowResult)

    // Current policy comes from the same module as the host. Historic render fixtures still exercise old-host values.
    const { paceSummary, paceExplain } = await import(pathToFileURL(path.join(path.dirname(CLIENT), 'lib/pace.mjs')).href)
    const currentPace = { ok: true, ...paceSummary({}, Date.now(), 1), explanation: paceExplain({}, Date.now(), 1) }
    const policyProbe = `const expected=${JSON.stringify(currentPace.explanation.kinds)};` + String.raw`
      let ran=0;const check=(yes,message)=>{if(!yes)throw Error(message);ran++};
      const line=kind=>document.querySelector('[data-bd-pace-range='+kind+']');
      for(const [kind,value] of Object.entries(expected))check(line(kind)?.textContent.includes('当前本地额度 '+value.hourCap+' 条/滚动小时'),'Displayed '+kind+' hourly capacity follows the backend policy');
      check(document.querySelector('[data-bd-pace-current=comment]').textContent.includes('/'+expected.comment.hourCap+' 条'),'Live status uses the same current capacity');
      const before=F.requests.filter(row=>row.path.endsWith('/config')).length;await F.click(F.textButton('轻快 0.5'));
      check(line('comment').textContent.includes('草稿 '+expected.comment.baseMinSec*0.5+'–'+expected.comment.baseMaxSec*0.5+' 秒'),'Responsive preset previews the next interval');
      check(line('comment').textContent.includes('当前本地额度 '+expected.comment.hourCap+' 条/滚动小时'),'An interval draft does not pretend to change hourly capacity');
      check(F.requests.filter(row=>row.path.endsWith('/config')).length===before,'A preset selection only edits the existing draft');
      check(document.querySelector('[data-bd-pace-editor]').textContent.includes('不是 B站 承诺的安全频率'),'The local policy is not a platform safety promise');
      F.finish({ok:true,checks:ran});`
    const policyFile = path.join(output, 'pace-policy.html')
    fs.writeFileSync(policyFile, makeFixturePage({ clientSource, status: { ...status, config: { ...status.config, paceFactor: 1 }, pace: currentPace }, tab: 'speech', probe: policyProbe }))
    await browser.size(1280, 900); await browser.navigate(policyFile)
    await browser.until("document.title==='fixture done'", 'current local activity policy')
    const currentPolicy = await browser.driver.evaluate('JSON.parse(document.getElementById("fixture-result").textContent)')
    must(currentPolicy.errors.length === 0, 'current activity policy errors: ' + JSON.stringify(currentPolicy)); must(currentPolicy.ok === true, 'current policy finished'); addProbe(currentPolicy)

    // The real session route can return a recoverable id even when permission inheritance fails after creation.
    const partialSessionProbe = String.raw`
      let ran=0;const check=(yes,message)=>{if(!yes)throw Error(message);ran++};
      for(const [http,id] of [[200,'partial-session-logical'],[503,'partial-session-http']]){
        F.queueReply('POST','/pet/session-new',F.reply(http,{ok:false,error:'QA_PARTIAL_CREATE',sessionId:id,hint:'恢复该会话前需核对权限'}));
        await F.click(document.querySelector('[data-bd-launch-action=session]'));
        await F.waitFor(()=>document.querySelector('[role=alert]')?.textContent.includes('QA_PARTIAL_CREATE'),'partial creation error');
        check(document.querySelector('[role=alert]').textContent.includes(id),'Partially created session id remains visible after HTTP '+http);
        check(!F.requests.some(row=>row.path.endsWith('/pet/start')),'Partially created sessions never start without successful inheritance');
      }
      F.finish({ok:true,checks:ran});`
    const quickSessionProbe = String.raw`
      let ran=0;const check=(yes,message)=>{if(!yes)throw Error(message);ran++};
      const launch=()=>document.querySelector('[data-bd-pet-fish]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));
      for(const [http,id] of [[200,'quick-partial-logical'],[503,'quick-partial-http']]){
        F.queueReply('POST','/pet/session-new',F.reply(http,{ok:false,error:'QA_PARTIAL_CREATE',sessionId:id}));launch();
        await F.waitFor(()=>document.querySelector('[data-bd-pet-toast]')?.textContent.includes(id),'quick partial receipt');
        check(!F.requests.some(row=>row.path.endsWith('/pet/start')),'Quick launch preserves partial id without starting after HTTP '+http);
      }
      const originalGet=ctx.get;ctx.get=name=>{const value=originalGet(name);return name==='uiWorkspace'?{...value,openSession:async()=>{throw Error('QA_OPEN_SESSION_REJECTED')}}:value};
      launch();await F.waitFor(()=>F.requests.some(row=>row.path.endsWith('/pet/start')),'quick run continues after navigation failure');await F.wait(80);
      check(F.errors.length===0,'Async openSession rejection is handled');
      check(document.querySelector('[data-bd-pet-toast]').textContent.includes('fixture-new-session'),'Quick navigation failure retains the created session id');
      F.finish({ok:true,checks:ran});`
    for (const [name, probe, target] of [['partial-session', partialSessionProbe, 'settings'], ['quick-session', quickSessionProbe, 'root']]) {
      const file = path.join(output, name + '.html')
      fs.writeFileSync(file, makeFixturePage({ clientSource, status, tab: 'run', target, position: { x: 'right', y: 'bottom' }, probe }))
      await browser.size(1280, 900); await browser.navigate(file)
      await browser.until("document.title==='fixture done'", name + ' compatibility')
      const result = await browser.driver.evaluate('JSON.parse(document.getElementById("fixture-result").textContent)')
      must(result.errors.length === 0, name + ' errors: ' + JSON.stringify(result)); must(result.ok === true, name + ' finished: ' + JSON.stringify(result)); addProbe(result)
    }

    const petFile = path.join(output, 'pet.html')
    const petProbe = String.raw`
      let ran=0;const check=(yes,message)=>{if(!yes)throw Error(message);ran++};
      F.data.status={...F.data.status,rev:'pet-2',learn:{approved:3,pending:0},companion:{silenced:false,notificationLevel:'normal',reducedMotion:true}};
      const poll=[...F.intervals.values()].find(x=>x.ms===5000);check(Boolean(poll),'Missing shared status poll');await poll.callback();
      await F.waitFor(()=>document.querySelector('[data-bd-pet-reaction]'),'Learning reaction');
      check(document.querySelector('[data-bd-pet-reaction]').textContent.includes('又懂了一点'),'Missing context reaction');
      check(document.querySelector('[data-bd-pet-fish]').hasAttribute('data-reduced-motion'),'Reduced motion not wired');
      F.data.status={...F.data.status,rev:'pet-3',petEvent:{at:Date.now(),text:'隔离测试：制作完成',tone:'good',kind:'complete'},companion:{silenced:true,notificationLevel:'minimal',reducedMotion:true}};
      await poll.callback();await F.waitFor(()=>document.querySelector('[data-bd-pet-toast]').textContent.includes('隔离测试：制作完成'),'First terminal receipt while focused');
      check(document.querySelector('[data-bd-pet-toast]').textContent.includes('隔离测试：制作完成'),'First terminal receipt text');
      F.finish({ok:true,checks:ran});`
    fs.writeFileSync(petFile, makeFixturePage({ clientSource, status, target: 'root', position: { x: 'right', y: 'bottom' }, probe: petProbe }))
    await browser.size(1280, 900); await browser.navigate(petFile)
    await browser.until("document.title==='fixture done'", 'pet reaction')
    const pet = await browser.driver.evaluate('JSON.parse(document.getElementById("fixture-result").textContent)')
    must(pet.errors.length === 0, 'pet fixture errors: ' + JSON.stringify(pet))
    must(pet.ok === true, 'pet fixture finished ok')
    addProbe(pet)
    await browser.screenshot(path.join(output, 'pet-reaction.png'))
    const review = { ok: true, rev: 'review-1', pending: 2, unknown: 1, items: [
      { id: 'sr-one', kind: '视频评论', state: 'pending', hash: 'a'.repeat(64), args: { bvid: 'BV1234567890', text: '镜头停在旋钮上的那一秒，想隔着屏幕摸摸它的质感。' } },
      { id: 'sr-two', kind: '成果私信', state: 'pending', hash: 'b'.repeat(64), args: { text: '这次的精选理由已经整理好了。' }, targetUid: '123' },
      { id: 'sr-unknown', kind: '动态', state: 'unknown', hash: 'c'.repeat(64), args: { text: '这条需要核对结果。' } },
    ] }
    const reviewProbe = String.raw`
      let ran=0;const check=(yes,msg)=>{if(!yes)throw Error(msg);ran++};
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
      F.finish({ok:true,checks:ran});`
    const reviewFile = path.join(output, 'send-review.html')
    fs.writeFileSync(reviewFile, makeFixturePage({ clientSource, status: { ...status, config: { ...status.config, sendReview: true }, sendReview: { ok: true, rev: 'review-1', pending: 2, unknown: 1 } }, fixtures: { sendReview: review }, tab: 'speech', probe: reviewProbe }))
    await browser.navigate(reviewFile)
    await browser.until("document.title==='fixture done'", 'send approval UI')
    const sent = await browser.driver.evaluate('JSON.parse(document.getElementById("fixture-result").textContent)')
    must(sent.errors.length === 0, 'send-review fixture errors: ' + JSON.stringify(sent))
    must(sent.ok === true, 'send-review fixture finished ok')
    addProbe(sent)
    await browser.screenshot(path.join(output, 'send-review-desktop.png'))
    await browser.size(390, 844)
    must(await browser.driver.evaluate("document.querySelector('[data-bd-pet-body]').scrollWidth<=document.querySelector('[data-bd-pet-body]').clientWidth+1"), 'Send review fits mobile')
    await browser.screenshot(path.join(output, 'send-review-mobile.png'))
    /* P3-41：不再写死总数 —— 输出实测值（node 断言 + 探针实跑 check），加减检查项时不再漂移 */
    console.log('Product acceptance: ' + (nodeChecks + browserChecks) + ' checks passed (measured). Isolated fixtures and screenshots: ' + output)
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
