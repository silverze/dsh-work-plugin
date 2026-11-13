import test from 'node:test'
import assert from 'node:assert/strict'

import { registerFeishuTools } from '../../packages/host-feishu/lib/index.js'

function harness(client) {
  const tools = new Map()
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  registerFeishuTools(ctx, client)
  return tools
}

const exec = { signal: new AbortController().signal }

test('feishu_doc_read truncates at maxChars and reports it', async () => {
  const tools = harness({
    async readDocument() {
      return { documentId: 'd1', content: '0123456789abcdef', url: 'https://feishu.cn/docx/d1' }
    },
  })
  const result = await tools.get('feishu_doc_read').execute(
    { documentId: 'd1', maxChars: 10 },
    exec,
  )
  assert.equal(result.content, '0123456789')
  assert.equal(result.truncated, true)
  assert.equal(result.url, 'https://feishu.cn/docx/d1')
})

test('feishu_sheet_read returns metadata or values', async () => {
  const tools = harness({
    async readSheet(input) {
      if (!input.range) {
        return { spreadsheetToken: input.spreadsheetToken, sheets: [{ sheetId: 's1', title: 'Sheet1', rowCount: 2, columnCount: 2 }] }
      }
      return { range: input.range, values: [['a', 1]] }
    },
  })
  const meta = await tools.get('feishu_sheet_read').execute({ spreadsheetToken: 't1' }, exec)
  assert.equal(meta.sheets[0].title, 'Sheet1')
  const values = await tools.get('feishu_sheet_read').execute({ spreadsheetToken: 't1', range: 'Sheet1!A1:B1' }, exec)
  assert.deepEqual(values.values, [['a', 1]])
})

test('feishu_im_send wraps plain text but passes interactive JSON through', async () => {
  const calls = []
  const tools = harness({
    async sendMessage(input) {
      calls.push(input)
      return { messageId: 'om_1' }
    },
  })
  await tools.get('feishu_im_send').execute(
    { receiveId: 'oc_1', receiveIdType: 'chat_id', msgType: 'text', content: 'hello' },
    exec,
  )
  assert.deepEqual(JSON.parse(calls[0].content), { text: 'hello' })
  await tools.get('feishu_im_send').execute(
    { receiveId: 'oc_1', receiveIdType: 'chat_id', msgType: 'interactive', content: '{"a":1}' },
    exec,
  )
  assert.equal(calls[1].content, '{"a":1}')
})

test('feishu_doc_create and append map to the client contract', async () => {
  const calls = []
  const tools = harness({
    async createDocument(input) {
      calls.push(['create', input])
      return { documentId: 'd2', url: 'https://feishu.cn/docx/d2' }
    },
    async appendDocument(input) {
      calls.push(['append', input])
      return { documentId: input.documentId, appended: 2, failed: 0 }
    },
  })
  const created = await tools.get('feishu_doc_create').execute({ title: 'Report' }, exec)
  assert.equal(created.documentId, 'd2')
  const appended = await tools.get('feishu_doc_append').execute(
    { documentId: 'd2', markdown: '# Title\n\nbody' },
    exec,
  )
  assert.equal(appended.appended, 2)
  assert.equal(calls[1][1].markdown, '# Title\n\nbody')
})

test('feishu_whoami returns identity fields', async () => {
  const tools = harness({
    async whoami() {
      return { openId: 'ou_1', name: 'Alice', unionId: 'on_1' }
    },
  })
  const me = await tools.get('feishu_whoami').execute({}, exec)
  assert.deepEqual(me, { openId: 'ou_1', name: 'Alice', unionId: 'on_1' })
})

test('feishu_wiki_get resolves a node token', async () => {
  const tools = harness({
    async resolveWikiNode(token) {
      assert.equal(token, 'w1')
      return { objType: 'docx', objToken: 'd1' }
    },
  })
  const node = await tools.get('feishu_wiki_get').execute({ nodeToken: 'w1' }, exec)
  assert.deepEqual(node, { objType: 'docx', objToken: 'd1' })
})
