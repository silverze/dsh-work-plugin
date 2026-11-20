#!/usr/bin/env node
/**
 * Public-release guard.
 *
 * Fails when the tree still contains personal data, secret material, or
 * packaging mistakes that would leak into npm.
 *
 * Site-specific identifiers (company, customers, colleagues, internal systems)
 * are deliberately NOT listed in this file: the repository is public, so the
 * blocklist itself would be the leak. Put them in
 * `scripts/public-denylist.local.txt` — one JavaScript regular expression per
 * line, `#` starts a comment — and git ignores that file:
 *
 *     # scripts/public-denylist.local.txt   (git-ignored, never committed)
 *     some-internal-system
 *     SomeCompanyName
 *     a-colleague
 *
 * On a machine without that file the generic checks (PII, secrets, packaging)
 * still run, so CI keeps working.
 *
 * Run: node scripts/check-public.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

/** Optional, never committed: site-specific patterns. */
const DENYLIST_FILE = 'scripts/public-denylist.local.txt'

/** Personal data that must never ship, whatever the project. */
const PERSONAL = [
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, label: '邮箱地址' },
  { pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/, label: '疑似手机号' },
  { pattern: /\/Users\/[A-Za-z0-9._-]+/, label: 'macOS 绝对家目录路径' },
  { pattern: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/i, label: 'Windows 绝对家目录路径' },
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

/** Read the optional local blocklist; a broken line is itself a problem. */
function loadDenylist(problems) {
  if (!existsSync(DENYLIST_FILE)) return []
  const patterns = []
  const lines = readFileSync(DENYLIST_FILE, 'utf8').split('\n')
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    try {
      // Case-insensitive: a name is a name whatever its capitalisation.
      patterns.push({ source: line, expression: new RegExp(line, 'i') })
    } catch {
      problems.push(`${DENYLIST_FILE}:${index + 1} 不是合法的正则：${line}`)
    }
  })
  return patterns
}

const problems = []
const denylist = loadDenylist(problems)
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)

for (const file of files) {
  if (SKIP.has(file) || BINARY.test(file)) continue
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  text.split('\n').forEach((line, index) => {
    for (const { source, expression } of denylist) {
      if (expression.test(line)) {
        problems.push(`${file}:${index + 1} 站点标识 /${source}/: ${line.trim().slice(0, 120)}`)
      }
    }
    for (const { pattern, label } of PERSONAL) {
      if (pattern.test(line)) problems.push(`${file}:${index + 1} ${label}: ${line.trim().slice(0, 120)}`)
    }
    for (const pattern of SECRETS) {
      if (pattern.test(line)) problems.push(`${file}:${index + 1} 疑似密钥 ${pattern}`)
    }
  })
}

for (const file of PUBLISHABLE) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  if (pkg.private === true) problems.push(`${file}: 发布包不能 private`)
  if (pkg.license !== 'MIT') problems.push(`${file}: license 必须是 MIT`)
  if (!pkg.repository?.url?.includes('github.com/silverze/dsh-work-plugin')) problems.push(`${file}: repository 缺失或不是公开仓库`)
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
if (denylist.length === 0) {
  console.log(`check-public: 未配置 ${DENYLIST_FILE}（站点专属黑名单可选，见脚本头注释）`)
}
console.log(`check-public: ${files.length} 个文件通过，${denylist.length} 条站点黑名单规则`)
