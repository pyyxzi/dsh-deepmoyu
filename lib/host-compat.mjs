/**
 * lib/host-compat.mjs —— 启动时的「宿主兼容性自检」
 * ============================================================================
 * 🔴 为什么要有它（2026-11-10 真机事故）：
 *   DSH 升到 0.12.1 之后，选「鲸鱼摸鱼模式」整个起不来，本轮直接
 *     `unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix";
 *      registered variables: provider, model`
 *   根因是 `presets/deepmoyu.patch.yml` 里 persona 的 `suffix` 写着
 *   `Your working directory is {{cwd}}.`：
 *     · `dsh-persona` 把 prefix/suffix 原样注册成提示词段（不做任何转义）；
 *     · `dsh-system-prompt` 组装时会把段文本里所有 `{{名字}}` 当变量查表，
 *       **查不到就 throw**，而且这个 throw 发生在宿主每轮组装提示词的时候，
 *       不是加载插件的时候 ⇒ 插件看着是好的，一开就炸。
 *
 * ⭐ 本模块只做一件很窄的事：**把这类错提前说清楚**。
 *   插件打包时就把自己那两个 patch 文件里出现的 `{{...}}` 扫一遍，
 *   只要出现白名单（宿主真正会注册的变量）以外的名字，就在 duty.log 里
 *   写一条能照着改的告警 —— 而不是等使用者选了模式、看到一句英文堆栈。
 *
 * ⚠️ 刻意**不用 YAML 解析器**：`yaml` 是 devDependency，不进 npm 包；
 *    这里做的是纯文本正则扫描（patch 文件是我们自己写的，形状稳定）。
 *    扫描只产生日志，永远不抛错、不阻断加载 —— 自检本身不能变成新的风险。
 * ============================================================================
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 宿主真正注册过的提示词变量。
 * DSH 0.12.1 里由 `@deepseek-ai/dsh-agent-loop` 注册 `provider` / `model` 两个，
 * 被扫过一遍整个 asar，官方没有任何别处用 `{{cwd}}` 之类的写法。
 * 宿主再升版时**先改这里，再改 `tests/prompt-variables.test.mjs` 里的同名白名单**。
 */
export const HOST_PROMPT_VARIABLES = Object.freeze(['provider', 'model'])

/** 插件自己声明配置的那几个 patch 文件（相对插件根） */
export const PATCH_FILES = Object.freeze(['cordis.patch.yml', 'presets/deepmoyu.patch.yml'])

/** `{{名字}}` —— 与宿主 `GROUP_AT` 的"简单组"语义一致（中间不许再出现花括号） */
const VARIABLE = /\{\{([^{}]*)\}\}/g

/**
 * 扫一个文本里出现的提示词变量名。
 * @param {string} text 文件正文
 * @returns {string[]} 出现过的变量名（去重，保持出现顺序）
 */
export function promptVariablesIn(text) {
  const seen = []
  for (const match of String(text ?? '').matchAll(VARIABLE)) {
    const name = match[1]
    if (!seen.includes(name)) seen.push(name)
  }
  return seen
}

/**
 * 去掉 YAML 注释行（`#` 开头）。
 *
 * 为什么需要：注释里为了讲清楚规矩，会写「别在这里写任何 `{{变量}}`」这种话，
 * 那本身就是一段带花括号的注释；不剔掉就会自己告警自己。
 *
 * ⚠️ 取舍：这里不认 YAML 的块标量（`|` / `>` 里的 `#` 是正文，不是注释）。
 *    人格正文是中文，几乎不会以 `#` 开头；真出现了也只是**少报**，不会误报停服务 ——
 *    而真正把关的是 `tests/prompt-variables.test.mjs` 里那一条：它用 `parsePatch()`
 *    把 YAML 解析成对象后只扫**值**，注释根本进不去。运行时自检是"多说一句"的辅助。
 * @param {string} text
 * @returns {string}
 */
export function stripYamlComments(text) {
  return String(text ?? '').split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n')
}

/**
 * 扫插件目录下的 patch 文件，返回所有不在白名单里的变量。
 * @param {string} pluginDir 插件根目录
 * @param {readonly string[]} [allowed] 白名单（默认 {@link HOST_PROMPT_VARIABLES}）
 * @returns {Array<{file: string, name: string}>} 空数组 = 没问题
 */
export function unknownPromptVariables(pluginDir, allowed = HOST_PROMPT_VARIABLES) {
  const allow = new Set(allowed)
  const found = []
  for (const rel of PATCH_FILES) {
    const file = join(pluginDir, rel)
    // 文件没了不是兼容性问题（打包形状变了），交给别的测试去管
    if (!existsSync(file)) continue
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { continue }
    for (const name of promptVariablesIn(stripYamlComments(text))) {
      if (!allow.has(name)) found.push({ file: rel, name })
    }
  }
  return found
}

/**
 * 给 duty.log 用的人话告警（没问题就返回空数组）。
 * @param {string} pluginDir 插件根目录
 * @returns {string[]}
 */
export function promptVariableWarnings(pluginDir) {
  const found = unknownPromptVariables(pluginDir)
  if (found.length === 0) return []
  const allowed = HOST_PROMPT_VARIABLES.join(' / ')
  return found.map(({ file, name }) => `⚠️ ${file} 里写了 {{${name}}}，但这个宿主只注册 ${allowed} 两个提示词变量`
    + ' —— 宿主组装提示词时会直接抛 unknown prompt variable，整套模式就起不来。'
    + '工作目录由宿主自己以 runtime context 注入，段里不用再写；别的动态信息请写成纯文字。')
}

/**
 * 宿主版本（拿得到就拿来写进日志，方便下次排障）。
 * 桌面版在 `resources/app.asar` 里，从模块位置往上找不到就返回 ''。
 * @returns {string}
 */
export function hostVersion() {
  const candidates = [
    process.env.DSH_HOST_VERSION,
    process.env.DSH_VERSION,
  ]
  for (const value of candidates) {
    if (value && String(value).trim()) return String(value).trim()
  }
  return ''
}
