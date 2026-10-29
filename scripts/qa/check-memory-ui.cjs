const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { memoryFixture } = require('./memory-browser-fixture.cjs')
const { openChrome } = require('./browser-cdp.cjs')
const { qaOutput } = require('./paths.cjs')

async function main() {
  const output = qaOutput('memory')
  const browser = await openChrome({ output })
  const results = []
  try {
    for (const [name, width, height] of [['desktop', 1280, 900], ['mobile', 390, 844]]) {
      const file = path.join(output, name + '.html')
      fs.writeFileSync(file, memoryFixture())
      await browser.size(width, height); await browser.navigate(file)
      await browser.until("document.title==='fixture done'", 'memory ' + name)
      const result = await browser.driver.evaluate('JSON.parse(document.getElementById("fixture-result").textContent)')
      assert.deepEqual(result.errors, [], JSON.stringify(result))
      assert.deepEqual(result.unknownRequests, [], JSON.stringify(result))
      assert.equal(result.checks.length, 9)
      assert(result.checks.every((check) => check.pass), JSON.stringify(result))
      await browser.screenshot(path.join(output, name + '.png'))
      results.push({ name, ...result })
      console.log('PASS memory ' + name + ': ' + result.checks.length + ' search, approval, conflict and confirmation checks')
    }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
  } finally { await browser.close() }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
