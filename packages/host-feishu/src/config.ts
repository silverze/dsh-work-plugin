/**
 * Feishu app configuration.
 *
 * The App Secret should live in the DSH credentials store in production. The
 * env fallback exists for local development and CI only.
 */

export const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:17321/feishu/oauth/callback'

/** Request only what the tools need. Keep in sync with docs/feishu-app-setup.md. */
export const DEFAULT_SCOPES = [
  'docx:document',
  'sheets:spreadsheet',
  'drive:drive',
  'im:message',
  'im:message:send_as_bot',
  'contact:user.base:readonly',
  'offline_access',
  // Optional: only needed when the timeline/wiki tools are used.
  'wiki:wiki',
] as const

export type FeishuBrand = 'feishu' | 'lark'

export interface FeishuConfig {
  appId: string
  /** Dev-only fallback. Prefer `appSecretRef` + credentials in production. */
  appSecret?: string
  /** Credential key in `ctx.credentials`, e.g. `FEISHU_APP_SECRET`. */
  appSecretRef?: string
  redirectUri: string
  scopes: string[]
  brand: FeishuBrand
}

export class FeishuConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeishuConfigError'
  }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): FeishuConfig {
  const appId = env.FEISHU_APP_ID?.trim()
  if (!appId) {
    throw new FeishuConfigError('FEISHU_APP_ID is required (see docs/feishu-app-setup.md)')
  }

  const appSecret = env.FEISHU_APP_SECRET?.trim() || undefined
  const redirectUri = env.FEISHU_REDIRECT_URI?.trim() || DEFAULT_REDIRECT_URI
  const scopes = (env.FEISHU_SCOPES?.trim() || DEFAULT_SCOPES.join(' '))
    .split(/\s+/)
    .filter(Boolean)

  return {
    appId,
    ...(appSecret ? { appSecret } : {}),
    appSecretRef: 'FEISHU_APP_SECRET',
    redirectUri,
    scopes,
    brand: env.FEISHU_BRAND === 'lark' ? 'lark' : 'feishu',
  }
}
