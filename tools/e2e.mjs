/**
 * End-to-end check of the registered tool: builds a real Cordis-like context,
 * lets `apply` register the definition, then executes it the way the Harness
 * would — including the failure paths.
 *
 * Run: node tools/e2e.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

let passed = 0
let failed = 0

/**
 * Run one named check.
 * @param {string} label what is asserted
 * @param {() => Promise<void>} body the check
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

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'outline-e2e-'))
const big = path.join(workspace, 'big.md')
fs.writeFileSync(
  big,
  ['# Root', '', ...Array.from({ length: 60 }, (_, i) => `## Chapter ${i} topic ${'x'.repeat(i % 7)}\n\nbody\n`)].join('\n'),
)
const plain = path.join(workspace, 'plain.txt')
fs.writeFileSync(plain, 'no headings here\nat all\n')
const binary = path.join(workspace, 'bin.dat')
fs.writeFileSync(binary, Buffer.from([0, 1, 2, 3, 4]))

let registered = []
const ctx = {
  effect(fn) {
    fn()
    return () => {}
  },
  tools: {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  },
  get(name) {
    if (name !== 'workingDirectory') return undefined
    return { ensure: async () => workspace }
  },
}

apply(ctx)
const byName = (name) => registered.find((definition) => definition.name === name)
const exec = { agent: { id: 'agent-test' }, signal: new AbortController().signal }

console.log('\nregistration')
await check('registers outline, file_card and digest', () => {
  assert.equal(registered.length, 3, `registered ${registered.length}`)
  assert.ok(byName('outline'), 'outline missing')
  assert.ok(byName('file_card'), 'file_card missing')
  assert.ok(byName('digest'), 'digest missing')
})

const outline = byName('outline')
const card = byName('file_card')
const digest = byName('digest')
registered = outline

await check('outline declares a renderer and a schema', () => {
  assert.equal(typeof registered.output.render, 'function')
  assert.deepEqual(Object.keys(registered.parameters.properties), [
    'path',
    'keyword',
    'literal',
    'case_sensitive',
    'depth',
    'max_items',
  ])
})
await check('declares a renderer and a schema', () => {
  assert.equal(typeof registered.output.render, 'function')
  assert.equal(registered.output.schema.type, 'object')
  assert.ok(registered.output.schema.properties.text)
})
console.log('\nexecution')
await check('maps a workspace file', async () => {
  const value = await registered.execute({ path: 'big.md' }, exec)
  assert.equal(value.lines, 241)
  assert.ok(value.headingTotal > 50)
  assert.match(value.text, /Sections \(depth 2/)
  const rendered = registered.output.render({}, value)
  assert.equal(rendered[0].type, 'text')
  assert.equal(rendered[0].text, value.text)
})

await check('accepts an absolute path inside the workspace', async () => {
  const value = await registered.execute({ path: big }, exec)
  assert.equal(value.headingTotal, value.headingTotal)
  assert.ok(value.path.toLowerCase().includes('outline-e2e'))
})

await check('honours depth and max_items', async () => {
  const value = await registered.execute({ path: 'big.md', depth: 6, max_items: 3 }, exec)
  assert.equal(value.depth, 6)
  assert.match(value.text, /more entries omitted/)
})

await check('clamps out-of-range arguments instead of failing', async () => {
  const value = await registered.execute({ path: 'big.md', depth: 99, max_items: -5 }, exec)
  assert.equal(value.depth, 6)
  assert.ok(value.text.length > 0)
})

await check('reports a plain-text file honestly', async () => {
  const value = await registered.execute({ path: 'plain.txt' }, exec)
  assert.equal(value.headingTotal, 0)
  assert.match(value.text, /No Markdown headings/)
})

console.log('\nfile_card execution')
await check('cards a file with structure', async () => {
  const value = await card.execute({ path: 'big.md' }, exec)
  assert.equal(value.hasStructure, true)
  assert.equal(value.degraded, false)
  assert.match(value.text, /Size tier:/)
  assert.match(value.text, /Opening lines/)
  assert.match(value.text, /Closing lines/)
  const rendered = card.output.render({}, value)
  assert.equal(rendered[0].text, value.text)
})

await check('cards a plain-text file through the degraded path', async () => {
  const value = await card.execute({ path: 'plain.txt' }, exec)
  assert.equal(value.hasStructure, false)
  assert.equal(value.degraded, true)
  assert.match(value.text, /no Markdown headings/)
})

await check('clamps card arguments', async () => {
  const value = await card.execute({ path: 'big.md', max_headings: -1, depth: 99, head_lines: 999 }, exec)
  assert.ok(value.text.length > 0)
})

await check('card rejects a path outside the workspace', async () => {
  await assert.rejects(card.execute({ path: '../escape.md' }, exec), /outside the workspace/)
})

console.log('\ndigest execution')
await check('digests an explicit line range', async () => {
  const value = await digest.execute({ path: 'big.md', lines: '5-15', budget: 5000 }, exec)
  assert.equal(value.startLine, 5)
  assert.equal(value.endLine, 15)
  assert.ok(value.tokens > 0)
  assert.match(value.text, /Returned lines 5–15/)
  const rendered = digest.output.render({}, value)
  assert.equal(rendered[0].text, value.text)
})

await check('digests a section by title', async () => {
  const value = await digest.execute({ path: 'big.md', section: 'Chapter 5 topic', budget: 5000 }, exec)
  assert.ok(value.section, 'should report the matched title')
  assert.ok(value.startLine >= 1)
})

await check('reports remaining lines when the budget bites', async () => {
  const value = await digest.execute({ path: 'big.md', lines: '1-240', budget: 200 }, exec)
  assert.ok(value.remainingLines > 0, 'should say what is left')
  assert.match(value.text, /Continue with digest/)
})

await check('rejects a missing range and section', async () => {
  await assert.rejects(digest.execute({ path: 'big.md' }, exec), /lines is required/)
})

await check('rejects a malformed range', async () => {
  await assert.rejects(digest.execute({ path: 'big.md', lines: 'abc' }, exec), /cannot parse lines/)
})

await check('rejects an inverted range', async () => {
  await assert.rejects(digest.execute({ path: 'big.md', lines: '50-10' }, exec), /before its start/)
})

await check('reports an unknown section', async () => {
  await assert.rejects(digest.execute({ path: 'big.md', section: 'No Such Chapter' }, exec), /no heading matches/)
})

await check('digest clamps an out-of-range budget', async () => {
  const value = await digest.execute({ path: 'big.md', lines: '1-5', budget: 999999 }, exec)
  assert.equal(value.budget, 20000)
})

console.log('\nrefusals')
await check('rejects a path outside the workspace', async () => {
  await assert.rejects(registered.execute({ path: '../escape.md' }, exec), /outside the workspace/)
})
await check('rejects a missing path argument', async () => {
  await assert.rejects(registered.execute({}, exec), /path is required/)
})
await check('rejects a nonexistent file', async () => {
  await assert.rejects(registered.execute({ path: 'nope.md' }, exec), /does not exist/)
})
await check('rejects a directory', async () => {
  await assert.rejects(registered.execute({ path: '.' }, exec), /is a directory/)
})
await check('rejects a binary file', async () => {
  await assert.rejects(registered.execute({ path: 'bin.dat' }, exec), /binary/i)
})

console.log('\ndeterminism')
await check('same input gives byte-identical output', async () => {
  const a = await registered.execute({ path: 'big.md' }, exec)
  const b = await registered.execute({ path: 'big.md' }, exec)
  assert.equal(a.text, b.text)
})

fs.rmSync(workspace, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
