import test from 'node:test'
import assert from 'node:assert/strict'

import { WorkbenchController } from '../../packages/client-work/lib/client.node.mjs'

function makeCtx(handler) {
  const calls = []
  const ctx = {
    get(name) {
      if (name === 'uiWorkspace') return { openSession: (id) => calls.push({ endpoint: 'ui/openSession', id }) }
      if (name === 'sidebarRight') return { openResource: (address) => calls.push({ endpoint: 'ui/openResource', address }) }
      if (name !== 'connection') return undefined
      return {
        rpc: {
          async call(channel, endpoint, payload, signal) {
            calls.push({ channel, endpoint, payload, signal })
            return handler(endpoint, payload)
          },
        },
      }
    },
  }
  return { ctx, calls }
}

test('createTask calls work/taskCreate through the authenticated RPC', async () => {
  const task = { id: 'sess-1', title: '项目周报', status: 'running' }
  const h = makeCtx((endpoint) => {
    if (endpoint === 'work/taskCreate') return { ok: true, value: task }
    return { ok: false, error: { code: 'unexpected', message: endpoint } }
  })
  const controller = new WorkbenchController(h.ctx)

  const created = await controller.createTask({ title: '项目周报', goal: '生成周报 docx' })
  assert.equal(created.id, 'sess-1')
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].channel, '/api')
  assert.equal(h.calls[0].endpoint, 'work/taskCreate')
  assert.deepEqual(h.calls[0].payload, {
    args: { request: { title: '项目周报', goal: '生成周报 docx' } },
  })
  assert.ok(h.calls[0].signal)
})

test('empty goal rejects before calling the RPC', async () => {
  const h = makeCtx(() => ({ ok: true, value: {} }))
  const controller = new WorkbenchController(h.ctx)
  await assert.rejects(controller.createTask({ title: '', goal: '  ' }), /任务目标不能为空/)
  assert.equal(h.calls.length, 0)
})

test('listTasks and listArtifacts map to their endpoints', async () => {
  const h = makeCtx((endpoint) => {
    if (endpoint === 'work/taskList') return { ok: true, value: [{ id: 's1' }] }
    if (endpoint === 'work/artifactList') return { ok: true, value: [{ id: 'a1' }] }
    return { ok: false, error: { code: 'unexpected', message: endpoint } }
  })
  const controller = new WorkbenchController(h.ctx)

  assert.equal((await controller.listTasks()).length, 1)
  assert.equal((await controller.listArtifacts('s1')).length, 1)
  assert.equal(h.calls[0].endpoint, 'work/taskList')
  assert.deepEqual(h.calls[1].payload, { args: { request: { taskId: 's1', limit: 100 } } })
})

test('an RPC failure surfaces the endpoint and Host message', async () => {
  const h = makeCtx(() => ({
    ok: false,
    error: { code: 'gateway/denied', message: 'not allowed' },
  }))
  const controller = new WorkbenchController(h.ctx)
  await assert.rejects(controller.listTasks(), /work\/taskList: not allowed/)
})

test('feishu connection actions use the feishu/* endpoints', async () => {
  const h = makeCtx((endpoint) => {
    if (endpoint === 'feishu/status') return { ok: true, value: { connected: false } }
    if (endpoint === 'feishu/startAuth') {
      return { ok: true, value: { url: 'https://example/auth', state: 's', expiresAt: 1 } }
    }
    if (endpoint === 'feishu/disconnect') return { ok: true, value: { disconnected: true } }
    return { ok: false, error: { code: 'unexpected', message: endpoint } }
  })
  const controller = new WorkbenchController(h.ctx)

  assert.equal((await controller.feishuStatus()).connected, false)
  assert.equal((await controller.feishuStart()).state, 's')
  assert.equal((await controller.feishuDisconnect()).disconnected, true)
  assert.deepEqual(
    h.calls.map((call) => call.endpoint),
    ['feishu/status', 'feishu/startAuth', 'feishu/disconnect'],
  )
})

test('prompt and schedule actions map to work/taskPrompt and work/taskSchedule', async () => {
  const h = makeCtx((endpoint) => {
    if (endpoint === 'work/taskPrompt') return { ok: true, value: { accepted: true } }
    if (endpoint === 'work/taskSchedule') return { ok: true, value: { scheduleId: 'sch-1' } }
    return { ok: false, error: { code: 'unexpected', message: endpoint } }
  })
  const controller = new WorkbenchController(h.ctx)

  assert.equal((await controller.promptTask('s1', '再补一张图')).accepted, true)
  assert.equal((await controller.scheduleTask('s1', 'DTSTART:20261110T090000Z\nRRULE:FREQ=DAILY', 'oc_1')).scheduleId, 'sch-1')
  assert.deepEqual(h.calls[0].payload, {
    args: { request: { taskId: 's1', text: '再补一张图' } },
  })
  assert.deepEqual(h.calls[1].payload, {
    args: {
      request: {
        taskId: 's1',
        rrule: 'DTSTART:20261110T090000Z\nRRULE:FREQ=DAILY',
        chatId: 'oc_1',
      },
    },
  })
})

test('openSession and openArtifact delegate to the shell services', async () => {
  const h = makeCtx(() => ({ ok: true, value: {} }))
  const controller = new WorkbenchController(h.ctx)
  controller.openSession('s1')
  controller.openArtifact('s1', '/tmp/report.docx')
  assert.equal(h.calls[0].endpoint, 'ui/openSession')
  assert.equal(h.calls[0].id, 's1')
  assert.equal(h.calls[1].endpoint, 'ui/openResource')
  assert.match(h.calls[1].address, /^dsh-resource:\/\/file\/session\/s1\//)
  assert.match(h.calls[1].address, /report\.docx/)
})

test('shareArtifact calls feishu/shareArtifact with the artifact and optional chat', async () => {
  const h = makeCtx((endpoint) => {
    if (endpoint === 'feishu/shareArtifact') {
      return { ok: true, value: { mode: 'import', token: 't1', url: 'https://feishu.cn/docx/d1' } }
    }
    return { ok: false, error: { code: 'unexpected', message: endpoint } }
  })
  const controller = new WorkbenchController(h.ctx)
  const result = await controller.shareArtifact('a1', 'oc_1')
  assert.equal(result.mode, 'import')
  assert.deepEqual(h.calls[0].payload, {
    args: { request: { artifactId: 'a1', chatId: 'oc_1' } },
  })
})

test('work settings get/set use their RPC endpoints', async () => {
  const h = makeCtx((endpoint) => {
    if (endpoint === 'work/settingsGet') return { ok: true, value: { defaultModel: 'm1' } }
    if (endpoint === 'work/settingsSet') return { ok: true, value: { defaultModel: 'm2' } }
    return { ok: false, error: { code: 'unexpected', message: endpoint } }
  })
  const controller = new WorkbenchController(h.ctx)
  assert.equal((await controller.getSettings()).defaultModel, 'm1')
  assert.equal((await controller.setSettings({ defaultModel: 'm2' })).defaultModel, 'm2')
  assert.deepEqual(h.calls[0].payload, { args: { request: {} } })
  assert.deepEqual(h.calls[1].payload, { args: { request: { defaultModel: 'm2' } } })
})

test('runSchedule calls work/scheduleRun with the schedule id', async () => {
  const h = makeCtx((endpoint) => {
    if (endpoint === 'work/scheduleRun') return { ok: true, value: { id: 'sch-1' } }
    return { ok: false, error: { code: 'unexpected', message: endpoint } }
  })
  const controller = new WorkbenchController(h.ctx)
  await controller.runSchedule('sch-1')
  assert.deepEqual(h.calls[0].payload, { args: { request: { scheduleId: 'sch-1' } } })
})

test('feishu app info/configure use their RPC endpoints', async () => {
  const h = makeCtx((endpoint) => {
    if (endpoint === 'feishu/appInfo') return { ok: true, value: { configured: true, appId: 'cli_12…7890' } }
    if (endpoint === 'feishu/configureApp') return { ok: true, value: { configured: true } }
    return { ok: false, error: { code: 'unexpected', message: endpoint } }
  })
  const controller = new WorkbenchController(h.ctx)
  assert.equal((await controller.feishuAppInfo()).configured, true)
  await controller.configureFeishuApp('cli_1234567890', 'secret')
  assert.deepEqual(h.calls[1].payload, { args: { request: { appId: 'cli_1234567890', appSecret: 'secret' } } })
})

test('Feishu quick read uses docRead/sheetRead with request args', async () => {
  const h = makeCtx((endpoint) => {
    if (endpoint === 'feishu/docRead') return { ok: true, value: { documentId: 'd1', content: 'body', url: 'u' } }
    if (endpoint === 'feishu/sheetRead') return { ok: true, value: { range: 'A1:B1', values: [['a']] } }
    return { ok: false, error: { code: 'unexpected', message: endpoint } }
  })
  const controller = new WorkbenchController(h.ctx)
  assert.equal((await controller.readFeishuDocument('d1')).content, 'body')
  await controller.readFeishuSheet('s1', 'A1:B1')
  assert.deepEqual(h.calls[0].payload, { args: { request: { documentId: 'd1' } } })
  assert.deepEqual(h.calls[1].payload, { args: { request: { spreadsheetToken: 's1', range: 'A1:B1' } } })
})

test('resolveFeishuWiki uses feishu/wikiResolve', async () => {
  const h = makeCtx((endpoint) => {
    if (endpoint === 'feishu/wikiResolve') return { ok: true, value: { objType: 'docx', objToken: 'd1' } }
    return { ok: false, error: { code: 'unexpected', message: endpoint } }
  })
  const controller = new WorkbenchController(h.ctx)
  const node = await controller.resolveFeishuWiki('w1')
  assert.equal(node.objToken, 'd1')
  assert.deepEqual(h.calls[0].payload, { args: { request: { nodeToken: 'w1' } } })
})

test('listLibrary queries all artifacts without a task id', async () => {
  const h = makeCtx((endpoint) => {
    if (endpoint === 'work/artifactList') return { ok: true, value: [] }
    return { ok: false, error: { code: 'unexpected', message: endpoint } }
  })
  const controller = new WorkbenchController(h.ctx)
  await controller.listLibrary({ kind: 'docx', query: '周报' })
  assert.deepEqual(h.calls[0].payload, { args: { request: { kind: 'docx', query: '周报', limit: 200 } } })
})

test('clearData sends confirm=DELETE', async () => {
  const h = makeCtx((endpoint) => {
    if (endpoint === 'work/clearData') return { ok: true, value: { tasks: 1, artifacts: 2 } }
    return { ok: false, error: { code: 'unexpected', message: endpoint } }
  })
  const controller = new WorkbenchController(h.ctx)
  assert.deepEqual(await controller.clearData(), { tasks: 1, artifacts: 2 })
  assert.deepEqual(h.calls[0].payload, { args: { request: { confirm: 'DELETE' } } })
})

test('exportData calls work/exportData', async () => {
  const h = makeCtx((endpoint) => {
    if (endpoint === 'work/exportData') return { ok: true, value: { path: '/tmp/x.tar.gz', size: 10, tasks: 1, artifacts: 1 } }
    return { ok: false, error: { code: 'unexpected', message: endpoint } }
  })
  const controller = new WorkbenchController(h.ctx)
  assert.equal((await controller.exportData()).path, '/tmp/x.tar.gz')
  assert.deepEqual(h.calls[0].payload, { args: { request: {} } })
})

test('work mode attach/detach/remove/schedulePause map to remotes', async () => {
  const h = makeCtx((endpoint) => {
    if (endpoint === 'work/taskList') return { ok: true, value: [] }
    if (endpoint === 'work/attachSession') return { ok: true, value: { id: 's1', outputs: [], title: 't', goal: 'g', status: 'draft', createdAt: 1, updatedAt: 1 } }
    if (endpoint === 'work/detachSession') return { ok: true, value: { detached: true } }
    if (endpoint === 'work/removeTask') return { ok: true, value: { artifacts: 2 } }
    if (endpoint === 'work/schedulePause') return { ok: true, value: { active: false } }
    return { ok: false, error: { code: 'unexpected', message: endpoint } }
  })
  const controller = new WorkbenchController(h.ctx)
  await controller.attachSession('s1')
  await controller.detachSession('s1')
  assert.deepEqual(await controller.removeTask('s1'), { artifacts: 2 })
  await controller.schedulePause('sch1', false)
  assert.deepEqual(h.calls.find((call) => call.endpoint === 'work/attachSession').payload, { args: { request: { sessionId: 's1' } } })
  assert.deepEqual(h.calls.find((call) => call.endpoint === 'work/removeTask').payload, { args: { request: { taskId: 's1', confirm: 'DELETE' } } })
})
