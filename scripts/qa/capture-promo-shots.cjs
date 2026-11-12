/**
 * capture-promo-shots.cjs —— 推广视频用的补充截图。
 * 全部合成演示数据；点进子页后再拍，保证画面里是"真实 UI 的那一屏"。
 * 输出到 QA_OUTPUT_DIR（未设置时为系统临时目录）下的 capture-promo/shots。
 */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { makeFixturePage } = require('./ui-browser-fixture.cjs')
const { demoData } = require('./demo-data.cjs')
const { openChrome } = require('./browser-cdp.cjs')
const { CLIENT, qaOutput } = require('./paths.cjs')

const OUT = path.join(qaOutput('capture-promo'), 'shots')
const WORK = path.join(qaOutput('capture-promo'), 'work')

const PROBE_CLICK = `F.click(F.textButton('%s')).then(r=>F.finish({clicked:Boolean(r),requests:F.requests}))`

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  fs.mkdirSync(WORK, { recursive: true })
  const clientSource = fs.readFileSync(CLIENT, 'utf8')
  const browser = await openChrome({ output: WORK, width: 1920, height: 1080 })
  const jobs = [
    // [输出名, tab, 需要点的按钮文字, 等待的选择器]
    ['stickers', 'learning', '表情收藏', '[data-bd-settings-page="stickers"]'],
    ['run_bg', 'run', '后台与定时', '[data-bd-settings-page="run"]'],
  ]
  try {
    for (const [name, tab, buttonText, waitSel] of jobs) {
      const file = path.join(WORK, name + '.html')
      fs.writeFileSync(file, makeFixturePage({
        clientSource, ...demoData(), tab,
        probe: PROBE_CLICK.replace('%s', buttonText),
      }))
      await browser.navigate(file)
      await browser.until("document.title==='fixture done'", name)
      await browser.until(`Boolean(document.querySelector(${JSON.stringify(waitSel)}))`, name + ' page')
      await browser.driver.evaluate('new Promise(r=>setTimeout(r,600))')
      const errors = await browser.driver.evaluate('window.__fixture.errors')
      assert.deepEqual(errors, [], name + ' fixture errors')
      await browser.screenshot(path.join(OUT, name + '.png'))
      console.log('shot:', name)
    }
    console.log('done ->', OUT)
  } finally {
    await browser.close()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
