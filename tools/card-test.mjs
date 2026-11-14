/**
 * file_card verification: identity, structure, and the degraded path.
 *
 * The degraded path is the part most likely to rot silently, because it only
 * runs on files nobody writes tests for (logs, dumps, plain text). Every
 * assertion below is about what the card claims versus what the file holds.
 *
 * Run: node tools/card-test.mjs [--real]
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SAMPLE_LINE_WIDTH, classify, clipLine, collectCard } from '../lib/engine.js'
import { renderFileCard } from '../lib/render.js'

let pass = 0
let fail = 0
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outline-card-'))

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
 * @param {string|Buffer} body contents
 * @returns {string} absolute path
 */
function put(name, body) {
  const file = path.join(tmp, name)
  fs.writeFileSync(file, body)
  return file
}

console.log('\nidentity')

await check('reports size, lines and encoding', async () => {
  const file = put('doc.md', '# A\n\ntext\n\n## B\n\nmore\n')
  const card = await collectCard(file)
  assert.equal(card.lines, 7)
  assert.equal(card.encoding, 'utf-8')
  assert.ok(card.bytes > 0)
  assert.match(card.modified, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
})

await check('classifies the size tier', async () => {
  const file = put('small.md', '# A\n')
  const card = await collectCard(file)
  assert.match(classify(card.bytes).tier, /small/)
})

console.log('\nhead and tail samples')

await check('takes the requested number of lines', async () => {
  const body = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')
  const file = put('long.txt', body)
  const card = await collectCard(file, { headLines: 5, tailLines: 5 })
  assert.equal(card.head.length, 5)
  assert.equal(card.tail.length, 5)
  assert.equal(card.head[0].text, 'line 1')
  assert.equal(card.tail[4].text, 'line 200')
})

await check('clips a very long line to the width ceiling', async () => {
  const file = put('wide.md', `# ${'z'.repeat(5000)}\n`)
  const card = await collectCard(file)
  assert.ok(card.head[0].text.length <= SAMPLE_LINE_WIDTH, `got ${card.head[0].text.length}`)
  assert.ok(card.head[0].text.endsWith('…'), 'clipping must be visible')
})

await check('honours zero head and tail', async () => {
  const file = put('zero.md', '# A\n')
  const card = await collectCard(file, { headLines: 0, tailLines: 0 })
  assert.equal(card.head.length, 0)
  assert.equal(card.tail.length, 0)
})

await check('a file shorter than the tail keeps every line', async () => {
  const file = put('tiny.txt', 'a\nb\nc\n')
  const card = await collectCard(file, { headLines: 20, tailLines: 20 })
  assert.equal(card.head.length, 3)
  assert.equal(card.tail.length, 3)
  assert.equal(card.tail[0].n, 1)
})

console.log('\ndegraded path (no headings)')

await check('does not run when headings exist', async () => {
  const file = put('withheads.md', '# A\n\ntext\n')
  const card = await collectCard(file)
  assert.equal(card.degraded, null)
})

await check('lists paragraph openers by blank-line blocks', async () => {
  const body = ['first block opener', 'second line', '', 'second block opener', '', 'third opener'].join('\n')
  const file = put('paras.txt', body)
  const card = await collectCard(file)
  assert.ok(card.degraded, 'should degrade')
  assert.equal(card.degraded.paragraphs.length, 3)
  assert.equal(card.degraded.paragraphs[0].first, 'first block opener')
  assert.equal(card.degraded.paragraphs[1].first, 'second block opener')
})

await check('finds repeated log prefixes', async () => {
  const body = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? `[INFO] step ${i}` : `[ERROR] step ${i}`)).join('\n')
  const file = put('app.log', body)
  const card = await collectCard(file)
  const labels = card.degraded.prefixes.map((p) => p.text)
  assert.ok(labels.some((l) => l.includes('[INFO]')), `prefixes: ${JSON.stringify(labels)}`)
  assert.ok(labels.some((l) => l.includes('[ERROR]')), `prefixes: ${JSON.stringify(labels)}`)
})

await check('ignores prefixes inside code fences', async () => {
  const fenced = ['```', ...Array.from({ length: 60 }, () => '[INFO] inside fence'), '```', ''].join('\n')
  const file = put('fencedlog.txt', fenced)
  const card = await collectCard(file)
  assert.equal(card.degraded.prefixes.length, 0, 'fenced lines must not become "log patterns"')
})

await check('splits an enormous paragraph into windows', async () => {
  const body = Array.from({ length: 700 }, (_, i) => `line ${i}`).join('\n')
  const file = put('onepara.txt', body)
  const card = await collectCard(file)
  assert.ok(card.degraded.paragraphs.length >= 3, `expected windows, got ${card.degraded.paragraphs.length}`)
})

console.log('\nrendering')

await check('says the file has no headings and names the fallback', async () => {
  const file = put('flat.txt', 'alpha\n\nbeta\n')
  const card = await collectCard(file)
  const text = renderFileCard(card, {})
  assert.match(text, /no Markdown headings/)
  assert.match(text, /paragraph/i)
})

await check('shows a heading tree when there is one', async () => {
  const file = put('tree.md', '# Root\n\n## Child\n\n### Leaf\n')
  const card = await collectCard(file)
  const text = renderFileCard(card, { maxHeadings: 50, depth: 3 })
  assert.match(text, /Structure: 3 headings/)
  assert.match(text, /# Root/)
  assert.match(text, /### Leaf/)
})

await check('states omitted headings over the cap', async () => {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  const body = Array.from({ length: 50 }, (_, i) => `## T${letters[i % 26]}${letters[(i * 7) % 26]}x\n`).join('')
  const file = put('many.md', body)
  const card = await collectCard(file)
  const text = renderFileCard(card, { maxHeadings: 5, depth: 2 })
  assert.match(text, /more entries omitted/)
})

await check('stays inside the output ceiling', async () => {
  const body = Array.from({ length: 2000 }, (_, i) => `## Chapter ${'q'.repeat(i % 23)}${i}\n\nbody\n`).join('')
  const file = put('huge.md', body)
  const card = await collectCard(file, { headLines: 100, tailLines: 100 })
  const text = renderFileCard(card, { maxHeadings: 2000 })
  assert.ok(text.length <= 8000, `length ${text.length}`)
})

await check('is deterministic apart from the mtime', async () => {
  // mtime is part of the card by design; hold it fixed to compare the rest.
  const file = put('stable.md', '# A\n\ntext\n')
  const a = renderFileCard(await collectCard(file), {})
  const b = renderFileCard(await collectCard(file), {})
  const strip = (text) => text.replace(/modified \S+ \S+/, 'modified X')
  assert.equal(strip(a), strip(b))
})

await check('clipLine collapses tabs and marks shortening', () => {
  assert.equal(clipLine('a\tb'), 'a  b')
  assert.equal(clipLine('short'), 'short')
  assert.ok(clipLine('x'.repeat(500)).endsWith('…'))
})

console.log('\nsingle-pass behaviour')

await check('collectCard reads a structured file exactly once', async () => {
  const body = Array.from({ length: 400 }, (_, i) => (i % 20 === 0 ? `## H${i / 20}` : `line ${i}`)).join('\n')
  const file = put('onepass.md', `${body}\n`)
  let opens = 0
  const original = fs.createReadStream
  fs.createReadStream = (...args) => {
    opens += 1
    return original(...args)
  }
  try {
    await collectCard(file, { headLines: 5, tailLines: 5 })
  } finally {
    fs.createReadStream = original
  }
  assert.equal(opens, 1, `expected one pass, saw ${opens}`)
})

await check('a heading-less file may take a second pass for the fallback', async () => {
  const file = put('twopass.txt', Array.from({ length: 100 }, (_, i) => `para line ${i}`).join('\n'))
  let opens = 0
  const original = fs.createReadStream
  fs.createReadStream = (...args) => {
    opens += 1
    return original(...args)
  }
  try {
    await collectCard(file, { headLines: 5, tailLines: 5 })
  } finally {
    fs.createReadStream = original
  }
  // Structure+sample pass, plus the paragraph/prefix pass the degraded path needs.
  assert.ok(opens <= 2, `expected at most 2 passes, saw ${opens}`)
})

await check('single-pass samples equal the first and last lines', async () => {
  const body = Array.from({ length: 300 }, (_, i) => `row ${i + 1}`).join('\n')
  const file = put('edges.txt', `${body}\n`)
  const card = await collectCard(file, { headLines: 3, tailLines: 3 })
  assert.deepEqual(card.head, [
    { n: 1, text: 'row 1' },
    { n: 2, text: 'row 2' },
    { n: 3, text: 'row 3' },
  ])
  assert.deepEqual(card.tail, [
    { n: 298, text: 'row 298' },
    { n: 299, text: 'row 299' },
    { n: 300, text: 'row 300' },
  ])
})

if (process.argv.includes('--real')) {
  console.log('\nreal files')
  for (const [label, file] of [
    ['markdown', 'D:/MR/设计-S6-内容系统.md'],
    ['plain text', 'D:/MR/.dsh-tree/_raw/an-019-021.txt'],
    ['log', 'D:/MR/Unity/MR/Logs/Packages-Update.log'],
    ['json', 'D:/MR/src/data/base/enemies.json'],
    ['python', 'D:/MR/audit-body-ready.py'],
  ]) {
    if (!fs.existsSync(file)) continue
    await check(`cards a real ${label} file`, async () => {
      const card = await collectCard(file)
      const text = renderFileCard(card, {})
      assert.ok(text.length <= 8000)
      assert.match(text, /Size tier:/)
      console.log(`       ${path.basename(file)}: ${text.length} chars, headings=${card.headings.length}, degraded=${card.degraded !== null}`)
    })
  }

  const huge = 'D:/MR/_归档/对话存档/_WorkBuddy对话B-设置MR项目UI设计工作流.md'
  if (fs.existsSync(huge)) {
    await check('cards the 14 MB file within budget', async () => {
      const started = Date.now()
      const card = await collectCard(huge)
      const ms = Date.now() - started
      const text = renderFileCard(card, { maxHeadings: 40, depth: 2 })
      assert.ok(text.length <= 8000)
      assert.equal(card.headings.length, 5276)
      console.log(`       ${ms} ms, ${text.length} chars`)
    })
  }
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
