import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { root } from '../scripts/release/paths.mjs'
import { parsePatch } from '../scripts/release/check-manifest.mjs'
import { promptVariablesIn } from '../lib/host-compat.mjs'
import { ensureCharter } from '../lib/state.mjs'

const role = parsePatch('presets/deepmoyu.patch.yml').flatMap(row => row.insert || []).find(row => row.config?.id === 'dafeiyu')
const persona = role.config.plugins.find(row => row.id === 'persona')
const charter = readFileSync(join(root, 'prompts/duty.md'), 'utf8')
const voiceContract = text => {
  assert.match(text, /可爱活泼/)
  assert.match(text, /嘴硬心软/)
  assert.match(text, /爱接梗/)
  assert.match(text, /群友/)
  assert.match(text, /几字|短梗/)
  assert.match(text, /不总结、不分点、不说教/)
  assert.match(text, /自己的话/)
  assert.match(text, /不用「」摘抄原文/)
  assert.match(text, /轻怼/)
  assert.match(text, /不恶毒/)
  assert.match(text, /严肃求助认真回答/)
  assert.match(text, /热评.*节奏/)
  assert.match(text, /全局人格.*覆盖/)
  assert.doesNotMatch(text, /示例回复[：:]|例如这样回[：:]|固定回复[：:]/)
}

test('the selected fish preset supplies the peer-like default voice without a user persona field', () => {
  assert.equal(role.name, '@deepseek-ai/dsh-agent-preset')
  assert.equal(role.config.id, 'dafeiyu')
  assert.equal(typeof persona.config.prefix, 'string')
  voiceContract(persona.config.prefix)
  assert.match(persona.config.prefix, /选成这个模式.*不代表已经在刷/)
  assert.match(persona.config.prefix, /发送仍看开关、判重和节奏/)
  assert.match(persona.config.prefix, /以上只在这个模式里生效/)
})

test('the new default keeps the host interpolation and mode capability contracts', () => {
  assert.equal(persona.name, '@deepseek-ai/dsh-persona')
  assert.equal(persona.config.suffix, '')
  assert.deepEqual(promptVariablesIn(persona.config.prefix), ['model'])
  assert.equal(role.config.plugins.find(row => row.id === 'tool-pwsh').disabled, "process.platform !== 'win32'")
  assert.equal(role.config.plugins.find(row => row.id === 'tool-bash').disabled, "process.platform === 'win32'")
  for (const id of ['agent-instructions', 'tool-fs', 'tool-fs-search', 'tool-goal', 'compaction', 'delegation']) {
    assert.ok(role.config.plugins.some(row => row.id === id), id)
  }
})

test('the shipped preset and charter keep browsing dialogue in character without mandatory selection reports', () => {
  for (const text of [persona.config.prefix, charter]) {
    assert.match(text, /新开会话刷.*普通消息、工具前后接话/)
    assert.match(text, /当前全局人格/)
    assert.match(text, /好奇.*看入迷/)
    assert.match(text, /看到可爱的会偏心/)
    assert.match(text, /有话才聊|想聊的是眼下/)
    assert.match(text, /不强制每条/)
    assert.match(text, /故障.*简短如实说明|简短如实说明.*失败/)
    assert.doesNotMatch(text, /bili_say 留的是你挑中或空手的理由|挑完一条视频\*\*必须\*\*/)
  }
})

test('video-inspired moments carry a short recognizable context while ordinary daily posts need no invented video', () => {
  for (const text of [persona.config.prefix, charter]) {
    assert.match(text, /视频动态|因看视频而发时/)
    assert.match(text, /背景/)
    assert.match(text, /纯日常/)
    assert.doesNotMatch(text, /不想提就完全不提|一句没头没尾的吐槽/)
  }
  assert.match(persona.config.prefix, /可识别的标题、UP或具体主题/)
  assert.match(charter, /背景一两句就够，不写长摘要/)
  assert.match(charter, /联想要接得上这件事/)
})

test('a fresh install receives the same voice charter and an existing custom charter stays untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fish-default-voice-')), home = join(dir, 'bili-duty')
  mkdirSync(home)
  try {
    ensureCharter(root, home)
    const installed = readFileSync(join(home, 'duty.md'), 'utf8')
    assert.equal(installed, charter)
    voiceContract(installed)
    assert.match(installed, /不要求挑出某秒某句写影评或清单/)
    assert.match(installed, /本地报告与回看链接可以保留真实时间锚点/)
    assert.match(installed, /日报.*只追加/)
    assert.match(installed, /full才展开，off不写日报/)
    const custom = '# 使用者自己写的章程\n保留这份本地表达偏好。\n'
    writeFileSync(join(home, 'duty.md'), custom)
    // Simulate an older shipped baseline to exercise the real custom-file upgrade branch.
    writeFileSync(join(home, 'charter.sha256'), createHash('sha256').update('previous shipped charter').digest('hex'))
    ensureCharter(root, home)
    assert.equal(readFileSync(join(home, 'duty.md'), 'utf8'), custom)
    assert.equal(readFileSync(join(home, 'duty.md.new'), 'utf8'), charter)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
