import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  ComposerContextRow,
  FeishuContextChip,
  feishuKindLabel,
  formatClock,
  presenceErrorHint,
  presenceQuoteMarkdown,
  presenceQuoteSummary,
} from '../../packages/client-work/lib/client.node.mjs'

const CAPTURED_AT = new Date('2026-11-13T10:32:00').getTime()

function entry(overrides = {}) {
  return {
    chatName: '示例产品群',
    chatKind: 'group',
    messages: ['张三：明天上午 10 点评审', '李四：收到，我把材料发群里', '王五：+1'],
    capturedAt: CAPTURED_AT,
    ...overrides,
  }
}

test('presence quote is a numbered markdown blockquote with its provenance', () => {
  const text = presenceQuoteMarkdown(entry())
  const lines = text.split('\n')
  assert.equal(lines[0], '> 飞书群聊「示例产品群」· 10:32 屏幕可见 3 行（OCR，最旧在上）：')
  assert.equal(lines[1], '>')
  assert.equal(lines[2], '> 1. 张三：明天上午 10 点评审')
  assert.equal(lines[3], '> 2. 李四：收到，我把材料发群里')
  assert.equal(lines[4], '> 3. 王五：+1')
})

test('presence quote keeps only the newest visible messages', () => {
  const text = presenceQuoteMarkdown(entry(), { maxMessages: 2 })
  assert.match(text, /屏幕可见 2 行/)
  assert.doesNotMatch(text, /张三：明天上午 10 点评审/)
  assert.match(text, /王五：\+1/)
})

test('the composer preview skips the wrapped tail of the last line', () => {
  const summary = presenceQuoteSummary(entry({ messages: ['王五：+1', '件。'] }))
  assert.match(summary.body, /王五：\+1/)
  assert.doesNotMatch(summary.body, /件。/)
})

test('presence quote explains an empty screen instead of inserting nothing', () => {
  const text = presenceQuoteMarkdown(entry({ messages: [] }))
  assert.match(text, /屏幕可见 0 行/)
  assert.match(text, /当前没有可见消息/)
  assert.equal(text.split('\n').length, 3)
})

test('presence quote summary carries kind, count and clock for the composer preview', () => {
  const summary = presenceQuoteSummary(entry())
  assert.equal(summary.label, '飞书')
  assert.equal(summary.title, '群聊｜示例产品群')
  assert.equal(summary.detail, '3 行可见 · 10:32 读取')
  assert.match(summary.body, /李四：收到/)
})

test('kind labels and clock formatting stay readable in the chip', () => {
  assert.equal(feishuKindLabel('group'), '群聊')
  assert.equal(feishuKindLabel('direct'), '单聊')
  assert.equal(feishuKindLabel('unknown'), '会话')
  assert.equal(feishuKindLabel(undefined), '会话')
  assert.equal(formatClock(new Date('2026-11-13T09:05:00').getTime()), '09:05')
})

const task = {
  id: 's1',
  title: '整理评审结论',
  goal: '整理评审结论',
  status: 'running',
  outputs: [],
  createdAt: 0,
  updatedAt: 0,
}

function fakeWorkbench({ withTask = true, presence, style = 'dsh' } = {}) {
  const index = new Map(withTask ? [[task.id, task]] : [])
  return {
    subscribeIndex: () => () => {},
    indexSnapshot: () => index,
    subscribePresence: () => () => {},
    presenceSnapshot: () => presence,
    refreshPresence: async () => presence,
    subscribePresenceStyle: () => () => {},
    presenceStyleSnapshot: () => style,
    loadPresenceStyle: async () => style,
  }
}

test('composer context chip shows the focused Feishu conversation in work mode', () => {
  const html = renderToStaticMarkup(
    React.createElement(FeishuContextChip, {
      sessionId: 's1',
      workbench: fakeWorkbench({
        presence: {
          ...entry(),
          detected: true,
          cached: false,
          recent: [],
        },
      }),
      notify: () => {},
      inputActions: { insertQuote: () => true },
    }),
  )
  assert.match(html, /群聊｜/)
  assert.match(html, /示例产品群/)
  assert.match(html, /3 行 · 10:32/)
  assert.match(html, /aria-haspopup="menu"/)
})

test('composer context chip stays hidden outside work mode', () => {
  const html = renderToStaticMarkup(
    React.createElement(FeishuContextChip, {
      sessionId: 's1',
      workbench: fakeWorkbench({ withTask: false, presence: entry() }),
      notify: () => {},
      inputActions: { insertQuote: () => true },
    }),
  )
  assert.equal(html, '')
})

test('composer context chip offers a retry when no conversation was found', () => {
  const html = renderToStaticMarkup(
    React.createElement(FeishuContextChip, {
      sessionId: 's1',
      workbench: fakeWorkbench({
        presence: {
          detected: false,
          chatName: '',
          chatKind: 'unknown',
          messages: [],
          capturedAt: CAPTURED_AT,
          cached: false,
          recent: [],
          error: 'Feishu is not running; open Feishu first',
        },
      }),
      notify: () => {},
      inputActions: { insertQuote: () => true },
    }),
  )
  assert.match(html, /飞书未检测到/)
  assert.match(html, /没有发现运行中的飞书/)
})

test('one context row above the composer carries the Feishu chip and the mode toggle', () => {
  const html = renderToStaticMarkup(
    React.createElement(ComposerContextRow, {
      sessionId: 's1',
      workbench: fakeWorkbench({
        presence: { ...entry(), detected: true, cached: false, recent: [] },
      }),
      notify: () => {},
      inputActions: { insertQuote: () => true },
    }),
  )
  assert.match(html, /data-dsh-work-composer-context/)
  assert.match(html, /box-sizing:border-box/)
  assert.match(html, /width:calc\(100% - var\(--dsh-composer-side-clearance, 16px\)/)
  assert.match(html, /群聊｜示例产品群/)
  assert.match(html, /工作模式 · 开/)
  assert.ok(html.indexOf('群聊｜示例产品群') < html.indexOf('工作模式 · 开'))
})

test('the context row keeps the mode toggle reachable outside work mode', () => {
  const html = renderToStaticMarkup(
    React.createElement(ComposerContextRow, {
      sessionId: 's1',
      workbench: fakeWorkbench({ withTask: false, presence: entry() }),
      notify: () => {},
      inputActions: { insertQuote: () => true },
    }),
  )
  assert.match(html, /data-dsh-work-composer-context/)
  assert.match(html, /工作模式/)
  assert.doesNotMatch(html, /群聊｜/)
})

test('read failures become one actionable Chinese sentence', () => {
  assert.match(
    presenceErrorHint('Feishu is running but its window is not on the current desktop (minimized or another Space)'),
    /不在 DSH 所在的桌面/,
  )
  assert.match(presenceErrorHint('no window found for pid 1034'), /不在 DSH 所在的桌面/)
  assert.match(
    presenceErrorHint('No Feishu conversation recognized. Make sure the Feishu window is on screen'),
    /没识别出当前会话/,
  )
  assert.match(presenceErrorHint('Feishu is not running; open Feishu first'), /先打开飞书/)
  assert.match(presenceErrorHint('capture failed; check Screen Recording permission'), /屏幕录制/)
  assert.equal(presenceErrorHint(undefined), '未读到飞书会话，稍后重试')
})

test('composer context chip falls back to the last conversation when the screen cannot be read', () => {
  const html = renderToStaticMarkup(
    React.createElement(FeishuContextChip, {
      sessionId: 's1',
      workbench: fakeWorkbench({
        presence: {
          detected: false,
          chatName: '',
          chatKind: 'unknown',
          messages: [],
          capturedAt: CAPTURED_AT,
          cached: false,
          recent: [entry({ chatName: '示例销售群' })],
          error: 'Feishu is running but its window is not on the current desktop',
        },
      }),
      notify: () => {},
      inputActions: { insertQuote: () => true },
    }),
  )
  assert.match(html, /上次 群聊｜示例销售群/)
  assert.match(html, /3 行 · 10:32 · 上次/)
  assert.doesNotMatch(html, /aria-pressed/)
})
