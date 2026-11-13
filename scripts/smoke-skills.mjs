/** Dev-only smoke plugin: list the skills visible to a work agent. */
import { writeFileSync } from 'node:fs'

export const name = 'acme-smoke-skills'
export const inject = ['skills']

export async function apply(ctx) {
  const marker = process.env.DSH_WORK_SKILLS_MARKER
  if (!marker) return
  try {
    const list = await ctx.skills.list()
    writeFileSync(marker, list.map((skill) => skill.name).sort().join('\n') + '\n', 'utf8')
  } catch (error) {
    writeFileSync(marker, `error ${error?.message ?? String(error)}\n`, 'utf8')
  }
}
