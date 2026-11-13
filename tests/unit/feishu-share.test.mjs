import test from 'node:test'
import assert from 'node:assert/strict'

import { registerFeishuShareTool } from '../../packages/host-feishu/lib/share.js'

function makeCtx() {
  const tools = new Map()
  const artifacts = new Map([
    ['a1', { id: 'a1', path: '/tmp/report.docx', kind: 'docx' }],
  ])
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    get(name) {
      if (name === 'workArtifacts') {
        return { get: async (id) => artifacts.get(id) }
      }
      return undefined
    },
  }
  return { ctx, tools }
}

function makeClient() {
  const calls = []
  return {
    calls,
    client: {
      async uploadFile(input) {
        calls.push(['upload', input])
        return { fileToken: 'file_1', url: 'https://feishu.cn/file/file_1' }
      },
      async importDocument(input) {
        calls.push(['import', input])
        return { ticket: 'ticket_1', status: 'done', url: 'https://feishu.cn/docx/doc_1' }
      },
      async sendMessage(input) {
        calls.push(['send', input])
        return { messageId: 'om_1' }
      },
    },
  }
}

test('auto mode imports a docx artifact and sends a card', async () => {
  const { ctx, tools } = makeCtx()
  const { client, calls } = makeClient()
  registerFeishuShareTool(ctx, client)

  const result = await tools.get('feishu_share_artifact').execute(
    { artifactId: 'a1', chatId: 'oc_1', mode: 'auto', title: '项目周报' },
    { signal: new AbortController().signal },
  )

  assert.equal(result.mode, 'import')
  assert.equal(result.token, 'ticket_1')
  assert.equal(result.url, 'https://feishu.cn/docx/doc_1')
  assert.equal(result.messageId, 'om_1')
  assert.equal(calls[0][0], 'import')
  assert.equal(calls[0][1].fileName, 'report.docx')
  assert.equal(calls[0][1].fileExtension, 'docx')
  assert.equal(calls[1][0], 'send')
  assert.equal(calls[1][1].msgType, 'interactive')
  const card = JSON.parse(calls[1][1].content)
  assert.equal(card.header.title.content, '项目周报')
  assert.match(card.elements[0].content, /report\.docx/)
})

test('upload mode shares an arbitrary file without a card', async () => {
  const { ctx, tools } = makeCtx()
  const { client, calls } = makeClient()
  registerFeishuShareTool(ctx, client)

  const result = await tools.get('feishu_share_artifact').execute(
    { filePath: '/tmp/data.csv', fileName: 'data.csv', mode: 'upload' },
    { signal: new AbortController().signal },
  )

  assert.equal(result.mode, 'upload')
  assert.equal(result.token, 'file_1')
  assert.equal(result.messageId, undefined)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'upload')
})

test('a missing file path and artifact id is rejected', async () => {
  const { ctx, tools } = makeCtx()
  const { client } = makeClient()
  registerFeishuShareTool(ctx, client)

  await assert.rejects(
    tools.get('feishu_share_artifact').execute({ mode: 'auto' }, { signal: new AbortController().signal }),
    /requires artifactId or filePath/,
  )
})

test('import mode rejects a non-importable extension', async () => {
  const { ctx, tools } = makeCtx()
  const { client } = makeClient()
  registerFeishuShareTool(ctx, client)

  await assert.rejects(
    tools.get('feishu_share_artifact').execute(
      { filePath: '/tmp/data.csv', fileName: 'data.csv', mode: 'import' },
      { signal: new AbortController().signal },
    ),
    /cannot import/,
  )
})
