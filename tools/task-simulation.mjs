/**
 * Task-level simulation: does the tool output contain enough information to
 * answer the questions an agent actually asks about a big file?
 *
 * The A/B trial used real model conversations, which are slow, costly, and
 * noisy. This suite replaces them with deterministic assertions: for each
 * question, an independent oracle computes the ground truth directly from the
 * file, then we assert the rendered report contains it. No model is involved.
 *
 * Run: node tools/task-simulation.mjs [--real]
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  bucketHits,
  classify,
  compileMatcher,
  digestRange,
  findSection,
  scanParagraphs,
  scanStructure,
} from '../lib/engine.js'
import { renderDigest, renderFileCard, renderKeywordOutline, renderOutline } from '../lib/render.js'
import { collectCard } from '../lib/engine.js'

let pass = 0
let fail = 0
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outline-sim-'))
const rows = []

/**
 * Run one named simulated question.
 * @param {string} question the agent's question
 * @param {string} tool which tool answers it
 * @param {() => Promise<string>} answer produces the rendered report
 * @param {(text: string) => void} verify asserts the answer is in the report
 */
async function simulate(question, tool, answer, verify) {
  try {
    const text = await answer()
    verify(text)
    pass += 1
    rows.push({ question, tool, ok: true, detail: `${text.length} chars` })
    console.log(`  ok   [${tool}] ${question}`)
  } catch (error) {
    fail += 1
    rows.push({ question, tool, ok: false, detail: error.message })
    console.log(`  FAIL [${tool}] ${question}\n       ${error.message}`)
  }
}

/**
 * Write a fixture.
 * @param {string} name file name
 * @param {string} body contents
 * @returns {string} absolute path
 */
function put(name, body) {
  const file = path.join(tmp, name)
  fs.writeFileSync(file, body, 'utf8')
  return file
}

/**
 * Independent oracle: scan a file directly, with no plugin code involved in
 * the counting. Uses a different mechanism (whole-string split) on purpose.
 * @param {string} file file path
 * @param {string} keyword search term
 * @param {number} bucketSize bucket width
 * @returns {{counts: Map<number, number>, total: number, lines: number}} ground truth
 */
function oracle(file, keyword, bucketSize) {
  // split('\n') leaves a trailing empty element when the file ends with a
  // newline; drop it so the line count matches the streaming reader.
  const raw = fs.readFileSync(file, 'utf8').split('\n')
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()
  const all = raw
  const counts = new Map()
  let total = 0
  for (let i = 0; i < all.length; i += 1) {
    if (!all[i].includes(keyword)) continue
    total += 1
    const index = Math.floor(i / bucketSize)
    counts.set(index, (counts.get(index) || 0) + 1)
  }
  return { counts, total, lines: all.length }
}

/**
 * Find the bucket with the most hits, using the oracle.
 * @param {Map<number, number>} counts bucket counts
 * @param {number} size bucket width
 * @returns {{from: number, to: number, count: number}} the peak
 */
function peakBucket(counts, size) {
  let best = { from: 0, to: 0, count: -1 }
  for (const [index, count] of counts) {
    if (count > best.count) best = { from: index * size + 1, to: (index + 1) * size, count }
  }
  return best
}

console.log('\nsimulated questions on a synthetic 3,000-line file')

// Build a file where the oracle-known answer is unambiguous.
const parts = []
for (let i = 1; i <= 3000; i += 1) {
  if (i % 100 === 0) parts.push(`# Chapter ${i / 100}`)
  // Concentrate "target" in lines 2100-2400, sparingly elsewhere.
  if (i >= 2100 && i <= 2400 && i % 3 === 0) parts.push(`target line ${i}`)
  else if (i % 250 === 0) parts.push(`target line ${i}`)
  else parts.push(`filler ${i}`)
}
const synthetic = put('synthetic.md', `${parts.join('\n')}\n`)

await simulate('where does the topic concentrate overall?', 'outline(keyword)', async () => {
  const scan = await scanStructure(synthetic, { matcher: compileMatcher('target', { literal: true }) })
  return renderKeywordOutline(scan, { keyword: 'target', maxItems: 20 })
}, (text) => {
  assert.match(text, /Global distribution/, 'the report must include a global view')
  assert.match(text, /highest concentration is lines/, 'must name the peak range')
  // Bucket width adapts to file size; assert the peak lands in the injected
  // 2100-2400 cluster rather than hard-coding a bucket label.
  const match = /highest concentration is lines ([\d,]+)–([\d,]+)/.exec(text)
  assert.ok(match, `missing peak: ${text.slice(0, 400)}`)
  const from = Number(match[1].replace(/,/g, ''))
  const to = Number(match[2].replace(/,/g, ''))
  assert.ok(from <= 2400 && to >= 2100, `peak ${from}-${to} outside the cluster`)
})

await simulate('how many sections mention it, and how many lines?', 'outline(keyword)', async () => {
  const scan = await scanStructure(synthetic, { matcher: compileMatcher('target', { literal: true }) })
  return renderKeywordOutline(scan, { keyword: 'target', maxItems: 20 })
}, (text) => {
  assert.match(text, /appears in \d+ sections?, [\d,]+ matching lines total/)
})

await simulate('which single section should I read first?', 'outline(keyword)', async () => {
  const scan = await scanStructure(synthetic, { matcher: compileMatcher('target', { literal: true }) })
  return renderKeywordOutline(scan, { keyword: 'target', maxItems: 20 })
}, (text) => {
  assert.match(text, /Densest single section \(not the global picture\)/)
  assert.match(text, /digest\(path=\.\.\., lines="\d+–\d+"/)
})

await simulate('is this file worth using these tools on?', 'file_card', async () => {
  return renderFileCard(await collectCard(synthetic), {})
}, (text) => {
  assert.match(text, /Size tier:/)
  assert.match(text, /[Ss]mall file: the built-in read tool is enough|Normal size/)
})

await simulate('what is the overall structure?', 'outline', async () => {
  return renderOutline(await scanStructure(synthetic), { depth: 1, maxItems: 50 })
}, (text) => {
  assert.match(text, /Sections \(depth 1/)
  // Numbered series fold, but the fold must preserve the first/last identity.
  assert.match(text, /Chapter 1 … Chapter 30/)
})

await simulate('read one bounded chunk and tell me how to continue', 'digest', async () => {
  const result = await digestRange(synthetic, 'utf-8', 2100, 2200, 400)
  return renderDigest(result, synthetic)
}, (text) => {
  assert.match(text, /Returned lines 2,100/)
  assert.match(text, /Continue with digest|This range is complete/)
})

await simulate('find a section by its title', 'digest(section)', async () => {
  const scan = await scanStructure(synthetic)
  const found = findSection(scan.headings, 'Chapter 25')
  assert.ok(found, 'oracle: Chapter 25 exists')
  const result = await digestRange(synthetic, 'utf-8', found.line, found.endLine, 5000)
  return renderDigest(result, synthetic)
}, (text) => {
  // The heading line itself occupies a line, so Chapter 25 starts at 2524.
  assert.match(text, /Returned lines 2,524–2,624/)
  assert.match(text, /# Chapter 25/)
})

console.log('\nbucket maths')

await simulate('bucket sizes snap to round numbers', 'bucketHits', async () => {
  const { size, buckets } = bucketHits([1, 500, 1000, 9000], 9000, 16)
  return String(size)
}, (text) => {
  const size = Number(text)
  assert.ok([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000].includes(size), `size ${size} not round`)
})

await simulate('a short file still gets more than one bucket', 'bucketHits', async () => {
  const { buckets } = bucketHits([2, 3, 45, 46, 47], 60, 16)
  return String(buckets.length)
}, (text) => {
  assert.ok(Number(text) >= 2, `only ${text} buckets`)
})

await simulate('empty hits produce no buckets', 'bucketHits', async () => {
  const { buckets } = bucketHits([], 1000, 16)
  return String(buckets.length)
}, (text) => assert.equal(text, '0'))

if (process.argv.includes('--real')) {
  const huge = 'D:/MR/_归档/对话存档/_WorkBuddy对话B-设置MR项目UI设计工作流.md'
  if (fs.existsSync(huge)) {
    console.log('\nreal 14 MB file (the A/B trial\'s exact question)')

    const keyword = '配色'
    const scan = await scanStructure(huge, { matcher: compileMatcher(keyword, { literal: true }) })

    // Independent oracle, built without any plugin counting logic.
    const size = scan.distribution.size
    const truth = oracle(huge, keyword, size)
    const peak = peakBucket(truth.counts, size)

    await simulate('where does 「配色」 concentrate overall? (A/B trial question)', 'outline(keyword)', async () => {
      return renderKeywordOutline(scan, { keyword, maxItems: 8 })
    }, (text) => {
      assert.match(text, /Global distribution/)
      const from = peak.from.toLocaleString('en-US')
      const to = peak.to.toLocaleString('en-US')
      assert.ok(
        text.includes(`${from}–${to}`),
        `report must name the oracle peak lines ${from}–${to}`,
      )
      // The A/B trial's B group answered 112000-120000; the oracle peak must win.
      assert.match(text, /highest concentration is lines/)
    })

    await simulate('report and oracle agree on total hit count', 'outline(keyword)', async () => {
      return renderKeywordOutline(scan, { keyword, maxItems: 8 })
    }, (text) => {
      assert.equal(scan.keywordHits, truth.total, 'plugin count must match the independent oracle')
      assert.ok(text.includes(truth.total.toLocaleString('en-US')) || text.includes(String(truth.total)))
    })

    await simulate('the global peak beats every local section', 'outline(keyword)', async () => {
      return renderKeywordOutline(scan, { keyword, maxItems: 8 })
    }, (text) => {
      assert.match(text, /Overall, the highest concentration is lines/)
      assert.match(text, /Densest single section \(not the global picture\)/)
      assert.ok(text.indexOf('Global distribution') < text.indexOf('Densest single section'), 'global view must come first')
    })

    await simulate('file_card reports the true line count', 'file_card', async () => {
      return renderFileCard(await collectCard(huge), { maxHeadings: 20 })
    }, (text) => {
      assert.ok(text.includes(truth.lines.toLocaleString('en-US')), `missing ${truth.lines}`)
      assert.match(text, /huge \(>10 MB\)/)
    })

    await simulate('digest of the oracle peak stays within budget', 'digest', async () => {
      const result = await digestRange(huge, 'utf-8', peak.from, Math.min(peak.to, peak.from + 300), 800)
      return renderDigest(result, huge)
    }, (text) => {
      assert.match(text, /Returned lines/)
      assert.match(text, /~[\d,]+ tokens \(budget 800\)/)
      assert.ok(text.length <= 8000)
    })

    console.log(`       oracle: ${truth.total} hits, peak lines ${peak.from}–${peak.to} (${peak.count} hits), ${truth.lines} lines total`)
  }
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
