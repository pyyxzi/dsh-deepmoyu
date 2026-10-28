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
