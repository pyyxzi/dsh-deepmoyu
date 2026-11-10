import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { root } from '../scripts/release/paths.mjs'
import { parsePatch } from '../scripts/release/check-manifest.mjs'
import { HOST_PROMPT_VARIABLES, unknownPromptVariables, promptVariablesIn, promptVariableWarnings, stripYamlComments } from '../lib/host-compat.mjs'

/* ── 为什么要有这组测试 ──
 * DSH 的 dsh-system-prompt 在组装提示词时，会把每个 section 的文本里所有 `{{名字}}`
 * 当成"提示词变量"去查表；查不到就**直接 throw**（`unknown prompt variable "{{cwd}}"
 * in section "deployment:persona-suffix"; registered variables: provider, model`），
 * 整轮 prompt 组装跟着失败 —— 表现出来就是"选了这个模式就起不来"。
 *
 * 2026-11-10 就是这么坏的：`presets/deepmoyu.patch.yml` 的 persona.suffix 写着
 * `Your working directory is {{cwd}}.`，而 DSH 0.12.1 全局只注册 provider / model 两个变量
 * （由 dsh-agent-loop 注册），cwd 早改由 dsh-working-directory 以 runtime context 注入。
 *
 * 这两条闸分别是：
 *   1. 我们自己的 patch/preset 里只许出现宿主真的注册过的变量；
 *   2. 插件自己注册的 section 一律 `interpolate: false`，插件的文案永远不参与变量替换。
 */

/** 宿主真正注册的提示词变量。宿主升版后要重新核对这一行（见文件头说明）。 */
const HOST_VARIABLES = new Set(HOST_PROMPT_VARIABLES)

const VARIABLE = /\{\{([^{}]*)\}\}/g

/** Collect every `{{...}}` reference with a JSON-ish path so a failure points at the exact spot. */
function references(value, path = '') {
  const found = []
  if (typeof value === 'string') {
    for (const match of value.matchAll(VARIABLE)) found.push({ name: match[1], path })
    return found
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...references(item, path + '[' + index + ']')))
    return found
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) found.push(...references(item, path ? path + '.' + key : key))
  }
  return found
}

test('bundle patches only reference prompt variables the host actually registers', () => {
  const files = ['cordis.patch.yml', 'presets/deepmoyu.patch.yml']
  for (const file of files) {
    for (const reference of references(parsePatch(file), file)) {
      assert.ok(HOST_VARIABLES.has(reference.name),
        file + ' at ' + reference.path + ' references {{' + reference.name + '}}, but the host only registers '
        + [...HOST_VARIABLES].join(', ') + '. 未注册的变量会让整轮提示词组装失败，整套模式起不来：'
        + '改用 runtime context（工作目录由宿主自己注入），或把这一段写成纯文字。')
    }
  }
})

test('the persona suffix does not claim to know the working directory', () => {
  const role = parsePatch('presets/deepmoyu.patch.yml')
    .flatMap(row => row.insert || [])
    .find(row => row.config?.id === 'dafeiyu')
  assert.ok(role, 'the dafeiyu role preset must exist')
  const persona = role.config.plugins.find(plugin => plugin.id === 'persona')
  assert.ok(persona, 'the role preset must mount dsh-persona')
  // cwd 由 dsh-working-directory 以 runtime context 注入，persona 再写一遍只会写成错的。
  assert.equal(persona.config.suffix, '')
})

test('every prompt section this plugin registers opts out of variable interpolation', () => {
  const source = readFileSync(join(root, 'index.js'), 'utf8')
  const registrations = [...source.matchAll(/sp\.section\(\{/g)]
  assert.ok(registrations.length > 0, 'the plugin must register at least one prompt section')
  for (const match of registrations) {
    // 往前看 40 个字符拿到行号，方便失败时直接定位。
    const line = source.slice(0, match.index).split('\n').length
    const body = source.slice(match.index, match.index + 1200)
    assert.match(body, /interpolate:\s*false/,
      'index.js:' + line + ' 注册的提示词 section 必须带 `interpolate: false`：'
      + '插件的文案（人格、soul、实时配额）不该参与变量替换，否则文案里出现一个 {{ 就把整轮对话炸掉')
  }
})

/* ── 启动自检（lib/host-compat.mjs）自己也要有回归 ──
 * 它是"出问题时唯一会喊话的地方"，坏掉就等于没有。 */
test('the startup self-check extracts every prompt variable name it sees', () => {
  assert.deepEqual(promptVariablesIn('a {{model}} b {{ cwd }} c {{model}}'), ['model', ' cwd '])
  assert.deepEqual(promptVariablesIn('no variables here'), [])
  assert.deepEqual(promptVariablesIn('{{}}'), [''])
})

test('comment lines are not mistaken for real prompt variables', () => {
  // 注释里为了讲清规矩难免出现 `{{变量}}`，剔不掉就会自己告警自己
  assert.equal(stripYamlComments('# 别写 {{whatever}}\nname: ok\n  # 也别写 {{cwd}}\n'), 'name: ok\n')
  assert.deepEqual(promptVariablesIn(stripYamlComments('# {{cwd}}\nsuffix: {{model}}\n')), ['model'])
})

test('the startup self-check passes on this repository and stays silent', () => {
  assert.deepEqual(unknownPromptVariables(root), [], '仓库自己的 patch 文件里不该有宿主不认识的提示词变量')
  assert.deepEqual(promptVariableWarnings(root), [], '没问题的时候自检不该写告警（否则日志会被噪音淹掉）')
})
