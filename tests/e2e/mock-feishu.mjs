/**
 * Minimal Feishu OpenAPI mock for Host-level integration checks.
 * Writes its port to PORT_FILE and exposes GET /__calls for assertions.
 */
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'

const calls = []
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks).toString('utf8')
  const url = new URL(req.url, 'http://127.0.0.1')
  calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: req.headers.authorization, contentType: req.headers['content-type'], body })

  const json = (status, value) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(value))
  }

  if (url.pathname === '/__calls') return json(200, calls)
  if (url.pathname === '/open-apis/authen/v2/oauth/token') {
    const parsed = JSON.parse(body || '{}')
    if (parsed.grant_type === 'authorization_code') {
      return json(200, { code: 0, access_token: 'at-mock', refresh_token: 'rt-mock', expires_in: 7200, scope: 'docx:document' })
    }
    return json(200, { code: 0, access_token: 'at-refreshed', refresh_token: 'rt-refreshed', expires_in: 7200 })
  }
  if (url.pathname === '/open-apis/authen/v1/user_info') {
    return json(200, { code: 0, data: { name: 'Mock User', open_id: 'ou_mock', tenant_key: 'tk_mock' } })
  }
  if (url.pathname === '/open-apis/wiki/v2/spaces/get_node') {
    return json(200, { code: 0, data: { node: { obj_type: 'docx', obj_token: 'doxcnMock' } } })
  }
  if (url.pathname === '/open-apis/docx/v1/documents/doxcnMock/raw_content') {
    return json(200, { code: 0, data: { content: 'Mock document body' } })
  }
  if (url.pathname === '/open-apis/sheets/v3/spreadsheets/shtMock/sheets/query') {
    return json(200, { code: 0, data: { sheets: [{ sheet_id: 's1', title: 'Sheet1', grid_properties: { row_count: 2, column_count: 2 } }] } })
  }
  if (url.pathname.startsWith('/open-apis/sheets/v2/spreadsheets/shtMock/values/')) {
    return json(200, { code: 0, data: { valueRange: { values: [['a', 1], ['b', 2]] } } })
  }
  if (url.pathname === '/open-apis/drive/v1/files/upload_all') {
    return json(200, { code: 0, data: { file_token: 'file_mock' } })
  }
  if (url.pathname === '/open-apis/im/v1/messages') {
    return json(200, { code: 0, data: { message_id: 'om_mock' } })
  }
  return json(404, { code: 404, msg: `unexpected ${url.pathname}` })
})

const port = Number(process.env.PORT ?? 0)
server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port
  if (process.env.PORT_FILE) writeFileSync(process.env.PORT_FILE, String(actual))
  console.log(`mock feishu on ${actual}`)
})
