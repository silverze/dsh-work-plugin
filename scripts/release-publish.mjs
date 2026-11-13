#!/usr/bin/env node
// Publish the five workspace packages to npm, skipping versions that already
// exist on the registry. Re-running a release (or moving a tag) must not fail
// just because a version is already public.
//
// `pnpm publish` is used instead of `npm publish` because only pnpm rewrites
// `workspace:^` dependencies into real semver ranges before packing.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const REGISTRY = 'https://registry.npmjs.org'
const dryRun = process.argv.includes('--dry-run')

// Dependencies first, the bundle last: a bundle version is only useful once the
// packages it points at are installable.
const ORDER = [
  'packages/skills-work',
  'packages/host-feishu',
  'packages/host-work',
  'packages/client-work',
  'packages/bundle',
]

const root = path.resolve(import.meta.dirname, '..')

function sh(file, args, options = {}) {
  return execFileSync(file, args, { stdio: 'inherit', ...options })
}

function published(name, version) {
  try {
    execFileSync('npm', ['view', `${name}@${version}`, 'version', `--registry=${REGISTRY}`], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

let failed = 0
for (const dir of ORDER) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8'))
  const label = `${manifest.name}@${manifest.version}`
  if (published(manifest.name, manifest.version)) {
    console.log(`skip ${label}: already on ${REGISTRY}`)
    continue
  }
  if (dryRun) {
    console.log(`would publish ${label}`)
    continue
  }
  console.log(`publish ${label}`)
  try {
    sh('pnpm', ['--filter', manifest.name, 'publish', '--access', 'public', '--no-git-checks', '--provenance'])
  } catch {
    failed += 1
    console.error(`failed ${label}`)
  }
}

if (failed > 0) process.exit(1)
console.log('release: every package version is on the registry')
