import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FeishuHttpClient, markdownToBlocks } from '../../packages/host-feishu/lib/client.js'

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function withServer(handler, fn) {
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const url = new URL(req.url, 'http://127.0.0.1')
    const record = {
      method: req.method,
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: body.toString('utf8'),
      raw: body,
    }
    requests.push(record)
    try {
      await handler(record, res)
    } catch (error) {
      if (!res.headersSent) json(res, 500, { code: 500, msg: String(error?.message ?? error) })
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    return await fn({
      baseUrl: `http://127.0.0.1:${port}/open-apis`,
      requests,
    })
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

test('whoami sends the bearer token and reads identity', async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.method, 'GET')
      assert.equal(req.pathname, '/open-apis/authen/v1/user_info')
      assert.equal(req.headers.authorization, 'Bearer test-token')
      json(res, 200, {
        code: 0,
        data: { name: 'Alice', open_id: 'ou_1', union_id: 'on_1', tenant_key: 'tk_1' },
      })
    },
    async ({ baseUrl }) => {
      const client = new FeishuHttpClient({ baseUrl, accessToken: async () => 'test-token' })
      const me = await client.whoami()
      assert.equal(me.name, 'Alice')
      assert.equal(me.openId, 'ou_1')
      assert.equal(me.unionId, 'on_1')
      assert.equal(me.tenantKey, 'tk_1')
    },
  )
})

test('doc read, create, and append use the expected paths and block payloads', async () => {
  await withServer(
    (req, res) => {
      if (req.pathname === '/open-apis/docx/v1/documents/doc_1/raw_content') {
        json(res, 200, { code: 0, data: { content: '# Title\n\nHello' } })
        return
      }
      if (req.pathname === '/open-apis/docx/v1/documents' && req.method === 'POST') {
        const body = JSON.parse(req.body)
        assert.equal(body.title, 'Report')
        assert.equal(body.folder_token, 'fld_1')
        json(res, 200, { code: 0, data: { document: { document_id: 'doc_2' } } })
        return
      }
      if (req.pathname === '/open-apis/docx/v1/documents/doc_2/blocks') {
        json(res, 200, { code: 0, data: { items: [{ block_id: 'doc_2', block_type: 1 }] } })
        return
      }
      if (req.pathname === '/open-apis/docx/v1/documents/doc_2/blocks/doc_2/children') {
        assert.equal(req.query.document_revision_id, '-1')
        const body = JSON.parse(req.body)
        assert.equal(body.index, 0)
        assert.equal(body.children[0].block_type, 3)
        assert.equal(body.children[0].heading1.elements[0].text_run.content, 'Title')
        assert.equal(body.children[1].block_type, 12)
        assert.equal(body.children[2].block_type, 14)
        json(res, 200, { code: 0, data: {} })
        return
      }
      json(res, 404, { code: 404, msg: `unexpected ${req.method} ${req.pathname}` })
    },
    async ({ baseUrl }) => {
      const client = new FeishuHttpClient({ baseUrl, accessToken: async () => 'test-token' })
      const doc = await client.readDocument({ documentId: 'doc_1' })
      assert.equal(doc.content, '# Title\n\nHello')

      const created = await client.createDocument({ title: 'Report', folderToken: 'fld_1' })
      assert.equal(created.documentId, 'doc_2')
      assert.match(created.url, /doc_2$/)

      const appended = await client.appendDocument({
        documentId: 'doc_2',
        markdown: '# Title\n\n- bullet\n\n```\ncode\n```',
      })
      assert.equal(appended.appended, 3)
    },
  )
})

test('sheets read/write/append map to v2 valueRange calls', async () => {
  await withServer(
    (req, res) => {
      if (req.pathname.endsWith('/values/Sheet1!A1%3AB2') || req.pathname.endsWith('/values/Sheet1!A1:B2')) {
        json(res, 200, { code: 0, data: { valueRange: { values: [['a', 1], ['b', 2]] } } })
        return
      }
      if (req.pathname.endsWith('/values') && req.method === 'PUT') {
        const body = JSON.parse(req.body)
        assert.equal(body.valueRange.range, 'Sheet1!A1:B2')
        assert.deepEqual(body.valueRange.values, [[1, 2]])
        json(res, 200, { code: 0, data: { updatedCells: 2 } })
        return
      }
      if (req.pathname.endsWith('/values_append') && req.method === 'POST') {
        const body = JSON.parse(req.body)
        assert.equal(body.valueRange.range, 'Sheet1!A1:B2')
        json(res, 200, { code: 0, data: { updatedCells: 2 } })
        return
      }
      json(res, 404, { code: 404, msg: 'unexpected' })
    },
    async ({ baseUrl }) => {
      const client = new FeishuHttpClient({ baseUrl, accessToken: async () => 'test-token' })
      const read = await client.readSheet({ spreadsheetToken: 'sht_1', range: 'Sheet1!A1:B2' })
      assert.deepEqual(read.values, [['a', 1], ['b', 2]])
      const written = await client.writeSheet({
        spreadsheetToken: 'sht_1',
        range: 'Sheet1!A1:B2',
        values: [[1, 2]],
      })
      assert.equal(written.updatedCells, 2)
      const appended = await client.appendSheet({
        spreadsheetToken: 'sht_1',
        range: 'Sheet1!A1:B2',
        values: [[3, 4]],
      })
      assert.equal(appended.updatedCells, 2)
    },
  )
})

test('message send wraps text and upload sends multipart fields', async () => {
  await withServer(
    (req, res) => {
      if (req.pathname === '/open-apis/im/v1/messages') {
        assert.equal(req.query.receive_id_type, 'chat_id')
        const body = JSON.parse(req.body)
        assert.equal(body.receive_id, 'oc_1')
        assert.equal(body.msg_type, 'text')
        assert.deepEqual(JSON.parse(body.content), { text: 'hello' })
        json(res, 200, { code: 0, data: { message_id: 'om_1' } })
        return
      }
      if (req.pathname === '/open-apis/drive/v1/files/upload_all') {
        assert.match(req.headers['content-type'], /multipart\/form-data/)
        assert.match(req.body, /file_name/)
        assert.match(req.body, /report\.txt/)
        json(res, 200, { code: 0, data: { file_token: 'file_1' } })
        return
      }
      json(res, 404, { code: 404, msg: 'unexpected' })
    },
    async ({ baseUrl }) => {
      const client = new FeishuHttpClient({ baseUrl, accessToken: async () => 'test-token' })
      const sent = await client.sendMessage({
        receiveId: 'oc_1',
        receiveIdType: 'chat_id',
        msgType: 'text',
        content: JSON.stringify({ text: 'hello' }),
      })
      assert.equal(sent.messageId, 'om_1')

      const root = await mkdtemp(join(tmpdir(), 'feishu-upload-'))
      try {
        const path = join(root, 'report.txt')
        await writeFile(path, 'hello feishu')
        const uploaded = await client.uploadFile({ filePath: path, fileName: 'report.txt' })
        assert.equal(uploaded.fileToken, 'file_1')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})


test('importDocument uploads, creates a ticket, and polls to a native doc URL', async () => {
  await withServer(
    (req, res) => {
      if (req.pathname === '/open-apis/drive/v1/files/upload_all') {
        json(res, 200, { code: 0, data: { file_token: 'file_import_1' } })
        return
      }
      if (req.pathname === '/open-apis/drive/v1/import_tasks' && req.method === 'POST') {
        const body = JSON.parse(req.body)
        assert.equal(body.file_token, 'file_import_1')
        assert.equal(body.file_extension, 'docx')
        assert.equal(body.type, 'docx')
        json(res, 200, { code: 0, data: { ticket: 'ticket_1' } })
        return
      }
      if (req.pathname === '/open-apis/drive/v1/import_tasks/ticket_1') {
        json(res, 200, {
          code: 0,
          data: { result: { token: 'doc_token_1', url: 'https://feishu.cn/docx/doc_token_1' } },
        })
        return
      }
      json(res, 404, { code: 404, msg: 'unexpected' })
    },
    async ({ baseUrl }) => {
      const root = await mkdtemp(join(tmpdir(), 'feishu-import-'))
      try {
        const path = join(root, 'report.docx')
        await writeFile(path, 'fake docx')
        const client = new FeishuHttpClient({ baseUrl, accessToken: async () => 'test-token' })
        const result = await client.importDocument({
          filePath: path,
          fileName: 'report.docx',
          fileExtension: 'docx',
        })
        assert.equal(result.ticket, 'ticket_1')
        assert.equal(result.status, 'done')
        assert.equal(result.url, 'https://feishu.cn/docx/doc_token_1')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})

test('403 maps to feishu_permission_denied without retry', async () => {
  await withServer(
    (_req, res) => json(res, 403, { code: 99991672, msg: 'no permission' }),
    async ({ baseUrl }) => {
      const client = new FeishuHttpClient({ baseUrl, accessToken: async () => 'test-token' })
      await assert.rejects(
        client.whoami(),
        (error) => error.code === 'feishu_permission_denied' && error.retryable === false,
      )
    },
  )
})

test('429 is retried once and then succeeds', async () => {
  let attempts = 0
  await withServer(
    (_req, res) => {
      attempts += 1
      if (attempts === 1) {
        json(res, 429, { code: 99991400, msg: 'rate limited' })
        return
      }
      json(res, 200, { code: 0, data: { name: 'Alice', open_id: 'ou_1' } })
    },
    async ({ baseUrl }) => {
      const client = new FeishuHttpClient({
        baseUrl,
        accessToken: async () => 'test-token',
        maxRetries: 1,
        retryDelayMs: 1,
      })
      const me = await client.whoami()
      assert.equal(me.openId, 'ou_1')
      assert.equal(attempts, 2)
    },
  )
})

test('missing token reports feishu_not_connected before any request', async () => {
  let called = false
  await withServer(
    (_req, res) => {
      called = true
      json(res, 200, { code: 0, data: {} })
    },
    async ({ baseUrl }) => {
      const client = new FeishuHttpClient({ baseUrl, accessToken: async () => undefined })
      await assert.rejects(client.whoami(), (error) => error.code === 'feishu_not_connected')
      assert.equal(called, false)
    },
  )
})

test('markdownToBlocks handles headings, bullets, code, and paragraphs', () => {
  const blocks = markdownToBlocks('# H1\n\n- item\n\n1. first\n\n```js\nconst x = 1\n```\n\nplain')
  assert.deepEqual(
    blocks.map((block) => block.block_type),
    [3, 12, 13, 14, 2],
  )
})
