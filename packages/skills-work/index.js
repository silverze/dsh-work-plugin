/**
 * @dsh-work-plug/skills — bundled provider for the six DSH Work skills.
 *
 * Registers the skills on `ctx.skills` directly, anchoring every path at
 * `import.meta.url` (the same pattern as the official bundled-skill
 * providers such as @deepseek-ai/dsh-skill-badge). The skills therefore work
 * from a profile install, a linked checkout, or a packed tarball — no
 * `customSkillDirs` and no dependency on the host process cwd.
 */

import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/**
 * Matches `BUNDLED_SKILL_RANK` from @deepseek-ai/dsh-skill (0.2.2-rc.2).
 * Kept local so this plugin stays dependency-free at runtime; revisit when
 * the DSH skill rank contract changes.
 */
const BUNDLED_SKILL_RANK = 600

/** Cordis plugin name. */
export const name = 'work-skills'

/** Service required by the bundled provider. */
export const inject = ['skills']

const PROVIDER_NAME = 'work-skills'
const SKILLS_ROOT = new URL('./skills/', import.meta.url)
const INVOCATION = { modelInvocable: true, userInvocable: true }

/**
 * Minimal SKILL.md frontmatter reader: `key: value` lines between `---`
 * fences. The bundled skills only use single-line scalar fields.
 */
function parseFrontmatter(text) {
  if (!text.startsWith('---')) return undefined
  const end = text.indexOf('\n---', 3)
  if (end === -1) return undefined
  const fields = {}
  for (const line of text.slice(4, end).split('\n')) {
    const sep = line.indexOf(':')
    if (sep <= 0) continue
    fields[line.slice(0, sep).trim()] = line.slice(sep + 1).trim()
  }
  return fields
}

/** Discover the bundled skills; unreadable or malformed dirs are skipped. */
async function discoverSkills() {
  const entries = await readdir(SKILLS_ROOT, { withFileTypes: true })
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillDir = new URL(`${entry.name}/`, SKILLS_ROOT)
    const locator = new URL('SKILL.md', skillDir)
    let body
    try {
      body = await readFile(locator, 'utf8')
    } catch {
      continue
    }
    const frontmatter = parseFrontmatter(body)
    if (!frontmatter?.name || !frontmatter?.description) continue
    candidates.push({
      name: frontmatter.name,
      description: frontmatter.description,
      invocation: INVOCATION,
      provider: PROVIDER_NAME,
      source: 'bundled',
      resourceBase: { kind: 'directory', path: fileURLToPath(skillDir) },
      rank: BUNDLED_SKILL_RANK,
      locator,
    })
  }
  return candidates
}

const provider = {
  name: PROVIDER_NAME,
  async list() {
    return discoverSkills()
  },
  async get(candidate) {
    const content = await readFile(candidate.locator, 'utf8')
    return {
      name: candidate.name,
      description: candidate.description,
      invocation: candidate.invocation,
      provider: PROVIDER_NAME,
      source: 'bundled',
      resourceBase: candidate.resourceBase,
      content,
    }
  },
}

/** Register the bundled work-skills provider on `ctx.skills`. */
export function apply(ctx) {
  ctx.skills.registerProvider(() => provider)
}
