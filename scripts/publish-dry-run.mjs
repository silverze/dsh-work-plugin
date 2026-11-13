#!/usr/bin/env node
/**
 * Registry publish rehearsal.
 *
 * Stages each package with its published files, drops `private`, replaces the
 * bundle's file: dependencies with exact versions, then runs
 * `pnpm publish --dry-run` for each package. Nothing is uploaded.
 */
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const stage = join(root, 'dist', 'publish-stage')

const packages = [
  { dir: 'host-work', files: ['lib'] },
  { dir: 'host-feishu', files: ['lib'] },
  { dir: 'client-work', files: ['lib'] },
  { dir: 'skills-work', files: ['index.js', 'skills', 'locale', 'icon.svg', 'README.md'] },
  { dir: 'bundle', files: ['index.js', 'cordis.patch.yml', 'presets', 'locale', 'docs', 'icon.svg'] },
]

await rm(stage, { recursive: true, force: true })
await mkdir(stage, { recursive: true })

for (const pkg of packages) {
  const source = join(root, 'packages', pkg.dir)
  const target = join(stage, pkg.dir)
  await mkdir(target, { recursive: true })
  for (const entry of pkg.files) {
    await cp(join(source, entry), join(target, entry), { recursive: true })
  }

  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  delete manifest.private
  if (pkg.dir === 'bundle') {
    manifest.dependencies = {
      '@dsh-work-plugin/host': '0.1.0',
      '@dsh-work-plugin/feishu': '0.1.0',
      '@dsh-work-plugin/client': '0.1.0',
      '@dsh-work-plugin/skills': '0.1.0',
    }
  }
  await writeFile(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
}

for (const pkg of packages) {
  const target = join(stage, pkg.dir)
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
  console.log(`\n=== ${manifest.name} ===`)
  const output = execFileSync('pnpm', ['publish', '--dry-run', '--no-git-checks', '--access', 'public'], {
    cwd: target,
    encoding: 'utf8',
    env: process.env,
  })
  console.log(output.trim().split('\n').slice(-6).join('\n'))
}

console.log('\nDry run complete. Nothing was published.')
