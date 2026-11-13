import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, name, VERSION } from '../../packages/bundle/index.js'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

test('bundle exports the Cordis plugin contract', () => {
  assert.equal(name, 'dsh-work')
  assert.equal(typeof apply, 'function')
  assert.match(VERSION, /^\d+\.\d+\.\d+/)
})

test('apply logs once and registers exactly one effect', () => {
  const logs = []
  const effects = []
  const ctx = {
    logger: { info: (message) => logs.push(String(message)) },
    effect(fn) {
      const dispose = fn()
      assert.equal(typeof dispose, 'function')
      effects.push(dispose)
      return dispose
    },
  }

  apply(ctx)

  assert.equal(effects.length, 1)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /dsh-work/)
})

test('apply falls back to console when ctx.logger is absent', () => {
  const original = console.info
  const logs = []
  console.info = (message) => logs.push(String(message))
  try {
    const disposers = []
    apply({
      effect(fn) {
        const dispose = fn()
        disposers.push(dispose)
        return dispose
      },
    })
    assert.equal(logs.length, 1)
    assert.match(logs[0], /dsh-work/)
    for (const dispose of disposers) dispose()
  } finally {
    console.info = original
  }
})

test('disposing the effect logs the disposal exactly once', () => {
  const logs = []
  let dispose
  const ctx = {
    logger: { info: (message) => logs.push(String(message)) },
    effect(fn) {
      dispose = fn()
      return dispose
    },
  }

  apply(ctx)
  dispose()
  dispose()

  assert.equal(logs.filter((line) => line.includes('disposed')).length, 1)
})

test('bundle patch inserts the package row', () => {
  const patch = readFileSync(join(root, 'packages', 'bundle', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- insert:/)
  assert.match(patch, /name: '@dsh-work-plugin\/bundle'/)
})

test('every skill has frontmatter with name and description', () => {
  const skills = [
    'work-research',
    'work-screen-awareness',
    'work-weekly-report',
    'work-meeting-minutes',
    'work-data-analysis',
    'work-deck',
    'work-doc-polish',
  ]

  for (const skill of skills) {
    const text = readFileSync(
      join(root, 'packages', 'skills-work', 'skills', skill, 'SKILL.md'),
      'utf8',
    )
    assert.match(text, /^---\n/, `${skill} must start with frontmatter`)
    assert.match(text, new RegExp(`^name: ${skill}$`, 'm'), `${skill} name mismatch`)
    assert.match(text, /^description: .+$/m, `${skill} missing description`)
  }
})
