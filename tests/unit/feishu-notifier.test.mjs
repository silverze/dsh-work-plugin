import test from 'node:test'
import assert from 'node:assert/strict'

import { FeishuWorkNotifier } from '../../packages/host-feishu/lib/notifier.js'

function makeClient() {
  const calls = []
  return {
    calls,
    client: {
      async sendMessage(input) {
        calls.push(input)
        return { messageId: 'om_1' }
      },
    },
  }
}

test('done notification sends an interactive card to the task chat', async () => {
  const { client, calls } = makeClient()
  const notifier = new FeishuWorkNotifier(client)
  await notifier.notify({
    event: 'done',
    task: {
      id: 'sess-1',
      title: '项目周报',
      status: 'done',
      notifyChatId: 'oc_1',
      scheduleId: 'sch-1',
      outputs: ['a1', 'a2'],
    },
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].receiveId, 'oc_1')
  assert.equal(calls[0].receiveIdType, 'chat_id')
  assert.equal(calls[0].msgType, 'interactive')
  const card = JSON.parse(calls[0].content)
  assert.equal(card.header.template, 'green')
  assert.match(card.elements[0].content, /项目周报/)
  assert.match(card.elements[0].content, /产物：2 个/)
  assert.match(card.elements[0].content, /sch-1/)
})

test('failed notification uses the red template and includes the error', async () => {
  const { client, calls } = makeClient()
  const notifier = new FeishuWorkNotifier(client)
  await notifier.notify({
    event: 'failed',
    task: {
      id: 'sess-1',
      title: '失败任务',
      status: 'failed',
      notifyChatId: 'oc_1',
      lastError: { message: 'model exploded' },
    },
  })
  const card = JSON.parse(calls[0].content)
  assert.equal(card.header.template, 'red')
  assert.match(card.elements[0].content, /model exploded/)
})

test('no chat means no send', async () => {
  const { client, calls } = makeClient()
  const notifier = new FeishuWorkNotifier(client)
  await notifier.notify({
    event: 'done',
    task: { id: 'sess-1', title: 'x', status: 'done' },
  })
  assert.equal(calls.length, 0)
})

test('default chat id is the fallback', async () => {
  const { client, calls } = makeClient()
  const notifier = new FeishuWorkNotifier(client, 'oc_default')
  await notifier.notify({
    event: 'cancelled',
    task: { id: 'sess-1', title: 'x', status: 'cancelled' },
  })
  assert.equal(calls[0].receiveId, 'oc_default')
})
