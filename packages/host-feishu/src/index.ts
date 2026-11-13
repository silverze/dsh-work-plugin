/**
 * @dsh-work-plug/feishu — Feishu tools.
 *
 * Token source: the environment variable named by `accessTokenEnv`
 * (default `FEISHU_USER_ACCESS_TOKEN`); the OAuth flow + credentials store
 * provide the fallback. The tool surface and client do not change.
 */

import { writeFileSync } from 'node:fs'

import type { Context } from '@deepseek-ai/cordis'

import { registerFeishuWriteApproval } from './approval.js'
import { FeishuAuthService, type FeishuAuthConfig } from './auth.js'
import { registerFeishuAuthTools } from './auth-tools.js'
import { FeishuHttpClient } from './feishu-client.js'
import { FeishuRemoteService } from './feishu-remote.js'
import { registerFeishuWorkNotifier } from './notifier.js'
import { registerFeishuShareTool } from './share-tools.js'
import { registerFeishuTools } from './tools.js'

export const name = 'dsh-work-feishu'

/** Tools must exist before the Feishu tool surface can register. */
export const inject = ['tools', 'credentials', 'approval']

export interface Config extends FeishuAuthConfig {
  /** Environment variable carrying a dev/user access token. */
  accessTokenEnv?: string
  /** OpenAPI root override (tests / Lark deployments). */
  baseUrl?: string
  /** Default Feishu chat_id for scheduled-run notifications. */
  notifyChatId?: string
}

export function apply(ctx: Context, config: Config = {}): void {
  const tokenEnv = config.accessTokenEnv ?? 'FEISHU_USER_ACCESS_TOKEN'
  const auth = new FeishuAuthService(ctx, {
    ...(config.appId ? { appId: config.appId } : {}),
    ...(config.appSecret ? { appSecret: config.appSecret } : {}),
    ...(config.redirectUri ? { redirectUri: config.redirectUri } : {}),
    ...(config.scopes ? { scopes: config.scopes } : {}),
    ...(config.baseUrl ? { openApiBaseUrl: config.baseUrl } : {}),
    ...(config.authBaseUrl ? { authBaseUrl: config.authBaseUrl } : {}),
  })
  ctx.effect(() => () => auth.close())

  const client = new FeishuHttpClient({
    accessToken: async () => {
      const value = process.env[tokenEnv]?.trim()
      if (value) return value
      return auth.getAccessToken()
    },
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  })

  new FeishuRemoteService(ctx, auth, client)

  registerFeishuTools(ctx, client)
  registerFeishuShareTool(ctx, client)
  registerFeishuWorkNotifier(ctx, client, config.notifyChatId ?? process.env.FEISHU_NOTIFY_CHAT_ID)
  registerFeishuAuthTools(ctx, auth)
  registerFeishuWriteApproval(ctx)

  // Opt-in boot marker for local smoke tests; never set in normal runs.
  const marker = process.env.DSH_FEISHU_MARKER
  if (marker) {
    writeFileSync(
      marker,
      ctx.tools.definitions().map((definition) => definition.name).sort().join('\n') + '\n',
      'utf8',
    )
  }
}

export { FeishuHttpClient } from './feishu-client.js'
export { FeishuError, mapFeishuError } from './errors.js'
export { registerFeishuTools } from './tools.js'
export { registerFeishuShareTool } from './share-tools.js'
export { registerFeishuAuthTools } from './auth-tools.js'
