/**
 * Stage-1 verification for the outline engine.
 *
 * Runs against fixtures plus the real large files, and asserts the properties
 * the design promises: correct heading counts, fence exclusion, repeat folding,
 * line ranges, the output ceiling, and byte-identical results across runs.
 *
 * Run: node tools/selftest.mjs [--real]
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanStructure, foldKey, classify, estimateTokens, OUTPUT_LIMIT } from '../lib/engine.js'
import { renderOutline, foldHeadings } from '../lib/render.js'
import { resolveInside } from '../lib/path.js'

let passed = 0
let failed = 0

/**
 * Run one named check.
 * @param {string} label what is asserted
 * @param {() => void|Promise<void>} body the check
 */
async function check(label, body) {
  try {
    await body()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}\n       ${error.message}`)
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outline-test-'))

/**
 * Write a fixture and return its path.
 * @param {string} name file name
 * @param {string} body contents
 * @returns {string} absolute path
 */
function fixture(name, body) {
  const file = path.join(tmp, name)
  fs.writeFileSync(file, body, 'utf8')
  return file
}

console.log('\nfoldKey')
await check('collapses numbered suffixes', () => {
  assert.equal(foldKey('👤 甲方 #12'), '👤 甲方')
  assert.equal(foldKey('部署（第 3 轮）'), '部署')
  assert.equal(foldKey('Step (7)'), 'Step')
  assert.equal(foldKey('验收 12'), '验收')
})
await check('leaves ordinary titles alone', () => {
  assert.equal(foldKey('3.8 配色铁律'), '3.8 配色铁律')
  assert.equal(foldKey('Deploy'), 'Deploy')
})

console.log('\nclassify')
await check('size tiers', () => {
  assert.match(classify(5 * 1024).tier, /small/)
  assert.match(classify(500 * 1024).tier, /normal/)
  assert.match(classify(5 * 1024 * 1024).tier, /large/)
  assert.match(classify(50 * 1024 * 1024).tier, /huge/)
})

console.log('\nscanStructure')
const basic = fixture('basic.md', '# One\n\ntext\n\n## Two\n\ntext\n\n### Three\n\ntext\n')
await check('counts headings and levels', async () => {
  const scan = await scanStructure(basic)
  assert.equal(scan.headings.length, 3)
  assert.deepEqual(scan.headings.map((h) => h.level), [1, 2, 3])
  assert.equal(scan.lines, 11)
})

await check('computes section line ranges', async () => {
  const scan = await scanStructure(basic)
  assert.equal(scan.headings[0].line, 1)
  assert.equal(scan.headings[0].endLine, 11)
  assert.equal(scan.headings[1].line, 5)
  assert.equal(scan.headings[1].endLine, 11)
  assert.equal(scan.headings[2].line, 9)
  assert.equal(scan.headings[2].endLine, 11)
})

const fenced = fixture(
  'fenced.md',
  ['# Real', '', '```js', '# Not a heading', '```', '', '## Also real', '', '~~~~', '# hidden', '~~~~', ''].join('\n'),
)
await check('excludes headings inside fences', async () => {
  const scan = await scanStructure(fenced)
  assert.equal(scan.headings.length, 2)
  assert.equal(scan.headingsInsideFence, 2)
  assert.deepEqual(scan.headings.map((h) => h.title), ['Real', 'Also real'])
})

const nested = fixture('nested.md', ['````md', '```js', '# hidden', '```', '````', '', '# Shown', ''].join('\n'))
await check('honours longer outer fences', async () => {
  const scan = await scanStructure(nested)
  assert.equal(scan.headings.length, 1)
  assert.equal(scan.headings[0].title, 'Shown')
})

const unclosed = fixture('unclosed.md', ['# A', '', '```', '# swallowed', 'more', ''].join('\n'))
await check('reports an unterminated fence', async () => {
  const scan = await scanStructure(unclosed)
  assert.equal(scan.headings.length, 1)
  assert.ok(scan.unterminatedFence)
  assert.equal(scan.unterminatedFence.line, 3)
  assert.equal(scan.headingsInsideFence, 1)
})

await check('does not treat indented code as a fence', async () => {
  const file = fixture('indented.md', ['    # four-space line', '', '# Real', ''].join('\n'))
  const scan = await scanStructure(file)
  assert.equal(scan.headings.length, 1)
  assert.equal(scan.headings[0].title, 'Real')
})

console.log('\nencoding')
await check('detects UTF-8 BOM', async () => {
  const file = path.join(tmp, 'bom.md')
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Bom\n', 'utf8')]))
  const scan = await scanStructure(file)
  assert.equal(scan.encoding, 'utf-8-bom')
  assert.equal(scan.headings[0].title, 'Bom')
})

await check('decodes GBK Chinese', async () => {
  // A realistic-length sample: six characters are enough for the byte
  // structure to identify GBK, but three characters are genuinely ambiguous
  // with EUC-KR, which the next check covers.
  const gbk = Buffer.from([
    0x23, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0xb1, 0xea, 0xcc, 0xe2, 0x0a, // "# 中文标题\n"
    0xd5, 0xe2, 0xca, 0xc7, 0xd2, 0xbb, 0xb6, 0xce, 0xd5, 0xfd, 0xce, 0xc4, 0x0a, // "这是一段正文\n"
  ])
  const file = path.join(tmp, 'gbk.md')
  fs.writeFileSync(file, gbk)
  const scan = await scanStructure(file)
  assert.equal(scan.encoding, 'gbk')
  assert.equal(scan.headings[0].title, '中文标题')
})

await check('reports uncertainty instead of guessing on ambiguous bytes', async () => {
  // Three Han characters in GBK are also valid EUC-KR byte pairs. Reporting a
  // definite answer here would be a lie, so the confidence must be low.
  const tiny = Buffer.from([0x23, 0x20, 0xc4, 0xe3, 0xba, 0xc3, 0x0a])
  const file = path.join(tmp, 'ambiguous.md')
  fs.writeFileSync(file, tiny)
  const scan = await scanStructure(file)
  assert.equal(scan.encodingConfidence, 'uncertain', `reported ${scan.encodingConfidence}`)
  const text = renderOutline(scan, { depth: 2 })
  assert.match(text, /encoding was guessed/)
})

await check('rejects binary files', async () => {
  const file = path.join(tmp, 'bin.dat')
  fs.writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0x41]))
  await assert.rejects(scanStructure(file), /binary/i)
})

console.log('\nfoldHeadings')
const repeats = fixture(
  'repeats.md',
  ['# Top', '', ...Array.from({ length: 6 }, (_, i) => `## 🤖 AI #${i + 1}\n\nbody\n`), '## Unique\n\nbody\n'].join('\n'),
)
await check('folds repeats above threshold', async () => {
  const scan = await scanStructure(repeats)
  const { entries, foldedCount, foldedGroups } = foldHeadings(scan.headings, 2)
  assert.equal(foldedGroups, 1)
  assert.equal(foldedCount, 6)
  assert.equal(entries.length, 3)
  const folded = entries.find((e) => e.folded)
  assert.match(folded.text, /🤖 AI ×6/)
  assert.match(folded.text, /lines \d+–\d+/)
  assert.match(folded.text, /median \d+ lines each/)
})

await check('keeps small repeat groups', async () => {
  const file = fixture('smallrepeat.md', ['# A', '', '## Dup', '', '## Dup', '', '## Dup', ''].join('\n'))
  const scan = await scanStructure(file)
  const { entries } = foldHeadings(scan.headings, 2)
  assert.equal(entries.length, 4)
  assert.ok(entries.every((e) => !e.folded))
})

console.log('\nrenderOutline')
await check('stays inside the output ceiling', async () => {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  const many = Array.from({ length: 400 }, (_, i) => {
    const name = `${letters[i % 26]}${letters[Math.floor(i / 26) % 26]}-${letters[(i * 7) % 26]}`
    return `## Chapter ${name}\n\nbody\n`
  }).join('\n')
  const file = fixture('many.md', `# Root\n\n${many}`)
  const scan = await scanStructure(file)
  const text = renderOutline(scan, { depth: 2, maxItems: 500 })
  assert.ok(text.length <= OUTPUT_LIMIT, `length ${text.length} exceeds ${OUTPUT_LIMIT}`)
  assert.match(text, /truncated/)
})

await check('states omitted entries', async () => {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  const many = Array.from({ length: 40 }, (_, i) => {
    const name = `${letters[i % 26]}${letters[Math.floor(i / 26) % 26]}-${letters[(i * 3) % 26]}`
    return `## Topic ${name}\n\nbody\n`
  }).join('\n')
  const file = fixture('omit.md', `# Root\n\n${many}`)
  const scan = await scanStructure(file)
  const text = renderOutline(scan, { depth: 2, maxItems: 5 })
  assert.match(text, /36 more entries omitted/)
})

await check('numbered series stays visible after folding', async () => {
  const series = Array.from({ length: 30 }, (_, i) => `## Phase ${i + 1}\n\nbody\n`).join('\n')
  const file = fixture('series.md', `# Root\n\n${series}`)
  const scan = await scanStructure(file)
  const text = renderOutline(scan, { depth: 2 })
  assert.match(text, /Phase ×30/)
  assert.match(text, /Phase 1 … Phase 30/)
})

await check('says so when there are no headings', async () => {
  const file = fixture('plain.txt', 'just text\nno structure\n')
  const scan = await scanStructure(file)
  const text = renderOutline(scan, { depth: 2 })
  assert.match(text, /No Markdown headings/)
})

await check('is byte-identical across runs', async () => {
  const scanA = await scanStructure(basic)
  const scanB = await scanStructure(basic)
  const a = renderOutline(scanA, { depth: 2, maxItems: 100 })
  const b = renderOutline(scanB, { depth: 2, maxItems: 100 })
  assert.equal(a, b)
})

console.log('\npath confinement')
await check('rejects escapes', () => {
  assert.throws(() => resolveInside('D:/ws', '../etc/passwd'), /outside the workspace/)
  assert.throws(() => resolveInside('D:/ws', 'D:/other/file.md'), /outside the workspace/)
})
await check('accepts inside paths', () => {
  const inside = resolveInside('D:/ws', 'sub/file.md')
  assert.ok(inside.replace(/\\/g, '/').toLowerCase().startsWith('d:/ws/'))
})

console.log('\ntoken estimate')
await check('never prices CJK below the flat heuristic', () => {
  const cjk = '这是一段中文文本'.repeat(50)
  const flat = cjk.length / 4
  assert.ok(estimateTokens(cjk) >= flat)
  assert.equal(estimateTokens('abcd'), 1)
})

if (process.argv.includes('--real')) {
  const real = 'D:/MR/_归档/对话存档/_WorkBuddy对话B-设置MR项目UI设计工作流.md'
  console.log('\nreal 14 MB sample')
  await check('scans the huge file deterministically and within budget', async () => {
    const t0 = Date.now()
    const scan = await scanStructure(real)
    const ms = Date.now() - t0
    assert.equal(scan.lines, 165359)
    assert.equal(scan.headings.length, 5276)
    const text = renderOutline(scan, { depth: 2, maxItems: 100 })
    assert.ok(text.length <= OUTPUT_LIMIT)
    const again = renderOutline(await scanStructure(real), { depth: 2, maxItems: 100 })
    assert.equal(text, again)
    assert.match(text, /huge/)
    console.log(`       scanned in ${ms} ms, rendered ${text.length} chars, ${scan.headingsInsideFence} fence-hidden`)
  })
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
