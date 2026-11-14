/**
 * Mode-B verification: keyword attribution by section.
 *
 * The heading stack is the easiest part of this plugin to get subtly wrong, so
 * every assertion here is about *ownership*: which section a hit belongs to, and
 * that density — not raw count — chooses the reading suggestion.
 *
 * Run: node tools/keyword-test.mjs [--real]
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compileMatcher, scanStructure } from '../lib/engine.js'
import { renderKeywordOutline } from '../lib/render.js'

let pass = 0
let fail = 0
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outline-kw-'))

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
 * Scan a file in keyword mode.
 * @param {string} file fixture path
 * @param {string} keyword search term
 * @param {object} [options] matcher options
 * @returns {Promise<object>} the scan
 */
async function scan(file, keyword, options = {}) {
  return scanStructure(file, { matcher: compileMatcher(keyword, options) })
}

console.log('\nattribution')

const nested = put(
  'nested.md',
  [
    '# Alpha',
    'color here', // owner: Alpha
    '',
    '## Beta',
    'color here', // owner: Beta
    'color here', // owner: Beta
    '',
    '### Gamma',
    'color here', // owner: Gamma
    '',
    '## Delta',
    'nothing', // no hit
    '',
    '# Epsilon',
    'color here', // owner: Epsilon
    '',
  ].join('\n'),
)

await check('attributes a hit to the innermost open heading', async () => {
  const result = await scan(nested, 'color')
  const byTitle = Object.fromEntries(result.headings.map((h) => [h.title, h.hits ?? 0]))
  assert.equal(byTitle.Alpha, 1)
  assert.equal(byTitle.Beta, 2)
  assert.equal(byTitle.Gamma, 1)
  assert.equal(byTitle.Delta, 0)
  assert.equal(byTitle.Epsilon, 1)
})

await check('a sibling heading closes the previous one', async () => {
  const result = await scan(nested, 'color')
  const beta = result.headings.find((h) => h.title === 'Beta')
  const delta = result.headings.find((h) => h.title === 'Delta')
  const gamma = result.headings.find((h) => h.title === 'Gamma')
  // Gamma is Beta's child, so Beta must contain it; Delta is a sibling and closes Beta.
  assert.ok(beta.line < gamma.line && gamma.line < beta.endLine, 'Gamma nests inside Beta')
  assert.equal(beta.endLine, delta.line - 1, 'Delta starts the line after Beta ends')
})

await check('text before any heading belongs to nobody', async () => {
  const file = put('preamble.md', ['color in the preamble', '', '# First', 'color under first', ''].join('\n'))
  const result = await scan(file, 'color')
  assert.equal(result.keywordHits, 2, 'both lines are counted in the file total')
  assert.equal(result.headings[0].hits, 1, 'only the second line has an owner')
})

console.log('\ncounting rules')

await check('counts a line once even with repeated matches', async () => {
  const file = put('dense.md', ['# A', 'color color color color color', ''].join('\n'))
  const result = await scan(file, 'color')
  assert.equal(result.keywordHits, 1, 'one line is one unit of evidence')
})

await check('does not count matches inside code fences', async () => {
  const file = put('fenced.md', ['# A', 'color outside', '', '```js', 'const color = 1', '```', ''].join('\n'))
  const result = await scan(file, 'color')
  assert.equal(result.keywordHits, 1)
  assert.equal(result.headings[0].hits, 1)
})

await check('respects case sensitivity when asked', async () => {
  const file = put('case.md', ['# A', 'Color', 'color', ''].join('\n'))
  const insensitive = await scan(file, 'color')
  assert.equal(insensitive.keywordHits, 2)
  const sensitive = await scan(file, 'color', { caseSensitive: true })
  assert.equal(sensitive.keywordHits, 1)
})

await check('matches literally when asked', async () => {
  const file = put('literal.md', ['# A', 'a.c', 'abc', ''].join('\n'))
  const regex = await scan(file, 'a.c')
  assert.equal(regex.keywordHits, 2, 'regex a.c matches both')
  const literal = await scan(file, 'a.c', { literal: true })
  assert.equal(literal.keywordHits, 1, 'literal a.c matches one')
})

await check('rejects an invalid regex with guidance', async () => {
  assert.throws(() => compileMatcher('([', {}), /valid regular expression/)
})

console.log('\nrendering')

const render = (result, options) => renderKeywordOutline(result, { keyword: 'color', ...options })

await check('lists only sections with hits', async () => {
  const result = await scan(nested, 'color')
  const text = render(result, {})
  assert.match(text, /Alpha/)
  assert.match(text, /Beta/)
  assert.doesNotMatch(text, /^# Delta/m)
})

await check('chooses the densest section, not the largest', async () => {
  // Big section: 1 hit in 400 lines. Small section: 8 hits in ~20 lines.
  const body = [
    '# Big',
    'color',
    ...Array.from({ length: 400 }, () => 'filler'),
    '',
    '## Small',
    ...Array.from({ length: 8 }, () => 'color'),
    ...Array.from({ length: 12 }, () => 'filler'),
    '',
  ].join('\n')
  const file = put('density.md', body)
  const result = await scan(file, 'color')
  const text = render(result, {})
  assert.match(text, /Densest single section \(not the global picture\): 「Small」/, 'density must beat raw count')
  assert.match(text, /digest\(path=\.\.\., lines="\d+–\d+"/)
})

await check('ignores tiny sections when suggesting', async () => {
  // A 6-line section with 2 hits is 33% dense but tells a reader nothing.
  const body = [
    '# Real',
    ...Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? 'color' : 'filler')),
    '',
    '## Stub',
    'color',
    'color',
    'filler',
    '',
  ].join('\n')
  const file = put('stub.md', body)
  const result = await scan(file, 'color')
  const text = render(result, {})
  assert.match(text, /Densest single section \(not the global picture\): 「Real」/, 'the 60-line section must win over a 4-line stub')
})

await check('states when nothing matches', async () => {
  const result = await scan(nested, 'nonexistentterm')
  const text = render(result, {})
  assert.match(text, /No line matched/)
})

await check('reports omitted sections when over the cap', async () => {
  const body = Array.from({ length: 30 }, (_, i) => `# S${i}\ntarget\n`).join('\n')
  const file = put('many.md', body)
  const result = await scan(file, 'target')
  const text = render(result, { maxItems: 5 })
  assert.match(text, /more matching sections omitted/)
})

await check('stays inside the output ceiling', async () => {
  const body = Array.from({ length: 500 }, (_, i) => `## Section ${i} ${'y'.repeat(i % 11)}\ntarget\n`).join('\n')
  const file = put('hugekw.md', body)
  const result = await scan(file, 'target')
  const text = render(result, { maxItems: 500 })
  assert.ok(text.length <= 8000, `length ${text.length}`)
})

await check('is deterministic', async () => {
  const a = render(await scan(nested, 'color'), {})
  const b = render(await scan(nested, 'color'), {})
  assert.equal(a, b)
})

if (process.argv.includes('--real')) {
  const real = 'D:/MR/_归档/对话存档/_WorkBuddy对话B-设置MR项目UI设计工作流.md'
  if (fs.existsSync(real)) {
    console.log('\nreal 14 MB file')
    await check('attributes a real keyword across 5,276 headings', async () => {
      const started = Date.now()
      const result = await scan(real, '配色')
      const ms = Date.now() - started
      const text = renderKeywordOutline(result, { keyword: '配色', maxItems: 15 })
      assert.ok(result.keywordHits > 0, 'should find the keyword')
      assert.ok(text.length <= 8000)
      assert.match(text, /Densest single section/)
      assert.match(text, /Global distribution/)
      console.log(`       ${result.keywordHits} hits in ${ms} ms (single pass)`)
      console.log(text.split('\n').slice(0, 8).map((l) => `       | ${l}`).join('\n'))
      console.log(text.split('\n').filter((l) => l.startsWith('Densest')).map((l) => `       | ${l}`).join('\n'))
    })
  }
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
