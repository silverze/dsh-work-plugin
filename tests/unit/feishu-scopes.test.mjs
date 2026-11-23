import test from 'node:test'
import assert from 'node:assert/strict'

import { grantedScopes, missingScopes } from '../../packages/host-feishu/lib/index.js'

test('a parent scope covers its children', () => {
  const granted = grantedScopes('im:message docx:document offline_access')
  const gaps = missingScopes(granted).map((gap) => gap.tool)
  assert.ok(gaps.includes('feishu_task_create'))
  assert.ok(!gaps.includes('feishu_im_send'))
  assert.ok(!gaps.includes('feishu_doc_read'))
})

test('every tool gap lists only the scopes it actually needs', () => {
  const gaps = missingScopes([])
  const tasks = gaps.find((gap) => gap.tool === 'feishu_task_list_mine')
  assert.deepEqual(tasks, { tool: 'feishu_task_list_mine', scopes: ['task:task:read'] })
  const share = gaps.find((gap) => gap.tool === 'feishu_share_artifact')
  assert.deepEqual(share?.scopes, ['drive:drive', 'docx:document', 'im:message:send_as_bot'])
})

test('grantedScopes tolerates null and separators', () => {
  assert.deepEqual(grantedScopes(null), [])
  assert.deepEqual(grantedScopes('a,b  c'), ['a', 'b', 'c'])
})

test('feishu_auth_status lists the scopes each tool is missing', async () => {
  const { registerFeishuAuthTools } = await import('../../packages/host-feishu/lib/index.js')
  const tools = new Map()
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
  }
  registerFeishuAuthTools(ctx, {
    async status() {
      return { connected: true, tokenState: 'valid', name: 'Alice', scope: 'docx:document' }
    },
  })
  const tool = tools.get('feishu_auth_status')
  const result = await tool.execute({}, { signal: new AbortController().signal })
  assert.equal(result.connected, true)
  assert.deepEqual(result.scopes, ['docx:document'])
  assert.ok(result.missingScopes.some((gap) => gap.tool === 'feishu_calendar_agenda'))
  const [block] = tool.output.render({}, result)
  assert.match(block.text, /Feishu connected as Alice/)
  assert.match(block.text, /missing scopes/)
})

test('feishu_auth_status stays quiet when the grant covers every tool', async () => {
  const { registerFeishuAuthTools } = await import('../../packages/host-feishu/lib/index.js')
  const tools = new Map()
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
  }
  const fullGrant = [
    'docx:document',
    'sheets:spreadsheet',
    'drive:drive',
    'im:message',
    'im:message:send_as_bot',
    'contact:user.base:readonly',
    'wiki:wiki',
    'task:task:write',
    'task:task:read',
    'calendar:calendar:read',
    'minutes:minutes:readonly',
  ].join(' ')
  registerFeishuAuthTools(ctx, {
    async status() {
      return { connected: true, tokenState: 'valid', name: 'Alice', scope: fullGrant }
    },
  })
  const tool = tools.get('feishu_auth_status')
  const result = await tool.execute({}, { signal: new AbortController().signal })
  assert.deepEqual(result.missingScopes, [])
  const [block] = tool.output.render({}, result)
  assert.doesNotMatch(block.text, /missing scopes/)
})

test('a disconnected grant reports no scope gaps and says how to reconnect', async () => {
  const { registerFeishuAuthTools } = await import('../../packages/host-feishu/lib/index.js')
  const tools = new Map()
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
  }
  registerFeishuAuthTools(ctx, {
    async status() {
      return { connected: false, tokenState: 'none', reason: 'no_token' }
    },
  })
  const tool = tools.get('feishu_auth_status')
  const result = await tool.execute({}, { signal: new AbortController().signal })
  assert.deepEqual(result.scopes, [])
  assert.deepEqual(result.missingScopes, [])
  const [block] = tool.output.render({}, result)
  assert.match(block.text, /Feishu is not connected/)
  assert.match(block.text, /feishu_auth_start/)
})
