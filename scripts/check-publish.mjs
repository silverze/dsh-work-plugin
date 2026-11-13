#!/usr/bin/env node
/** Pre-publish manifest audit. No network; fails on hard inconsistencies. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const dirs = ['packages/host-work', 'packages/host-feishu', 'packages/client-work', 'packages/skills-work', 'packages/bundle']
const manifests = []
for (const dir of dirs) {
  manifests.push({ dir, manifest: JSON.parse(await readFile(join(root, dir, 'package.json'), 'utf8')) })
}

const errors = []
const warnings = []
const versions = new Set(manifests.map(({ manifest }) => manifest.version))
if (versions.size !== 1) errors.push(`versions differ: ${[...versions].join(', ')}`)

for (const { dir, manifest } of manifests) {
  if (manifest.private === true) warnings.push(`${manifest.name}: private=true blocks publish`)
  if (!manifest.engines?.dsh) warnings.push(`${manifest.name}: missing engines.dsh`)
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) errors.push(`${manifest.name}: files is empty`)
}

const bundle = manifests.find(({ dir }) => dir.endsWith('/bundle')).manifest
const patch = bundle.dsh?.bundle?.patch
if (!patch) errors.push('bundle: missing dsh.bundle.patch')
const deps = bundle.dependencies ?? {}
for (const [name, spec] of Object.entries(deps)) {
  if (String(spec).startsWith('file:')) warnings.push(`bundle dependency ${name}=${spec}: registry publish needs a version`)
}

for (const warning of warnings) console.warn(`WARN  ${warning}`)
for (const error of errors) console.error(`ERROR ${error}`)
if (errors.length) process.exit(1)
console.log(`\nOK ${manifests.length} packages, version ${[...versions][0]}. Review warnings before publishing.`)
