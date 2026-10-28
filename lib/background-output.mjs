/** Bounded background diagnostics. Never copy raw tool arguments, private inboxes or reasoning into the pet log. */
import { StringDecoder } from 'node:string_decoder'
import { redactRecordText } from './record-privacy.mjs'

const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/g
export function createBackgroundOutput({ onDiagnostic, onProgress } = {}) {
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
  const pending = { stdout: '', stderr: '' }
  let lastError = '', lastProgress = '', ended = false
  const notify = (fn, value) => { try { fn?.(value) } catch { /* diagnostic failures cannot kill the host */ } }
  const line = (value, channel) => {
    const text = redactRecordText(String(value).replace(ansi, '').trim(), { maxLength: 1200 })
    if (!text) return
    // Print only task/diagnostic metadata; a tool invocation may contain somebody's private message.
    const tools = [...new Set(text.match(/\bbili_[a-z_]+\b/g) || [])]
    if (tools.length) {
      const message = '工具：' + tools.slice(0, 8).join('、')
      if (message !== lastProgress) { lastProgress = message; notify(onProgress, { stage: 'tool', text: message }) }
    }
    const isError = /NO_ADAPTER|\b(?:Error|ERROR|ENOENT|ECONNREFUSED|ETIMEDOUT|ACCOUNT_SIGN_IN_REQUIRED|INVALID_[A-Z_]+|RELAY_[A-Z_]+)\b|dsh:|failed to import|启动失败|连接失败/i.test(text)
    const isWarning = /^(?:\(node:\d+\)\s*)?(?:Warning:|warning:)|Ignoring extra certs|ExperimentalWarning/i.test(text)
    if ((channel === 'stderr' && (isError || isWarning || /^\s*at\s/.test(text))) || isError) {
      const clean = text.replace(/((?:request|response|messages?|body|arguments|prompt)\s*[:=]).*/i, '$1[内容省略]')
      if (isError && !isWarning) lastError = clean
      notify(onDiagnostic, { channel, text: clean, error: isError && !isWarning })
    }
  }
  const feed = (text, channel, flush = false) => {
    pending[channel] += text
    let newline
    while ((newline = pending[channel].indexOf('\n')) >= 0) {
      line(pending[channel].slice(0, newline), channel)
      pending[channel] = pending[channel].slice(newline + 1)
    }
    if (pending[channel].length > 16384 || flush) { line(pending[channel], channel); pending[channel] = '' }
  }
  return {
    push(value, channel = 'stdout') {
      if (ended) return
      try { feed(decoders[channel].write(Buffer.isBuffer(value) ? value : Buffer.from(String(value))), channel) } catch { /* invalid console bytes */ }
    },
    flush() {
      if (ended) return
      ended = true
      for (const channel of ['stdout', 'stderr']) feed(decoders[channel].end(), channel, true)
    },
    get lastError() { return lastError },
  }
}
