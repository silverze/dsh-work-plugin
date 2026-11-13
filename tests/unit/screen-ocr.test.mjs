import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseFeishuPids,
  parseFeishuScreen,
  preferFrontmost,
  screenTextLines,
} from '../../packages/host-work/lib/index.js'

/** Lines captured from a real Feishu window with the Vision OCR helper. */
const FEISHU_CAPTURE = {
  imageWidth: 1567,
  imageHeight: 866,
  windowNumber: 1146,
  lines: [
    { text: '示例项目 Beta 开发测试群：43', x: 0.4, y: 0.02, w: 0.22, h: 0.03 },
    { text: 'E消息', x: 0.13, y: 0.03, w: 0.04, h: 0.02 },
    { text: '［群公告］沟通地图：AML：张三，李四 EXAMPLE：王五', x: 0.39, y: 0.11, w: 0.54, h: 0.02 },
    { text: '示例项目 Alpha 开发测...', x: 0.16, y: 0.15, w: 0.14, h: 0.02 },
    { text: '昨天', x: 0.33, y: 0.15, w: 0.02, h: 0.02 },
    { text: '新项目 DEMO X100-...', x: 0.16, y: 0.22, w: 0.14, h: 0.02 },
    { text: '1群公告', x: 0.44, y: 0.06, w: 0.03, h: 0.02 },
    { text: '@张三 Type C 的软件今天有什么进展吗？', x: 0.41, y: 0.32, w: 0.16, h: 0.02 },
    { text: '1、IIC采用模拟IIC，已成功打通和PD芯片的通讯', x: 0.41, y: 0.42, w: 0.19, h: 0.02 },
    { text: '顺利的话明天应该就能出图了', x: 0.41, y: 0.51, w: 0.12, h: 0.02 },
    { text: '11月11日', x: 0.32, y: 0.58, w: 0.03, h: 0.02 },
    { text: '赵六', x: 0.4, y: 0.67, w: 0.02, h: 0.02 },
    { text: 'CC', x: 0.41, y: 0.86, w: 0.01, h: 0.02 },
    { text: '发送给 示例项目 Alpha 开发测试群', x: 0.39, y: 0.93, w: 0.19, h: 0.02 },
    { text: '示例固件运营群', x: 0.16, y: 0.96, w: 0.07, h: 0.02 },
    { text: '孙七：收到，谢谢', x: 0.17, y: 0.96, w: 0.07, h: 0.02 },
  ],
}

test('parseFeishuScreen reads the focused chat from OCR lines', () => {
  const focus = parseFeishuScreen(FEISHU_CAPTURE)
  assert.equal(focus.detected, true)
  // The composer placeholder is the most reliable source for the chat name.
  assert.equal(focus.chatName, '示例项目 Alpha 开发测试群')
  assert.equal(focus.chatKind, 'group')
  assert.deepEqual(focus.messages, [
    '［群公告］沟通地图：AML：张三，李四 EXAMPLE：王五',
    '@张三 Type C 的软件今天有什么进展吗？',
    '1、IIC采用模拟IIC，已成功打通和PD芯片的通讯',
    '顺利的话明天应该就能出图了',
    '赵六',
  ])
  // Left column metadata (conversation list) must not leak into the messages.
  assert.ok(focus.otherChats.includes('新项目 DEMO X100-...'))
  assert.ok(!focus.otherChats.includes('昨天'))
  assert.equal(focus.window?.windowNumber, 1146)
})

test('parseFeishuScreen drops glyph fragments read from stickers and images', () => {
  const focus = parseFeishuScreen({
    ...FEISHU_CAPTURE,
    lines: [
      ...FEISHU_CAPTURE.lines,
      { text: 'DEMO-8891', x: 0.62, y: 0.855, w: 0.05, h: 0.02 },
      { text: 'Aaeo%', x: 0.62, y: 0.88, w: 0.05, h: 0.02 },
    ],
  })
  assert.equal(focus.detected, true)
  assert.ok(focus.messages.includes('DEMO-8891'), 'IDs are real content')
  assert.ok(!focus.messages.includes('Aaeo%'), 'sticker glyphs are not messages')
})

test('parseFeishuScreen falls back to the title band and honours maxMessages', () => {
  const withoutComposer = {
    ...FEISHU_CAPTURE,
    lines: FEISHU_CAPTURE.lines.filter((line) => !line.text.startsWith('发送给')),
  }
  const focus = parseFeishuScreen(withoutComposer, { maxMessages: 2 })
  assert.equal(focus.detected, true)
  assert.equal(focus.chatName, '示例项目 Beta 开发测试群：43')
  assert.equal(focus.messages.length, 2)
  assert.deepEqual(focus.messages, ['顺利的话明天应该就能出图了', '赵六'])
})

test('parseFeishuScreen reports nothing for a window without a conversation', () => {
  const focus = parseFeishuScreen({
    imageWidth: 1280,
    imageHeight: 800,
    windowNumber: 42,
    lines: [
      { text: 'DeepSeek Harness', x: 0.02, y: 0.02, w: 0.2, h: 0.02 },
      { text: 'Settings', x: 0.5, y: 0.4, w: 0.1, h: 0.02 },
    ],
  })
  assert.equal(focus.detected, false)
  assert.deepEqual(focus.messages, [])
  assert.match(focus.error ?? '', /Screen Recording/)
})

test('parseFeishuPids prefers the company build and skips helpers', () => {
  const ps = [
    '  1034     1 /Applications/Lark.app/Contents/MacOS/Feishu',
    '  1073  1034 /Applications/Lark.app/Contents/Frameworks/Lark Helper.app/Contents/MacOS/Lark Helper',
    ' 20766     1 /Applications/saxmsa667.app/Contents/MacOS/MiWorkSaaS',
    ' 23409     1 /usr/bin/code',
  ].join('\n')
  assert.deepEqual(parseFeishuPids(ps), [20766, 1034])
})

test('preferFrontmost reads the client the user is actually looking at', () => {
  assert.deepEqual(preferFrontmost([20766, 1034], 1034), [1034, 20766])
  assert.deepEqual(preferFrontmost([20766, 1034], 999), [20766, 1034])
  assert.deepEqual(preferFrontmost([20766], undefined), [20766])
})

test('parseFeishuPids finds a client whose window is owned by a child process', () => {
  const ps = [
    '   1034     1 /Applications/Lark.app/Contents/MacOS/Feishu',
    '   1040  1034 /Applications/Lark.app/Contents/MacOS/Lark Helper (Renderer)',
    '   1073  1040 /Applications/Lark.app/Contents/Frameworks/Lark Helper.app/Contents/MacOS/Lark Helper',
  ].join('\n')
  assert.deepEqual(parseFeishuPids(ps), [1034])
})

test('screenTextLines sorts lines top to bottom and limits output', () => {
  const lines = screenTextLines(
    {
      lines: [
        { text: 'bottom', x: 0.1, y: 0.9, w: 0.1, h: 0.1 },
        { text: 'top', x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
        { text: '   ', x: 0.1, y: 0.5, w: 0.1, h: 0.1 },
      ],
    },
    2,
  )
  assert.deepEqual(lines, ['top', 'bottom'])
})

/**
 * Same window, maximized to 1651px: the chat list grows with the window, so the
 * conversation pane starts at x≈0.30 and the fixed 0.36 cut used to drop the
 * title, the bubbles and the composer line together.
 */
const WIDE_LIST_CAPTURE = {
  imageWidth: 1651,
  imageHeight: 852,
  windowNumber: 133,
  lines: [
    { text: 'E消息', x: 0.116, y: 0.025, w: 0.04, h: 0.02 },
    { text: '张三（Zhang）', x: 0.321, y: 0.036, w: 0.07, h: 0.03 },
    { text: '研发中心-软件一部 ｜系统软件工程师', x: 0.323, y: 0.065, w: 0.24, h: 0.02 },
    { text: '李四', x: 0.147, y: 0.223, w: 0.06, h: 0.02 },
    { text: '附件收到了', x: 0.147, y: 0.248, w: 0.08, h: 0.02 },
    { text: '11月11日', x: 0.628, y: 0.2, w: 0.03, h: 0.02 },
    { text: '这个软件的状态没有维护？', x: 0.468, y: 0.493, w: 0.1, h: 0.02 },
    { text: '行了，你那边审核下', x: 0.33, y: 0.558, w: 0.08, h: 0.02 },
    { text: '可以了', x: 0.93, y: 0.149, w: 0.02, h: 0.02 },
    { text: '发送给 张三（Zhang）', x: 0.305, y: 0.927, w: 0.09, h: 0.02 },
  ],
}

test('parseFeishuScreen finds the pane when the chat list is wide', () => {
  const focus = parseFeishuScreen(WIDE_LIST_CAPTURE)
  assert.equal(focus.detected, true)
  assert.equal(focus.chatName, '张三（Zhang）')
  assert.deepEqual(focus.messages, ['可以了', '这个软件的状态没有维护？', '行了，你那边审核下'])
  // Left-column previews must not leak into the message list.
  assert.ok(!focus.messages.includes('附件收到了'))
})

function kindFixture(headerLines) {
  return {
    imageWidth: 1651,
    imageHeight: 852,
    windowNumber: 7,
    lines: [
      { text: '发送给 某某', x: 0.305, y: 0.927, w: 0.08, h: 0.02 },
      { text: '收到', x: 0.33, y: 0.6, w: 0.03, h: 0.02 },
      ...headerLines,
    ],
  }
}

test('parseFeishuScreen claims a kind only on positive evidence', () => {
  const title = (text) => ({ text, x: 0.321, y: 0.036, w: 0.12, h: 0.03 })
  const sub = (text) => ({ text, x: 0.323, y: 0.065, w: 0.2, h: 0.02 })
  const kind = (lines) => parseFeishuScreen(kindFixture(lines)).chatKind

  // A member count in the header is a group marker.
  assert.equal(kind([title('项目协作'), { text: '128人', x: 0.33, y: 0.065, w: 0.04, h: 0.02 }]), 'group')
  // 外部 alone must not imply a group: direct chats with external contacts show it too.
  assert.equal(kind([title('王五'), sub('外部联系人')]), 'direct')
  assert.equal(kind([title('张三'), sub('研发中心 ｜ 软件工程师')]), 'direct')
  assert.equal(kind([title('示例名字（Alex）')]), 'direct')
  assert.equal(kind([title('TSC2027届-校招面试群')]), 'group')
  // Nothing recognisable: say 会话 rather than guess.
  assert.equal(kind([title('某某')]), 'unknown')
})

test('parseFeishuScreen keeps the title out of the direct-chat subtitle test', () => {
  const capture = {
    imageWidth: 1651,
    imageHeight: 852,
    windowNumber: 3,
    lines: [
      { text: '发送给 销售运营', x: 0.305, y: 0.927, w: 0.08, h: 0.02 },
      { text: '• 消息', x: 0.282, y: 0.036, w: 0.04, h: 0.02 },
      { text: '销售运营事业部', x: 0.321, y: 0.036, w: 0.12, h: 0.03 },
      { text: '撤回了一条消息', x: 0.33, y: 0.5, w: 0.1, h: 0.02 },
      { text: '这周的排期发你了', x: 0.33, y: 0.56, w: 0.12, h: 0.02 },
    ],
  }
  const focus = parseFeishuScreen(capture)
  // A job word inside the group name must not turn the group into a direct chat.
  assert.equal(focus.chatKind, 'unknown')
  assert.deepEqual(focus.messages, ['这周的排期发你了'])
})

/**
 * A 1920px-wide window, where the chat list is a fixed width and the composer
 * input is inset far right of the title: the placeholder is missing from OCR,
 * so the title band is the only source for the name, and the window controls
 * leave a "0o" glyph in the top-right corner of the same band.
 */
const WIDE_WINDOW_CAPTURE = {
  imageWidth: 1920,
  imageHeight: 1050,
  windowNumber: 122,
  lines: [
    { text: '张有麒', x: 0.276, y: 0.018, w: 0.028, h: 0.022 },
    { text: '0o', x: 0.946, y: 0.021, w: 0.007, h: 0.016 },
    { text: '三消息', x: 0.102, y: 0.021, w: 0.031, h: 0.016 },
    { text: '示例科技-产品事业部-技术支持中心｜软件工程师', x: 0.278, y: 0.04, w: 0.227, h: 0.016 },
    { text: '国云文档', x: 0.313, y: 0.066, w: 0.028, h: 0.016 },
    { text: '•消息', x: 0.282, y: 0.069, w: 0.02, h: 0.014 },
    { text: '■文件', x: 0.349, y: 0.069, w: 0.022, h: 0.014 },
    { text: 'SFAE软件经理群', x: 0.126, y: 0.239, w: 0.055, h: 0.016 },
    { text: '11:21|', x: 0.219, y: 0.239, w: 0.017, h: 0.014 },
    { text: '有麒，这个问题卷有完成了没', x: 0.613, y: 0.321, w: 0.097, h: 0.016 },
    { text: '还没有我一会整完', x: 0.285, y: 0.376, w: 0.06, h: 0.016 },
    { text: '搞完跟我说一声', x: 0.904, y: 0.464, w: 0.054, h: 0.016 },
    { text: '♥•示例同事添加了备注- 2026/11/13 9:51', x: 0.621, y: 0.597, w: 0.129, h: 0.016 },
    { text: '张有麒 下一版本修改，这问题不应该是挂起，应该是调整到期时间，尽快修改问题 回归测试。', x: 0.631, y: 0.626, w: 0.285, h: 0.019 },
  ],
}

test('parseFeishuScreen names a wide window from the title band, not corner noise', () => {
  const focus = parseFeishuScreen(WIDE_WINDOW_CAPTURE)
  assert.equal(focus.detected, true)
  // The window-control glyph sits higher than the title; it must not win.
  assert.equal(focus.chatName, '张有麒')
  assert.equal(focus.chatKind, 'direct')
  // The pane edge must not be taken from the inset composer area (0.59) and
  // must keep the left-aligned incoming message.
  assert.ok(focus.messages.includes('还没有我一会整完'))
  assert.ok(focus.messages.includes('搞完跟我说一声'))
  assert.ok(!focus.otherChats.includes('0o'))
})

test('parseFeishuScreen refuses toolbar labels instead of naming the chat after them', () => {
  // Same window with no enlarged title in the band: only tab-strip labels and
  // the corner glyph are left, and none of them may become the chat name.
  const focus = parseFeishuScreen({
    imageWidth: 1920,
    imageHeight: 1050,
    windowNumber: 122,
    lines: [
      { text: '0o', x: 0.946, y: 0.021, w: 0.007, h: 0.015 },
      { text: '•消息', x: 0.282, y: 0.069, w: 0.02, h: 0.015 },
      { text: '■文件', x: 0.349, y: 0.069, w: 0.022, h: 0.015 },
      { text: '有麒，这个问题卷有完成了没', x: 0.613, y: 0.321, w: 0.097, h: 0.016 },
    ],
  })
  assert.equal(focus.detected, false)
  assert.match(String(focus.error), /No Feishu conversation recognized/)
})
