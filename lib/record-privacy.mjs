/** Shared privacy boundary for reusable records. Never feed raw credentials or inbox bodies to memory. */
const SECRET_KEY = /^(?:.*(?:credential|password|passwd|secret|cookie|authorization|access[_-]?token|refresh[_-]?token|api[_-]?key)|sessdata|bili_jct|dedeuserid(?:__ckmd5)?|csrf(?:_token)?)$/i
const PRIVATE_KEY = /^(?:dm(?:body|text|content|message)?|private[_-]?(?:body|text|content|message)|inbox|phone|mobile|email|address|realname|contact|手机号|手机号码|电话|邮箱|住址|家庭地址|真实姓名|真名|联系方式)$/i
const cleanControls = (s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')

export function redactRecordText(value, { maxLength = 16000 } = {}) {
  let text = cleanControls(String(value ?? ''))
  text = text
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '[凭证已隐去]')
    .replace(/((?:["']?(?:SESSDATA|bili_jct|DedeUserID(?:__ckMd5)?|csrf(?:_token)?|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credential)["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;,}\r\n]+)/gi, '$1[已隐去]')
    .replace(/\b(?:sk|pk)-(?:[A-Za-z0-9_-]{20,})\b/g, '[密钥已隐去]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[邮箱已隐去]')
    .replace(/(?<!\d)(?:\+?86[ -]?)?1[3-9]\d{9}(?!\d)/g, '[电话已隐去]')
    .replace(/([?&](?:token|key|auth|access_token|sessdata|bili_jct)=)[^&#\s]+/gi, '$1[已隐去]')
  const n = Number(maxLength)
  return text.slice(0, Number.isFinite(n) ? Math.max(0, Math.min(Math.trunc(n), 1024 * 1024)) : 16000)
}

/** JSON-only, bounded, key-aware sanitization. Unknown external data is data, never a prompt instruction. */
export function sanitizeRecord(value, opts = {}) {
  const maxDepth = Math.max(1, Math.min(Number(opts.maxDepth) || 6, 10))
  const maxKeys = Math.max(1, Math.min(Number(opts.maxKeys) || 100, 20000))
  const maxLength = Math.max(1, Math.min(Number(opts.maxLength) || 4000, 1024 * 1024))
  const seen = new WeakSet()
  const visit = (v, depth) => {
    if (typeof v === 'string') return redactRecordText(v, { maxLength })
    if (v === null || typeof v === 'boolean') return v
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    if (typeof v !== 'object' || depth >= maxDepth) return null
    if (seen.has(v)) return '[循环引用]'
    seen.add(v)
    let out
    if (Array.isArray(v)) out = v.slice(0, maxKeys).map((x) => visit(x, depth + 1))
    else {
      out = {}
      for (const key of Object.keys(v).slice(0, maxKeys)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) continue
        out[key] = SECRET_KEY.test(key) || PRIVATE_KEY.test(key) ? '[已隐去]' : visit(v[key], depth + 1)
      }
    }
    seen.delete(v)
    return out
  }
  return visit(value, 0)
}

export function isPrivateActivity(row) {
  return /(?:bili_dm_|private|inbox)/i.test(String(row?.tool || '')) || /^(?:dm|private)(?:[.:_-]|$)/i.test(String(row?.kind || ''))
}
