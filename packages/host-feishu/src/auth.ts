/**
 * Feishu OAuth (authorization code) + token persistence.
 *
 * The callback is a loopback HTTP server on the redirect URI's host/port. The
 * browser authorizes, Feishu redirects to the loopback, and the code is
 * exchanged for a user access token and refresh token. Tokens live in the DSH
 * credentials store under `dsh-work-feishu/user-token`; `getAccessToken()` refreshes
 * on demand under the credentials store's serialized modify lock.
 */

import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'

import type { Context } from '@deepseek-ai/cordis'
import { credentialKey, type CredentialKey } from '@deepseek-ai/dsh-credentials'

import { FeishuError, mapFeishuError } from './errors.js'
import { FeishuHttpClient } from './feishu-client.js'

export interface FeishuAuthConfig {
  appId?: string
  appSecret?: string
  redirectUri?: string
  scopes?: string[]
  /** OpenAPI root (token exchange + user_info); tests override. */
  openApiBaseUrl?: string
  /** Accounts host for the authorization page; tests do not open it. */
  authBaseUrl?: string
  /** How long an uncompleted authorization stays open. */
  pendingTtlMs?: number
}

export interface FeishuGrant {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  refreshExpiresAt?: number
  scope?: string
  openId?: string
  unionId?: string
  name?: string
}

interface FeishuTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  refresh_token_expires_in?: number
  scope?: string
}

export interface FeishuAuthStatus {
  /** True only when a usable token exists: valid now, or expired but refreshable. */
  connected: boolean
  /** `valid` = access token usable; `refresh_pending` = expired but refreshable; `expired` = needs re-authorization. */
  tokenState: 'valid' | 'refresh_pending' | 'expired' | 'none'
  /** Why the connection is not usable; present only when `connected` is false. */
  reason?: 'no_token' | 'access_expired' | 'refresh_expired'
  name?: string
  openId?: string
  expiresAt?: number
  refreshExpiresAt?: number
  scope?: string
}

const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:17321/feishu/oauth/callback'
const DEFAULT_TTL_MS = 10 * 60 * 1000

export class FeishuAuthService {
  private readonly key: CredentialKey
  private readonly appKey: CredentialKey
  private server?: Server
  private pending?: { state: string; url: string; expiresAt: number; timer: NodeJS.Timeout }

  constructor(
    private readonly ctx: Context,
    private readonly config: FeishuAuthConfig = {},
  ) {
    this.key = credentialKey('dsh-work-feishu', 'user-token')
    this.appKey = credentialKey('dsh-work-feishu', 'app')
  }

  private async appCredentials(): Promise<{ appId?: string; appSecret?: string }> {
    const record = await this.ctx.credentials.readRecord(this.appKey).catch(() => undefined)
    const payload = record?.kind === 'grant' ? (record.payload as { appId?: string; appSecret?: string }) : undefined
    return {
      appId: this.config.appId ?? payload?.appId ?? process.env.FEISHU_APP_ID,
      appSecret: this.config.appSecret ?? payload?.appSecret ?? process.env.FEISHU_APP_SECRET,
    }
  }

  /** Persist the self-built app credentials in the DSH credential store. */
  async configureApp(appId: string, appSecret: string): Promise<{ configured: true }> {
    const id = appId.trim()
    const secret = appSecret.trim()
    if (!id || !secret) throw new Error('Feishu app id and app secret are required')
    await this.ctx.credentials.modifyRecord(this.appKey, async () => ({
      kind: 'grant',
      payload: { appId: id, appSecret: secret },
    }))
    return { configured: true }
  }

  async appInfo(): Promise<{ configured: boolean; appId?: string }> {
    const { appId, appSecret } = await this.appCredentials()
    if (!appId || !appSecret) return { configured: false }
    const masked = appId.length > 8 ? `${appId.slice(0, 6)}…${appId.slice(-4)}` : appId
    return { configured: true, appId: masked }
  }

  private get redirectUri(): string {
    return this.config.redirectUri ?? process.env.FEISHU_REDIRECT_URI ?? DEFAULT_REDIRECT_URI
  }

  private get scopes(): string[] {
    if (this.config.scopes?.length) return this.config.scopes
    return (process.env.FEISHU_SCOPES ?? '')
      .split(/\s+/)
      .filter(Boolean)
  }

  private get openApiBaseUrl(): string {
    return (this.config.openApiBaseUrl ?? 'https://open.feishu.cn/open-apis').replace(/\/$/, '')
  }

  private get authBaseUrl(): string {
    return (this.config.authBaseUrl ?? 'https://accounts.feishu.cn').replace(/\/$/, '')
  }

  private async requireCredentials(): Promise<{ appId: string; appSecret: string }> {
    const { appId, appSecret } = await this.appCredentials()
    if (!appId || !appSecret) {
      throw new FeishuError(
        'feishu_not_connected',
        'Feishu app credentials are missing. Set them in Settings → Feishu, or via FEISHU_APP_ID / FEISHU_APP_SECRET.',
      )
    }
    return { appId, appSecret }
  }

  async readGrant(): Promise<FeishuGrant | undefined> {
    const record = await this.ctx.credentials.readRecord(this.key)
    if (!record || record.kind !== 'grant') return undefined
    const payload = record.payload as FeishuGrant | undefined
    if (!payload?.accessToken) return undefined
    return payload
  }

  private async writeGrant(grant: FeishuGrant): Promise<void> {
    await this.ctx.credentials.modifyRecord(this.key, async () => ({
      kind: 'grant',
      payload: grant,
    }))
  }

  async clear(): Promise<void> {
    await this.ctx.credentials.deleteRecord(this.key)
  }

  /**
   * Expiry-aware status. A stored grant is not the same as a usable token: a
   * grant whose access token expired and whose refresh token is gone cannot
   * authenticate anything, so it must not report `connected: true`.
   */
  async status(): Promise<FeishuAuthStatus> {
    const grant = await this.readGrant()
    if (!grant) return { connected: false, tokenState: 'none', reason: 'no_token' }

    const now = Date.now()
    const accessValid = grant.expiresAt > now
    const refreshUsable =
      Boolean(grant.refreshToken) && (!grant.refreshExpiresAt || grant.refreshExpiresAt > now)
    const base = {
      ...(grant.name ? { name: grant.name } : {}),
      ...(grant.openId ? { openId: grant.openId } : {}),
      expiresAt: grant.expiresAt,
      ...(grant.refreshExpiresAt ? { refreshExpiresAt: grant.refreshExpiresAt } : {}),
      ...(grant.scope ? { scope: grant.scope } : {}),
    }

    if (accessValid) return { connected: true, tokenState: 'valid', ...base }
    if (refreshUsable) return { connected: true, tokenState: 'refresh_pending', ...base }
    return {
      connected: false,
      tokenState: 'expired',
      reason: grant.refreshToken ? 'refresh_expired' : 'access_expired',
      ...base,
    }
  }

  /** Current user token, refreshing it when it is close to expiry. */
  async getAccessToken(): Promise<string | undefined> {
    const grant = await this.readGrant()
    if (!grant) return undefined
    if (grant.expiresAt > Date.now() + 60_000) return grant.accessToken

    if (!grant.refreshToken) {
      throw new FeishuError(
        'feishu_token_expired',
        'Feishu token expired without refresh_token; reconnect Feishu with offline_access scope.',
      )
    }
    if (grant.refreshExpiresAt && grant.refreshExpiresAt < Date.now()) {
      await this.clear()
      return undefined
    }

    try {
      const refreshed = await this.exchange({
        grant_type: 'refresh_token',
        refresh_token: grant.refreshToken,
      })
      const next = this.grantFromToken(refreshed, grant)
      await this.writeGrant(next)
      return next.accessToken
    } catch (error) {
      await this.clear()
      throw error
    }
  }

  /**
   * Start a loopback authorization. Returns the URL the user must open; the
   * callback completes asynchronously, after which `status()` reports connected.
   */
  async startAuth(): Promise<{ url: string; state: string; expiresAt: number }> {
    if (this.pending && this.pending.expiresAt > Date.now()) {
      return { url: this.pending.url, state: this.pending.state, expiresAt: this.pending.expiresAt }
    }

    const { appId } = await this.requireCredentials()
    const redirect = new URL(this.redirectUri)
    const port = Number(redirect.port || (redirect.protocol === 'https:' ? 443 : 80))
    const path = redirect.pathname
    const state = randomBytes(16).toString('hex')
    const expiresAt = Date.now() + (this.config.pendingTtlMs ?? DEFAULT_TTL_MS)

    const url = new URL(`${this.authBaseUrl}/open-apis/authen/v1/authorize`)
    url.searchParams.set('client_id', appId)
    url.searchParams.set('redirect_uri', this.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', state)
    if (this.scopes.length) url.searchParams.set('scope', this.scopes.join(' '))

    const server = createServer((request, response) => {
      void this.handleCallback(request, response, state, path)
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening)
        reject(
          new FeishuError(
            'feishu_auth_port_busy',
            `Cannot listen on ${redirect.host} for the Feishu callback: ${error.message}`,
          ),
        )
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, redirect.hostname)
    })

    this.server = server
    const timer = setTimeout(() => {
      this.closePending()
    }, this.config.pendingTtlMs ?? DEFAULT_TTL_MS)
    timer.unref?.()
    this.pending = { state, url: url.toString(), expiresAt, timer }

    return { url: url.toString(), state, expiresAt }
  }

  private async handleCallback(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
    expectedState: string,
    path: string,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', this.redirectUri)
    if (url.pathname !== path) {
      response.writeHead(404).end('not found')
      return
    }

    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!code || state !== expectedState) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<h1>Feishu authorization failed</h1><p>Invalid state or missing code.</p>')
      return
    }

    try {
      const token = await this.exchange({ grant_type: 'authorization_code', code })
      const grant = this.grantFromToken(token)
      await this.writeGrant(grant)

      const client = new FeishuHttpClient({
        baseUrl: this.openApiBaseUrl,
        accessToken: async () => grant.accessToken,
      })
      const identity = await client.whoami().catch(() => undefined)
      if (identity) {
        grant.name = identity.name
        grant.openId = identity.openId
        if (identity.unionId) grant.unionId = identity.unionId
        await this.writeGrant(grant)
      }

      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        '<h1>Feishu connected</h1><p>You can close this tab and return to DSH Work.</p>',
      )
      this.closePending()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      response.writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<h1>Feishu authorization failed</h1><p>${escapeHtml(message)}</p>`)
    }
  }

  private async exchange(payload: Record<string, string>): Promise<FeishuTokenResponse> {
    const { appId, appSecret } = await this.requireCredentials()
    const response = await fetch(`${this.openApiBaseUrl}/authen/v2/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: appId,
        client_secret: appSecret,
        ...payload,
        ...(payload.grant_type === 'authorization_code' ? { redirect_uri: this.redirectUri } : {}),
      }),
    })
    const text = await response.text()
    let body: Record<string, unknown> | undefined
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined
    } catch {
      body = undefined
    }
    const code = typeof body?.code === 'number' ? body.code : undefined
    if (!response.ok || (code !== undefined && code !== 0)) {
      throw mapFeishuError({
        status: response.status,
        ...(code !== undefined ? { code } : {}),
        message: typeof body?.msg === 'string' ? body.msg : text.slice(0, 500) || 'OAuth exchange failed',
      })
    }
    const rawData = body?.data
    let parsedData: Record<string, unknown> | undefined
    if (typeof rawData === 'string') {
      try {
        parsedData = JSON.parse(rawData) as Record<string, unknown>
      } catch {
        parsedData = undefined
      }
    } else if (rawData && typeof rawData === 'object') {
      parsedData = rawData as Record<string, unknown>
    }
    const data = parsedData ?? body ?? {}
    return data as FeishuTokenResponse
  }

  private grantFromToken(token: FeishuTokenResponse, previous?: FeishuGrant): FeishuGrant {
    const accessToken = token.access_token ?? ''
    const refreshToken = token.refresh_token ?? previous?.refreshToken
    if (!accessToken) {
      throw new FeishuError(
        'feishu_unknown',
        'Feishu OAuth response omitted access_token; check the app credentials and authorization code.',
      )
    }
    const now = Date.now()
    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      expiresAt: now + (token.expires_in ?? 7200) * 1000,
      ...(token.refresh_token_expires_in
        ? { refreshExpiresAt: now + token.refresh_token_expires_in * 1000 }
        : {}),
      ...(token.scope ?? previous?.scope ? { scope: token.scope ?? previous?.scope } : {}),
      ...(previous?.openId ? { openId: previous.openId } : {}),
      ...(previous?.unionId ? { unionId: previous.unionId } : {}),
      ...(previous?.name ? { name: previous.name } : {}),
    }
  }

  private closePending(): void {
    if (this.pending) clearTimeout(this.pending.timer)
    this.pending = undefined
    this.server?.close()
    this.server = undefined
  }

  close(): void {
    this.closePending()
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}
