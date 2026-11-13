#!/usr/bin/env node
/**
 * Build an installable bundle tarball.
 *
 * The source bundle links its sibling packages with `file:../...`, which pnpm
 * does not install when the bundle itself is linked. For distribution we pack
 * every runtime package into `vendor/`, rewrite the stage manifest to those
 * tarballs, then pack the stage. The result is one `.tgz` that installs host,
 * client, and Feishu plugins together.
 */

import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundleDir = join(root, 'packages', 'bundle')
const vendorDir = join(bundleDir, 'vendor')
const distDir = join(root, 'dist')
const stageDir = join(distDir, 'bundle-stage')

const packages = [
  ['@dsh-work-plugin/host', join(root, 'packages', 'host-work')],
  ['@dsh-work-plugin/feishu', join(root, 'packages', 'host-feishu')],
  ['@dsh-work-plugin/client', join(root, 'packages', 'client-work')],
  ['@dsh-work-plugin/skills', join(root, 'packages', 'skills-work')],
]

function pnpm(args, cwd = root) {
  console.log(`$ pnpm ${args.join(' ')}`)
  execFileSync('pnpm', args, { cwd, stdio: 'inherit', env: process.env })
}

async function pack(name, cwd) {
  pnpm(['--filter', name, 'run', '--if-present', 'build'], root)
  pnpm(['--filter', name, 'pack', '--pack-destination', vendorDir], root)
}

await rm(vendorDir, { recursive: true, force: true })
await mkdir(vendorDir, { recursive: true })

for (const [name, cwd] of packages) await pack(name, cwd)

await rm(stageDir, { recursive: true, force: true })
await mkdir(stageDir, { recursive: true })
for (const entry of ['index.js', 'cordis.patch.yml', 'presets', 'locale', 'docs', 'icon.svg']) {
  await cp(join(bundleDir, entry), join(stageDir, entry), { recursive: true })
}

const manifest = JSON.parse(await readFile(join(bundleDir, 'package.json'), 'utf8'))
delete manifest.dependencies
manifest.files = ['index.js', 'cordis.patch.yml', 'presets', 'locale/*.json', 'docs', 'icon.svg']
await writeFile(join(stageDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')

await mkdir(distDir, { recursive: true })
pnpm(['pack', '--pack-destination', distDir], stageDir)

// The bundle's plugin rows reference these packages by name, so install them
// alongside the bundle in one `dsh plugin add` invocation.
for (const [name] of packages) {
  const file = (name.startsWith('@') ? name.slice(1) : name).replace('/', '-')
  await cp(join(vendorDir, `${file}-0.1.0.tgz`), join(distDir, `${file}-0.1.0.tgz`))
}
console.log('\ninstall with:')
console.log(`  dsh plugin --profile work add dist/dsh-work-bundle-0.1.0.tgz dist/dsh-work-host-0.1.0.tgz dist/dsh-work-feishu-0.1.0.tgz dist/dsh-work-client-0.1.0.tgz dist/dsh-work-skills-0.1.0.tgz`)
