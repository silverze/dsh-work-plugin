/**
 * Dev-only smoke plugin: prove the `work` agent preset is registered by
 * creating a blank Session with it. Writes the result to
 * DSH_WORK_SMOKE_MARKER and creates nothing when that variable is unset.
 */
import { writeFileSync } from 'node:fs'

export const name = 'acme-smoke-preset'
export const inject = ['sessionController']

export async function apply(ctx) {
  const marker = process.env.DSH_WORK_SMOKE_MARKER
  if (!marker) return
  try {
    const created = await ctx.sessionController.create({
      cwd: process.cwd(),
      agentPreset: 'work',
    })
    writeFileSync(
      marker,
      `ok agentPreset=${created.agentPreset ?? 'unknown'} session=${created.sessionId}\n`,
      'utf8',
    )
  } catch (error) {
    writeFileSync(marker, `error ${error?.message ?? String(error)}\n`, 'utf8')
  }
}
