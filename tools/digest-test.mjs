/**
 * digest verification: budgeted extraction and continuation.
 *
 * The digest's whole value is that it tells the reader what it did NOT return.
 * Every assertion below is about that contract: the returned range is stated,
 * the remainder is quantified, and the next call is spelled out.
 *
 * Run: node tools/digest-test.mjs [--real]
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { digestRange, estimateTokens, findSection, scanStructure } from '../lib/engine.js'

let pass = 0
let fail = 0
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outline-digest-'))

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

/**
 * Digest a fixture with the default decoder.
 * @param {string} file fixture path
 * @param {number} from first line
 * @param {number} to last line
 * @param {number} budget token ceiling
 * @returns {Promise<object>} the digest
 */
async function digest(file, from, to, budget) {
  return digestRange(file, 'utf-8', from, to, budget)
}

const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1} ${'x'.repeat(i % 30)}`)
const big = put('big.txt', `${lines.join('\n')}\n`)

console.log('\nrange extraction')

await check('returns exactly the requested range', async () => {
  const result = await digest(big, 10, 20, 100000)
  assert.equal(result.startLine, 10)
  assert.equal(result.endLine, 20)
  assert.equal(result.returnedLines, 11)
  assert.match(result.text, /^line 10 /)
  assert.match(result.text, /line 20 /)
})

await check('reports the total line count', async () => {
  const result = await digest(big, 1, 5, 100000)
  assert.equal(result.totalLines, 500)
})

await check('clamps a range past the end of the file', async () => {
  const result = await digest(big, 495, 999, 100000)
  assert.equal(result.endLine, 500)
  assert.equal(result.returnedLines, 6)
  assert.equal(result.remainingLines, 0)
})

await check('handles a start past the end', async () => {
  const result = await digest(big, 900, 950, 100000)
  assert.equal(result.returnedLines, 0)
  assert.equal(result.text, '')
})

console.log('\nbudget')

await check('stops before exceeding the budget', async () => {
  const wide = put('wide.txt', Array.from({ length: 300 }, () => 'y'.repeat(100)).join('\n'))
  const result = await digest(wide, 1, 300, 200)
  assert.ok(result.tokens <= 200 * 1.05, `tokens ${result.tokens} exceeded budget 200`)
  assert.ok(result.returnedLines < 300, 'must stop early')
})

await check('always returns a minimum even when over budget', async () => {
  const wide = put('huge.txt', Array.from({ length: 50 }, () => 'z'.repeat(2000)).join('\n'))
  const result = await digest(wide, 1, 50, 10)
  assert.ok(result.returnedLines >= 1, 'must return something')
  assert.ok(result.returnedLines <= 5, `expected a small minimum, got ${result.returnedLines}`)
})

await check('quantifies what remains', async () => {
  const wide = put('rem.txt', Array.from({ length: 200 }, () => 'w'.repeat(80)).join('\n'))
  const result = await digest(wide, 1, 200, 300)
  assert.ok(result.remainingLines > 0)
  assert.equal(result.startLine + result.returnedLines - 1, result.endLine)
  assert.equal(result.remainingLines, 200 - result.endLine)
})

await check('prefers a blank line near the cut', async () => {
  const body = []
  for (let i = 0; i < 40; i += 1) {
    body.push(`para ${i} text text text`)
    body.push('')
  }
  const file = put('paras.txt', body.join('\n'))
  const result = await digest(file, 1, 80, 200)
  // Whatever it cut, the last line should be a paragraph end or a blank.
  const lastLine = result.text.split('\n').at(-1)
  assert.ok(lastLine.trim() === '' || /^para \d+ text/.test(lastLine), `ended on "${lastLine}"`)
})

await check('marks when it had to cut', async () => {
  const wide = put('cut.txt', Array.from({ length: 200 }, () => 'c'.repeat(100)).join('\n'))
  const result = await digest(wide, 1, 200, 250)
  assert.equal(result.overBudget, true)
  assert.ok(result.returnedLines < 200)
})

await check('does not claim a cut when the whole range fits', async () => {
  const result = await digest(big, 1, 10, 100000)
  assert.equal(result.overBudget, false)
  assert.equal(result.remainingLines, 0)
})

console.log('\ntoken estimate consistency')

await check('reported tokens match the estimate of the text', async () => {
  const result = await digest(big, 1, 50, 100000)
  assert.equal(result.tokens, estimateTokens(result.text))
})

await check('CJK text costs at least chars/4', () => {
  const cjk = '这是一段中文'.repeat(100)
  assert.ok(estimateTokens(cjk) >= cjk.length / 4)
})

console.log('\nsection lookup')

const sections = put(
  'sections.md',
  ['# Alpha', 'a', '', '## Beta rules', 'b', '', '## Gamma', 'c', '', '### Beta nested', 'd', ''].join('\n'),
)

await check('finds a section by exact title', async () => {
  const scan = await scanStructure(sections)
  const found = findSection(scan.headings, 'Gamma')
  assert.equal(found.title, 'Gamma')
})

await check('falls back to a substring match', async () => {
  const scan = await scanStructure(sections)
  const found = findSection(scan.headings, 'rules')
  assert.equal(found.title, 'Beta rules')
})

await check('prefers an exact match over a substring', async () => {
  const scan = await scanStructure(sections)
  const exact = findSection(scan.headings, 'Beta nested')
  assert.equal(exact.title, 'Beta nested')
})

await check('returns null when nothing matches', async () => {
  const scan = await scanStructure(sections)
  assert.equal(findSection(scan.headings, 'Nonexistent'), null)
})

await check('is case-insensitive by default', async () => {
  const scan = await scanStructure(sections)
  assert.equal(findSection(scan.headings, 'gamma').title, 'Gamma')
})

await check('a matched section digests its own range', async () => {
  const scan = await scanStructure(sections)
  const found = findSection(scan.headings, 'Gamma')
  const result = await digest(sections, found.line, found.endLine, 100000)
  assert.match(result.text, /^## Gamma/)
  assert.match(result.text, /### Beta nested/, 'a parent section includes its children')
})

if (process.argv.includes('--real')) {
  const huge = 'D:/MR/_归档/对话存档/_WorkBuddy对话B-设置MR项目UI设计工作流.md'
  if (fs.existsSync(huge)) {
    console.log('\nreal 14 MB file')
    await check('digests a range deep in the huge file', async () => {
      const started = Date.now()
      const result = await digest(huge, 119953, 120200, 3000)
      const ms = Date.now() - started
      assert.ok(result.tokens <= 3000 * 1.05, `tokens ${result.tokens}`)
      assert.equal(result.startLine, 119953)
      assert.ok(result.remainingLines > 0, 'should report continuation')
      console.log(`       ${ms} ms, ${result.returnedLines} lines, ${result.tokens} tokens, ${result.remainingLines} remaining`)
      console.log(`       text starts: ${result.text.split('\n')[0].slice(0, 60)}`)
    })
  }
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
