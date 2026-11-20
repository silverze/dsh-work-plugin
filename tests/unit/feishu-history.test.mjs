import test from 'node:test'
import assert from 'node:assert/strict'

import {
  formatTranscript,
  messageText,
  readChatHistory,
  resolveChatByName,
} from '../../packages/host-feishu/lib/index.js'

test('messageText flattens the message types Feishu sends', () => {
  assert.equal(messageText('text', JSON.stringify({ text: '  明天评审  ' })), '明天评审')
  assert.equal(
    messageText('post', JSON.stringify({
      title: '周报',
      content: [[{ tag: 'text', text: '进展：' }, { tag: 'text', text: '三件事' }], [{ tag: 'text', text: '风险：无' }]],
    })),
    '周报\n进展：三件事\n风险：无',
  )
  assert.equal(messageText('image', '{"image_key":"img_v2_demo"}'), '[图片]')
  assert.equal(messageText('file', JSON.stringify({ file_name: '报告.docx' })), '[文件] 报告.docx')
  assert.equal(messageText('sticker', '{}'), '[表情]')
  assert.equal(messageText('weird_type', 'not json'), '[weird_type]')
})

test('resolveChatByName prefers the exact chat and then the shortest prefix', () => {
  const chats = [
    { chatId: 'oc_old', name: '示例产品群（旧）' },
    { chatId: 'oc_new', name: '示例产品群' },
    { chatId: 'oc_other', name: '示例产品群北区' },
  ]
  assert.equal(resolveChatByName(chats, '示例产品群')?.chatId, 'oc_new')
  assert.equal(resolveChatByName(chats, '示例产品群北')?.chatId, 'oc_other')
  assert.equal(resolveChatByName([], '示例产品群'), undefined)
})

test('readChatHistory resolves a chat by name and returns it oldest first', async () => {
  const calls = []
  const client = {
    searchChats: async (input) => {
      calls.push(['search', input])
      return [{ chatId: 'oc_demo', name: '示例产品群' }]
    },
    listChatMessages: async (input) => {
      calls.push(['list', input])
      return {
        messages: [
          { messageId: 'm2', chatId: 'oc_demo', msgType: 'text', createTime: 2, senderId: 'ou_b', text: '第二句' },
          { messageId: 'm1', chatId: 'oc_demo', msgType: 'text', createTime: 1, senderId: 'ou_a', text: '第一句' },
        ],
        hasMore: false,
      }
    },
  }
  const history = await readChatHistory(client, { chatName: '示例产品群', limit: 20 })
  assert.equal(history.chatId, 'oc_demo')
  assert.equal(history.chatName, '示例产品群')
  assert.deepEqual(history.messages.map((message) => message.text), ['第二句', '第一句'])
  assert.equal(calls[0][0], 'search')
  assert.equal(calls[1][0], 'list')
  assert.equal(calls[1][1].pageSize, 20)
})

test('readChatHistory insists on a name or an id', async () => {
  await assert.rejects(readChatHistory({}, {}), /chatName or chatId is required/)
})

test('formatTranscript prints one clock-prefixed line per message', () => {
  const text = formatTranscript([
    { messageId: 'm1', chatId: 'c', msgType: 'text', createTime: new Date(2026, 10, 19, 9, 5).getTime(), senderId: 'ou_a', text: '早上好' },
  ])
  assert.equal(text, '11-19 09:05 ou_a: 早上好')
})
import { FeishuHttpClient } from '../../packages/host-feishu/lib/index.js'

function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    const parsed = new URL(url)
    calls.push({ path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), method: init?.method })
    const body = handler(parsed.pathname, parsed.searchParams)
    return new Response(JSON.stringify({ code: 0, msg: 'ok', data: body }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { impl, calls }
}

test('listChatMessages asks Feishu for seconds and unwraps body.content', async () => {
  const { impl, calls } = fakeFetch((path) => {
    if (path.endsWith('/im/v1/messages')) {
      return {
        items: [
          {
            message_id: 'om_2',
            chat_id: 'oc_demo',
            msg_type: 'post',
            create_time: '1795000060000',
            sender: { id: 'ou_sender' },
            body: { content: '{"title":"周报","content":[[{"tag":"text","text":"进展"}]]}' },
          },
          {
            message_id: 'om_1',
            chat_id: 'oc_demo',
            chat_type: 'group',
            msg_type: 'text',
            create_time: '1795000000000',
            sender: { id: 'ou_sender', sender_type: 'user' },
            body: { content: '{"text":"这条有正文"}' },
          },
        ],
        has_more: false,
      }
    }
    return {}
  })
  const client = new FeishuHttpClient({ accessToken: async () => 't', fetchImpl: impl })
  const { messages } = await client.listChatMessages({
    chatId: 'oc_demo',
    pageSize: 50,
    startTime: 1794990000000,
    endTime: 1795010000000,
  })
  assert.equal(messages.length, 2)
  assert.equal(messages[0].text, '这条有正文')
  assert.equal(messages[1].text, '周报\n进展')
  assert.equal(messages[0].senderId, 'ou_sender')
  const query = calls.find((call) => call.path.endsWith('/im/v1/messages')).query
  assert.equal(query.start_time, '1794990000')
  assert.equal(query.end_time, '1795010000')
  assert.equal(query.container_id, 'oc_demo')
})

test('readChatHistory reports stats and a cursor for the next chunk', async () => {
  const client = {
    searchChats: async () => [{ chatId: 'oc_demo', name: '示例产品群' }],
    listChatMessages: async () => ({
      // listChatMessages always returns a chunk oldest-first.
      messages: [
        { messageId: 'm1', chatId: 'oc_demo', msgType: 'text', createTime: 1795001600000, senderId: 'ou_a', text: '第一条' },
        { messageId: 'm2', chatId: 'oc_demo', msgType: 'text', createTime: 1795001700000, senderId: 'ou_a', text: '第二条' },
        { messageId: 'm3', chatId: 'oc_demo', msgType: 'text', createTime: 1795001800000, senderId: 'ou_b', text: '第三条' },
      ],
      hasMore: true,
    }),
  }
  const history = await readChatHistory(client, { chatName: '示例产品群', limit: 3, stats: true })
  assert.equal(history.order, 'newest')
  assert.equal(history.truncated, true)
  assert.equal(history.nextEndTime, 1795001600000 - 1)
  assert.equal(history.stats.total, 3)
  assert.deepEqual(history.stats.senders, [
    { senderId: 'ou_a', count: 2 },
    { senderId: 'ou_b', count: 1 },
  ])
  assert.equal(history.stats.firstAt, 1795001600000)
  assert.equal(history.stats.lastAt, 1795001800000)
})

test('order=oldest starts from the beginning of the window', async () => {
  const calls = []
  const client = {
    searchChats: async () => [{ chatId: 'oc_demo', name: '示例产品群' }],
    listChatMessages: async (input) => {
      calls.push(input)
      return {
        messages: [
          { messageId: 'm1', chatId: 'oc_demo', msgType: 'text', createTime: 1795001600000, senderId: 'ou_a', text: '第一条' },
        ],
        hasMore: true,
      }
    },
  }
  const history = await readChatHistory(client, { chatName: '示例产品群', order: 'oldest', limit: 1 })
  assert.equal(history.order, 'oldest')
  assert.equal(calls[0].order, 'oldest')
  assert.equal(history.nextStartTime, 1795001600000 + 1)
  assert.equal(history.nextEndTime, undefined)
})
