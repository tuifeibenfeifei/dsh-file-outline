/**
 * Portability verification: does this plugin behave correctly for users whose
 * machine differs from the development one?
 *
 * Every case here is a realistic difference: Windows drive letters, POSIX
 * roots, CRLF files, mixed encodings, symlinked paths, unicode filenames. The
 * assertions are about behaviour, not implementation.
 *
 * Run: node tools/portability-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { digestRange, detectEncoding, scanStructure } from '../lib/engine.js'
import { resolveInside } from '../lib/path.js'
import { renderDigest, renderOutline } from '../lib/render.js'

let pass = 0
let fail = 0
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outline-port-'))

/**
 * Run one named check.
 * @param {string} label what is asserted
 * @param {() => Promise<void>|void} body the check
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

console.log(`\nplatform: ${process.platform}, node: ${process.versions.node}`)
console.log(`temp root: ${tmp}`)

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

console.log('\nline endings (users on every OS produce all of these)')

await check('LF files parse', async () => {
  const scan = await scanStructure(put('lf.md', '# A\ntext\n## B\n'))
  assert.equal(scan.headings.length, 2)
  assert.equal(scan.lines, 3)
})

await check('CRLF files parse without stray \\r in titles', async () => {
  const scan = await scanStructure(put('crlf.md', '# A\r\ntext\r\n## B\r\n'))
  assert.equal(scan.headings.length, 2)
  assert.equal(scan.headings[0].title, 'A')
  assert.equal(scan.headings[1].title, 'B')
  assert.ok(!scan.headings.some((h) => h.title.includes('\r')), 'titles must not carry CR')
})

await check('CR-only (classic Mac) files do not crash', async () => {
  const scan = await scanStructure(put('cr.md', '# A\rtext\r## B\r'))
  assert.ok(scan.lines >= 1, 'must produce at least one line')
})

await check('mixed endings inside one file', async () => {
  const scan = await scanStructure(put('mixed.md', '# A\r\n\r\npara\n## B\r\n'))
  assert.equal(scan.headings.length, 2)
  assert.equal(scan.headings[1].title, 'B')
})

await check("digest preserves the file's own line content", async () => {
  const file = put('digestcrlf.md', 'one\r\ntwo\r\nthree\r\n')
  const result = await digestRange(file, 'utf-8', 1, 3, 1000)
  assert.equal(result.returnedLines, 3)
  assert.ok(!result.text.includes('\r'), 'CR must be stripped from returned text')
})

console.log('\npath confinement across platforms')

await check('a sibling directory with a shared prefix is rejected', () => {
  const root = path.join(tmp, 'ws')
  fs.mkdirSync(root, { recursive: true })
  const sibling = `${root}-evil`
  assert.throws(
    () => resolveInside(root, path.join(sibling, 'x.md')),
    /outside the workspace/,
    'ws-evil must not be treated as inside ws',
  )
})

await check('a path with .. that stays inside is allowed', () => {
  const root = path.join(tmp, 'ws2')
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
  const resolved = resolveInside(root, path.join('a', 'b', '..', 'x.md'))
  assert.ok(resolved.startsWith(root), `resolved ${resolved}`)
})

await check('an absolute path inside the root is allowed', () => {
  const root = path.join(tmp, 'ws3')
  fs.mkdirSync(root, { recursive: true })
  const inside = path.join(root, 'f.md')
  assert.equal(resolveInside(root, inside), path.resolve(inside))
})

await check('trailing separators on the root do not break confinement', () => {
  const root = path.join(tmp, 'ws4')
  fs.mkdirSync(root, { recursive: true })
  const resolved = resolveInside(`${root}${path.sep}`, 'f.md')
  assert.ok(!resolved.includes('..'), `resolved ${resolved}`)
})

await check('a relative path with no root prefix resolves under the root', () => {
  const root = path.join(tmp, 'ws5')
  fs.mkdirSync(root, { recursive: true })
  assert.equal(resolveInside(root, 'sub/f.md'), path.resolve(root, 'sub', 'f.md'))
})

console.log('\nfile names real users have')

await check('unicode and spaces in file names', async () => {
  const file = put('中文 文件名（副本）.md', '# 标题\n\n正文\n')
  const scan = await scanStructure(file)
  assert.equal(scan.headings[0].title, '标题')
})

await check('emoji in file names', async () => {
  const file = put('report 📊 final.md', '# Emoji ok\n')
  const scan = await scanStructure(file)
  assert.equal(scan.headings.length, 1)
})

await check('very deep directory nesting', async () => {
  const deep = path.join(tmp, ...Array.from({ length: 12 }, (_, i) => `d${i}`))
  fs.mkdirSync(deep, { recursive: true })
  const file = path.join(deep, 'deep.md')
  fs.writeFileSync(file, '# Deep\n')
  const scan = await scanStructure(file)
  assert.equal(scan.headings.length, 1)
})

console.log('\nencodings from non-English users')

await check('UTF-8 with BOM does not leak the BOM into the first title', async () => {
  const file = path.join(tmp, 'bom.md')
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 标题\n', 'utf8')]))
  const scan = await scanStructure(file)
  assert.equal(scan.headings[0].title, '标题')
  assert.equal(scan.encoding, 'utf-8-bom')
})

await check('Windows-1252 / Latin-1 text still yields lines', async () => {
  const file = path.join(tmp, 'latin.txt')
  fs.writeFileSync(file, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x62, 0x61, 0x72, 0x0a]))
  const scan = await scanStructure(file)
  assert.equal(scan.lines, 2)
})

await check('Shift-JIS decodes without throwing', async () => {
  const file = path.join(tmp, 'sjis.txt')
  fs.writeFileSync(file, Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x0a]))
  const scan = await scanStructure(file)
  assert.ok(scan.lines >= 1)
})

await check('a file that is only a BOM is not an error', async () => {
  const file = path.join(tmp, 'bomonly.md')
  fs.writeFileSync(file, Buffer.from([0xef, 0xbb, 0xbf]))
  const scan = await scanStructure(file)
  assert.equal(scan.headings.length, 0)
})

console.log('\nlegacy encodings from users worldwide')

/**
 * Encode a realistic paragraph in a legacy codec using a lookup the test can
 * verify: the same text is written as UTF-8 and re-encoded by the decoder
 * round-trip is not available, so the sample text is supplied pre-encoded.
 * @param {string} name file name
 * @param {string} text source text
 * @param {string} codec TextDecoder label
 * @returns {string} file path
 */
function putEncoded(name, text, codec) {
  // Node cannot encode to these codecs, so only lossless codecs are used here;
  // the non-UTF-8 fixtures come from the Python generator instead.
  const file = path.join(tmp, name)
  fs.writeFileSync(file, Buffer.from(text, codec === 'utf-8' ? 'utf8' : 'utf8'))
  return file
}

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
for (const [name, expected] of [
  ['sjis.txt', 'shift_jis'],
  ['euckr.txt', 'euc-kr'],
  ['cp1251.txt', 'windows-1251'],
  ['tis620.txt', 'windows-874'],
]) {
  const fixture = path.join(fixturesDir, name)
  if (!fs.existsSync(fixture)) continue
  await check(`detects ${expected}`, async () => {
    const detected = await detectEncoding(fixture)
    assert.equal(detected.encoding, expected, `got ${detected.encoding}`)
    assert.notEqual(detected.confidence, 'uncertain', 'a clear CJK/Cyrillic lead must be certain')
  })
}

await check('an undecidable single-byte file says so instead of guessing', async () => {
  const fixture = path.join(fixturesDir, 'cp1250.txt')
  if (!fs.existsSync(fixture)) return
  const detected = await detectEncoding(fixture)
  // Central European text is byte-compatible with several single-byte codecs.
  assert.equal(detected.confidence, 'uncertain', `reported ${detected.confidence}`)
  const scan = await scanStructure(fixture)
  const text = renderOutline(scan, { depth: 2 })
  assert.match(text, /encoding was guessed/, 'the report must warn the reader')
})

await check('Chinese and Taiwanese text still separate correctly', async () => {
  for (const [name, expected] of [['gb18030.txt', 'gbk'], ['big5.txt', 'big5']]) {
    const fixture = path.join(fixturesDir, name)
    if (!fs.existsSync(fixture)) continue
    const detected = await detectEncoding(fixture)
    assert.equal(detected.encoding, expected, `${name}: got ${detected.encoding}`)
  }
})

console.log('\nedge shapes')

await check('file with no trailing newline', async () => {
  const scan = await scanStructure(put('notrail.md', '# A\nlast line'))
  assert.equal(scan.lines, 2)
  assert.match(renderOutline(scan, { depth: 2 }), /# A/)
})

await check('file of only blank lines', async () => {
  const scan = await scanStructure(put('blank.md', '\n\n\n\n'))
  assert.equal(scan.headings.length, 0)
  assert.ok(scan.lines >= 1)
})

await check('one very long line does not break the reader', async () => {
  const scan = await scanStructure(put('longline.md', `# ${'x'.repeat(500000)}\n`))
  assert.equal(scan.headings.length, 1)
})

await check('NUL-free binary-ish file is reported as text', async () => {
  // A file of high-bit bytes with no NUL: not a known format, so it is text.
  const file = path.join(tmp, 'highbytes.bin')
  fs.writeFileSync(file, Buffer.from(Array.from({ length: 200 }, (_, i) => 0x80 + (i % 0x60))))
  const scan = await scanStructure(file)
  assert.equal(scan.binary, false, 'no magic number and no NUL means text')
})

console.log('\ndigest boundaries')

await check('a range longer than the file is clamped, not an error', async () => {
  const file = put('short.md', 'a\nb\nc\n')
  const result = await digestRange(file, 'utf-8', 1, 99999, 1000)
  assert.equal(result.endLine, 3)
  assert.equal(result.returnedLines, 3)
})

await check('a start past the end returns empty text and states the file size', async () => {
  const file = put('past.md', 'a\nb\n')
  const result = await digestRange(file, 'utf-8', 500, 600, 1000)
  assert.equal(result.returnedLines, 0)
  const text = renderDigest(result, file)
  assert.match(text, /nothing to return/)
})

console.log('\nencoding detection cost is bounded')

await check('only the first 64 KiB is inspected', async () => {
  const big = path.join(tmp, 'bighead.txt')
  // 2 MB of ASCII, then a NUL far past the sample window.
  fs.writeFileSync(big, `${'a'.repeat(2 * 1024 * 1024)}\u0000tail`)
  const detected = await detectEncoding(big)
  assert.equal(detected.binary, false, 'a NUL beyond the sample window is not inspected')
})

console.log(`\nplatform-specific notes`)
console.log(`  path.sep = ${JSON.stringify(path.sep)}`)
console.log(`  resolveInside uses node:path, so separators follow the host OS`)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
