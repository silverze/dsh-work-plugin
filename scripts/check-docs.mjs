#!/usr/bin/env node
/**
 * Documentation link guard: every relative link and image in README/docs must exist.
 *
 * Run: node scripts/check-docs.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((file) => file.endsWith('.md') && (file === 'README.md' || file === 'README.zh.md' || file.startsWith('docs/')))

const problems = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1])
  for (const link of links) {
    if (/^(https?:|mailto:|#)/.test(link)) continue
    const target = link.split('#')[0]
    if (!target) continue
    const resolved = resolve(dirname(file), decodeURI(target))
    if (!existsSync(resolved)) problems.push(`${file}: 链接不存在 ${link}`)
  }
}

if (problems.length > 0) {
  console.error(`check-docs: ${problems.length} 个问题\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`check-docs: ${files.length} 个文档文件通过`)
