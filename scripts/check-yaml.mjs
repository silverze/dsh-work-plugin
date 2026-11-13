#!/usr/bin/env node
/**
 * Validate every checked-in YAML file. Uses the `yaml` package when installed;
 * otherwise falls back to a structural check so W0 CI does not hard-depend on
 * a fresh install.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const files = [
  'packages/bundle/cordis.patch.yml',
  'packages/bundle/presets/work.patch.yml',
  'profiles/work/dev.patch.yml.example',
  'pnpm-workspace.yaml',
]

let YAML
try {
  YAML = await import('yaml')
} catch {
  console.warn('[check-yaml] `yaml` not installed; running structural checks only')
}

let failed = false
for (const relative of files) {
  const file = join(root, relative)
  const text = readFileSync(file, 'utf8')

  if (!text.trim()) {
    console.error(`[check-yaml] empty file: ${relative}`)
    failed = true
    continue
  }

  if (YAML) {
    try {
      const doc = YAML.parse(text)
      if (doc === null || doc === undefined) throw new Error('empty document')
      console.log(`[check-yaml] ok ${relative}`)
    } catch (error) {
      console.error(`[check-yaml] invalid YAML in ${relative}: ${error.message}`)
      failed = true
    }
    continue
  }

  if (!/^[\s\S]*- insert:/m.test(text)) {
    if (relative.includes('.patch.yml')) {
      console.error(`[check-yaml] expected an insert list in ${relative}`)
      failed = true
      continue
    }
    console.log(`[check-yaml] structural ok ${relative}`)
    continue
  }
  console.log(`[check-yaml] structural ok ${relative}`)
}

if (failed) process.exit(1)
