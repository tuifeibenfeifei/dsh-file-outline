/**
 * dsh-file-outline engine — deterministic, streaming, read-only.
 *
 * Zero runtime dependencies: only Node built-ins. No file is ever read whole;
 * every scan uses a bounded read stream and keeps memory constant.
 *
 * @module dsh-file-outline/lib/engine
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'

/** Bytes inspected to decide the text encoding. */
const SAMPLE_BYTES = 1 << 16

/** Hard ceiling for one tool's rendered output, in characters. */
export const OUTPUT_LIMIT = 8000

/** Reader to recommend for each refused binary format. */
const BINARY_HINTS = {
  pdf: 'ops_read_pdf',
  zip: 'an archive or Office reader (docx/xlsx/pptx are zip containers)',
  ole2: 'an Office reader (legacy .doc/.xls/.ppt)',
  png: 'an image viewer',
  jpeg: 'an image viewer',
  gif: 'an image viewer',
  riff: 'a media player',
  mp4: 'a media player',
  elf: 'a disassembler or hex viewer',
}

/** Characters per token under the DSH core heuristic. */
const CHARS_PER_TOKEN = 4

/* ------------------------------------------------------------------ */
/* errors                                                             */
/* ------------------------------------------------------------------ */

/** A refusal or failure the model should read as a tool error. */
export class OutlineError extends Error {
  /** @param {string} code stable machine code @param {string} message model-facing text */
  constructor(code, message) {
    super(message)
    this.name = 'OutlineError'
    this.code = code
  }
}

/* ------------------------------------------------------------------ */
/* encoding                                                           */
/* ------------------------------------------------------------------ */

/** True when `buf` is valid UTF-8, tolerating a multi-byte sequence cut at the tail. */
function looksUtf8(buf) {
  for (let trim = 0; trim <= 3 && trim < buf.length; trim += 1) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, buf.length - trim))
      return true
    } catch {
      /* try a shorter prefix */
    }
  }
  return false
}

/**
 * Detect UTF-16 from a BOM or from the NUL-byte parity pattern.
 *
 * UTF-16 text carries a NUL in one of every two bytes for most characters, so a
 * blanket "any NUL means binary" rule rejected perfectly good UTF-16 files. A
 * genuine binary container has NULs at both parities.
 *
 * @param {Buffer} buf head bytes
 * @returns {'utf-16le'|'utf-16be'|null} the byte order, or null when not UTF-16
 */
function looksUtf16(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le'
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be'
  const sample = Math.min(buf.length, 4096) & ~1
  if (sample < 8) return null
  let evenNul = 0
  let oddNul = 0
  for (let i = 0; i < sample; i += 2) {
    if (buf[i] === 0) evenNul += 1
    if (buf[i + 1] === 0) oddNul += 1
  }
  const pairs = sample / 2
  // One parity carries the NUL of every ASCII-range character; non-ASCII
  // characters lower that rate, so the threshold must tolerate CJK text.
  if (oddNul / pairs > 0.5 && evenNul / pairs < 0.2) return 'utf-16le'
  if (evenNul / pairs > 0.5 && oddNul / pairs < 0.2) return 'utf-16be'
  return null
}

/**
 * Recognize binary container formats by signature, independent of NUL bytes.
 *
 * NUL-byte sniffing alone is not enough: an uncompressed PDF or an old-style
 * .doc can be almost entirely printable ASCII while still being binary. These
 * signatures cover the formats a text-oriented map must refuse.
 *
 * @param {Buffer} head leading bytes
 * @returns {string|null} a format label when the bytes are a known binary format
 */
function sniffBinaryFormat(head) {
  const starts = (bytes) =>
    head.length >= bytes.length && bytes.every((byte, index) => head[index] === byte)
  if (starts([0x25, 0x50, 0x44, 0x46])) return 'pdf'
  if (starts([0x50, 0x4b, 0x03, 0x04])) return 'zip'
  if (starts([0x50, 0x4b, 0x05, 0x06])) return 'zip'
  if (starts([0x50, 0x4b, 0x07, 0x08])) return 'zip'
  if (starts([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole2'
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (starts([0xff, 0xd8, 0xff])) return 'jpeg'
  if (starts([0x47, 0x49, 0x46, 0x38])) return 'gif'
  if (starts([0x7f, 0x45, 0x4c, 0x46])) return 'elf'
  if (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp') return 'mp4'
  if (starts([0x52, 0x49, 0x46, 0x46]) && head.length >= 12) {
    const kind = head.toString('latin1', 8, 12)
    if (kind === 'WEBP' || kind === 'WAVE' || kind === 'AVI ') return 'riff'
  }
  return null
}

/**
 * Candidate legacy encodings, in rough order of how many users a wrong guess
 * would hurt. Kept deliberately small: a full charset detector would need a
 * large statistical table and break the zero-dependency rule.
 */
const LEGACY_CANDIDATES = ['gbk', 'big5', 'shift_jis', 'euc-kr', 'windows-1251', 'windows-1252', 'iso-8859-2', 'windows-874']

/**
 * Double-byte encodings have a structural rule: every lead byte and trail byte
 * must fall inside a specific range. Thai and the single-byte European
 * encodings have no such rule — any high byte can stand alone. So a valid
 * double-byte parse is strong evidence, while a byte stream that violates the
 * rule everywhere rules the encoding out.
 *
 * @param {Buffer} buf raw bytes
 * @param {'euc-kr'|'gbk'|'big5'|'shift_jis'} kind which structural rule to apply
 * @returns {number} fraction of high bytes that fit the rule (0..1)
 */
function structuralFit(buf, kind) {
  let lead = 0
  let ok = 0
  let i = 0
  while (i < buf.length) {
    const byte = buf[i]
    if (byte < 0x80) {
      i += 1
      continue
    }
    let leadOk = false
    let trailOk = false
    if (kind === 'euc-kr') {
      leadOk = byte >= 0xa1 && byte <= 0xfe
      trailOk = i + 1 < buf.length && buf[i + 1] >= 0xa1 && buf[i + 1] <= 0xfe
    } else if (kind === 'gbk') {
      leadOk = byte >= 0x81 && byte <= 0xfe
      const t = buf[i + 1]
      trailOk = i + 1 < buf.length && ((t >= 0x40 && t <= 0x7e) || (t >= 0x80 && t <= 0xfe))
    } else if (kind === 'big5') {
      leadOk = byte >= 0xa1 && byte <= 0xf9
      const t = buf[i + 1]
      trailOk = i + 1 < buf.length && ((t >= 0x40 && t <= 0x7e) || (t >= 0xa1 && t <= 0xfe))
    } else {
      // shift_jis: lead 0x81-0x9F or 0xE0-0xEF; trail 0x40-0x7E or 0x80-0xFC
      leadOk = (byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xef)
      const t = buf[i + 1]
      trailOk = i + 1 < buf.length && ((t >= 0x40 && t <= 0x7e) || (t >= 0x80 && t <= 0xfc))
    }
    lead += 1
    if (leadOk && trailOk) {
      ok += 1
      i += 2
    } else {
      i += 1
    }
  }
  return lead === 0 ? 0 : ok / lead
}

/**
 * Score how plausible a decoded sample looks as human text in its own script.
 *
 * Decoding failure alone cannot discriminate: GB18030 turns almost any byte
 * pair into some Han character, and Latin-1 turns every byte into *something*.
 * Two signals do the work:
 *
 * 1. **Script purity** — real text is overwhelmingly one script. A Japanese
 *    document decoded as GBK becomes Han-without-kana, which is suspicious;
 *    Russian decoded as Thai becomes Thai-with-no-spaces, which is suspicious.
 * 2. **Character plausibility** — a codec that produces rare ideographs,
 *    unassigned code points, or private-use characters is almost certainly
 *    wrong, because real prose does not consist of those.
 *
 * @param {string} text decoded sample
 * @returns {number} plausibility score; higher is better
 */
function scoreDecoded(text) {
  let points = 0
  let han = 0
  let kana = 0
  let hangul = 0
  let cyrillic = 0
  let latin = 0
  let thai = 0
  let rareHan = 0
  let bad = 0
  let privateUse = 0
  let control = 0
  let total = 0

  for (const ch of text) {
    total += 1
    const cp = ch.codePointAt(0)
    if (ch === '\ufffd') bad += 1
    else if (cp < 0x20 && cp !== 0x0a && cp !== 0x0d && cp !== 0x09) control += 1
    else if (cp < 0x80) points += 1
    else if (cp >= 0x4e00 && cp <= 0x9fff) {
      han += 1
      points += 2
    } else if (cp >= 0x3400 && cp <= 0x4dbf) {
      rareHan += 1
      points -= 4
    } else if (cp >= 0x3040 && cp <= 0x30ff) {
      kana += 1
      points += 3
    } else if (cp >= 0xac00 && cp <= 0xd7a3) {
      hangul += 1
      points += 3
    } else if (cp >= 0x0400 && cp <= 0x04ff) {
      cyrillic += 1
      points += 2
    } else if (cp >= 0x0e00 && cp <= 0x0e7f) {
      thai += 1
      points += 2
    } else if (cp >= 0x00c0 && cp <= 0x024f) {
      latin += 1
      points += 1
    } else if (cp >= 0x3000 && cp <= 0x303f) points += 1
    else if (cp >= 0xe000 && cp <= 0xf8ff) privateUse += 1
    else if (cp > 0xffff) points -= 2
  }

  points -= bad * 10
  points -= privateUse * 10
  points -= control * 10
  points -= rareHan * 2

  // Multiple non-Latin scripts in one short sample is a wrong-codec signature.
  const scripts = [han, kana, hangul, cyrillic, thai].filter((n) => n > 0).length
  if (scripts > 1) points -= 8 * (scripts - 1)

  // Japanese mixes Han with kana by definition; Han alone is Chinese, and a
  // Japanese decoder that produces no kana is a poor fit for kana-heavy text.
  if (kana > 0 && han === 0) points -= 4

  // A Latin decoder should not be chosen for text that is nearly all non-Latin.
  const nonLatin = han + kana + hangul + cyrillic + thai
  if (latin > 0 && nonLatin > latin * 3) points -= 6

  // Ratio sanity: losing more than a tenth of characters to replacement or
  // control bytes means the codec is wrong.
  if (total > 0 && (bad + control) / total > 0.1) points -= 12

  return points
}

/**
 * Pick the most plausible legacy encoding for bytes that are not valid UTF-8.
 *
 * Every candidate is decoded and scored; the highest score wins. A label is
 * only reported as `certain` when it beats every rival by a clear margin. The
 * single-byte European encodings genuinely cannot be told apart from each other
 * by decoding alone — CP1251, CP1252 and ISO-8859-2 map the same bytes to
 * different but equally valid letters — so those are reported as `uncertain`
 * instead of being guessed.
 *
 * @param {Buffer} buf head bytes
 * @returns {{encoding: string, confidence: 'certain'|'uncertain'}} the decision
 */
function detectLegacy(buf) {
  const DOUBLE_BYTE = new Set(['gbk', 'big5', 'shift_jis', 'euc-kr'])
  const scored = []
  // Structural evidence only becomes trustworthy once there are enough pairs to
  // discriminate: with three characters, GBK and EUC-KR fit equally well.
  const highBytes = buf.reduce((n, byte) => n + (byte >= 0x80 ? 1 : 0), 0)
  const structuralWeight = highBytes >= 8 ? 120 : 40
  for (const label of LEGACY_CANDIDATES) {
    let text
    try {
      text = new TextDecoder(label, { fatal: false }).decode(buf)
    } catch {
      continue
    }
    let score = scoreDecoded(text)
    if (DOUBLE_BYTE.has(label)) {
      // Structural fit dominates: a double-byte encoding whose byte pairs are
      // almost never valid cannot be right, however plausible the result looks
      // character by character. This is what separates Korean from Thai, whose
      // byte ranges overlap but whose structure does not.
      const fit = structuralFit(buf, label)
      score += Math.round(fit * structuralWeight) - Math.round(structuralWeight / 3)
    }
    scored.push({ label, score })
  }
  if (scored.length === 0) return { encoding: 'windows-1252', confidence: 'uncertain' }

  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  const runnerUp = scored[1]?.score ?? Number.NEGATIVE_INFINITY

  // A clear lead means the evidence really points one way. A near-tie among
  // single-byte encodings means the bytes are compatible with several of them,
  // and saying so is more useful than picking one at random.
  const margin = best.score - runnerUp
  const confidence = margin >= 40 ? 'certain' : 'uncertain'

  return { encoding: best.label, confidence }
}

/**
 * Decide how to decode a text file by inspecting its head bytes.
 * @param {string} absPath absolute file path
 * @returns {Promise<{encoding: string, decoder: string, binary: boolean}>} the decision
 */
export async function detectEncoding(absPath) {
  const handle = await fsp.open(absPath, 'r')
  try {
    const buffer = Buffer.alloc(SAMPLE_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, SAMPLE_BYTES, 0)
    const head = buffer.subarray(0, bytesRead)
    if (head.length === 0) return { encoding: 'utf-8', decoder: 'utf-8', binary: false }
    const format = sniffBinaryFormat(head)
    if (format) return { encoding: format, decoder: 'utf-8', binary: true, format }
    const utf16 = looksUtf16(head)
    if (utf16) return { encoding: utf16, decoder: utf16, binary: false }
    if (head.includes(0)) return { encoding: 'binary', decoder: 'utf-8', binary: true }
    if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
      return { encoding: 'utf-8-bom', decoder: 'utf-8', binary: false }
    }
    if (looksUtf8(head)) return { encoding: 'utf-8', decoder: 'utf-8', binary: false }
    const legacy = detectLegacy(head)
    return {
      encoding: legacy.encoding,
      decoder: legacy.encoding,
      binary: false,
      confidence: legacy.confidence,
    }
  } finally {
    await handle.close()
  }
}

/**
 * Yield the lines of one file as decoded strings, without buffering the file.
 * @param {string} absPath absolute file path
 * @param {string} decoder encoding label for `TextDecoder`
 * @param {number} chunkBytes stream high-water mark
 */
export async function* readLines(absPath, decoder, chunkBytes = 1 << 20) {
  const stream = fs.createReadStream(absPath, { highWaterMark: chunkBytes })
  const textDecoder = new TextDecoder(decoder)
  let carry = ''
  let first = true
  try {
    for await (const chunk of stream) {
      let text = textDecoder.decode(chunk, { stream: true })
      if (first) {
        first = false
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      }
      carry += text
      let start = 0
      let at
      while ((at = carry.indexOf('\n', start)) !== -1) {
        let line = carry.slice(start, at)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        start = at + 1
        yield line
      }
      carry = carry.slice(start)
    }
    carry += textDecoder.decode()
    if (carry.length > 0) yield carry.endsWith('\r') ? carry.slice(0, -1) : carry
  } finally {
    stream.destroy()
  }
}

/* ------------------------------------------------------------------ */
/* markdown structure                                                 */
/* ------------------------------------------------------------------ */

const HEADING = /^(#{1,6})[ \t]+(.*)$/
const TRAILING_CR = /\r$/
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/

/**
 * Strip the variable tail of a heading so templated repeats collapse together.
 * Removes `#12`, `（第 12 轮）`, `(12)`, ` 12`, and trailing separator noise.
 * @param {string} title raw heading text
 * @returns {string} the fold key
 */
export function foldKey(title) {
  let key = title.trim()
  key = key.replace(/[\s\-–—_·:：]*#\s*\d+\s*$/, '')
  key = key.replace(/[\s\-–—_·:：]*（第\s*\d+\s*[轮次回天]）\s*$/, '')
  key = key.replace(/[\s\-–—_·:：]*\(\s*\d+\s*\)\s*$/, '')
  key = key.replace(/[\s\-–—_·:：]*\d+\s*$/, '')
  key = key.replace(/[\s\-–—_·:：]+$/, '')
  return key.trim()
}

/**
 * Scan one text file for its heading skeleton and, optionally, where a keyword
 * occurs — in a single pass over the bytes.
 *
 * Titles and keyword hits are collected together because a second pass would
 * double the I/O on a huge file for no benefit. A hit is attributed to the
 * innermost heading open at that line (the top of the heading stack) and counted
 * once per line, not once per occurrence: one line repeating a word 5 times is
 * still one line of evidence, and counting occurrences would let a single
 * pathological line outrank a whole real section.
 *
 * @param {string} absPath absolute file path
 * @param {object} [options] keyword options
 * @param {RegExp|null} [options.matcher] prepared matcher, or null for no counting
 * @returns {Promise<object>} the structural summary
 */
export async function scanStructure(absPath, options = {}) {
  const matcher = options.matcher ?? null
  const headLines = options.headLines ?? 0
  const tailLines = options.tailLines ?? 0
  /** Opening sample, filled while the single pass runs. */
  const head = []
  /** Ring buffer holding only the closing lines. */
  const tailRing = []
  const stat = await fsp.stat(absPath)
  if (!stat.isFile()) {
    throw new OutlineError('NOT_A_FILE', `${absPath} is not a regular file`)
  }
  const detected = await detectEncoding(absPath)
  const { encoding, decoder, binary } = detected
  /** Absent means "certain"; only uncertain legacy guesses set it. */
  const confidence = detected.confidence ?? 'certain'
  if (binary) {
    const hint = BINARY_HINTS[detected.format] ?? 'a binary-aware reader'
    throw new OutlineError(
      'BINARY_FILE',
      `${absPath} is ${detected.format ? `a ${detected.format} file` : 'binary'} (${encoding}), not text, so it has no line-based outline. Use ${hint} instead.`,
    )
  }

  const headings = []
  let lineCount = 0
  let fenceChar = ''
  let fenceLen = 0
  let fenceStart = 0
  let inFence = false
  let headingsInsideFence = 0
  let fatestFence = 0
  /** Open headings, outermost first; the last entry owns the current line. */
  const stack = []
  let totalHits = 0
  /** Hit lines, kept only for the global distribution view. */
  const hitLines = []

  for await (const line of readLines(absPath, decoder)) {
    lineCount += 1

    // Samples see every line, including fenced ones: they describe what the
    // file looks like, not its parseable structure.
    if (headLines > 0 && lineCount <= headLines) head.push({ n: lineCount, text: clipLine(line) })
    if (tailLines > 0) {
      tailRing.push(line)
      if (tailRing.length > tailLines) tailRing.shift()
    }

    let indent = 0
    while (indent < line.length && line[indent] === ' ') indent += 1
    const body = indent <= 3 ? line.slice(indent) : ''

    if (inFence) {
      const close = indent <= 3 ? /^(`{3,}|~{3,})[ \t]*$/.exec(body) : null
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
        inFence = false
        fenceChar = ''
        fenceLen = 0
      } else if (HEADING.test(line)) {
        headingsInsideFence += 1
      }
      continue
    }

    if (indent <= 3) {
      const open = FENCE_OPEN.exec(body)
      if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
        inFence = true
        fenceChar = open[1][0]
        fenceLen = open[1].length
        fenceStart = lineCount
        if (open[1].length > fatestFence) fatestFence = open[1].length
        continue
      }
    }

    const heading = HEADING.exec(line)
    if (heading) {
      const level = heading[1].length
      const title = heading[2].trim().replace(/\s+#+\s*$/, '')
      const entry = { level, title, line: lineCount }
      headings.push(entry)
      // Pop every heading at the same or a deeper level, then push this one.
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop()
      stack.push(entry)
      continue
    }

    if (matcher && !inFence) {
      matcher.lastIndex = 0
      if (matcher.test(line)) {
        totalHits += 1
        hitLines.push(lineCount)
        const owner = stack[stack.length - 1]
        if (owner) owner.hits = (owner.hits ?? 0) + 1
      }
    }
  }

  if (inFence) {
    headings.push({
      level: 0,
      title: `(unterminated fence opened at line ${fenceStart})`,
      line: fenceStart,
      unterminated: true,
    })
  }

  // Resolve every section's end with one stack pass. The previous nested loop
  // was O(n²): on a 5,276-heading file that is ~14 million comparisons and
  // dominated the scan time.
  const open = []
  for (let i = 0; i < headings.length; i += 1) {
    const current = headings[i]
    if (current.unterminated) continue
    while (open.length > 0 && open[open.length - 1].level >= current.level) {
      const closed = open.pop()
      closed.endLine = Math.max(current.line - 1, closed.line)
      closed.lineCount = closed.endLine - closed.line + 1
    }
    open.push(current)
  }
  for (const remaining of open) {
    remaining.endLine = Math.max(lineCount, remaining.line)
    remaining.lineCount = remaining.endLine - remaining.line + 1
  }

  const tail = []
  if (tailLines > 0 && tailRing.length > 0) {
    const start = Math.max(1, lineCount - tailRing.length + 1)
    for (let i = 0; i < tailRing.length; i += 1) {
      tail.push({ n: start + i, text: clipLine(tailRing[i]) })
    }
  }

  return {
    path: absPath,
    bytes: stat.size,
    lines: lineCount,
    encoding,
    encodingConfidence: confidence,
    binary: false,
    mtimeMs: stat.mtimeMs,
    headings: headings.filter((h) => !h.unterminated),
    unterminatedFence: headings.find((h) => h.unterminated) || null,
    headingsInsideFence,
    fenceMarker: fatestFence,
    keywordHits: matcher ? totalHits : null,
    distribution: matcher ? bucketHits(hitLines, lineCount) : null,
    head: headLines > 0 ? head : null,
    tail: tailLines > 0 ? tail : null,
  }
}

/**
 * Bucket hit lines into equal-width ranges, choosing a width that fits the file.
 *
 * Fixed-size buckets are useless on both extremes: a 1,000-line file gets one
 * bucket, a 1,000,000-line file gets a hundred. The width is chosen so a
 * typical file yields roughly 15–30 buckets, then snapped to a round number so
 * the labels stay readable.
 *
 * @param {Array<number>} lines 1-based hit line numbers
 * @param {number} totalLines total lines in the file
 * @param {number} [target] desired bucket count
 * @returns {{size: number, buckets: Array<{from: number, to: number, count: number}>}} the distribution
 */
export function bucketHits(lines, totalLines, target = 24) {
  if (lines.length === 0 || totalLines <= 0) return { size: 0, buckets: [] }
  const raw = Math.max(1, Math.ceil(totalLines / target))
  // Snap to 1/2/5 × 10^n so labels look like 1000, 2000, 5000, 10000.
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalized = raw / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  const size = step * magnitude

  const counts = new Map()
  for (const line of lines) {
    const index = Math.floor((line - 1) / size)
    counts.set(index, (counts.get(index) || 0) + 1)
  }
  const buckets = [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, count]) => ({
      from: index * size + 1,
      to: Math.min(totalLines, (index + 1) * size),
      count,
    }))
  return { size, buckets }
}

/**
 * Compile a keyword matcher.
 * @param {string} keyword literal text or a regular expression source
 * @param {{literal?: boolean, caseSensitive?: boolean}} options matching mode
 * @returns {RegExp} a global, non-anchored matcher
 */
export function compileMatcher(keyword, options = {}) {
  const literal = options.literal === true
  const source = literal ? keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : keyword
  let flags = 'g'
  if (options.caseSensitive !== true) flags += 'i'
  try {
    return new RegExp(source, flags)
  } catch (error) {
    throw new OutlineError('BAD_PATTERN', `keyword is not a valid regular expression: ${error.message}. Pass literal=true to match it as text.`)
  }
}

/* ------------------------------------------------------------------ */
/* sizing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Classify a file by size and describe the recommended tool.
 * @param {number} bytes file size
 * @returns {{tier: string, advice: string}} the classification
 */
export function classify(bytes) {
  if (bytes < 10 * 1024) return { tier: 'small (<10 KB)', advice: 'Small file: the built-in read tool is enough; no outline needed.' }
  if (bytes < 1024 * 1024) return { tier: 'normal (10 KB–1 MB)', advice: 'Normal size: read directly, or outline first when the structure is unclear.' }
  if (bytes < 10 * 1024 * 1024) return { tier: 'large (1–10 MB)', advice: 'Large file: outline first, then digest the section you need.' }
  return { tier: 'huge (>10 MB)', advice: 'Huge file: do not read the whole file. Use outline, then digest by section or line range.' }
}

/**
 * Round a byte count for display.
 * @param {number} bytes byte count
 * @returns {string} human-readable size
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * Insert thousands separators without depending on the system locale.
 * @param {number} value integer
 * @returns {string} grouped digits
 */
export function group(value) {
  const digits = String(Math.trunc(Math.abs(value)))
  let out = ''
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ','
    out += digits[i]
  }
  return value < 0 ? `-${out}` : out
}

/* ------------------------------------------------------------------ */
/* file card                                                          */
/* ------------------------------------------------------------------ */

/**
 * Collect everything a file card needs, without reading the body into memory.
 * @param {string} absPath absolute file path
 * @param {object} options collection options
 * @param {number} [options.headLines] opening sample size
 * @param {number} [options.tailLines] closing sample size
 * @param {number} [options.maxParagraphs] paragraph openers to keep
 * @returns {Promise<object>} the card data
 */
export async function collectCard(absPath, options = {}) {
  const headLines = options.headLines ?? 20
  const tailLines = options.tailLines ?? 20
  // One pass collects the structure and both samples together. Reading the
  // file three times (structure, head, tail) cost 343 ms on a 14 MB file for
  // no benefit: the bytes are identical each time.
  const scan = await scanStructure(absPath, { headLines, tailLines })
  const { decoder } = await detectEncoding(absPath)
  const head = scan.head ?? []
  const tail = scan.tail ?? []

  let degraded = null
  if (scan.headings.length === 0) {
    // Only the degraded path needs a second pass, and only for heading-less
    // files, where the paragraph/prefix statistics cannot come from the scan.
    degraded = await scanParagraphs(absPath, decoder, options.maxParagraphs ?? 40)
  }

  const modified = new Date(scan.mtimeMs).toISOString().replace('T', ' ').slice(0, 16)

  return {
    path: scan.path,
    bytes: scan.bytes,
    lines: scan.lines,
    encoding: scan.encoding,
    encodingConfidence: scan.encodingConfidence,
    modified,
    headings: scan.headings,
    unterminatedFence: scan.unterminatedFence,
    headingsInsideFence: scan.headingsInsideFence,
    head,
    tail,
    degraded,
  }
}

/** Hard per-line character ceiling for samples; never grows with spare budget. */
export const SAMPLE_LINE_WIDTH = 200

/**
 * Clip one sample line, marking that it was shortened.
 * @param {string} line raw line
 * @returns {string} the clipped line
 */
export function clipLine(line) {
  const clean = line.replace(/\t/g, '  ')
  if (clean.length <= SAMPLE_LINE_WIDTH) return clean
  return `${clean.slice(0, SAMPLE_LINE_WIDTH - 1)}…`
}

/**
 * Estimate tokens for a block of text under the DSH-core density heuristic,
 * taking the larger of the flat `chars/4` price and a CJK-weighted price so a
 * budget never under-counts CJK text.
 * @param {string} text sample text
 * @returns {number} estimated tokens
 */
export function estimateTokens(text) {
  let wide = 0
  let all = 0
  for (const ch of text) {
    all += 1
    if (ch.codePointAt(0) > 0x2e7f) wide += 1
  }
  const flat = all / CHARS_PER_TOKEN
  const weighted = wide * 0.6 + (all - wide) * 0.25
  return Math.ceil(Math.max(flat, weighted))
}

/* ------------------------------------------------------------------ */
/* digest: budgeted range extraction                                  */
/* ------------------------------------------------------------------ */

/** A digest never returns fewer than this many lines, even over budget. */
const MIN_DIGEST_LINES = 5

/**
 * Read one line range while respecting a token budget.
 *
 * Stops before the budget is exceeded rather than after, so the caller always
 * receives text it asked for rather than text it must truncate. When the cut
 * lands mid-paragraph it walks back to the last blank line, unless that would
 * drop below {@link MIN_DIGEST_LINES}; a hard cut is still better than returning
 * almost nothing.
 *
 * @param {string} absPath absolute file path
 * @param {string} decoder encoding label
 * @param {number} from first line to read, 1-based, inclusive
 * @param {number} to last line to read, 1-based, inclusive
 * @param {number} budget token ceiling
 * @returns {Promise<object>} the extracted text and how much remains
 */
export async function digestRange(absPath, decoder, from, to, budget) {
  const wanted = []
  let lineNo = 0
  let totalLines = 0

  for await (const line of readLines(absPath, decoder)) {
    lineNo += 1
    totalLines = lineNo
    if (lineNo < from) continue
    if (lineNo > to) {
      // Keep counting so the caller learns the real file length, which the
      // continuation pointer and the "lines total" display both depend on.
      continue
    }
    wanted.push({ n: lineNo, text: line })
  }

  if (wanted.length === 0) {
    return {
      from,
      to,
      requestedLines: 0,
      returnedLines: 0,
      startLine: from,
      endLine: from - 1,
      text: '',
      tokens: 0,
      budget,
      totalLines,
      remainingLines: 0,
      overBudget: false,
    }
  }

  let used = 0
  let cut = 0
  for (const row of wanted) {
    const cost = estimateTokens(row.text) + 1 // +1 for the newline
    if (cut >= MIN_DIGEST_LINES && used + cost > budget) break
    used += cost
    cut += 1
  }
  cut = Math.max(1, cut)

  // Prefer a paragraph boundary near the cut, but never collapse to nothing.
  if (cut < wanted.length && cut > MIN_DIGEST_LINES) {
    for (let i = cut - 1; i >= MIN_DIGEST_LINES; i -= 1) {
      if (wanted[i].text.trim() === '') {
        cut = i + 1
        break
      }
    }
  }

  const kept = wanted.slice(0, cut)
  const text = kept.map((row) => row.text).join('\n')
  const keptEnd = kept[kept.length - 1].n
  const requestedEnd = Math.min(to, totalLines)

  return {
    from,
    to: requestedEnd,
    requestedLines: Math.max(0, requestedEnd - from + 1),
    returnedLines: kept.length,
    startLine: kept[0].n,
    endLine: keptEnd,
    text,
    tokens: estimateTokens(text),
    budget,
    totalLines,
    remainingLines: Math.max(0, requestedEnd - keptEnd),
    overBudget: kept.length < Math.max(0, requestedEnd - from + 1),
  }
}

/**
 * Find the first heading whose title matches `wanted`, for `digest(section=...)`.
 * @param {Array<object>} headings scanned headings with line ranges
 * @param {string} wanted section title fragment
 * @param {boolean} [caseSensitive] whether matching respects case
 * @returns {object|null} the matched heading, or null
 */
export function findSection(headings, wanted, caseSensitive = false) {
  const needle = caseSensitive ? wanted : wanted.toLowerCase()
  const norm = (text) => (caseSensitive ? text : text.toLowerCase())
  // Exact match first, then substring: an exact title should beat a partial one.
  const exact = headings.find((h) => norm(h.title) === needle)
  if (exact) return exact
  return headings.find((h) => norm(h.title).includes(needle)) ?? null
}

/* ------------------------------------------------------------------ */
/* degraded navigation for files without headings                     */
/* ------------------------------------------------------------------ */

/** Longest line prefix tracked by the frequency scan. */
const PREFIX_WIDTH = 12

/** Paragraphs longer than this many lines are split into windows. */
const PARAGRAPH_WINDOW = 200

/** Shortest prefix that counts as a meaningful repeated pattern. */
const MIN_PREFIX_LENGTH = 3

/**
 * Build a navigation aid for a file that has no Markdown headings.
 *
 * Two signals are combined because they answer different questions. Paragraph
 * first-lines answer "what topics does this touch"; repeated line prefixes answer
 * "what kind of file is this" — a log whose lines all start with `[INFO]` or a
 * date is a log, and the pattern makes that obvious without parsing anything.
 *
 * @param {string} absPath absolute file path
 * @param {string} decoder encoding label
 * @param {number} maxParagraphs how many paragraph openers to keep
 * @returns {Promise<{paragraphs: Array<object>, prefixes: Array<object>, blankBlocks: number}>} the aid
 */
export async function scanParagraphs(absPath, decoder, maxParagraphs = 40) {
  const paragraphs = []
  const prefixCounts = new Map()
  let lineCount = 0
  let blockStart = 0
  let blockLines = 0
  let blockFirst = ''
  let blankBlocks = 0
  let inFence = false
  let fenceChar = ''
  let fenceLen = 0

  for await (const line of readLines(absPath, decoder)) {
    lineCount += 1
    const trimmed = line.trim()

    // Track fences so a code sample's `[INFO]` is not mistaken for a log pattern.
    let indent = 0
    while (indent < line.length && line[indent] === ' ') indent += 1
    const body = indent <= 3 ? line.slice(indent) : ''
    if (inFence) {
      const close = indent <= 3 ? /^(`{3,}|~{3,})[ \t]*$/.exec(body) : null
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
        inFence = false
        fenceChar = ''
        fenceLen = 0
      }
      continue
    }
    const open = indent <= 3 ? /^(`{3,}|~{3,})(.*)$/.exec(body) : null
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      inFence = true
      fenceChar = open[1][0]
      fenceLen = open[1].length
      continue
    }

    if (trimmed === '') {
      if (blockLines > 0) {
        blankBlocks += 1
        if (paragraphs.length < maxParagraphs) {
          paragraphs.push({ line: blockStart, lines: blockLines, first: blockFirst })
        }
        blockLines = 0
        blockFirst = ''
      }
      continue
    }

    // Count a bounded prefix of the raw line, whitespace-normalised.
    const prefix = trimmed.slice(0, PREFIX_WIDTH).replace(/\d/g, '#').replace(/\s+/g, ' ')
    if (prefix.length >= MIN_PREFIX_LENGTH) {
      prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1)
    }

    if (blockLines === 0) {
      blockStart = lineCount
      blockFirst = trimmed.slice(0, 160)
    }
    blockLines += 1
    // A very long paragraph still needs an intermediate landmark.
    if (blockLines % PARAGRAPH_WINDOW === 0 && paragraphs.length < maxParagraphs) {
      paragraphs.push({ line: blockStart, lines: PARAGRAPH_WINDOW, first: blockFirst })
      blockStart = lineCount + 1
      blockFirst = ''
    }
  }

  if (blockLines > 0) {
    blankBlocks += 1
    if (paragraphs.length < maxParagraphs) {
      paragraphs.push({ line: blockStart, lines: blockLines, first: blockFirst })
    }
  }

  const minRepeat = Math.max(3, Math.floor(lineCount * 0.02))
  const prefixes = [...prefixCounts.entries()]
    .filter(([text, count]) => count >= minRepeat && count >= 5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([text, count]) => ({ text, count }))

  return { paragraphs, prefixes, blankBlocks }
}
