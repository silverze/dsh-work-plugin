import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  DataSettings,
  FeishuSettingsShell,
  WorkGeneralSettings,
  WorkPanel,
} from '../../packages/client-work/lib/client.node.mjs'

const fakeWorkbench = {
  listTasks: async () => [],
  getTask: async () => undefined,
  listArtifacts: async () => [],
  listLibrary: async () => [],
  feishuStatus: async () => ({ connected: false }),
  getSettings: async () => ({ defaultModel: 'glm-5.3-flash' }),
  setSettings: async (patch) => patch,
  exportData: async () => ({ path: '/tmp/x.tar.gz', size: 1, tasks: 0, artifacts: 0 }),
  clearData: async () => ({ tasks: 0, artifacts: 0 }),
  attachSession: async () => ({}),
}

test('right work panel renders its three tabs and no-task guidance', () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkPanel, { sessionId: 's1', workbench: fakeWorkbench }),
  )
  assert.match(html, /当前任务/)
  assert.match(html, /成果库/)
  assert.match(html, /定时/)
  assert.match(html, /当前会话还不是工作任务/)
})

test('Feishu settings shell renders connection/preferences/data tabs', () => {
  const html = renderToStaticMarkup(
    React.createElement(FeishuSettingsShell, { workbench: fakeWorkbench, close: () => {} }),
  )
  assert.match(html, /连接/)
  assert.match(html, /偏好/)
  assert.match(html, /工作数据/)
  assert.match(html, /应用凭据/)
  assert.match(html, /授权码只保存在本机/)
})

test('work preferences render editable defaults', () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkGeneralSettings, { workbench: fakeWorkbench, close: () => {} }),
  )
  assert.match(html, /默认模型/)
  assert.match(html, /定时通知/)
})

test('data settings render export and destructive action', () => {
  const html = renderToStaticMarkup(
    React.createElement(DataSettings, { workbench: fakeWorkbench, close: () => {} }),
  )
  assert.match(html, /清空本地数据/)
  assert.match(html, /导出数据/)
})
