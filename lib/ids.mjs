/** Lossless decimal IDs at JS/JSON boundaries. Never guess an already-rounded ID. */
export const normalizeId = (value, { allowZero = true } = {}) => {
  let text
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError('ID number must be a non-negative safe integer; pass large IDs as decimal strings')
    }
    text = String(value)
  } else if (typeof value === 'string') {
    text = value.trim()
    if (!/^[0-9]+$/.test(text)) throw new TypeError('ID must be a decimal string or a safe integer')
  } else {
    throw new TypeError('ID must be a decimal string or a safe integer')
  }
  const canonical = text.replace(/^0+(?=[0-9])/, '')
  if (!allowZero && canonical === '0') throw new RangeError('ID must be greater than zero')
  return canonical
}

/** Invalid values throw rather than silently selecting a different action. */
export const idPresent = (value) => normalizeId(value) !== '0'

/** Only a truly omitted optional ID defaults to zero; null and malformed input remain invalid. */
export const optionalId = (value) => normalizeId(value === undefined ? '0' : value)

/** SDK/result inspection: malformed IDs are unavailable, not alternate reply targets. */
export const readableId = (value, options = {}) => {
  try { return normalizeId(value, options) } catch { return '' }
}

/** Preserve the selected target: only a missing/zero primary ID permits the fallback. */
export const replyTargetId = (primary, fallback) => {
  const first = optionalId(primary)
  return first !== '0' ? first : optionalId(fallback)
}

/** Parse JSON without rounding decimal integer tokens. Strings/escapes are scanned, never rewritten.
 * Ordinary JSON syntax validation remains JSON.parse's job; invalid leading zeros stay invalid.
 * Safe integers, decimal fractions and exponent notation retain their standard JSON number types.
 */
export function parseJsonExactIntegers(source) {
  if (typeof source !== 'string') throw new TypeError('JSON source must be a string')
  // Validate original grammar first: quoting an illegal numeric object key must not repair it.
  // Rounded values from this syntax pass are discarded whenever an unsafe token is present.
  const ordinary = JSON.parse(source)
  const parts = []
  let cursor = 0, untouched = 0
  const digit = index => source.charCodeAt(index) >= 48 && source.charCodeAt(index) <= 57
  while (cursor < source.length) {
    if (source[cursor] === '"') {
      cursor++
      while (cursor < source.length) {
        if (source[cursor] === '\\') { cursor += 2; continue }
        if (source[cursor++] === '"') break
      }
      continue
    }
    if (source[cursor] !== '-' && !digit(cursor)) { cursor++; continue }
    const start = cursor
    if (source[cursor] === '-') cursor++
    while (digit(cursor)) cursor++
    let integer = true
    if (source[cursor] === '.') { integer = false; cursor++; while (digit(cursor)) cursor++ }
    if (source[cursor] === 'e' || source[cursor] === 'E') {
      integer = false; cursor++
      if (source[cursor] === '+' || source[cursor] === '-') cursor++
      while (digit(cursor)) cursor++
    }
    const token = source.slice(start, cursor)
    if (integer && /^-?(?:0|[1-9]\d*)$/.test(token) && !Number.isSafeInteger(Number(token))) {
      parts.push(source.slice(untouched, start), JSON.stringify(token))
      untouched = cursor
    }
  }
  return parts.length ? JSON.parse(parts.join('') + source.slice(untouched)) : ordinary
}
