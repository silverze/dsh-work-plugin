import test from 'node:test'
import assert from 'node:assert/strict'

import { parseAxTree, parseFeishuFocus } from '../../packages/host-work/lib/index.js'

/** A dump shaped like AXTextFormatter output for a Feishu conversation window. */
const FEISHU_DUMP = `- [0] AXWindow subrole=AXStandardWindow "项目讨论群（12）"
  - [1] AXGroup
    - [2] AXTextField placeholder="搜索" selectionWritable=true
  - [3] AXGroup
    - [4] AXRow "产品需求群"
    - [5] AXRow "项目讨论群（12）" selected
  - [6] AXScrollArea
    - [7] AXStaticText "张三：今天的方案我看过了"
    - [8] AXStaticText "李四：那明天上午同步"
    - [9] AXTextArea focused ""

- [10] AXWindow subrole=AXStandardWindow "飞书"
  - [11] AXGroup
`

test('parseAxTree keeps depth, role, title and flags', () => {
  const nodes = parseAxTree(FEISHU_DUMP)
  const window = nodes.find((node) => node.role === 'AXWindow')
  assert.equal(window?.depth, 0)
  assert.equal(window?.title, '项目讨论群（12）')

  const selected = nodes.find((node) => node.selected)
  assert.equal(selected?.role, 'AXRow')
  assert.equal(selected?.title, '项目讨论群（12）')

  assert.equal(nodes.find((node) => node.focused)?.role, 'AXTextArea')
})

test('parseFeishuFocus prefers the specific window title', () => {
  const focus = parseFeishuFocus(FEISHU_DUMP)
  assert.equal(focus.detected, true)
  assert.equal(focus.chat.name, '项目讨论群（12）')
  assert.equal(focus.chat.kind, 'group')
  assert.deepEqual(focus.windowTitles, ['项目讨论群（12）', '飞书'])
  assert.equal(focus.candidates[0]?.source, 'window-title')
  assert.ok(focus.recentText.some((text) => text.includes('今天的方案')))
})

test('parseFeishuFocus ignores generic app titles and reports no focus', () => {
  const dump = `- [0] AXWindow subrole=AXStandardWindow "飞书"
  - [1] AXGroup
    - [2] AXTextField placeholder="搜索" selectionWritable=true
`
  const focus = parseFeishuFocus(dump)
  assert.equal(focus.chat.name, null)
  assert.equal(focus.chat.kind, 'unknown')
  assert.equal(focus.candidates.length, 0)
})

test('parseFeishuFocus flags a truncated tree and respects recentLimit', () => {
  const dump = `${FEISHU_DUMP}Accessibility tree truncated (maxElements=800, maxDepth=12). Select a narrower window or increase these provider limits before reading again.`
  const focus = parseFeishuFocus(dump, { recentLimit: 2 })
  assert.equal(focus.truncated, true)
  assert.equal(focus.recentText.length, 2)
})
