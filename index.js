/**
 * dsh-file-outline — a structural map of large files for the agent.
 *
 * Host-only plugin, no Client half. Every registered tool is read-only,
 * deterministic, streaming, and free of LLM calls: it tells the model what a
 * file is made of and where each part lives, instead of making search faster or
 * reading the whole file into context.
 */
import { renderDigest, renderFileCard, renderKeywordOutline, renderOutline } from './lib/render.js'
import { assertReadableFile, resolveInside } from './lib/path.js'
import {
  OutlineError,
  classify,
  collectCard,
  compileMatcher,
  detectEncoding,
  digestRange,
  findSection,
  scanStructure,
} from './lib/engine.js'

export const name = 'dsh-file-outline'
export const inject = ['tools']

const OUTLINE_NAME = 'outline'
const CARD_NAME = 'file_card'
const DIGEST_NAME = 'digest'

const DIGEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'File inside the workspace: relative to it, or absolute under it.' },
    section: {
      type: 'string',
      description: 'Heading title, matched exactly first then as a substring. Takes the section\'s whole line range as the request; the output narrows to whatever the budget allows. Provide either section or lines.',
    },
    lines: {
      type: 'string',
      description: 'Line range as "START-END", 1-based and inclusive, e.g. "2100-2600". Provide either section or lines.',
    },
    budget: {
      type: 'integer',
      description: 'Token ceiling for the returned text (200–20000). Default 3000. The tool stops before exceeding it and reports how many lines remain.',
    },
  },
  required: ['path'],
}

const DIGEST_DESCRIPTION =
  'Read one section or line range of a file within a token budget, and say exactly what was left out. '
  + 'Returns the requested range reduced to what fits, the actual line range covered, the estimated token cost, and the exact lines= value that continues from there. '
  + 'Use it after outline has told you where a section is. Cut points prefer blank lines so the text does not stop mid-sentence. '
  + 'Prefer the built-in read when you want a small file whole or an exact unbudgeted range.'

/**
 * Parse a "START-END" line range.
 * @param {unknown} value caller's string
 * @returns {{from: number, to: number}} the range
 */
function parseLines(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OutlineError('LINES_REQUIRED', 'lines is required when section is not given; use the form "START-END", e.g. "2100-2600".')
  }
  const match = /^\s*(\d+)\s*[-–—]\s*(\d+)\s*$/.exec(value)
  if (!match) {
    throw new OutlineError('BAD_LINES', `cannot parse lines="${value}"; use the form "START-END", e.g. "2100-2600".`)
  }
  const from = Number(match[1])
  const to = Number(match[2])
  if (from < 1) throw new OutlineError('BAD_LINES', 'lines start must be 1 or greater.')
  if (to < from) throw new OutlineError('BAD_LINES', `lines end (${to}) is before its start (${from}).`)
  return { from, to }
}

/**
 * Run one digest call.
 * @param {object} ctx plugin context
 * @param {object} args model arguments
 * @param {object} exec tool run context
 * @returns {Promise<object>} structured digest plus rendered text
 */
async function executeDigest(ctx, args, exec) {
  const raw = args && typeof args === 'object' ? args : {}
  const workingDirectory = ctx.get('workingDirectory')
  if (!workingDirectory) {
    throw new Error('workingDirectory service is unavailable; cannot confirm the workspace root')
  }
  const root = await workingDirectory.ensure(exec.agent, exec.signal)
  const absolute = resolveInside(root, raw.path)
  await assertReadableFile(absolute)

  const budget = clampInt(raw.budget, 3000, 200, 20000)
  const { decoder } = await detectEncoding(absolute)

  let from
  let to
  let sectionTitle
  if (typeof raw.section === 'string' && raw.section.trim() !== '') {
    const wanted = raw.section.trim()
    const scan = await scanStructure(absolute)
    const found = findSection(scan.headings, wanted)
    if (!found) {
      throw new OutlineError(
        'SECTION_NOT_FOUND',
        `no heading matches "${wanted}". Run outline(path) to list the available sections.`,
      )
    }
    from = found.line
    to = found.endLine
    sectionTitle = found.title
  } else {
    const range = parseLines(raw.lines)
    from = range.from
    to = range.to
  }

  const result = await digestRange(absolute, decoder, from, to, budget)
  const text = renderDigest(result, absolute)

  return {
    path: absolute,
    ...(sectionTitle ? { section: sectionTitle } : {}),
    requestedFrom: from,
    requestedTo: result.to,
    startLine: result.startLine,
    endLine: result.endLine,
    returnedLines: result.returnedLines,
    remainingLines: result.remainingLines,
    totalLines: result.totalLines,
    tokens: result.tokens,
    budget,
    truncated: result.remainingLines > 0 || result.tokens > budget,
    text,
  }
}

const CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'File inside the workspace: relative to it, or absolute under it.' },
    max_headings: { type: 'integer', description: 'Maximum heading entries (1–1000). Default 200. The remainder is reported as omitted, with per-level truncation.' },
    depth: { type: 'integer', description: 'Deepest heading level to show (1–6). Default 3.' },
    head_lines: { type: 'integer', description: 'Opening sample lines (0–100). Default 20. Each line is clipped to 200 characters.' },
    tail_lines: { type: 'integer', description: 'Closing sample lines (0–100). Default 20. Each line is clipped to 200 characters.' },
  },
  required: ['path'],
}

const CARD_DESCRIPTION =
  'Identify one text file before reading it: byte size, line count, encoding, size tier, modified time, plus its heading skeleton and a short head/tail sample. '
  + 'It never returns body text beyond those clipped samples. '
  + 'Use it first when you do not know what a file is; use outline when you want the full tree or a keyword search, and digest to read a section. '
  + 'For a file with no Markdown headings it falls back to paragraph openers and repeated line prefixes instead of inventing structure. '
  + 'Binary files (PDF, Office, images, archives) are refused with the reader to use instead.'

/**
 * Run one file_card call.
 * @param {object} ctx plugin context
 * @param {object} args model arguments
 * @param {object} exec tool run context
 * @returns {Promise<object>} structured card plus rendered text
 */
async function executeCard(ctx, args, exec) {
  const raw = args && typeof args === 'object' ? args : {}
  const workingDirectory = ctx.get('workingDirectory')
  if (!workingDirectory) {
    throw new Error('workingDirectory service is unavailable; cannot confirm the workspace root')
  }
  const root = await workingDirectory.ensure(exec.agent, exec.signal)
  const absolute = resolveInside(root, raw.path)
  await assertReadableFile(absolute)

  const maxHeadings = clampInt(raw.max_headings, 200, 1, 1000)
  const depth = clampInt(raw.depth, 3, 1, 6)
  const headLines = clampInt(raw.head_lines, 20, 0, 100)
  const tailLines = clampInt(raw.tail_lines, 20, 0, 100)

  const card = await collectCard(absolute, { headLines, tailLines })
  const text = renderFileCard(card, { maxHeadings, depth })

  return {
    path: card.path,
    bytes: card.bytes,
    lines: card.lines,
    encoding: card.encoding,
    sizeTier: classify(card.bytes).tier,
    headingTotal: card.headings.length,
    hasStructure: card.headings.length > 0,
    degraded: card.degraded !== null,
    truncated: text.includes('… output truncated:'),
    text,
  }
}

const OUTLINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'File inside the workspace: relative to it, or absolute under it.' },
    keyword: {
      type: 'string',
      description: 'Optional. When set, return where this keyword occurs by section instead of the bare heading tree. Matched as a regular expression unless literal=true. Only line counts per section are returned, never the matching lines — use the built-in search tool for the text itself.',
    },
    literal: {
      type: 'boolean',
      description: 'Treat keyword as literal text instead of a regular expression. Default false.',
    },
    case_sensitive: {
      type: 'boolean',
      description: 'Match keyword case-sensitively. Default false.',
    },
    depth: {
      type: 'integer',
      description: 'Deepest heading level to show (1–6). Default 2 without a keyword, 6 with one; raise to 6 for every nested section.',
    },
    max_items: {
      type: 'integer',
      description: 'Maximum entries returned (1–500). Default 100. When exceeded, the remainder is reported, not silently dropped.',
    },
  },
  required: ['path'],
}

const OUTLINE_DESCRIPTION =
  'Map one large text file before reading it: returns its Markdown heading tree with each section\'s line range, its size tier, and how to read a chosen section next. '
  + 'With keyword, it instead reports which sections contain that keyword, how densely, and which section to read first. '
  + 'Use it when a file is too big to read whole or when you do not yet know what it contains. '
  + 'It never returns body text. Prefer the built-in read for files under 10 KB. '
  + 'Binary files (PDF, Office, images, archives) are refused with the reader to use instead. '
  + 'For a plain-text file with no headings, it says so instead of inventing structure.'

/**
 * Clamp an integer argument into a range, falling back to a default.
 * @param {unknown} value caller value
 * @param {number} fallback default when absent or not a number
 * @param {number} min inclusive lower bound
 * @param {number} max inclusive upper bound
 * @returns {number} the clamped integer
 */
function clampInt(value, fallback, min, max) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * Run one outline call.
 * @param {object} ctx plugin context
 * @param {object} args model arguments
 * @param {object} exec tool run context, carrying the calling agent and signal
 * @returns {Promise<object>} structured outline plus rendered text
 */
async function executeOutline(ctx, args, exec) {
  const raw = args && typeof args === 'object' ? args : {}
  const workingDirectory = ctx.get('workingDirectory')
  if (!workingDirectory) {
    throw new Error('workingDirectory service is unavailable; cannot confirm the workspace root')
  }
  const root = await workingDirectory.ensure(exec.agent, exec.signal)
  const absolute = resolveInside(root, raw.path)
  await assertReadableFile(absolute)

  const keyword = typeof raw.keyword === 'string' && raw.keyword.trim() !== '' ? raw.keyword : null
  const depth = clampInt(raw.depth, keyword ? 6 : 2, 1, 6)
  const maxItems = clampInt(raw.max_items, 100, 1, 500)

  const matcher = keyword
    ? compileMatcher(keyword, { literal: raw.literal === true, caseSensitive: raw.case_sensitive === true })
    : null
  const scan = await scanStructure(absolute, { matcher })

  const isKeywordMode = keyword !== null
  const text = isKeywordMode
    ? renderKeywordOutline(scan, { keyword, depth, maxItems })
    : renderOutline(scan, { depth, maxItems })

  return {
    path: scan.path,
    bytes: scan.bytes,
    lines: scan.lines,
    encoding: scan.encoding,
    mode: isKeywordMode ? 'keyword' : 'structure',
    ...(isKeywordMode ? { keyword, keywordHits: scan.keywordHits } : {}),
    depth,
    headingTotal: scan.headings.length,
    headingCounts: countLevels(scan.headings, depth),
    truncated: text.includes('… output truncated:'),
    text,
  }
}

/**
 * Count headings per level up to `depth`.
 * @param {Array<object>} headings scanned headings
 * @param {number} depth deepest level counted
 * @returns {Record<string, number>} counts keyed `h1`…`h6`
 */
function countLevels(headings, depth) {
  const counts = {}
  for (let level = 1; level <= depth; level += 1) {
    counts[`h${level}`] = headings.filter((h) => h.level === level).length
  }
  return counts
}

const TOOL_DEFINITION = {
  name: OUTLINE_NAME,
  description: OUTLINE_DESCRIPTION,
  parameters: OUTLINE_SCHEMA,
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Absolute path that was scanned.' },
        bytes: { type: 'integer', description: 'File size in bytes.' },
        lines: { type: 'integer', description: 'Total line count.' },
        encoding: { type: 'string', description: 'Detected text encoding.' },
        mode: { type: 'string', enum: ['structure', 'keyword'], description: 'Which report was produced.' },
        keyword: { type: 'string', description: 'Keyword used, in keyword mode.' },
        keywordHits: { type: 'integer', description: 'Matching lines outside code fences, in keyword mode.' },
        depth: { type: 'integer', description: 'Depth actually used.' },
        headingTotal: { type: 'integer', description: 'Headings found at any level, outside code fences.' },
        headingCounts: { type: 'object', description: 'Headings per level, up to depth.' },
        truncated: { type: 'boolean', description: 'Whether the entry list or the text hit a limit.' },
        text: { type: 'string', description: 'The rendered outline the model reads.' },
      },
      required: ['path', 'bytes', 'lines', 'encoding', 'text'],
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
}

/**
 * Register the file_card tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 */
function registerCard(ctx) {
  const definition = {
    name: CARD_NAME,
    description: CARD_DESCRIPTION,
    parameters: CARD_SCHEMA,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Absolute path that was scanned.' },
          bytes: { type: 'integer', description: 'File size in bytes.' },
          lines: { type: 'integer', description: 'Total line count.' },
          encoding: { type: 'string', description: 'Detected text encoding.' },
          sizeTier: { type: 'string', description: 'Size classification, e.g. "huge (>10 MB)".' },
          headingTotal: { type: 'integer', description: 'Markdown headings found.' },
          hasStructure: { type: 'boolean', description: 'Whether the file has any Markdown headings.' },
          degraded: { type: 'boolean', description: 'Whether paragraph/prefix fallback was used.' },
          truncated: { type: 'boolean', description: 'Whether the rendered text hit a limit.' },
          text: { type: 'string', description: 'The rendered card the model reads.' },
        },
        required: ['path', 'bytes', 'lines', 'encoding', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    execute: (args, exec) => executeCard(ctx, args, exec),
  }
  return ctx.tools.register(definition)
}

/**
 * Register the digest tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 * @returns {() => void} disposer
 */
function registerDigest(ctx) {
  return ctx.tools.register({
    name: DIGEST_NAME,
    description: DIGEST_DESCRIPTION,
    parameters: DIGEST_SCHEMA,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Absolute path that was read.' },
          section: { type: 'string', description: 'Matched heading title, when section was used.' },
          requestedFrom: { type: 'integer', description: 'First line requested.' },
          requestedTo: { type: 'integer', description: 'Last line requested, clamped to the file.' },
          startLine: { type: 'integer', description: 'First line actually returned.' },
          endLine: { type: 'integer', description: 'Last line actually returned.' },
          returnedLines: { type: 'integer', description: 'How many lines were returned.' },
          remainingLines: { type: 'integer', description: 'How many lines of the request were left out.' },
          totalLines: { type: 'integer', description: 'Total lines in the file.' },
          tokens: { type: 'integer', description: 'Estimated tokens in the returned text.' },
          budget: { type: 'integer', description: 'Token ceiling that was applied.' },
          truncated: { type: 'boolean', description: 'Whether anything was left out.' },
          text: { type: 'string', description: 'The rendered digest the model reads.' },
        },
        required: ['path', 'startLine', 'endLine', 'returnedLines', 'tokens', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    execute: (args, exec) => executeDigest(ctx, args, exec),
  })
}

/**
 * Register the outline tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 */
export function apply(ctx) {
  ctx.effect(() => {
    const disposeOutline = ctx.tools.register({
      ...TOOL_DEFINITION,
      isConcurrencySafe: () => true,
      execute: (args, exec) => executeOutline(ctx, args, exec),
    })
    const disposeCard = registerCard(ctx)
    const disposeDigest = registerDigest(ctx)
    return () => {
      disposeOutline()
      disposeCard()
      disposeDigest()
    }
  }, 'file-outline tools')
}

export { scanStructure, renderOutline }
