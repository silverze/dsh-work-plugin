import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const source = join(root, 'lib', '.client', 'client.cjs')
const body = readFileSync(source, 'utf8')
const wrapped = `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(manifest.name)},\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n${body}\n    return module.exports;\n  },\n});\n`
writeFileSync(join(root, 'lib', 'client.js'), wrapped)
rmSync(join(root, 'lib', '.client'), { recursive: true, force: true })
console.log('wrapped lib/client.js for DSH ModuleLoader')
