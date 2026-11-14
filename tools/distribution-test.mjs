/**
 * Global-distribution verification: the A/B trial's missing capability.
 *
 * The A/B trial showed the model answering "where does this concentrate" with a
 * local section instead of the global peak. These tests lock down the bucket
 * maths and the ordering of the two views so that regression is impossible.
 *
 * Run: node tools/distribution-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bucketHits, compileMatcher, scanStructure } from '../lib/engine.js'
import { renderKeywordOutline } from '../lib/render.js'

let pass = 0
let fail = 0
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outline-dist-'))

/**
 * Run one named check.
 * @param {string} label what is asserted
 * @param {() => Promise<void>} body the check
 */
async function check(label, body) {
  try {
    await body()
    pass += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    fail += 1
    console.log(`  FAIL ${label}\n       ${error.message}`)
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

console.log('\nbucket maths')

await check('empty input yields no buckets', () => {
  const r = bucketHits([], 1000)
  assert.equal(r.size, 0)
  assert.deepEqual(r.buckets, [])
})

await check('bucket sizes are round 1/2/5 x 10^n', () => {
  for (const [total, target] of [[60, 24], [9000, 16], [165359, 24], [1000000, 24], [500, 8]]) {
    const { size } = bucketHits([1], total, target)
    const mantissa = size / 10 ** Math.floor(Math.log10(size))
    assert.ok([1, 2, 5, 10].includes(Math.round(mantissa * 10) / 10), `size ${size} not round`)
  }
})

await check('a hit on the last line never exceeds the file', () => {
  const { buckets } = bucketHits([1000], 1000, 24)
  const last = buckets[buckets.length - 1]
  assert.ok(last.to <= 1000, `bucket ends at ${last.to}`)
})

await check('bucket counts sum to the number of hits', () => {
  const lines = [1, 2, 3, 500, 501, 999, 1000, 4500, 8800]
  const { buckets } = bucketHits(lines, 9000, 24)
  const sum = buckets.reduce((n, b) => n + b.count, 0)
  assert.equal(sum, lines.length)
})

await check('buckets are sorted and non-overlapping', () => {
  const { buckets } = bucketHits([8, 800, 80, 8000, 80000], 165359, 24)
  for (let i = 1; i < buckets.length; i += 1) {
    assert.ok(buckets[i].from > buckets[i - 1].to, `overlap at ${i}`)
  }
})

await check('a short file is not collapsed into one bucket', () => {
  const { buckets } = bucketHits([2, 3, 45, 46, 47], 60, 24)
  assert.ok(buckets.length >= 2, `only ${buckets.length} buckets`)
})

await check('a huge file yields a readable number of buckets', () => {
  const { buckets } = bucketHits([1, 165359], 165359, 24)
  assert.ok(buckets.length >= 2 && buckets.length <= 40, `${buckets.length} buckets`)
})

console.log('\nrender contract')

const body = []
for (let i = 1; i <= 3000; i += 1) {
  if (i % 100 === 0) body.push(`# Chapter ${i / 100}`)
  if (i >= 2100 && i <= 2400 && i % 3 === 0) body.push(`target ${i}`)
  else body.push(`filler ${i}`)
}
const file = put('clustered.md', `${body.join('\n')}\n`)

/**
 * Render the keyword report once.
 * @returns {Promise<string>} the text
 */
async function report() {
  const scan = await scanStructure(file, { matcher: compileMatcher('target', { literal: true }) })
  return renderKeywordOutline(scan, { keyword: 'target', maxItems: 20 })
}

await check('names the globally dominant range', async () => {
  const text = await report()
  assert.match(text, /Global distribution/)
  // Do not hard-code a bucket width: it adapts to file size. Assert instead
  // that the named peak lies inside the 2100-2400 cluster we constructed.
  const match = /highest concentration is lines ([\d,]+)–([\d,]+)/.exec(text)
  assert.ok(match, `missing peak: ${text.slice(0, 400)}`)
  const from = Number(match[1].replace(/,/g, ''))
  const to = Number(match[2].replace(/,/g, ''))
  assert.ok(from <= 2400 && to >= 2100, `peak ${from}-${to} is outside the injected cluster`)
})

await check('global view appears before the section list', async () => {
  const text = await report()
  assert.ok(text.indexOf('Global distribution') < text.indexOf('appears in'), 'global must come first')
  assert.ok(text.indexOf('Global distribution') < text.indexOf('Densest single section'))
})

await check('explicitly labels the densest section as NOT the global picture', async () => {
  const text = await report()
  assert.match(text, /Densest single section \(not the global picture\)/)
})

await check('shows at most five buckets with a percentage', async () => {
  const text = await report()
  const rows = text.split('\n').filter((l) => /^\s+lines [\d,]+–[\d,]+\s+█/.test(l))
  assert.ok(rows.length >= 1 && rows.length <= 5, `${rows.length} bucket rows`)
  assert.ok(rows.every((l) => /\d+\.\d%\)/.test(l)), 'each bucket needs a share')
})

await check('omits the distribution when there is only one bucket', async () => {
  const tiny = put('tiny.md', '# Only\n\ntarget here\n')
  const scan = await scanStructure(tiny, { matcher: compileMatcher('target', { literal: true }) })
  const text = renderKeywordOutline(scan, { keyword: 'target', maxItems: 20 })
  assert.doesNotMatch(text, /Global distribution/)
})

await check('omits the distribution when nothing matches', async () => {
  const scan = await scanStructure(file, { matcher: compileMatcher('absentword', { literal: true }) })
  const text = renderKeywordOutline(scan, { keyword: 'absentword', maxItems: 20 })
  assert.match(text, /No line matched/)
  assert.doesNotMatch(text, /Global distribution/)
})

await check('does not break the 8000-character ceiling', async () => {
  const text = await report()
  assert.ok(text.length <= 8000, `length ${text.length}`)
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
