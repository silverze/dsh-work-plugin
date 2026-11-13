/** Feishu connection tools: start authorization, read status, disconnect. */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { FeishuAuthService } from './auth.js'

function text(value: string): ContentBlock {
  return { type: 'text', text: value }
}

function describeStatus(value: {
  connected?: boolean
  tokenState?: string
  reason?: string
  name?: string
  openId?: string
  refreshExpiresAt?: number
}): string {
  const who = value.name ?? value.openId ?? 'unknown user'
  if (!value.connected) {
    const why =
      value.reason === 'refresh_expired'
        ? 'the refresh token expired, so it can no longer refresh itself'
        : value.reason === 'access_expired'
          ? 'the access token expired and no refresh token was stored'
          : 'no user token is stored'
    return `Feishu is not connected: ${why}. Run feishu_auth_start to authorize again.`
  }
  if (value.tokenState === 'refresh_pending') {
    const until = value.refreshExpiresAt
      ? `; the refresh token is valid until ${new Date(value.refreshExpiresAt).toISOString()}`
      : ''
    return `Feishu connected as ${who}, but the access token has expired and will be refreshed on the next call${until}.`
  }
  return `Feishu connected as ${who}`
}

export function registerFeishuAuthTools(ctx: Context, auth: FeishuAuthService): void {
  ctx.tools.register(
    defineTool({
      name: 'feishu_auth_start',
      description:
        'Start Feishu OAuth. Returns an authorization URL the user must open in a browser; after the loopback callback the tools use the stored user token. Ask the user before starting.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string' },
            state: { type: 'string' },
            expiresAt: { type: 'number' },
          },
        },
        render: (_args, value): ContentBlock[] => [
          text(`Open this URL to connect Feishu (expires at ${new Date(value.expiresAt ?? 0).toISOString()}):\n${value.url}`),
        ],
      },
      async execute() {
        return auth.startAuth()
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'feishu_auth_status',
      description:
        'Report whether a *usable* Feishu user token is stored, and which user/tenant it belongs to. Expiry-aware: a stored grant whose access token expired without a refresh token reports connected=false. Read-only.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            connected: { type: 'boolean' },
            tokenState: { type: 'string', enum: ['valid', 'refresh_pending', 'expired', 'none'] },
            reason: { type: 'string', enum: ['no_token', 'access_expired', 'refresh_expired'] },
            name: { type: 'string' },
            openId: { type: 'string' },
            expiresAt: { type: 'number' },
            refreshExpiresAt: { type: 'number' },
            scope: { type: 'string' },
          },
        },
        render: (_args, value): ContentBlock[] => [text(describeStatus(value))],
      },
      async execute() {
        return auth.status()
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'feishu_auth_disconnect',
      description: 'Delete the stored Feishu user token. Ask the user before disconnecting.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { disconnected: { type: 'boolean' } },
        },
        render: (): ContentBlock[] => [text('Feishu credentials removed.')],
      },
      async execute() {
        await auth.clear()
        return { disconnected: true }
      },
    }),
  )
}
