/**
 * Rendering for `outline` mode A: a deterministic, budgeted heading tree.
 *
 * Every rule here exists to keep the map honest: repeats are folded only when
 * folding preserves their span, truncation always states what was cut, and the
 * output never exceeds {@link OUTPUT_LIMIT} characters.
 *
 * @module dsh-file-outline/lib/render
 */
import { OUTPUT_LIMIT, classify, estimateTokens, foldKey, formatBytes, group } from './engine.js'

/** Repeats at or below this many occurrences are listed one by one. */
const FOLD_THRESHOLD = 3

/** Sections shorter than this are ignored when picking the reading suggestion. */
const MIN_SUGGEST_LINES = 20

/**
 * Shorten a heading for inline use inside a folded row.
 * @param {string} text heading title
 * @param {number} max character ceiling
 * @returns {string} the shortened title
 */
function brief(text, max = 28) {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

/**
 * Build the folded row. A fold must not erase identity: when the members differ
 * only by a trailing number they are a numbered series, so the first and last
 * real titles are shown, letting the reader see the series `#1 … #400` rather
 * than a single anonymous label.
 * @param {string} key normalized fold key
 * @param {Array<object>} entries the folded headings in document order
 * @returns {string} the row text
 */
function foldLabel(key, entries) {
  const first = entries[0]
  const last = entries[entries.length - 1]
  const spans = entries.map((e) => e.lineCount).sort((a, b) => a - b)
  const median = spans[Math.floor(spans.length / 2)]
  const series =
    first.title === last.title
      ? ''
      : ` · ${brief(first.title)} … ${brief(last.title)}`
  return `${key} ×${entries.length}${series} · lines ${group(first.line)}–${group(last.endLine)} · median ${group(median)} lines each`
}

/**
 * Fold repeated headings and keep the rest in document order.
 * @param {Array<object>} headings scanned headings with `level/title/line/endLine/lineCount`
 * @param {number} depth maximum level to show
 * @returns {{entries: Array<object>, foldedCount: number, foldedGroups: number}} renderable entries
 */
export function foldHeadings(headings, depth) {
  const visible = headings.filter((h) => h.level <= depth)
  const groups = new Map()
  for (const heading of visible) {
    const key = `${heading.level}\u0000${foldKey(heading.title)}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(heading)
  }

  const entries = []
  let foldedCount = 0
  let foldedGroups = 0
  for (const heading of visible) {
    const key = `${heading.level}\u0000${foldKey(heading.title)}`
    const members = groups.get(key)
    if (members.length > FOLD_THRESHOLD) {
      if (members[0] !== heading) continue
      foldedGroups += 1
      foldedCount += members.length
      entries.push({
        level: heading.level,
        folded: true,
        text: foldLabel(foldKey(heading.title), members),
        line: members[0].line,
        endLine: members[members.length - 1].endLine,
      })
      continue
    }
    entries.push({
      level: heading.level,
      folded: false,
      text: heading.title,
      line: heading.line,
      endLine: heading.endLine,
      lineCount: heading.lineCount,
    })
  }
  return { entries, foldedCount, foldedGroups, groups: visible.length }
}

/**
 * Build the `outline` mode A report.
 * @param {object} scan result of `scanStructure`
 * @param {{depth?: number, maxItems?: number}} options caller options
 * @returns {string} the rendered report, within the output limit
 */
export function renderOutline(scan, options = {}) {
  const depth = options.depth ?? 2
  const maxItems = options.maxItems ?? 100
  const size = classify(scan.bytes)

  const { entries, foldedCount, foldedGroups } = foldHeadings(scan.headings, depth)
  const shown = entries.slice(0, maxItems)
  const omitted = entries.length - shown.length

  const lines = []
  lines.push(`## ${scan.path}`)
  const encodingNote = scan.encodingConfidence === 'uncertain' ? `${scan.encoding} (guessed; see note below)` : scan.encoding
  lines.push(
    `${formatBytes(scan.bytes)} · ${group(scan.lines)} lines · ${encodingNote} · ${size.tier}`,
  )
  lines.push(size.advice)

  if (scan.encodingConfidence === 'uncertain') {
    lines.push(
      `⚠️ The encoding was guessed: these bytes are valid in several single-byte encodings and cannot be told apart reliably. Text is decoded as ${scan.encoding}. If characters look wrong, the file is probably a different legacy encoding; pass the file to a charset-aware reader instead.`,
    )
  }

  if (scan.unterminatedFence) {
    const start = scan.unterminatedFence.line
    lines.push(
      `⚠️ Unterminated code fence opened at line ${group(start)}: everything after it was treated as code. Headings there are not listed.`,
    )
  }
  if (scan.headingsInsideFence > 0) {
    lines.push(
      `(${group(scan.headingsInsideFence)} heading-like lines inside code fences were excluded.)`,
    )
  }

  if (entries.length === 0) {
    lines.push('')
    lines.push(
      `No Markdown headings at level ${depth} or shallower (${group(scan.headings.length)} headings exist in total at any level).`,
    )
    if (scan.headings.length > 0) lines.push(`Raise depth up to 6 to see nested sections.`)
    return clip(lines.join('\n'))
  }

  lines.push('')
  lines.push(`### Sections (depth ${depth}, ${group(entries.length)} entries)`)
  for (const entry of shown) {
    const indent = '  '.repeat(entry.level - 1)
    const span = `lines ${group(entry.line)}–${group(entry.endLine)}`
    if (entry.folded) {
      lines.push(`${indent}${'#'.repeat(entry.level)} ${entry.text}`)
    } else {
      lines.push(
        `${indent}${'#'.repeat(entry.level)} ${entry.text}  ·  ${span} (${group(entry.lineCount)})`,
      )
    }
  }

  lines.push('')
  const facts = []
  if (omitted > 0) facts.push(`${group(omitted)} more entries omitted (max_items=${maxItems})`)
  if (foldedCount > 0) facts.push(`${group(foldedCount)} repeated headings folded into ${group(foldedGroups)} rows`)
  if (scan.headingsInsideFence > 0) facts.push(`${group(scan.headingsInsideFence)} fence-hidden headings skipped`)
  if (facts.length > 0) lines.push(`— ${facts.join(' · ')}`)

  lines.push('Next: digest(path, lines="START-END", budget=3000) to read one section.')
  return clip(lines.join('\n'))
}

/**
 * Build the `outline` mode B report: where a keyword lives, by section.
 *
 * Only sections with at least one hit are listed, and their hit counts are
 * attributed as the scan saw them. The reading suggestion is chosen by hit
 * density (hits per line), never by raw hit count: in a long file a single
 * enormous section would otherwise always win, and the suggestion would stop
 * being a suggestion.
 *
 * @param {object} scan result of `scanStructure` with a matcher
 * @param {object} options rendered options
 * @param {string} options.keyword the keyword as the caller wrote it
 * @param {number} [options.depth] deepest level to show
 * @param {number} [options.maxItems] entry ceiling
 * @returns {string} the rendered report
 */
export function renderKeywordOutline(scan, options) {
  const depth = options.depth ?? 6
  const maxItems = options.maxItems ?? 100
  const size = classify(scan.bytes)
  const keyword = options.keyword

  const lines = []
  lines.push(`## ${scan.path}`)
  lines.push(`${formatBytes(scan.bytes)} · ${group(scan.lines)} lines · ${size.tier} · keyword「${keyword}」`)

  const hits = scan.headings.filter((h) => (h.hits ?? 0) > 0 && h.level <= depth)
  if (hits.length === 0) {
    lines.push('')
    lines.push(
      `No line matched「${keyword}」${scan.headings.length === 0 ? ' (the file has no Markdown headings at all)' : ''}.`,
    )
    lines.push('Try literal=false to treat the keyword as a regular expression, or check the casing.')
    return clip(lines.join('\n'))
  }

  // Density ranking drives the suggestion; hit count drives only display order.
  // Very short sections are skipped: a 6-line section with 2 hits would
  // otherwise outrank a real chapter and make the suggestion worthless.
  const eligible = hits.filter((h) => h.lineCount >= MIN_SUGGEST_LINES)
  const candidates = eligible.length > 0 ? eligible : hits
  const scored = candidates.map((h) => ({
    heading: h,
    density: h.hits / Math.max(1, h.lineCount),
  }))
  const best = scored.reduce((a, b) => (b.density > a.density ? b : a))

  const totalHits = hits.reduce((sum, h) => sum + h.hits, 0)
  const sorted = [...hits].sort((a, b) => b.hits - a.hits)
  const shown = sorted.slice(0, maxItems)

  // A section list alone cannot answer "where does this concentrate overall" —
  // that is the question the A/B trial showed the model getting wrong. Put the
  // global distribution BEFORE the per-section list so the reader sees the
  // shape of the whole file first, then drills into sections.
  const dist = scan.distribution
  if (dist && dist.buckets.length > 1) {
    const ranked = [...dist.buckets].sort((a, b) => b.count - a.count)
    const top = ranked.slice(0, 5)
    const sum = ranked.reduce((n, b) => n + b.count, 0)
    lines.push('')
    lines.push(`Global distribution (${group(dist.size)}-line buckets, by matching lines):`)
    for (const bucket of top) {
      const bar = '█'.repeat(Math.max(1, Math.round((bucket.count / Math.max(1, ranked[0].count)) * 12)))
      const share = ((bucket.count / Math.max(1, sum)) * 100).toFixed(1)
      lines.push(`  lines ${group(bucket.from)}–${group(bucket.to)}  ${bar} ${group(bucket.count)} (${share}%)`)
    }
    const peak = top[0]
    lines.push(
      `Overall, the highest concentration is lines ${group(peak.from)}–${group(peak.to)} (${group(peak.count)} of ${group(sum)} matching lines). Start there if you want the broad picture; the densest section below is for a focused read.`,
    )
  }

  lines.push('')
  lines.push(
    `「${keyword}」appears in ${group(hits.length)} section${hits.length === 1 ? '' : 's'}, ${group(totalHits)} matching lines total:`,
  )
  for (const heading of shown) {
    const indent = '  '.repeat(Math.max(0, heading.level - 1))
    const density = (heading.hits / Math.max(1, heading.lineCount)) * 100
    lines.push(
      `${indent}${'#'.repeat(heading.level)} ${heading.title}  ·  lines ${group(heading.line)}–${group(heading.endLine)} (${group(heading.lineCount)})  ·  ${group(heading.hits)} hits  ·  ${density.toFixed(1)}% of lines`,
    )
  }

  lines.push('')
  lines.push(
    `Densest single section (not the global picture): 「${best.heading.title}」— ${group(best.heading.hits)} of ${group(best.heading.lineCount)} lines (${(best.density * 100).toFixed(1)}%). Read it first for a focused pass: digest(path=..., lines="${best.heading.line}–${best.heading.endLine}", budget=3000).`,
  )

  const omitted = sorted.length - shown.length
  if (omitted > 0) lines.push(`— ${group(omitted)} more matching sections omitted (max_items=${maxItems})`)
  return clip(lines.join('\n'))
}

/**
 * Build the `file_card` report: a file's identity and skeleton, no body text.
 *
 * The card answers "is this the kind of file I am looking for" before any read
 * happens. The head/tail samples are the only content it shows, and they stay
 * clipped: a sample is for recognition, not for smuggling text past the budget.
 *
 * @param {object} card collected card data
 * @param {object} options render options
 * @param {number} [options.maxHeadings] heading ceiling
 * @param {number} [options.depth] deepest heading level
 * @returns {string} the rendered card
 */
export function renderFileCard(card, options = {}) {
  const maxHeadings = options.maxHeadings ?? 200
  const depth = options.depth ?? 3
  const size = classify(card.bytes)

  const lines = []
  lines.push(`## ${card.path}`)
  const cardEncoding = card.encodingConfidence === 'uncertain' ? `${card.encoding} (guessed; see note below)` : card.encoding
  lines.push(
    `${formatBytes(card.bytes)} · ${group(card.lines)} lines · ${cardEncoding} · modified ${card.modified}`,
  )
  lines.push(`Size tier: ${size.tier}. ${size.advice}`)

  if (card.encodingConfidence === 'uncertain') {
    lines.push(
      `⚠️ The encoding was guessed: these bytes are valid in several single-byte encodings and cannot be told apart reliably. Text is decoded as ${card.encoding}. If characters look wrong, the file is probably a different legacy encoding.`,
    )
  }

  if (card.unterminatedFence) {
    lines.push(
      `⚠️ Unterminated code fence opened at line ${group(card.unterminatedFence.line)}: everything after it was treated as code.`,
    )
  }

  lines.push('')
  if (card.headings.length > 0) {
    const { entries, foldedCount, foldedGroups } = foldHeadings(card.headings, depth)
    const shown = entries.slice(0, maxHeadings)
    const omitted = entries.length - shown.length

    lines.push(`### Structure: ${group(card.headings.length)} headings (depth ${depth}, ${group(entries.length)} entries)`)
    for (const entry of shown) {
      const indent = '  '.repeat(entry.level - 1)
      if (entry.folded) {
        lines.push(`${indent}${'#'.repeat(entry.level)} ${entry.text}`)
      } else {
        lines.push(
          `${indent}${'#'.repeat(entry.level)} ${entry.text}  ·  lines ${group(entry.line)}–${group(entry.endLine)} (${group(entry.lineCount)})`,
        )
      }
    }
    const facts = []
    if (omitted > 0) facts.push(`${group(omitted)} more entries omitted (max_headings=${maxHeadings})`)
    if (foldedCount > 0) facts.push(`${group(foldedCount)} repeated headings folded into ${group(foldedGroups)} rows`)
    if (facts.length > 0) lines.push(`— ${facts.join(' · ')}`)
  } else {
    lines.push('### Structure: no Markdown headings')
    lines.push(
      'This file has no `#` headings, so the outline below falls back to paragraph openers and repeated line prefixes.',
    )
    if (card.degraded && card.degraded.paragraphs.length > 0) {
      lines.push('')
      lines.push(`Paragraph openers (${group(card.degraded.paragraphs.length)} of ${group(card.degraded.blankBlocks)} blocks):`)
      for (const para of card.degraded.paragraphs) {
        lines.push(`  line ${group(para.line)} (${group(para.lines)} lines)  ${para.first}`)
      }
    }
    if (card.degraded && card.degraded.prefixes.length > 0) {
      lines.push('')
      lines.push('Repeated line prefixes (the file\'s own vocabulary):')
      for (const prefix of card.degraded.prefixes) {
        lines.push(`  ×${group(prefix.count)}  ${prefix.text}`)
      }
    }
  }

  if (card.head.length > 0) {
    lines.push('')
    lines.push(`### Opening lines (${card.head.length}, each clipped to 200 chars)`)
    for (const row of card.head) lines.push(`${String(row.n).padStart(6)}│ ${row.text}`)
  }
  if (card.tail.length > 0) {
    lines.push('')
    lines.push(`### Closing lines (${card.tail.length}, each clipped to 200 chars)`)
    for (const row of card.tail) lines.push(`${String(row.n).padStart(6)}│ ${row.text}`)
  }

  lines.push('')
  lines.push('Next: outline(path) for the full tree, outline(path, keyword=...) to locate a topic, digest(path, lines=...) to read one range.')
  return clip(lines.join('\n'))
}

/**
 * Build the `digest` report: the requested range, what was returned, and how to
 * continue.
 *
 * The continuation pointer is the whole point of this tool. A digest that
 * returned text without saying what it left behind would just be a `read` with
 * extra steps.
 *
 * @param {object} result output of `digestRange`
 * @param {string} absPath file that was read
 * @returns {string} the rendered digest
 */
export function renderDigest(result, absPath) {
  const lines = []
  lines.push(`## ${absPath}`)
  const requested =
    result.requestedLines > 0
      ? `lines ${group(result.startLine)}–${group(result.endLine)}`
      : `requested start ${group(result.startLine)} is past the end`
  lines.push(`Returned ${requested} · ${group(result.returnedLines)} lines · ~${group(result.tokens)} tokens (budget ${group(result.budget)})`)

  if (result.returnedLines === 0) {
    lines.push('')
    lines.push(`The file has ${group(result.totalLines)} lines, so there is nothing to return from line ${group(result.from)}.`)
    return clip(lines.join('\n'))
  }

  lines.push('')

  let text = result.text
  let textClipped = false
  if (text.length > OUTPUT_LIMIT - 1200) {
    const keep = OUTPUT_LIMIT - 1400
    text = `${text.slice(0, keep)}\n… (this range was clipped again by the 8000-character output ceiling)`
    textClipped = true
  }
  lines.push(text)

  lines.push('')
  if (result.remainingLines > 0) {
    const nextStart = result.endLine + 1
    const nextEnd = Math.min(result.to, nextStart + Math.max(50, result.returnedLines))
    lines.push(
      `Not returned: ${group(result.remainingLines)} more lines in the requested range. Continue with digest(path=..., lines="${nextStart}-${nextEnd}", budget=${result.budget}).`,
    )
  } else {
    lines.push(`This range is complete (${group(result.totalLines)} lines in the file).`)
  }
  if (textClipped) lines.push('The character ceiling cut the text, not the line range; narrow the range for a clean read.')

  return clip(lines.join('\n'))
}

/**
 * Enforce the hard output ceiling, stating the original length when it bites.
 * @param {string} text rendered report
 * @param {number} limit character ceiling
 * @returns {string} the clipped report
 */
export function clip(text, limit = OUTPUT_LIMIT) {
  if (text.length <= limit) return text
  const note = `\n… output truncated: ${group(text.length)} chars total, ${group(limit)} shown. Lower depth or max_items for a complete view.`
  return text.slice(0, limit - note.length) + note
}

/**
 * Count rendered tokens, for the operator's own sanity.
 * @param {string} text rendered report
 * @returns {number} estimated tokens
 */
export function tokensOf(text) {
  return estimateTokens(text)
}
