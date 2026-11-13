import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../../packages/host-work/lib/index.js'

function fakeTable() {
  const rows = new Map()
  return {
    get: (key) => rows.get(key),
    entries: () => rows.entries(),
    keys: () => rows.keys(),
    get size() {
      return rows.size
    },
    async put(key, value) {
      rows.set(key, value)
    },
    async delete(key) {
      return rows.delete(key)
    },
    async deleteMany(keys) {
      let count = 0
      for (const key of keys) if (rows.delete(key)) count += 1
      return count
    },
    async update(key, fn) {
      const current = rows.get(key)
      if (current === undefined) throw new Error(`missing key: ${key}`)
      const next = fn(current)
      rows.set(key, next)
      return next
    },
  }
}

function makeCtx() {
  const tables = {
    tasks: fakeTable(),
    artifacts: fakeTable(),
    shares: fakeTable(),
  }
  const tools = new Map()
  const prompts = []
  const renames = []
  const cancels = []
  const schedules = []
  const scheduleEdits = []
  const notifications = []
  const provided = new Map()
  const disposers = []
  const handlers = []
  let closes = 0
  let globalSettings = {}

  const ctx = {
    storageDomain: {
      async open(spec) {
        assert.equal(spec.name, 'work')
        return {
          name: 'work',
          global: {
            get: () => globalSettings,
            set: async (value) => { globalSettings = value },
          },
          table: (name) => {
            const table = tables[name]
            if (!table) throw new Error(`unknown table: ${name}`)
            return table
          },
          close: async () => {
            closes += 1
          },
        }
      },
    },
    schedule: {
      async create(request, actorSessionId) {
        schedules.push({ request, actorSessionId })
        return { id: 'sch-1', target: request.target }
      },
      async edit(request, actorSessionId) {
        scheduleEdits.push({ request, actorSessionId })
        return { id: request.id, target: { kind: 'session', sessionId: 'reserved-1' } }
      },
    },
    sessionController: {
      async create(request) {
        assert.equal(request.agentPreset, 'work')
        return { sessionId: 'sess-1' }
      },
      async prompt(request) {
        prompts.push(request)
        return { accepted: true }
      },
      async rename(request) {
        renames.push(request)
        return { title: request.title, seq: 1 }
      },
      cancel(request) {
        cancels.push(request)
        return { cancelled: true }
      },
    },
    tools: {
      definitions() {
        return []
      },
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect(fn) {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
    provide(name, value) {
      provided.set(name, value)
      return () => provided.delete(name)
    },
    get(name) {
      if (name === 'workNotifier') {
        return { notify: async (input) => { notifications.push(input) } }
      }
      return undefined
    },
    on(event, handler) {
      handlers.push([event, handler])
      return () => {}
    },
  }

  return {
    ctx,
    tables,
    tools,
    prompts,
    renames,
    cancels,
    schedules,
    scheduleEdits,
    notifications,
    provided,
    disposers,
    handlers,
    closeCount: () => closes,
  }
}

async function withArtifactRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-work-test-'))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('host-work registers services and tools, creates a task, indexes artifacts, and settles on turn end', async () => {
  await withArtifactRoot(async (artifactRoot) => {
    const h = makeCtx()
    await apply(h.ctx, { artifactRoot, retryDelayMs: 1, remote: false })

    assert.ok(h.provided.get('workTasks'), 'ctx.workTasks must be provided')
    assert.ok(h.provided.get('workArtifacts'), 'ctx.workArtifacts must be provided')
    for (const name of [
      'work_task_create',
      'work_task_list',
      'work_task_get',
      'work_task_prompt',
      'work_task_cancel',
      'work_task_schedule',
      'work_artifact_list',
      'work_artifact_scan',
      'work_artifact_get',
      'work_ping',
    ]) {
      assert.ok(h.tools.has(name), `missing tool: ${name}`)
    }

    const created = await h.tools.get('work_task_create').execute(
      { title: '周报', goal: '根据三篇文档生成周报 docx' },
      { signal: new AbortController().signal },
    )
    assert.deepEqual(created, { id: 'sess-1', title: '周报', status: 'running' })

    const task = h.tables.tasks.get('sess-1')
    assert.equal(task.status, 'running')
    assert.equal(task.goal, '根据三篇文档生成周报 docx')
    assert.equal(task.workspaceId, '')
    assert.equal(task.artifactDir, join(artifactRoot, 'sess-1'))
    assert.equal(h.renames.length, 1)
    assert.equal(h.renames[0].title, '[Work] 周报')
    assert.equal(h.prompts.length, 1)
    assert.match(h.prompts[0].content[0].text, /根据三篇文档生成周报 docx/)
    assert.match(h.prompts[0].content[0].text, /产物目录/)

    await writeFile(join(task.artifactDir, '周报.docx'), 'fake docx bytes')
    const scanned = await h.provided.get('workTasks').scanArtifacts('sess-1')
    assert.equal(scanned.length, 1)
    assert.equal(scanned[0].kind, 'docx')
    assert.equal(scanned[0].version, 1)
    assert.equal(h.tables.tasks.get('sess-1').outputs.length, 1)

    const listed = await h.tools.get('work_artifact_list').execute(
      { taskId: 'sess-1' },
      { signal: new AbortController().signal },
    )
    assert.equal(listed.length, 1)
    assert.equal(listed[0].kind, 'docx')

    const turnEnd = h.handlers.find(([event]) => event === 'session/event')?.[1]
    assert.equal(typeof turnEnd, 'function')
    await turnEnd(
      { id: 'sess-1' },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    )
    assert.equal(h.tables.tasks.get('sess-1').status, 'done')
    assert.equal(h.tables.tasks.get('sess-1').outputs.length, 1)
    assert.equal(h.notifications.length, 1)
    assert.equal(h.notifications[0].event, 'done')

    const scheduled = await h.tools.get('work_task_schedule').execute(
      {
        taskId: 'sess-1',
        rrule: 'DTSTART;TZID=Asia/Shanghai:20261110T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO',
        chatId: 'oc_1',
      },
      { signal: new AbortController().signal },
    )
    assert.equal(scheduled.scheduleId, 'sch-1')
    assert.equal(h.schedules.length, 1)
    assert.equal(h.schedules[0].actorSessionId, 'sess-1')
    assert.equal(h.schedules[0].request.title, '[Work] 周报')
    assert.equal(h.schedules[0].request.timing.kind, 'rrule')
    assert.deepEqual(h.schedules[0].request.target, { kind: 'session', sessionId: 'sess-1' })
    assert.match(h.schedules[0].request.prompt, /根据三篇文档生成周报 docx/)
    assert.equal(h.tables.tasks.get('sess-1').scheduleId, 'sch-1')
    assert.equal(h.tables.tasks.get('sess-1').notifyChatId, 'oc_1')

    const list = await h.tools.get('work_task_list').execute(
      { limit: 10 },
      { signal: new AbortController().signal },
    )
    assert.equal(list.length, 1)

    const ping = await h.tools.get('work_ping').execute({}, { signal: new AbortController().signal })
    assert.deepEqual(ping, { ok: true, version: '0.1.0', tasks: 1 })

    await h.tools.get('work_task_prompt').execute(
      { taskId: 'sess-1', text: '把结论改成三条' },
      { signal: new AbortController().signal },
    )
    assert.equal(h.prompts.length, 2)

    await h.tools.get('work_task_cancel').execute(
      { taskId: 'sess-1' },
      { signal: new AbortController().signal },
    )
    assert.equal(h.cancels.length, 1)
    assert.equal(h.tables.tasks.get('sess-1').status, 'cancelled')

    for (const dispose of h.disposers) await dispose()
    assert.equal(h.closeCount(), 1)
  })
})

test('host-work marks a task failed when the first prompt is rejected', async () => {
  await withArtifactRoot(async (artifactRoot) => {
    const h = makeCtx()
    h.ctx.sessionController.prompt = async () => {
      throw new Error('model unavailable')
    }
    await apply(h.ctx, { artifactRoot, retryDelayMs: 1, remote: false })

    await assert.rejects(
      h.tools.get('work_task_create').execute(
        { title: '失败任务', goal: '测试失败态' },
        { signal: new AbortController().signal },
      ),
      /model unavailable/,
    )

    const task = h.tables.tasks.get('sess-1')
    assert.equal(task.status, 'failed')
    assert.equal(task.lastError.code, 'work_task_prompt_failed')
  })
})

test('turn-end error maps to failed with a lastError', async () => {
  await withArtifactRoot(async (artifactRoot) => {
    const h = makeCtx()
    await apply(h.ctx, { artifactRoot, retryDelayMs: 1, remote: false })
    await h.tools.get('work_task_create').execute(
      { title: '失败', goal: '触发错误' },
      { signal: new AbortController().signal },
    )

    const turnEnd = h.handlers.find(([event]) => event === 'session/event')?.[1]
    await turnEnd(
      { id: 'sess-1' },
      { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'model exploded' } } } },
    )

    const task = h.tables.tasks.get('sess-1')
    assert.equal(task.status, 'failed')
    assert.equal(task.lastError.code, 'turn_failed')
    assert.match(task.lastError.message, /model exploded/)
  })
})

test('a failed scheduled run queues one retry and then notifies on success', async () => {
  await withArtifactRoot(async (artifactRoot) => {
    const h = makeCtx()
    await apply(h.ctx, { artifactRoot, retryDelayMs: 1, remote: false })
    await h.tools.get('work_task_create').execute(
      { title: '定时失败', goal: '触发一次失败' },
      { signal: new AbortController().signal },
    )
    await h.tools.get('work_task_schedule').execute(
      {
        taskId: 'sess-1',
        rrule: 'DTSTART;TZID=Asia/Shanghai:20261110T090000\nRRULE:FREQ=DAILY',
        chatId: 'oc_1',
      },
      { signal: new AbortController().signal },
    )

    const turnEnd = h.handlers.find(([event]) => event === 'session/event')?.[1]
    await turnEnd(
      { id: 'sess-1' },
      { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'temporary' } } } },
    )

    assert.equal(h.tables.tasks.get('sess-1').status, 'queued')
    assert.equal(h.tables.tasks.get('sess-1').retryCount, 1)
    assert.equal(h.notifications.length, 0)

    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(h.prompts.length, 2)
    assert.equal(h.tables.tasks.get('sess-1').status, 'running')
    assert.match(h.prompts[1].content[0].text, /上一次定时运行失败/)
  })
})

test('new_once reserves a companion task and repoints the schedule prompt', async () => {
  await withArtifactRoot(async (artifactRoot) => {
    const h = makeCtx()
    await apply(h.ctx, { artifactRoot, remote: false, retryDelayMs: 1 })
    await h.tools.get('work_task_create').execute(
      { title: '每日简报', goal: '整理昨日行业动态' },
      { signal: new AbortController().signal },
    )

    h.ctx.schedule.create = async (request) => {
      h.schedules.push({ request, actorSessionId: 'sess-1' })
      return {
        id: 'sch-2',
        target: { kind: 'new_once', sessionId: 'reserved-1', create: {} },
      }
    }

    const service = h.provided.get('workTasks')
    const scheduleId = await service.schedule(
      'sess-1',
      'DTSTART;TZID=Asia/Shanghai:20261110T090000\nRRULE:FREQ=DAILY',
      'new_once',
      'oc_1',
    )

    assert.equal(scheduleId, 'sch-2')
    const reserved = h.tables.tasks.get('reserved-1')
    assert.ok(reserved)
    assert.equal(reserved.scheduleId, 'sch-2')
    assert.equal(reserved.notifyChatId, 'oc_1')
    assert.equal(reserved.artifactDir, `${artifactRoot}/reserved-1`)
    assert.equal(h.tables.tasks.get('sess-1').scheduleId, 'sch-2')
    assert.equal(h.scheduleEdits.length, 1)
    assert.equal(h.scheduleEdits[0].request.id, 'sch-2')
    assert.match(h.scheduleEdits[0].request.patch.prompt, /reserved-1/)
  })
})

test('new target is rejected for work tasks', async () => {
  await withArtifactRoot(async (artifactRoot) => {
    const h = makeCtx()
    await apply(h.ctx, { artifactRoot, remote: false })
    await h.tools.get('work_task_create').execute(
      { title: 'x', goal: 'y' },
      { signal: new AbortController().signal },
    )
    await assert.rejects(
      h.provided.get('workTasks').schedule('sess-1', 'DTSTART:20261110T090000Z\nRRULE:FREQ=DAILY', 'new'),
      /cannot be attributed/,
    )
  })
})

test('work settings persist in the domain global and feed new tasks', async () => {
  await withArtifactRoot(async (artifactRoot) => {
    const h = makeCtx()
    await apply(h.ctx, { artifactRoot, remote: false })
    const service = h.provided.get('workTasks')

    assert.deepEqual(service.settings(), {})
    const saved = await service.updateSettings({ defaultModel: 'glm-5.3-flash', notifyChatId: 'oc_1' })
    assert.deepEqual(saved, { defaultModel: 'glm-5.3-flash', notifyChatId: 'oc_1' })
    assert.deepEqual(service.settings(), saved)

    const task = await service.create({ title: '设置模型', goal: '验证默认模型' })
    assert.equal(task.model, 'glm-5.3-flash')

    const cleared = await service.updateSettings({ notifyChatId: '' })
    assert.equal(cleared.notifyChatId, undefined)
    assert.equal(cleared.defaultModel, 'glm-5.3-flash')
  })
})

test('clearData removes tasks, artifact files, and shares', async () => {
  await withArtifactRoot(async (artifactRoot) => {
    const h = makeCtx()
    await apply(h.ctx, { artifactRoot, remote: false })
    const service = h.provided.get('workTasks')
    const task = await service.create({ title: '待清空', goal: 'x' })
    await mkdir(task.artifactDir, { recursive: true })
    await writeFile(`${task.artifactDir}/a.md`, 'artifact')
    await service.scanArtifacts(task.id)

    assert.equal(h.tables.tasks.size, 1)
    assert.equal(h.tables.artifacts.size, 1)
    const cleared = await service.clearData()
    assert.deepEqual(cleared, { tasks: 1, artifacts: 1 })
    assert.equal(h.tables.tasks.size, 0)
    assert.equal(h.tables.artifacts.size, 0)
    await assert.rejects(stat(task.artifactDir), /ENOENT/)
  })
})

test('exportData writes a tar.gz with tasks and artifact files', async () => {
  await withArtifactRoot(async (artifactRoot) => {
    const h = makeCtx()
    await apply(h.ctx, { artifactRoot, remote: false })
    const service = h.provided.get('workTasks')
    const task = await service.create({ title: '导出', goal: 'x' })
    await mkdir(task.artifactDir, { recursive: true })
    await writeFile(`${task.artifactDir}/a.md`, 'artifact')
    await service.scanArtifacts(task.id)

    const result = await service.exportData()
    const info = await stat(result.path)
    assert.equal(result.tasks, 1)
    assert.equal(result.artifacts, 1)
    assert.ok(info.size > 0)
    assert.match(result.path, /work-export-.*\.tar\.gz$/)
    await rm(result.path, { force: true })
  })
})

test('attachSession creates a draft task and turn-start moves it to running', async () => {
  await withArtifactRoot(async (artifactRoot) => {
    const h = makeCtx()
    await apply(h.ctx, { artifactRoot, remote: false })
    const service = h.provided.get('workTasks')
    const task = await service.attachSession('sess-1')
    assert.equal(task.status, 'draft')
    assert.equal(task.artifactDir, join(artifactRoot, 'sess-1'))
    assert.equal(h.prompts.length, 0)
    assert.equal(h.renames.at(-1).title, '[Work] 工作任务')
    await service.onTurnStart('sess-1')
    assert.equal(h.tables.tasks.get('sess-1').status, 'running')
  })
})

test('detachSession removes a draft task but keeps the session', async () => {
  await withArtifactRoot(async (artifactRoot) => {
    const h = makeCtx()
    await apply(h.ctx, { artifactRoot, remote: false })
    const service = h.provided.get('workTasks')
    await service.attachSession('sess-1')
    await service.detachSession('sess-1')
    assert.equal(h.tables.tasks.get('sess-1'), undefined)
    assert.equal(h.renames.at(-1).title, '新会话')
  })
})

test('exportTask/removeTask operate on one task and keep the session', async () => {
  await withArtifactRoot(async (artifactRoot) => {
    const h = makeCtx()
    await apply(h.ctx, { artifactRoot, remote: false })
    const service = h.provided.get('workTasks')
    const task = await service.attachSession('sess-1')
    await mkdir(task.artifactDir, { recursive: true })
    await writeFile(`${task.artifactDir}/a.md`, 'artifact')
    await service.scanArtifacts('sess-1')
    const exported = await service.exportTask('sess-1')
    assert.equal(exported.artifacts, 1)
    assert.ok((await stat(exported.path)).size > 0)
    await rm(exported.path, { force: true })
    const removed = await service.removeTask('sess-1')
    assert.equal(removed.artifacts, 1)
    assert.equal(h.tables.tasks.get('sess-1'), undefined)
    assert.equal(h.renames.at(-1).title, '工作任务')
  })
})

test('schedulePause patches the bound schedule', async () => {
  await withArtifactRoot(async (artifactRoot) => {
    const h = makeCtx()
    await apply(h.ctx, { artifactRoot, remote: false })
    const service = h.provided.get('workTasks')
    await service.schedulePause('sch-1', false)
    assert.deepEqual(h.scheduleEdits.at(-1).request, {
      id: 'sch-1',
      action: 'update',
      patch: { active: false },
    })
  })
})

test('first user message gives a generic work task a readable title', async () => {
  await withArtifactRoot(async (artifactRoot) => {
    const h = makeCtx()
    await apply(h.ctx, { artifactRoot, remote: false })
    const service = h.provided.get('workTasks')
    await service.attachSession('sess-1')
    assert.equal(h.tables.tasks.get('sess-1').title, '工作任务')
    await service.onUserMessage('sess-1', '整理本周销售数据并生成周报')
    const task = h.tables.tasks.get('sess-1')
    assert.equal(task.title, '整理本周销售数据并生成周报')
    assert.equal(task.goal, '整理本周销售数据并生成周报')
    assert.equal(h.renames.at(-1).title, '[Work] 整理本周销售数据并生成周报')
  })
})
