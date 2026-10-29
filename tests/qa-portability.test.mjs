import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
const require = createRequire(import.meta.url)
const paths = require('../scripts/qa/paths.cjs')
const { resolveBrowser } = require('../scripts/qa/browser-cdp.cjs')

test('UI QA resolves the repository independently of cwd and validates browser overrides', () => {
  assert.equal(paths.ROOT, resolve(dirname(fileURLToPath(import.meta.url)), '..'))
  assert.equal(paths.CLIENT, resolve(paths.ROOT, 'client.js'))
  assert.equal(resolveBrowser({ CHROME_PATH: process.execPath, PATH: '' }), process.execPath)
  assert.throws(() => resolveBrowser({ CHROME_PATH: resolve(paths.ROOT, 'missing-browser'), PATH: '' }), /CHROME_PATH/)
})

test('real React fixture builds from declared local dependencies and carries only synthetic demo data', () => {
  const { makeFixturePage } = require('../scripts/qa/ui-browser-fixture.cjs')
  const { demoData } = require('../scripts/qa/demo-data.cjs')
  const data = demoData()
  assert.equal(data.status.models[0].label, '演示模型')
  assert.equal(data.status.config.sessionModelId, '演示模型')
  assert.equal(data.status.config.autoComment, false)
  assert.equal(data.status.config.autoReplyDm, false)
  const html = makeFixturePage({ clientSource: "window.__ModuleLoader__.load({factory(){return {debugParts:{PetSettingsModal(){return null}}}}})", ...data })
  assert.match(html, /react-dom-client/)
  assert.match(html, /演示模型/)
  assert(!html.includes('Unknown fixture dependency'))
})
