#!/usr/bin/env node
/**
 * W0 verification: load the bundle with a mock Cordis context and prove the
 * plugin contract (name/apply/effect/dispose) without starting DSH.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, name, VERSION } from '../packages/bundle/index.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const patchPath = join(root, 'packages', 'bundle', 'cordis.patch.yml')
const patch = readFileSync(patchPath, 'utf8')

if (name !== 'dsh-work') throw new Error(`unexpected plugin name: ${name}`)
if (typeof apply !== 'function') throw new Error('apply must be a function')
if (!patch.includes("name: '@dsh-work-plug/bundle'")) throw new Error('patch does not insert the bundle row')

const logs = []
const effects = []
const ctx = {
  logger: { info: (message) => logs.push(String(message)) },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose !== 'function') throw new Error('ctx.effect callback must return a disposer')
    effects.push(dispose)
    return dispose
  },
}

apply(ctx)
if (effects.length !== 1) throw new Error(`expected 1 effect, got ${effects.length}`)
for (const dispose of effects) dispose()

console.log(JSON.stringify({ name, version: VERSION, patch: 'ok', logs, disposed: true }, null, 2))
