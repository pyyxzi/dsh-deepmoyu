/** Capture the current client with explicitly synthetic demonstration data. */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { makeFixturePage } = require('./ui-browser-fixture.cjs')
const { demoData } = require('./demo-data.cjs')
const { openChrome } = require('./browser-cdp.cjs')
const { ROOT, CLIENT, qaOutput } = require('./paths.cjs')
async function main() {
  const output = qaOutput('release-screenshots'), destination = path.join(ROOT, 'assets/screenshots')
  fs.mkdirSync(destination, { recursive: true })
  const clientSource = fs.readFileSync(CLIENT, 'utf8')
  const browser = await openChrome({ output, width: 1280, height: 900 })
  try {
    for (const [name, tab] of [['workspace', 'run'], ['memory', 'learning']]) {
      const file = path.join(output, name + '.html')
      fs.writeFileSync(file, makeFixturePage({ clientSource, ...demoData(), tab }))
      await browser.navigate(file); await browser.until("document.title==='fixture done'", name)
      await browser.until("document.querySelector('[data-bd-settings-page=" + tab + "]')", name + ' content')
      assert.deepEqual(await browser.driver.evaluate('window.__fixture.errors'), [])
      await browser.screenshot(path.join(destination, name + '.png'))
    }
    const file = path.join(output, 'menu.html')
    fs.writeFileSync(file, makeFixturePage({ clientSource, ...demoData(), target: 'root', position: { x: 'right', y: 'bottom' } }))
    await browser.navigate(file); await browser.until("document.title==='fixture done'", 'menu pet')
    await browser.driver.evaluate("document.querySelector('[data-bd-pet-fish]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))")
    await browser.until("document.querySelector('[data-bd-menu-key=settings]')", 'menu actions')
    await browser.driver.evaluate("window.__fixture.enter(document.querySelector('[data-bd-menu-key=settings]'))")
    await browser.until("document.querySelector('[data-bd-preview=settings]')", 'menu preview')
    await browser.driver.evaluate('new Promise(resolve=>setTimeout(resolve,350))')
    const clip = await browser.driver.evaluate(`(()=>{const rows=[...document.querySelectorAll('[data-bd-pet-fish],[data-bd-menu],[data-bd-preview]')].map(node=>node.getBoundingClientRect());const x=Math.max(0,Math.floor(Math.min(...rows.map(row=>row.left))-24)),y=Math.max(0,Math.floor(Math.min(...rows.map(row=>row.top))-24));return {x,y,width:Math.min(innerWidth-x,Math.ceil(Math.max(...rows.map(row=>row.right))-x+24)),height:Math.min(innerHeight-y,Math.ceil(Math.max(...rows.map(row=>row.bottom))-y+24)),scale:1}})()`)
    const image = await browser.driver.send('Page.captureScreenshot', { format: 'png', clip })
    fs.writeFileSync(path.join(destination, 'menu.png'), Buffer.from(image.data, 'base64'))
    console.log('Captured current-client demonstration screenshots: workspace.png, memory.png, menu.png')
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
