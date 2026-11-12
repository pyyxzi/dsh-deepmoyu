/**
 * capture-intro-shots.cjs —— 为插件介绍视频拍 6 张页面截图。
 * 全部使用 demo-data.cjs 的合成演示数据，不读取账号、不发送任何内容。
 * 输出到 QA_OUTPUT_DIR（未设置时为系统临时目录）下的 capture-intro/shots。
 */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { makeFixturePage } = require('./ui-browser-fixture.cjs')
const { demoData } = require('./demo-data.cjs')
const { openChrome } = require('./browser-cdp.cjs')
const { CLIENT, qaOutput } = require('./paths.cjs')

const OUT = path.join(qaOutput('capture-intro'), 'shots')
const WORK = path.join(qaOutput('capture-intro'), 'work')

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  fs.mkdirSync(WORK, { recursive: true })
  const clientSource = fs.readFileSync(CLIENT, 'utf8')
  const browser = await openChrome({ output: WORK, width: 1920, height: 1080 })
  const shots = [
    ['workspace', 'run'],
    ['speech', 'speech'],
    ['memory', 'learning'],
    ['video', 'video'],
    ['ledger', 'logs'],
    ['basic', 'basic'],
  ]
  try {
    for (const [name, tab] of shots) {
      const file = path.join(WORK, name + '.html')
      fs.writeFileSync(file, makeFixturePage({ clientSource, ...demoData(), tab }))
      await browser.navigate(file)
      await browser.until("document.title==='fixture done'", name)
      await browser.until(`Boolean(document.querySelector(${JSON.stringify('[data-bd-settings-page="' + tab + '"]')}))`, name + ' page')
      await browser.driver.evaluate('new Promise(r=>setTimeout(r,420))')
      const errors = await browser.driver.evaluate('window.__fixture.errors')
      assert.deepEqual(errors, [], name + ' fixture errors')
      await browser.screenshot(path.join(OUT, name + '.png'))
      console.log('shot:', name)
    }

    // 桌宠菜单：右键鱼 → 菜单 + 悬浮预览
    const file = path.join(WORK, 'menu.html')
    fs.writeFileSync(file, makeFixturePage({ clientSource, ...demoData(), target: 'root', position: { x: 'right', y: 'bottom' } }))
    await browser.navigate(file)
    await browser.until("document.title==='fixture done'", 'menu pet')
    await browser.driver.evaluate("document.querySelector('[data-bd-pet-fish]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))")
    await browser.until("document.querySelector('[data-bd-menu-key=settings]')", 'menu open')
    await browser.driver.evaluate('new Promise(r=>setTimeout(r,420))')
    await browser.screenshot(path.join(OUT, 'menu.png'))
    console.log('shot: menu')
    console.log('done ->', OUT)
  } finally {
    await browser.close()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
