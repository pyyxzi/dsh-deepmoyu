/** Bounded background diagnostics. Never copy raw tool arguments, private inboxes or reasoning into the pet log. */
import { StringDecoder } from 'node:string_decoder'

const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/g
const MAX_LINE = 16384
const TOOL_NAMES = new Set(('bili_search bili_video_info bili_subtitle bili_comments bili_reply bili_reply_opus bili_received_replies '
  + 'bili_dm_inbox bili_dm_list bili_dm_thread bili_dm_reply bili_send_message bili_send_dynamic bili_send_opus bili_moment '
  + 'bili_my_dynamics bili_my_notices bili_my_video_comments bili_user_info bili_user_videos bili_hot_videos bili_weekly_hot bili_rank '
  + 'bili_danmaku bili_login bili_login_poll bili_login_start bili_check_credential bili_whoami bili_config bili_duty_status '
  + 'bili_feiyu bili_guard_status bili_learn bili_pace bili_pv bili_records bili_run bili_say bili_seen bili_setup bili_soul bili_status bili_sticker bili_taste').split(' '))
const CODES = new Set(('NO_ADAPTER ENOENT EACCES EPERM ECONNREFUSED ECONNRESET ETIMEDOUT ERR_MODULE_NOT_FOUND MODULE_NOT_FOUND '
  + 'ACCOUNT_SIGN_IN_REQUIRED INVALID_ARGUMENT INVALID_ROLE INVALID_MODEL_ROUTE RELAY_ERROR RELAY_INVALID_URL RELAY_NO_CAPABILITY '
  + 'RELAY_ROUTE_MISMATCH RELAY_INVALID_MODEL_INFO RELAY_FRAME_LIMIT RELAY_STREAM_CLOSED RELAY_INVALID_ROLE RELAY_FORBIDDEN '
  + 'RELAY_EXPIRED RELAY_BODY_LIMIT RELAY_INVALID_JSON RELAY_BUSY RELAY_NO_LLM RELAY_INVALID_REQUEST RELAY_NOT_READY').split(' '))

/** Exception messages may echo arbitrary model/tool input. Emit allowlisted metadata only. */
function diagnosticSummary(text, isWarning, truncated) {
  const codes = [...new Set(text.match(/\b[A-Z][A-Z0-9_]+\b/g) || [])].filter(code => CODES.has(code)).slice(0, 6)
  let summary = isWarning ? '后台运行时警告' : '后台进程报告错误'
  if (/Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|failed to import/i.test(text)) summary = '后台依赖加载失败'
  else if (/NO_ADAPTER|RELAY_NO_LLM|RELAY_NOT_READY/.test(text)) summary = '后台模型适配器不可用'
  else if (/ACCOUNT_SIGN_IN_REQUIRED/.test(text)) summary = '后台账号需要重新登录'
  else if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|连接失败/.test(text)) summary = '后台连接失败或超时'
  else if (/启动失败/.test(text)) summary = '后台任务启动失败'
  else if (/Ignoring extra certs/i.test(text)) summary = '后台证书配置警告'
  else if (/ExperimentalWarning/i.test(text)) summary = '后台运行时实验性能力警告'
  return { codes, text: summary + (codes.length ? `（${codes.join('、')}）` : '') + (truncated ? '；长行已截断' : '') + '；原始输出已省略' }
}

/** Shared by structured relay errors, which can echo the same private input as stderr. */
export function summarizeBackgroundDiagnostic(value) {
  const text = typeof value === 'string' ? value : `${String(value?.code || '')} ${String(value?.message || value || '')}`
  return diagnosticSummary(text.slice(0, MAX_LINE), false, text.length > MAX_LINE)
}

export function createBackgroundOutput({ onDiagnostic, onProgress } = {}) {
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
  const pending = { stdout: '', stderr: '' }
  const discarding = { stdout: false, stderr: false }
  let lastError = '', lastProgress = '', ended = false
  const notify = (fn, value) => {
    try { Promise.resolve(fn?.(value)).catch(() => {}) } catch { /* diagnostic failures cannot kill the host */ }
  }
  const line = (value, channel, truncated = false) => {
    const text = String(value).replace(ansi, '').trim()
    if (!text) return
    // Print only task/diagnostic metadata; a tool invocation may contain somebody's private message.
    const tools = [...new Set(text.match(/\bbili_[a-z_]+\b/g) || [])].filter(name => TOOL_NAMES.has(name))
    if (tools.length) {
      const message = '工具：' + tools.slice(0, 8).join('、')
      if (message !== lastProgress) { lastProgress = message; notify(onProgress, { stage: 'tool', text: message }) }
    }
    const isError = /NO_ADAPTER|\b(?:Error|ERROR|ENOENT|EACCES|EPERM|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ACCOUNT_SIGN_IN_REQUIRED|INVALID_[A-Z_]+|RELAY_[A-Z_]+)\b|dsh:|failed to import|启动失败|连接失败/i.test(text)
    const isWarning = /^(?:\(node:\d+\)\s*)?(?:Warning:|warning:)|Ignoring extra certs|ExperimentalWarning/i.test(text)
    if ((channel === 'stderr' && (isError || isWarning || /^\s*at\s/.test(text))) || isError) {
      const summary = diagnosticSummary(text, isWarning, truncated)
      if (isError && !isWarning) lastError = summary.text
      notify(onDiagnostic, { channel, ...summary, error: isError && !isWarning })
    }
  }
  const feed = (text, channel) => {
    let offset = 0
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset), end = newline < 0 ? text.length : newline
      if (!discarding[channel]) {
        const room = MAX_LINE - pending[channel].length
        pending[channel] += text.slice(offset, Math.min(end, offset + room))
        if (end - offset > room) {
          line(pending[channel], channel, true)
          pending[channel] = ''; discarding[channel] = true
        }
      }
      if (newline < 0) break
      if (!discarding[channel]) line(pending[channel], channel)
      pending[channel] = ''; discarding[channel] = false
      offset = newline + 1
    }
  }
  return {
    push(value, channel = 'stdout') {
      if (ended) return
      if (channel !== 'stdout' && channel !== 'stderr') return
      try { feed(decoders[channel].write(Buffer.isBuffer(value) ? value : Buffer.from(String(value))), channel) } catch { /* invalid console bytes */ }
    },
    flush() {
      if (ended) return
      ended = true
      for (const channel of ['stdout', 'stderr']) {
        feed(decoders[channel].end(), channel)
        if (!discarding[channel]) line(pending[channel], channel)
        pending[channel] = ''; discarding[channel] = false
      }
    },
    get lastError() { return lastError },
  }
}
