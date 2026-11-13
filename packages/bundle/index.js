/**
 * @dsh-work-plug/bundle — the bundle entry of the work profile.
 *
 * The patch in `cordis.patch.yml` inserts the host services, the Feishu tools,
 * the web client plugins and the bundled skills. This file itself stays
 * dependency-free (Node built-ins only) so it can also be loaded by a plain
 * Node process during boot verification.
 */

import { readFileSync, writeFileSync } from 'node:fs'

export const name = 'dsh-work'

export const inject = []

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const logger = ctx && ctx.logger && typeof ctx.logger.info === 'function'
    ? ctx.logger
    : console

  logger.info(`[dsh-work] loaded v${VERSION}`)

  // Opt-in boot marker used by CI and local smoke tests.
  const marker = process.env.DSH_WORK_HELLO_MARKER
  if (marker) {
    try {
      writeFileSync(marker, `loaded ${VERSION}\n`, 'utf8')
    } catch (error) {
      logger.info(`[dsh-work] marker failed: ${String(error)}`)
    }
  }

  // Every registration in Cordis is an effect; disposing this plugin unwinds it.
  ctx.effect(() => {
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      logger.info('[dsh-work] disposed')
    }
  })
}

export { VERSION }
