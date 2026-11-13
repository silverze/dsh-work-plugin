/**
 * Host-level Feishu flow: login cookie -> feishu/startAuth -> loopback callback
 * -> feishu/status -> feishu/shareArtifact, against mock-feishu.mjs.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = process.argv[2]
if (!base) throw new Error('usage: node feishu-rpc-flow.mjs <launch-url>')

const login = await fetch(base, { redirect: 'manual' })
const cookie = login.headers.get('set-cookie')?.split(';')[0]
if (!cookie) throw new Error(`login did not set a cookie (status ${login.status})`)

async function rpc(endpoint, args) {
  const rpcId = crypto.randomUUID()
  const response = await fetch(new URL(`/api/${endpoint}`, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
  })
  const payload = await response.json()
  if (!payload.result?.ok) throw new Error(`${endpoint}: ${JSON.stringify(payload.result)}`)
  return payload.result.value
}

const configured = await rpc('feishu/configureApp', { request: { appId: 'cli_mock', appSecret: 'mock_secret' } })
const appInfo = await rpc('feishu/appInfo', {})
if (!configured.configured || !appInfo.configured) throw new Error(`app config failed: ${JSON.stringify({ configured, appInfo })}`)
const started = await rpc('feishu/startAuth', {})
const authUrl = new URL(started.url)
const redirect = authUrl.searchParams.get('redirect_uri')
if (!redirect) throw new Error('startAuth omitted redirect_uri')
const callback = new URL(redirect)
callback.searchParams.set('code', 'mock-code')
callback.searchParams.set('state', started.state)
const exchanged = await fetch(callback)
if (exchanged.status !== 200) throw new Error(`callback failed: ${exchanged.status} ${await exchanged.text()}`)

const wiki = await rpc('feishu/wikiResolve', { request: { nodeToken: 'wikcnMock' } })
if (wiki.objType !== 'docx' || wiki.objToken !== 'doxcnMock') throw new Error(`bad wiki: ${JSON.stringify(wiki)}`)
const doc = await rpc('feishu/docRead', { request: { documentId: 'doxcnMock' } })
const sheet = await rpc('feishu/sheetRead', { request: { spreadsheetToken: 'shtMock' } })
const values = await rpc('feishu/sheetRead', { request: { spreadsheetToken: 'shtMock', range: 'Sheet1!A1:B1' } })
if (doc.content !== 'Mock document body' || sheet.sheets[0]?.title !== 'Sheet1' || values.values[0][0] !== 'a') {
  throw new Error(`bad reads: ${JSON.stringify({ doc, sheet, values })}`)
}
const status = await rpc('feishu/status', {})
if (!status.connected || status.name !== 'Mock User') throw new Error(`bad status: ${JSON.stringify(status)}`)

const root = await mkdtemp(join(tmpdir(), 'feishu-rpc-'))
try {
  const filePath = join(root, 'smoke.txt')
  await writeFile(filePath, 'host-level share')
  const shared = await rpc('feishu/shareArtifact', {
    request: { filePath, fileName: 'smoke.txt', mode: 'upload', chatId: 'oc_mock' },
  })
  if (shared.token !== 'file_mock' || shared.messageId !== 'om_mock') {
    throw new Error(`bad share: ${JSON.stringify(shared)}`)
  }
  console.log('PASS', JSON.stringify({ appInfo, wiki, doc, sheet, values, status, shared }))
} finally {
  await rm(root, { recursive: true, force: true })
}
