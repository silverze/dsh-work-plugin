#!/usr/bin/env node
/**
 * Public-release guard.
 *
 * Fails when the tree still contains internal identifiers, personal data,
 * secret material, or packaging mistakes that would leak into npm.
 *
 * Run: node scripts/check-public.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const FORBIDDEN = [
  /cvte/i,
  /视源/,
  /希沃/,
  /seewo/i,
  /maxhub/i,
  /tv-fae/i,
  /cplm/i,
  /供应链/,
  /银泽/,
  /@cvte/i,
  /工号/,
]

const SECRETS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /cli_[a-z0-9]{16,}/,
  /app_secret["'\s:=]+[A-Za-z0-9]{16,}/i,
  /Bearer\s+[A-Za-z0-9._-]{20,}/,
]

const SKIP = new Set(['scripts/check-public.mjs'])
const BINARY = /\.(png|jpe?g|gif|webp|ico|tgz|woff2?|pdf)$/i
const PUBLISHABLE = [
  'packages/bundle/package.json',
  'packages/client-work/package.json',
  'packages/host-work/package.json',
  'packages/host-feishu/package.json',
  'packages/skills-work/package.json',
]

const problems = []
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)

for (const file of files) {
  if (SKIP.has(file) || BINARY.test(file)) continue
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    for (const pattern of FORBIDDEN) {
      if (pattern.test(line)) problems.push(`${file}:${index + 1} 内部标识 ${pattern}: ${line.trim().slice(0, 120)}`)
    }
    for (const pattern of SECRETS) {
      if (pattern.test(line)) problems.push(`${file}:${index + 1} 疑似密钥 ${pattern}`)
    }
    if (/\/Users\/[A-Za-z0-9._-]+/.test(line)) problems.push(`${file}:${index + 1} 绝对家目录路径`)
  })
}

for (const file of PUBLISHABLE) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  if (pkg.private === true) problems.push(`${file}: 发布包不能 private`)
  if (pkg.license !== 'MIT') problems.push(`${file}: license 必须是 MIT`)
  if (!pkg.repository?.url?.includes('github.com/silverze/dsh-work-plug')) problems.push(`${file}: repository 缺失或不是公开仓库`)
  if (!pkg.engines?.dsh) problems.push(`${file}: 缺少 engines.dsh`)
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    if (range.startsWith('file:')) problems.push(`${file}: 依赖 ${name} 仍是 file:`)
    if (name.startsWith('@deepseek-ai/')) problems.push(`${file}: 宿主包 ${name} 必须在 peerDependencies`)
  }
  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (name.startsWith('@deepseek-ai/') && name !== '@deepseek-ai/cordis' && !range.includes('<0.2.3-0')) {
      problems.push(`${file}: peer ${name} 必须显式包含预发布分支（当前 ${range}）`)
    }
  }
}

if (files.some((file) => file.includes('vendor/') && file.endsWith('.tgz'))) problems.push('仓库内不应包含 vendor/*.tgz')
if (!existsSync('LICENSE')) problems.push('缺少 LICENSE')
if (!existsSync('README.md')) problems.push('缺少 README.md')
if (!existsSync('README.zh.md')) problems.push('缺少 README.zh.md')

if (problems.length > 0) {
  console.error(`check-public: ${problems.length} 个问题\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`check-public: ${files.length} 个文件通过`)
