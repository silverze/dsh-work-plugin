import test from 'node:test'
import assert from 'node:assert/strict'

import { registerFeishuWriteApproval } from '../../packages/host-feishu/lib/approval.js'

function makeCtx(outcome = 'allowed-once') {
  const requests = []
  const handlers = []
  const ctx = {
    on(event, handler) {
      handlers.push([event, handler])
      return () => {}
    },
    approval: {
      async request(request) {
        requests.push(request)
        return outcome
      },
    },
  }
  registerFeishuWriteApproval(ctx)
  const handler = handlers.find(([event]) => event === 'tools/pre-execute')?.[1]
  assert.equal(typeof handler, 'function')
  return { handler, requests }
}

function exec(name, overrides = {}) {
  return {
    name,
    agent: { id: 'agent-1' },
    callId: 'call-1',
    signal: new AbortController().signal,
    ...overrides,
  }
}

test('read tools bypass the approval gate', async () => {
  const { handler, requests } = makeCtx()
  let nextCalled = false
  const result = await handler(exec('feishu_doc_read'), async () => {
    nextCalled = true
    return { kind: 'allow' }
  })
  assert.equal(nextCalled, true)
  assert.deepEqual(result, { kind: 'allow' })
  assert.equal(requests.length, 0)
})

test('write tools proceed only on allowed-once', async () => {
  const { handler, requests } = makeCtx('allowed-once')
  let nextCalled = false
  const result = await handler(exec('feishu_im_send'), async () => {
    nextCalled = true
    return { kind: 'allow' }
  })
  assert.equal(nextCalled, true)
  assert.deepEqual(result, { kind: 'allow' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].toolName, 'feishu_im_send')
  assert.equal(requests[0].callId, 'call-1')
  assert.ok(requests[0].signal)
})

test('a rejected write returns deny and never dispatches', async () => {
  const { handler } = makeCtx('rejected')
  let nextCalled = false
  const result = await handler(exec('feishu_doc_create'), async () => {
    nextCalled = true
    return { kind: 'allow' }
  })
  assert.equal(nextCalled, false)
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /rejected/)
})

test('a write without an agent fails closed without asking', async () => {
  const { handler, requests } = makeCtx()
  let nextCalled = false
  const result = await handler(exec('feishu_sheet_write', { agent: undefined }), async () => {
    nextCalled = true
    return { kind: 'allow' }
  })
  assert.equal(nextCalled, false)
  assert.equal(result.kind, 'deny')
  assert.equal(requests.length, 0)
})

test('auth disconnect is also gated', async () => {
  const { handler, requests } = makeCtx('cancelled')
  const result = await handler(exec('feishu_auth_disconnect'), async () => ({ kind: 'allow' }))
  assert.equal(result.kind, 'deny')
  assert.equal(requests.length, 1)
})
