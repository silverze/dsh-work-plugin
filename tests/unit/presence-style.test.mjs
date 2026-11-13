import test from 'node:test'
import assert from 'node:assert/strict'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  FeishuContextChip,
  PRESENCE_SAMPLE,
  PRESENCE_STYLE_OPTIONS,
  WorkGeneralSettings,
  isPresenceStyle,
  presenceChipTokens,
  presenceStyle,
} from '../../packages/client-work/lib/client.node.mjs'

test('the three chip styles are distinct and unknown values fall back', () => {
  assert.deepEqual(
    PRESENCE_STYLE_OPTIONS.map((option) => option.id),
    ['dsh', 'codex', 'claude'],
  )
  assert.equal(presenceStyle('codex'), 'codex')
  assert.equal(presenceStyle('nope'), 'dsh')
  assert.equal(presenceStyle(undefined), 'dsh')
  assert.equal(isPresenceStyle('claude'), true)
  assert.equal(isPresenceStyle('other'), false)

  const dsh = presenceChipTokens('dsh', true)
  const codex = presenceChipTokens('codex', true)
  const claude = presenceChipTokens('claude', true)
  assert.equal(dsh.pill.borderRadius, 999)
  assert.equal(dsh.glyph, '飞')
  assert.equal(codex.pill.borderRadius, 3)
  assert.match(String(codex.pill.fontFamily), /monospace/)
  assert.equal(codex.glyph, '›')
  assert.equal(claude.glyph, '●')
  assert.equal(claude.glyphStyle.color, '#D97757')

  // Active and idle states must differ, or the chip stops signalling whether a
  // conversation is actually available.
  for (const style of ['dsh', 'codex', 'claude']) {
    assert.notEqual(
      JSON.stringify(presenceChipTokens(style, true).pill),
      JSON.stringify(presenceChipTokens(style, false).pill),
      style,
    )
  }
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

function fakeWorkbench(style) {
  const index = new Map([[task.id, task]])
  return {
    subscribeIndex: () => () => {},
    indexSnapshot: () => index,
    subscribePresence: () => () => {},
    presenceSnapshot: () => ({
      chatName: '示例产品群',
      chatKind: 'group',
      messages: ['好', '可以了'],
      capturedAt: new Date('2026-11-13T10:32:00').getTime(),
      detected: true,
      cached: false,
      recent: [],
    }),
    refreshPresence: async () => undefined,
    subscribePresenceStyle: () => () => {},
    presenceStyleSnapshot: () => style,
    loadPresenceStyle: async () => style,
    getSettings: async () => ({ presenceStyle: style }),
    setSettings: async () => ({ presenceStyle: style }),
    setPresenceStyle: async () => {},
  }
}

const render = (style) =>
  renderToStaticMarkup(
    React.createElement(FeishuContextChip, {
      sessionId: 's1',
      workbench: fakeWorkbench(style),
      notify: () => {},
      inputActions: { insertQuote: () => true },
    }),
  )

test('the composer chip follows the configured style', () => {
  const dsh = render('dsh')
  assert.match(dsh, /飞/)
  assert.match(dsh, /border-radius:999px/)

  const codex = render('codex')
  assert.match(codex, /›/)
  assert.match(codex, /monospace/)
  assert.match(codex, /border-radius:3px/)

  const claude = render('claude')
  assert.match(claude, /●/)
  assert.match(claude, /border-radius:10px/)
  assert.match(claude, /#D97757/)
})

test('the settings picker lists every style with a live preview', () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkGeneralSettings, {
      workbench: fakeWorkbench('dsh'),
      close: () => {},
    }),
  )
  assert.match(html, /飞书会话 chip 风格/)
  assert.match(html, /DSH 默认/)
  assert.match(html, /Codex/)
  assert.match(html, /Claude/)
  assert.match(html, /使用中/)
  assert.match(html, /群聊｜示例产品群/)
  // The picker ships with the plugin: its sample must stay the fictional one.
  assert.deepEqual(PRESENCE_SAMPLE, { kindLabel: '群聊', chatName: '示例产品群', detail: '12 行 · 10:32' })
})
