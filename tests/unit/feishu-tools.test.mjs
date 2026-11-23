import test from 'node:test'
import assert from 'node:assert/strict'

import { registerFeishuTools } from '../../packages/host-feishu/lib/index.js'

function harness(client) {
  const tools = new Map()
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  registerFeishuTools(ctx, client)
  return tools
}

const exec = { signal: new AbortController().signal }

test('feishu_doc_read truncates at maxChars and reports it', async () => {
  const tools = harness({
    async readDocument() {
      return { documentId: 'd1', content: '0123456789abcdef', url: 'https://feishu.cn/docx/d1' }
    },
  })
  const result = await tools.get('feishu_doc_read').execute(
    { documentId: 'd1', maxChars: 10 },
    exec,
  )
  assert.equal(result.content, '0123456789')
  assert.equal(result.truncated, true)
  assert.equal(result.url, 'https://feishu.cn/docx/d1')
})

test('feishu_sheet_read returns metadata or values', async () => {
  const tools = harness({
    async readSheet(input) {
      if (!input.range) {
        return { spreadsheetToken: input.spreadsheetToken, sheets: [{ sheetId: 's1', title: 'Sheet1', rowCount: 2, columnCount: 2 }] }
      }
      return { range: input.range, values: [['a', 1]] }
    },
  })
  const meta = await tools.get('feishu_sheet_read').execute({ spreadsheetToken: 't1' }, exec)
  assert.equal(meta.sheets[0].title, 'Sheet1')
  const values = await tools.get('feishu_sheet_read').execute({ spreadsheetToken: 't1', range: 'Sheet1!A1:B1' }, exec)
  assert.deepEqual(values.values, [['a', 1]])
})

test('feishu_im_send wraps plain text but passes interactive JSON through', async () => {
  const calls = []
  const tools = harness({
    async sendMessage(input) {
      calls.push(input)
      return { messageId: 'om_1' }
    },
  })
  await tools.get('feishu_im_send').execute(
    { receiveId: 'oc_1', receiveIdType: 'chat_id', msgType: 'text', content: 'hello' },
    exec,
  )
  assert.deepEqual(JSON.parse(calls[0].content), { text: 'hello' })
  await tools.get('feishu_im_send').execute(
    { receiveId: 'oc_1', receiveIdType: 'chat_id', msgType: 'interactive', content: '{"a":1}' },
    exec,
  )
  assert.equal(calls[1].content, '{"a":1}')
})

test('feishu_doc_create and append map to the client contract', async () => {
  const calls = []
  const tools = harness({
    async createDocument(input) {
      calls.push(['create', input])
      return { documentId: 'd2', url: 'https://feishu.cn/docx/d2' }
    },
    async appendDocument(input) {
      calls.push(['append', input])
      return { documentId: input.documentId, appended: 2, failed: 0 }
    },
  })
  const created = await tools.get('feishu_doc_create').execute({ title: 'Report' }, exec)
  assert.equal(created.documentId, 'd2')
  const appended = await tools.get('feishu_doc_append').execute(
    { documentId: 'd2', markdown: '# Title\n\nbody' },
    exec,
  )
  assert.equal(appended.appended, 2)
  assert.equal(calls[1][1].markdown, '# Title\n\nbody')
})

test('feishu_whoami returns identity fields', async () => {
  const tools = harness({
    async whoami() {
      return { openId: 'ou_1', name: 'Alice', unionId: 'on_1' }
    },
  })
  const me = await tools.get('feishu_whoami').execute({}, exec)
  assert.deepEqual(me, { openId: 'ou_1', name: 'Alice', unionId: 'on_1' })
})

test('feishu_wiki_get resolves a node token', async () => {
  const tools = harness({
    async resolveWikiNode(token) {
      assert.equal(token, 'w1')
      return { objType: 'docx', objToken: 'd1' }
    },
  })
  const node = await tools.get('feishu_wiki_get').execute({ nodeToken: 'w1' }, exec)
  assert.deepEqual(node, { objType: 'docx', objToken: 'd1' })
})

test('dryRun write tools describe the request and never reach Feishu', async () => {
  const calls = []
  const client = new Proxy(
    {},
    {
      get: (_target, method) => async () => {
        calls.push(String(method))
        throw new Error(`dry run called ${String(method)}`)
      },
    },
  )
  const tools = harness(client)
  const cases = [
    ['feishu_doc_create', { title: 'Report' }],
    ['feishu_doc_append', { documentId: 'd1', markdown: '# Title' }],
    ['feishu_sheet_write', { spreadsheetToken: 't1', range: 'A1:B1', values: [['a', 'b']] }],
    ['feishu_sheet_append', { spreadsheetToken: 't1', range: 'A1', values: [['a']] }],
    ['feishu_drive_upload', { filePath: '/tmp/x.xlsx', fileName: 'x.xlsx' }],
    ['feishu_im_send', { receiveId: 'oc_1', receiveIdType: 'chat_id', msgType: 'text', content: 'hi' }],
  ]
  for (const [name, args] of cases) {
    const result = await tools.get(name).execute({ ...args, dryRun: true }, exec)
    assert.equal(result.dryRun, true, name)
    assert.match(result.preview, new RegExp(`Dry run for ${name}`), name)
  }
  assert.deepEqual(calls, [])
})

test('feishu_api allows read-only allowlisted services and refuses the rest', async () => {
  const paths = []
  const tools = harness({
    async getJson(path, query) {
      paths.push([path, query])
      return { items: [{ a: 1 }] }
    },
  })
  const api = tools.get('feishu_api')
  const ok = await api.execute(
    { path: '/open-apis/bitable/v1/apps/app1/tables', query: 'page_size=20' },
    exec,
  )
  assert.equal(ok.truncated, false)
  assert.match(ok.json, /"items"/)
  assert.deepEqual(paths[0], ['/bitable/v1/apps/app1/tables', { page_size: '20' }])

  await assert.rejects(() => api.execute({ path: '/open-apis/hire/v1/jobs' }, exec), /not on the read-only list/)
  await assert.rejects(() => api.execute({ path: 'https://evil.example.com/x' }, exec), /must start with/)
})

test('feishu_task_create maps due and assignee onto the client contract', async () => {
  const calls = []
  const tools = harness({
    async createTask(input) {
      calls.push(input)
      return { taskGuid: 'tk1', summary: input.summary }
    },
  })
  const created = await tools.get('feishu_task_create').execute(
    { summary: 'Ship 0.4.0', due: '2026-12-01', assigneeOpenId: 'ou_2' },
    exec,
  )
  assert.equal(created.taskGuid, 'tk1')
  assert.equal(calls[0].summary, 'Ship 0.4.0')
  assert.equal(calls[0].assigneeOpenId, 'ou_2')
  assert.equal(calls[0].dueMs, Date.parse('2026-12-01'))
  assert.equal(calls[0].allDay, true, 'a date-only due must become an all-day due')

  await tools.get('feishu_task_create').execute(
    { summary: 'Review', due: '2026-12-01T09:30:00+08:00' },
    exec,
  )
  assert.equal(calls[1].allDay, undefined, 'a timestamp due keeps its time of day')
  await assert.rejects(
    () => tools.get('feishu_task_create').execute({ summary: 'x', due: 'next tuesday-ish' }, exec),
    /could not read due/,
  )
})

test('feishu_task_list_mine renders completion state and continuation', async () => {
  const tools = harness({
    async listTasks() {
      return {
        tasks: [
          { guid: 't1', summary: 'Write tests', completed: false },
          { guid: 't2', summary: 'Ship', completed: true, dueMs: 1_790_000_000_000 },
        ],
        hasMore: true,
        pageToken: 'p2',
      }
    },
  })
  const page = await tools.get('feishu_task_list_mine').execute({}, exec)
  assert.equal(page.hasMore, true)
  assert.equal(page.pageToken, 'p2')
  assert.equal(page.tasks[0].guid, 't1')
  assert.equal(page.tasks[1].due, '2026-09-21T14:13:20.000Z')
})

test('feishu_calendar_agenda clamps to the 40-day window', async () => {
  const tools = harness({
    async calendarAgenda() {
      return { events: [{ eventId: 'e1', summary: 'Sync', startMs: 1_790_000_000_000, endMs: 1_790_003_600_000 }], hasMore: false }
    },
  })
  const agenda = await tools.get('feishu_calendar_agenda').execute(
    { startTime: '2026-11-01T00:00:00Z', endTime: '2026-11-08T00:00:00Z' },
    exec,
  )
  assert.equal(agenda.events[0].summary, 'Sync')
  await assert.rejects(
    () =>
      tools.get('feishu_calendar_agenda').execute(
        { startTime: '2026-01-01T00:00:00Z', endTime: '2026-06-01T00:00:00Z' },
        exec,
      ),
    /at most 40 days/,
  )
})

test('feishu_minutes_get reports metadata without leaking transcript endpoints', async () => {
  const tools = harness({
    async getMinutes() {
      return { token: 'm1', title: 'Release sync', durationSeconds: 1800, url: 'https://feishu.cn/minutes/m1' }
    },
  })
  const note = await tools.get('feishu_minutes_get').execute({ minuteToken: 'm1' }, exec)
  assert.equal(note.title, 'Release sync')
  assert.equal(note.durationSeconds, 1800)
})
