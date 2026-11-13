import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { FeishuAuthService } from '../../packages/host-feishu/lib/auth.js'

class FakeCredentials {
  constructor() {
    this.records = new Map()
  }

  async readRecord(key) {
    return this.records.get(String(key))
  }

  async modifyRecord(key, mutate) {
    const current = this.records.get(String(key))
    const next = await mutate(current)
    if (next !== undefined) this.records.set(String(key), next)
    return next
  }

  async deleteRecord(key) {
    this.records.delete(String(key))
  }
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function startOpenApi() {
  const calls = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    calls.push({ method: req.method, url: req.url, headers: req.headers, body })

    if (req.url === '/open-apis/authen/v2/oauth/token') {
      const parsed = JSON.parse(body)
      if (parsed.grant_type === 'authorization_code') {
        assert.equal(parsed.client_id, 'cli_test')
        assert.equal(parsed.client_secret, 'secret')
        assert.equal(parsed.code, 'code-1')
        json(res, 200, {
          code: 0,
          access_token: 'at-1',
          refresh_token: 'rt-1',
          expires_in: 7200,
          scope: 'docx:document',
        })
        return
      }
      assert.equal(parsed.grant_type, 'refresh_token')
      assert.equal(parsed.refresh_token, 'rt-1')
      json(res, 200, {
        code: 0,
        access_token: 'at-2',
        refresh_token: 'rt-2',
        expires_in: 7200,
      })
      return
    }

    if (req.url === '/open-apis/authen/v1/user_info') {
      assert.equal(req.headers.authorization, 'Bearer at-1')
      json(res, 200, { code: 0, data: { name: 'Alice', open_id: 'ou-1', union_id: 'on-1' } })
      return
    }

    json(res, 404, { code: 404, msg: `unexpected ${req.url}` })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    calls,
    baseUrl: `http://127.0.0.1:${server.address().port}/open-apis`,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

test('OAuth callback exchanges code, stores a grant, and reports status', async () => {
  const openapi = await startOpenApi()
  const credentials = new FakeCredentials()
  const callbackPort = await freePort()
  const auth = new FeishuAuthService(
    { credentials },
    {
      appId: 'cli_test',
      appSecret: 'secret',
      redirectUri: `http://127.0.0.1:${callbackPort}/feishu/oauth/callback`,
      openApiBaseUrl: openapi.baseUrl,
      scopes: ['docx:document'],
    },
  )

  try {
    const started = await auth.startAuth()
    const url = new URL(started.url)
    assert.equal(url.searchParams.get('client_id'), 'cli_test')
    assert.equal(url.searchParams.get('state'), started.state)
    assert.equal(url.searchParams.get('scope'), 'docx:document')
    assert.match(url.searchParams.get('redirect_uri') ?? '', /feishu\/oauth\/callback$/)

    const callback = await fetch(
      `http://127.0.0.1:${callbackPort}/feishu/oauth/callback?code=code-1&state=${started.state}`,
      { signal: AbortSignal.timeout(5000) },
    )
    assert.equal(callback.status, 200)
    assert.match(await callback.text(), /Feishu connected/)

    const status = await auth.status()
    assert.equal(status.connected, true)
    assert.equal(status.name, 'Alice')
    assert.equal(status.openId, 'ou-1')
    assert.equal(await auth.getAccessToken(), 'at-1')
    assert.equal(openapi.calls.filter((call) => call.url.endsWith('/oauth/token')).length, 1)
  } finally {
    auth.close()
    await openapi.close()
  }
})

test('expired grant refreshes and rotates the refresh token', async () => {
  const openapi = await startOpenApi()
  const credentials = new FakeCredentials()
  credentials.records.set('dsh-work-feishu/user-token', {
    kind: 'grant',
    payload: {
      accessToken: 'old',
      refreshToken: 'rt-1',
      expiresAt: Date.now() - 1000,
      name: 'Alice',
      openId: 'ou-1',
    },
  })
  const auth = new FeishuAuthService(
    { credentials },
    { appId: 'cli_test', appSecret: 'secret', openApiBaseUrl: openapi.baseUrl },
  )

  try {
    assert.equal(await auth.getAccessToken(), 'at-2')
    const stored = credentials.records.get('dsh-work-feishu/user-token')
    assert.equal(stored.payload.accessToken, 'at-2')
    assert.equal(stored.payload.refreshToken, 'rt-2')
    assert.equal(stored.payload.name, 'Alice')
  } finally {
    auth.close()
    await openapi.close()
  }
})

test('authorization without app credentials fails before opening a port', async () => {
  const auth = new FeishuAuthService(
    { credentials: new FakeCredentials() },
    { redirectUri: 'http://127.0.0.1:1/feishu/oauth/callback' },
  )
  const savedId = process.env.FEISHU_APP_ID
  const savedSecret = process.env.FEISHU_APP_SECRET
  delete process.env.FEISHU_APP_ID
  delete process.env.FEISHU_APP_SECRET
  try {
    await assert.rejects(auth.startAuth(), /FEISHU_APP_ID/)
  } finally {
    if (savedId !== undefined) process.env.FEISHU_APP_ID = savedId
    if (savedSecret !== undefined) process.env.FEISHU_APP_SECRET = savedSecret
    auth.close()
  }
})

test('configureApp stores app credentials and appInfo masks the id', async () => {
  const credentials = new FakeCredentials()
  const service = new FeishuAuthService({ credentials }, { redirectUri: 'http://127.0.0.1:1/feishu/oauth/callback' })

  assert.deepEqual(await service.appInfo(), { configured: false })
  await assert.rejects(service.configureApp('', 'secret'), /required/)
  await service.configureApp('cli_1234567890', 'secret')

  const info = await service.appInfo()
  assert.equal(info.configured, true)
  assert.match(info.appId, /^cli_12/)
  assert.match(info.appId, /7890$/)

  const record = credentials.records.get('dsh-work-feishu/app')
  assert.equal(record.kind, 'grant')
  assert.equal(record.payload.appId, 'cli_1234567890')
})

test('access-only grant works until expiry and then asks for reconnect', async () => {
  const credentials = new FakeCredentials()
  credentials.records.set('dsh-work-feishu/user-token', {
    kind: 'grant',
    payload: { accessToken: 'at-only', expiresAt: Date.now() + 120_000 },
  })
  const auth = new FeishuAuthService({ credentials }, {})
  assert.equal((await auth.status()).connected, true)
  assert.equal(await auth.getAccessToken(), 'at-only')

  credentials.records.set('dsh-work-feishu/user-token', {
    kind: 'grant',
    payload: { accessToken: 'at-only', expiresAt: Date.now() - 1000 },
  })
  await assert.rejects(auth.getAccessToken(), /without refresh_token/)
})

test('status reports an expired grant without refresh token as disconnected', async () => {
  const credentials = new FakeCredentials()
  credentials.records.set('dsh-work-feishu/user-token', {
    kind: 'grant',
    payload: { accessToken: 'at-only', expiresAt: Date.now() - 1000, name: 'Alice', openId: 'ou-1' },
  })
  const auth = new FeishuAuthService({ credentials }, {})

  const status = await auth.status()
  assert.equal(status.connected, false)
  assert.equal(status.tokenState, 'expired')
  assert.equal(status.reason, 'access_expired')
  assert.equal(status.name, 'Alice')
})

test('status reports a grant whose refresh token expired as disconnected', async () => {
  const credentials = new FakeCredentials()
  credentials.records.set('dsh-work-feishu/user-token', {
    kind: 'grant',
    payload: {
      accessToken: 'at-old',
      refreshToken: 'rt-old',
      expiresAt: Date.now() - 1000,
      refreshExpiresAt: Date.now() - 500,
    },
  })
  const auth = new FeishuAuthService({ credentials }, {})

  const status = await auth.status()
  assert.equal(status.connected, false)
  assert.equal(status.tokenState, 'expired')
  assert.equal(status.reason, 'refresh_expired')
})

test('status marks an expired but refreshable grant as refresh_pending', async () => {
  const credentials = new FakeCredentials()
  const refreshExpiresAt = Date.now() + 86_400_000
  credentials.records.set('dsh-work-feishu/user-token', {
    kind: 'grant',
    payload: {
      accessToken: 'at-old',
      refreshToken: 'rt-live',
      expiresAt: Date.now() - 1000,
      refreshExpiresAt,
    },
  })
  const auth = new FeishuAuthService({ credentials }, {})

  const status = await auth.status()
  assert.equal(status.connected, true)
  assert.equal(status.tokenState, 'refresh_pending')
  assert.equal(status.refreshExpiresAt, refreshExpiresAt)
  assert.equal(status.reason, undefined)
})

test('status reports a missing token as none/no_token', async () => {
  const auth = new FeishuAuthService({ credentials: new FakeCredentials() }, {})
  const status = await auth.status()
  assert.equal(status.connected, false)
  assert.equal(status.tokenState, 'none')
  assert.equal(status.reason, 'no_token')
})
