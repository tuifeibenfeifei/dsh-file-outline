import { scanStructure } from '../lib/engine.js'
import { renderOutline } from '../lib/render.js'

const file = process.argv[2]
const depth = Number(process.argv[3] || 2)
const maxItems = Number(process.argv[4] || 100)
const scan = await scanStructure(file)
const text = renderOutline(scan, { depth, maxItems })
console.log(text)
console.log(`\n--- ${text.length} chars, ~${Math.ceil(text.length / 4)} tok(flat) ---`)
