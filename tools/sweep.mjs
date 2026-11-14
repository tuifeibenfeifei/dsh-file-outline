/**
 * Broad-coverage sweep: every file type, every edge case.
 *
 * Each case declares what the engine MUST do — parse structure, or refuse with a
 * specific code. A refusal is a pass when it is the designed behaviour, so this
 * suite checks honesty at the boundaries, not just happy paths.
 *
 * Run: node tools/sweep.mjs [--real]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanStructure, classify, foldKey } from '../lib/engine.js'
import { renderOutline } from '../lib/render.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, '..', 'fixtures')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outline-sweep-'))

let pass = 0
let fail = 0
const rows = []

/**
 * Write a generated fixture.
 * @param {string} name file name
 * @param {string|Buffer} body contents
 * @returns {string} absolute path
 */
function put(name, body) {
  const file = path.join(tmp, name)
  fs.writeFileSync(file, body)
  return file
}

/**
 * Run one case, recording a table row.
 * @param {string} label short case name
 * @param {string} kind expected category
 * @param {string} file file under test
 * @param {(result: object) => void} assert expectations for a successful scan
 * @param {RegExp} [expectError] when set, the scan must fail with this message
 */
async function run(label, kind, file, assert, expectError) {
  const started = Date.now()
  let detail = ''
  let ok = true
  try {
    const scan = await scanStructure(file)
    const ms = Date.now() - started
    if (expectError) {
      ok = false
      detail = `expected refusal ${expectError}, but scanned ${scan.headings.length} headings`
    } else {
      assert(scan)
      const text = renderOutline(scan, { depth: 3, maxItems: 200 })
      detail = `${scan.headings.length} headings · ${scan.encoding} · ${text.length} chars · ${ms} ms`
    }
  } catch (error) {
    const ms = Date.now() - started
    if (expectError && expectError.test(error.message)) {
      detail = `refused as designed · ${ms} ms`
    } else {
      ok = false
      detail = `UNEXPECTED: ${error.message}`
    }
  }
  if (ok) pass += 1
  else fail += 1
  rows.push({ label, kind, ok, detail })
}

const noop = () => {}

console.log('text formats')

await run('markdown, nested', 'md', put('a.md', '# A\n\n## A1\n\n### A1a\n\ntext\n\n## A2\n'), (s) => {
  if (s.headings.length !== 4) throw new Error(`expected 4 headings, got ${s.headings.length}`)
})
await run('plain text, no headings', 'txt', put('b.txt', 'first line\nsecond line\n'), (s) => {
  if (s.headings.length !== 0) throw new Error('should have no headings')
})
await run('log file with bracket prefixes', 'log', put('c.log', '[INFO] start\n[ERROR] boom\n[INFO] end\n'), (s) => {
  if (s.headings.length !== 0) throw new Error('logs have no headings')
})
await run('csv data', 'csv', put('d.csv', 'id,name\n1,a\n2,b\n'), noop)
await run('json data', 'json', put('e.json', '{\n"a": 1\n}\n'), noop)
await run('yaml config', 'yml', put('f.yml', 'key: value\nlist:\n  - a\n'), noop)
await run('javascript source', 'js', put('g.js', "// comment\nconst a = 1\n/* block */\n"), noop)
await run('python source', 'py', put('h.py', '"""Docstring."""\n\n# comment\nx = 1\n'), noop)
await run('html document', 'html', put('i.html', '<html>\n<body>\n<h1>Title</h1>\n</body>\n</html>\n'), noop)
await run('typescript source', 'ts', put('j.ts', 'export const x: number = 1\n'), noop)
await run('empty file', 'empty', put('k.md', ''), (s) => {
  if (s.lines !== 0) throw new Error(`expected 0 lines, got ${s.lines}`)
})
await run('single line, no newline', 'tiny', put('l.md', '# only'), (s) => {
  if (s.headings.length !== 1) throw new Error('expected one heading')
  if (s.lines !== 1) throw new Error(`expected 1 line, got ${s.lines}`)
})

console.log('markdown edge cases')

await run('fence hides heading', 'md', put('m.md', '# Real\n```\n# fake\n```\n'), (s) => {
  if (s.headings.length !== 1) throw new Error(`expected 1, got ${s.headings.length}`)
  if (s.headingsInsideFence !== 1) throw new Error('should count the hidden one')
})
await run('all content inside fence', 'md', put('n.md', '```\n# a\n# b\n```\n'), (s) => {
  if (s.headings.length !== 0) throw new Error('nothing outside the fence')
})
await run('unterminated fence', 'md', put('o.md', '# A\n\n```\n# swallowed\n'), (s) => {
  if (!s.unterminatedFence) throw new Error('should report the open fence')
  if (s.headings.length !== 1) throw new Error('only the pre-fence heading')
})
await run('tilde fence', 'md', put('p.md', '# A\n~~~\n# hidden\n~~~\n'), (s) => {
  if (s.headings.length !== 1) throw new Error('tilde fence must hide')
})
await run('deep nesting', 'md', put('q.md', '# 1\n## 2\n### 3\n#### 4\n##### 5\n###### 6\n'), (s) => {
  if (s.headings.length !== 6) throw new Error('six levels')
})
await run('heading with trailing hashes', 'md', put('r.md', '## Title ##\n'), (s) => {
  if (s.headings[0].title !== 'Title') throw new Error(`got "${s.headings[0].title}"`)
})
await run('heading without space is not a heading', 'md', put('s.md', '#NotAHeading\n'), (s) => {
  if (s.headings.length !== 0) throw new Error('needs a space after #')
})
await run('CRLF line endings', 'md', put('t.md', '# A\r\n\r\ntext\r\n## B\r\n'), (s) => {
  if (s.headings.length !== 2) throw new Error('CRLF must not break parsing')
})
await run('mixed line endings', 'md', path.join(fixtures, 'mixed-eol.md'), (s) => {
  if (s.headings.length !== 2) throw new Error(`expected 2, got ${s.headings.length}`)
})
await run('UTF-8 BOM', 'md', path.join(fixtures, 'bom-utf8.md'), (s) => {
  if (s.encoding !== 'utf-8-bom') throw new Error(`encoding ${s.encoding}`)
  if (s.headings[0].title !== 'BOM heading') throw new Error('BOM must not leak into the title')
})
await run('extremely long single line', 'md', put('u.md', `# ${'x'.repeat(200000)}\n`), (s) => {
  if (s.headings.length !== 1) throw new Error('long line must still parse')
})
await run('many blank lines', 'md', put('v.md', '\n'.repeat(5000) + '# Late\n'), (s) => {
  if (s.headings[0].line !== 5001) throw new Error(`line ${s.headings[0].line}`)
})
await run('1000 repeated headings', 'md', put('w.md', Array.from({ length: 1000 }, (_, i) => `## 🔁 Same #${i + 1}\n`).join('')), (s) => {
  if (s.headings.length !== 1000) throw new Error('all captured')
  const text = renderOutline(s, { depth: 2, maxItems: 100 })
  if (!/🔁 Same ×1000/.test(text)) throw new Error('fold must show ×1000')
  if (text.length > 8000) throw new Error(`output ${text.length} exceeds limit`)
})

console.log('encodings')

await run('GB18030 Chinese', 'txt', path.join(fixtures, 'cjk-gb18030.txt'), (s) => {
  if (s.headings[0].title !== '国标标题') throw new Error(`got "${s.headings[0].title}"`)
})
await run('Big5 Chinese', 'txt', path.join(fixtures, 'cjk-big5.txt'), (s) => {
  if (s.encoding !== 'big5') throw new Error(`detected ${s.encoding}, expected big5`)
  if (s.headings[0].title !== '繁體標題') throw new Error(`got "${s.headings[0].title}"`)
})
await run('UTF-16LE Chinese', 'txt', path.join(fixtures, 'cjk-utf16le.txt'), (s) => {
  if (!s.encoding.startsWith('utf-16')) throw new Error(`detected ${s.encoding}`)
  if (s.headings.length !== 1) throw new Error(`expected 1 heading, got ${s.headings.length}`)
  if (s.headings[0].title !== 'UTF-16 标题') throw new Error(`got "${s.headings[0].title}"`)
})

console.log('binary and rich documents (must refuse)')

for (const [label, name] of [
  ['Word document', 'sample.docx'],
  ['Excel workbook', 'sample.xlsx'],
  ['PowerPoint deck', 'sample.pptx'],
  ['PDF document', 'sample.pdf'],
  ['zip archive', 'sample.zip'],
  ['PNG image', 'sample.png'],
]) {
  await run(label, path.extname(name).slice(1), path.join(fixtures, name), noop, /not text/i)
}

await run('NUL bytes mid-file', 'bin', put('x.bin', Buffer.from([0x41, 0x42, 0x00, 0x43])), noop, /not text/i)

console.log('real workspace files')

const realRoot = 'D:/MR'
const realFiles = [
  ['D:/MR/.dsh-tree/UI设计/summary.md', 'md'],
  ['D:/MR/.dsh-tree/_raw/an-019-021.txt', 'txt'],
  ['D:/MR/Unity/MR/Logs/Packages-Update.log', 'log'],
  ['D:/MR/src/data/base/enemies.json', 'json'],
  ['D:/MR/.dsh-tree/_build_tree.js', 'js'],
  ['D:/MR/audit-body-ready.py', 'py'],
  ['D:/MR/_UI迭代/assets/board_template.html', 'html'],
  ['D:/MR/_AI交接/09-铁律总纲与操作自查.md', 'md'],
  ['D:/MR/设计-S6-内容系统.md', 'md'],
  ['D:/MR/UI设计标准.md', 'md'],
  ['D:/MR/AGENTS.md', 'md'],
  ['D:/MR/README.md', 'md'],
]
for (const [file, kind] of realFiles) {
  if (!fs.existsSync(file)) continue
  await run(path.basename(file), kind, file, noop)
}

if (process.argv.includes('--real')) {
  console.log('huge real files')
  for (const file of [
    'D:/MR/_归档/对话存档/_WorkBuddy对话B-设置MR项目UI设计工作流.md',
    'D:/MR/_归档/对话存档/_WorkBuddy对话A-继续之前的话题.md',
  ]) {
    if (!fs.existsSync(file)) continue
    await run(path.basename(file).slice(0, 28), 'md-huge', file, (s) => {
      if (s.headings.length < 4000) throw new Error(`only ${s.headings.length} headings`)
      const text = renderOutline(s, { depth: 2, maxItems: 100 })
      if (text.length > 8000) throw new Error(`output ${text.length} exceeds limit`)
    })
  }
}

fs.rmSync(tmp, { recursive: true, force: true })

const width = Math.max(...rows.map((r) => r.label.length))
console.log(`\n${'case'.padEnd(width)}  kind      result  detail`)
console.log('-'.repeat(width + 50))
for (const row of rows) {
  console.log(`${row.label.padEnd(width)}  ${row.kind.padEnd(8)}  ${(row.ok ? 'PASS' : 'FAIL').padEnd(6)}  ${row.detail}`)
}
console.log(`\n${pass} passed, ${fail} failed, ${rows.length} cases`)
process.exit(fail === 0 ? 0 : 1)
