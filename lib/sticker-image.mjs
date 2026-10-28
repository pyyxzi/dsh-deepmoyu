/** Upload-only image integrity checks. No file paths, external programs or unbounded decompression. */
import { inflateSync } from 'node:zlib'

const bad = () => { throw new Error('图片数据损坏或不完整，请重新选择原图') }
const dimensions = (width, height) => { if (!width || !height || width > 65535 || height > 65535) bad() }
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
const crc32 = bytes => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngImage(bytes) {
  let at = 8, header, palette = false, ended = false, dataEnded = false
  const data = []
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at), end = at + 12 + length
    if (end > bytes.length) bad()
    const type = bytes.toString('ascii', at + 4, at + 8), part = bytes.subarray(at + 8, end - 4)
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) bad()
    if (!header && type !== 'IHDR') bad()
    if (type === 'IHDR') {
      if (header || length !== 13) bad()
      header = { width: part.readUInt32BE(0), height: part.readUInt32BE(4), depth: part[8], color: part[9], interlace: part[12] }
      dimensions(header.width, header.height)
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
      if (!depths[header.color]?.includes(header.depth) || part[10] || part[11] || header.interlace > 1) bad()
    } else if (type === 'PLTE') {
      if (palette || data.length || !length || length % 3 || length > 768) bad()
      palette = true
    } else if (type === 'IDAT') {
      if (dataEnded || (header.color === 3 && !palette)) bad()
      data.push(part)
    } else if (type === 'IEND') {
      if (length || !data.length || end !== bytes.length) bad()
      ended = true; break
    } else {
      if (data.length) dataEnded = true
      // Reject unknown critical chunks; ancillary metadata is still CRC checked.
      if (type[0] === type[0].toUpperCase()) bad()
    }
    at = end
  }
  if (!ended) bad()
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.color]
  const passes = header.interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]]
  const rows = passes.map(([x, y, dx, dy]) => {
    const width = Math.max(0, Math.ceil((header.width - x) / dx)), height = Math.max(0, Math.ceil((header.height - y) / dy))
    return { height: width ? height : 0, size: 1 + Math.ceil(width * channels * header.depth / 8) }
  })
  const expected = rows.reduce((total, row) => total + row.height * row.size, 0)
  // A tiny compressed input must not allocate hundreds of MB in the host.
  if (expected > 64 * 1024 * 1024) throw new Error('图片解压后超过 64MB，请缩小尺寸后再上传')
  let pixels
  try { pixels = inflateSync(Buffer.concat(data), { maxOutputLength: expected + 1 }) } catch { bad() }
  if (pixels.length !== expected) bad()
  let offset = 0
  for (const row of rows) for (let y = 0; y < row.height; y++, offset += row.size) if (pixels[offset] > 4) bad()
}

/** Validate the LZW code stream without allocating the decoded image. */
function gifPixels(bytes, minimum, expected) {
  if (minimum < 2 || minimum > 8) bad()
  const clear = 1 << minimum, stop = clear + 1, sizes = new Uint32Array(4096)
  for (let i = 0; i < clear; i++) sizes[i] = 1
  let bits = minimum + 1, next = stop + 1, previous = -1, offset = 0, count = 0, started = false
  while (offset + bits <= bytes.length * 8) {
    let code = 0
    for (let bit = 0; bit < bits; bit++, offset++) code |= ((bytes[offset >>> 3] >>> (offset & 7)) & 1) << bit
    if (!started && code !== clear) bad()
    started = true
    if (code === clear) { bits = minimum + 1; next = stop + 1; previous = -1; continue }
    if (code === stop) { if (count !== expected) bad(); return }
    if (code > next || code >= 4096 || (code === next && previous < 0)) bad()
    const size = code === next ? sizes[previous] + 1 : sizes[code]
    if (!size || (previous < 0 && code >= clear)) bad()
    count += size
    if (count > expected) bad()
    if (previous >= 0 && next < 4096) {
      sizes[next++] = sizes[previous] + 1
      if (next === 1 << bits && bits < 12) bits++
    }
    previous = code
  }
  bad()
}

function gifImage(bytes) {
  if (bytes.length < 14) bad()
  const width = bytes.readUInt16LE(6), height = bytes.readUInt16LE(8)
  dimensions(width, height)
  let at = 13 + (bytes[10] & 128 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0), frames = 0
  const blocks = () => {
    const chunks = []
    while (at < bytes.length) {
      const length = bytes[at++]
      if (!length) return Buffer.concat(chunks)
      if (at + length > bytes.length) bad()
      chunks.push(bytes.subarray(at, at + length)); at += length
    }
    bad()
  }
  while (at < bytes.length) {
    const marker = bytes[at++]
    if (marker === 0x3b) { if (!frames || at !== bytes.length) bad(); return }
    if (marker === 0x21) { if (at >= bytes.length) bad(); at++; blocks(); continue }
    if (marker !== 0x2c || at + 9 > bytes.length) bad()
    const left = bytes.readUInt16LE(at), top = bytes.readUInt16LE(at + 2), w = bytes.readUInt16LE(at + 4), h = bytes.readUInt16LE(at + 6), flags = bytes[at + 8]
    dimensions(w, h)
    if (left + w > width || top + h > height || flags & 0x18) bad()
    at += 9
    if (flags & 128) at += 3 * (1 << ((flags & 7) + 1))
    else if (!(bytes[10] & 128)) bad()
    if (at >= bytes.length) bad()
    const minimum = bytes[at++]
    gifPixels(blocks(), minimum, w * h); frames++
  }
  bad()
}

function jpegImage(bytes) {
  let at = 2, frame, scans = 0, tables = false, quantization = false
  while (at < bytes.length) {
    if (bytes[at++] !== 0xff) bad()
    while (bytes[at] === 0xff) at++
    const marker = bytes[at++]
    if (marker === 0xd9) { if (!frame || !scans || at !== bytes.length) bad(); return }
    if (!marker || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || at + 2 > bytes.length) bad()
    const length = bytes.readUInt16BE(at), end = at + length
    if (length < 2 || end > bytes.length) bad()
    const part = bytes.subarray(at + 2, end)
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (frame || part.length < 6) bad()
      const components = part[5]
      dimensions(part.readUInt16BE(3), part.readUInt16BE(1))
      if (![8, 12].includes(part[0]) || ![1, 3, 4].includes(components) || part.length !== 6 + components * 3) bad()
      const ids = new Set()
      for (let i = 6; i < part.length; i += 3) {
        if (ids.has(part[i]) || !(part[i + 1] & 15) || (part[i + 1] & 15) > 4 || !(part[i + 1] >> 4) || part[i + 1] >> 4 > 4 || part[i + 2] > 3) bad()
        ids.add(part[i])
      }
      frame = { marker, ids }
    } else if (marker === 0xc4) {
      let i = 0
      while (i < part.length) {
        if (i + 17 > part.length || part[i] >> 4 > 1 || (part[i] & 15) > 3) bad()
        let count = 0, available = 1
        for (let n = 1; n <= 16; n++) { count += part[i + n]; available = available * 2 - part[i + n]; if (available < 0) bad() }
        if (!count || count > 256) bad()
        i += 17 + count
        if (i > part.length) bad()
      }
      tables = true
    } else if (marker === 0xdb) {
      let i = 0
      while (i < part.length) {
        const precision = part[i] >> 4
        if (precision > 1 || (part[i] & 15) > 3) bad()
        i += 1 + 64 * (precision + 1)
        if (i > part.length) bad()
      }
      quantization = true
    } else if (marker === 0xda) {
      if (!frame || !tables || !quantization || !part.length || !part[0] || part.length !== 1 + part[0] * 2 + 3) bad()
      for (let i = 1; i < 1 + part[0] * 2; i += 2) if (!frame.ids.has(part[i]) || part[i + 1] >> 4 > 3 || (part[i + 1] & 15) > 3) bad()
      const spectral = part.subarray(part.length - 3)
      if (spectral[0] > spectral[1] || spectral[1] > 63 || (frame.marker !== 0xc2 && (spectral[0] || spectral[1] !== 63 || spectral[2]))) bad()
      at = end
      let count = 0
      while (at < bytes.length) {
        if (bytes[at] !== 0xff) { at++; count++; continue }
        if (bytes[at + 1] === 0 || (bytes[at + 1] >= 0xd0 && bytes[at + 1] <= 0xd7)) { at += 2; count++; continue }
        break
      }
      if (!count) bad()
      scans++; continue
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xcc].includes(marker)) bad()
    else if (marker === 0xdd && part.length !== 2) bad()
    at = end
  }
  bad()
}

function webpFrame(type, part) {
  if (type === 'VP8 ') {
    if (part.length < 11 || part[0] & 1 || ((part[0] >> 1) & 7) > 3 || !(part[0] & 16)
      || !part.subarray(3, 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) bad()
    dimensions(part.readUInt16LE(6) & 0x3fff, part.readUInt16LE(8) & 0x3fff)
    const partition = part.readUIntLE(0, 3) >>> 5
    if (!partition || partition + 10 >= part.length) bad()
  } else if (type === 'VP8L') {
    if (part.length < 6 || part[0] !== 0x2f || part[4] >> 5) bad()
    const bits = part.readUInt32LE(1)
    dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  } else bad()
}

function webpImage(bytes) {
  if (bytes.length < 20 || bytes.readUInt32LE(4) !== bytes.length - 8) bad()
  let at = 12, extended = false, animation = false, animatedHeader = false, images = 0
  while (at + 8 <= bytes.length) {
    const type = bytes.toString('ascii', at, at + 4), size = bytes.readUInt32LE(at + 4), end = at + 8 + size, padded = end + (size & 1)
    if (padded > bytes.length || (padded !== end && bytes[end])) bad()
    const part = bytes.subarray(at + 8, end)
    if (type === 'VP8X') {
      if (at !== 12 || size !== 10 || part[0] & 0xc1 || part[1] || part[2] || part[3]) bad()
      dimensions(part.readUIntLE(4, 3) + 1, part.readUIntLE(7, 3) + 1)
      extended = true; animation = Boolean(part[0] & 2)
    } else if (type === 'ANIM') {
      if (!animation || animatedHeader || size !== 6) bad()
      animatedHeader = true
    } else if (type === 'ANMF') {
      if (!animatedHeader || size < 24 || part[15] & 0xfc) bad()
      dimensions(part.readUIntLE(6, 3) + 1, part.readUIntLE(9, 3) + 1)
      let inner = 16, frames = 0
      while (inner + 8 <= size) {
        const kind = part.toString('ascii', inner, inner + 4), length = part.readUInt32LE(inner + 4), next = inner + 8 + length + (length & 1)
        if (next > size) bad()
        if (kind === 'VP8 ' || kind === 'VP8L') { webpFrame(kind, part.subarray(inner + 8, inner + 8 + length)); frames++ }
        else if (kind !== 'ALPH') bad()
        inner = next
      }
      if (inner !== size || frames !== 1) bad()
      images++
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (animation || images) bad()
      webpFrame(type, part); images++
    } else if (!extended || !['ALPH', 'ICCP', 'EXIF', 'XMP '].includes(type)) bad()
    at = padded
  }
  if (at !== bytes.length || !images || (animation && !animatedHeader)) bad()
}

/** Caller has already bounded the input and sniffed its actual format. */
export function validateStickerImage(bytes, format) {
  if (!Buffer.isBuffer(bytes)) bad()
  if (format === 'png') pngImage(bytes)
  else if (format === 'jpg') jpegImage(bytes)
  else if (format === 'gif') gifImage(bytes)
  else if (format === 'webp') webpImage(bytes)
  else bad()
}
