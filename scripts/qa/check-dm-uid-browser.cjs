/** UID form regression: current client + real React, intercepted transport, no account sends. */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { makeFixturePage } = require('./ui-browser-fixture.cjs')
const { demoData } = require('./demo-data.cjs')
const { openChrome } = require('./browser-cdp.cjs')
const { CLIENT, qaOutput } = require('./paths.cjs')
const output = qaOutput('dm-uid')
const probe = String.raw`
const checks=[],check=(ok,label)=>{checks.push({label,ok:Boolean(ok)});if(!ok)throw Error(label)};
const input=()=>document.querySelector('[data-bd-pet-modal] [aria-label="收件人 UID"]');
const save=()=>F.textButton('保存投递设置');
const posts=()=>F.requests.filter(row=>row.path.endsWith('/config')&&row.method==='POST'&&Object.hasOwn(row.body,'dmUid'));
const remount=async()=>{F.root.unmount();F.root=localRequire('react-dom/client').createRoot(document.getElementById('fixture-root'));F.root.render(React.createElement(Settings));await F.waitFor(input,'UID field after remount');await F.wait(40)};
await F.waitFor(()=>input()?.value==='9876543210987654321','initial 19-digit UID');
check(input().type==='text'&&input().inputMode==='numeric'&&input().pattern==='[0-9]*','UID uses numeric-keyboard text input, never number input');
check(input().value==='9876543210987654321','19-digit saved UID renders without precision loss');
await F.change(input(),'1234567890123456789');await F.click(save());
check(typeof posts().at(-1).body.dmUid==='string'&&posts().at(-1).body.dmUid==='1234567890123456789','19-digit edited UID is posted as its exact decimal string');
check(Object.keys(posts().at(-1).body).sort().join(',')==='dmMode,dmUid','UID save does not change unrelated permissions');
await remount();check(input().value==='1234567890123456789','server-echoed long UID round-trips after a fresh component mount');
await F.change(input(),'0001234567890123456789');await F.click(save());
check(posts().at(-1).body.dmUid==='0001234567890123456789','Leading zeroes are passed as digits rather than a Number conversion');
await F.change(input(),'0');await F.click(save());check(posts().at(-1).body.dmUid==='0','Explicit zero is submitted as string zero for backend normalization');
await F.change(input(),'');await F.click(save());check(posts().at(-1).body.dmUid==='','An empty recipient is submitted as empty string for backend normalization');
F.data.status.config.dmUid=1234567890;await remount();
check(input().value==='1234567890','Legacy safe-integer configuration remains editable');
await F.click(save());check(posts().at(-1).body.dmUid==='1234567890','Legacy safe integer saves as exact decimal string');
check(!F.requests.some(row=>row.path.endsWith('/send-review')&&row.method==='POST'),'UID form never sends account content');
check(F.unknownRequests.length===0,'All form requests use declared fixture routes');
F.finish({ok:true,checks,requests:posts(),errors:F.errors});
`
async function main() {
  const data = demoData()
  Object.assign(data.status.config, { dmMode: 'both', dmUid: '9876543210987654321' })
  const browser = await openChrome({ output })
  try {
    const file = path.join(output, 'long-uid.html')
    fs.writeFileSync(file, makeFixturePage({ clientSource: fs.readFileSync(CLIENT, 'utf8'), ...data, tab: 'speech', probe }))
    await browser.navigate(file); await browser.until("document.title==='fixture done'", 'exact decimal UID form', 200)
    const result = await browser.driver.evaluate('JSON.parse(document.getElementById("fixture-result").textContent)')
    assert.deepEqual(result.errors, [], JSON.stringify(result))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert(result.checks.every(row => row.ok), JSON.stringify(result))
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2))
    console.log('PASS exact UID browser round-trip: ' + result.checks.length + ' checks')
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
