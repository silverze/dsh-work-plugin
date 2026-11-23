/**
 * Feishu OpenAPI client for the P0 work tools.
 *
 * Direct `fetch` instead of the official SDK: the call surface is small, the
 * mock tests need exact request assertions, and token acquisition is owned by
 * the auth service (W3b) rather than hidden in a second cache.
 */

import { readFile } from 'node:fs/promises'

import { FeishuError, mapFeishuError } from './errors.js'
import type {
  FeishuDoc,
  FeishuIdentity,
  FeishuMessageResult,
  FeishuRangeValues,
  FeishuSheetMeta,
  FeishuImportResult,
  FeishuUploadResult,
} from './client.js'

export interface FeishuHttpClientOptions {
  /** Resolve a user access token. Return undefined to report `feishu_not_connected`. */
  accessToken: () => Promise<string | undefined>
  /** Defaults to the production OpenAPI root; tests point this at a local server. */
  baseUrl?: string
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
  maxRetries?: number
  retryDelayMs?: number
}

interface FeishuEnvelope<T> {
  code?: number
  msg?: string
  data?: T
}

type FeishuBlock = {
  block_type: number
  [key: string]: unknown
}

const DEFAULT_BASE_URL = 'https://open.feishu.cn/open-apis'
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_RETRY_DELAY_MS = 300

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function textBlock(blockType: number, content: string): FeishuBlock {
  const key =
    blockType === 2
      ? 'text'
      : blockType === 3
        ? 'heading1'
        : blockType === 4
          ? 'heading2'
          : blockType === 5
            ? 'heading3'
            : blockType === 12
              ? 'bullet'
              : blockType === 13
                ? 'ordered'
                : blockType === 14
                  ? 'code'
                  : 'text'

  return {
    block_type: blockType,
    [key]: {
      elements: [{ text_run: { content } }],
      style: {},
    },
  }
}

/** Minimal Markdown → docx block conversion for append operations. */
export function markdownToBlocks(markdown: string): FeishuBlock[] {
  const blocks: FeishuBlock[] = []
  let inCode = false
  let codeLines: string[] = []

  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (line.trimStart().startsWith('```')) {
      if (inCode) {
        blocks.push(textBlock(14, codeLines.join('\n')))
        codeLines = []
        inCode = false
      } else {
        inCode = true
      }
      continue
    }
    if (inCode) {
      codeLines.push(raw)
      continue
    }
    if (!line.trim()) continue

    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push(textBlock(2 + heading[1]!.length, heading[2]!))
      continue
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      blocks.push(textBlock(12, bullet[1]!))
      continue
    }
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line)
    if (ordered) {
      blocks.push(textBlock(13, ordered[1]!))
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      blocks.push(textBlock(2, line.replace(/^\s*>\s?/, '')))
      continue
    }
    blocks.push(textBlock(2, line))
  }

  if (inCode && codeLines.length) blocks.push(textBlock(14, codeLines.join('\n')))
  return blocks
}

export class FeishuHttpClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly maxRetries: number
  private readonly retryDelayMs: number

  constructor(private readonly options: FeishuHttpClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query: Record<string, string> = {},
  ): Promise<T> {
    const token = await this.options.accessToken()
    if (!token) {
      throw new FeishuError(
        'feishu_not_connected',
        'Feishu is not connected. Run the Feishu authorization flow first.',
      )
    }

    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)

    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    let payload: BodyInit | undefined
    if (body instanceof FormData) {
      payload = body
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }

    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl(url, { method, headers, body: payload })
      const text = await response.text()
      let envelope: FeishuEnvelope<T> | undefined
      try {
        envelope = text ? (JSON.parse(text) as FeishuEnvelope<T>) : undefined
      } catch {
        envelope = undefined
      }

      const logId = response.headers.get('x-tt-logid') ?? undefined
      const ok = response.ok && (envelope?.code === undefined || envelope.code === 0)
      if (ok) return (envelope?.data ?? ({} as T)) as T

      const error = mapFeishuError({
        status: response.status,
        code: envelope?.code,
        message: envelope?.msg ?? text.slice(0, 500) ?? response.statusText,
        ...(logId ? { logId } : {}),
      })

      if (!error.retryable || attempt >= this.maxRetries) throw error
      await delay(this.retryDelayMs * 2 ** attempt + Math.floor(Math.random() * 100))
    }
  }

  async whoami(): Promise<FeishuIdentity> {
    const data = await this.request<{
      name?: string
      open_id?: string
      union_id?: string
      avatar_url?: string
      tenant_key?: string
    }>('GET', '/authen/v1/user_info')
    return {
      openId: data.open_id ?? '',
      ...(data.union_id ? { unionId: data.union_id } : {}),
      name: data.name ?? 'Feishu user',
      ...(data.avatar_url ? { avatarUrl: data.avatar_url } : {}),
      ...(data.tenant_key ? { tenantKey: data.tenant_key } : {}),
    }
  }

  async readDocument(input: { documentId: string }): Promise<FeishuDoc> {
    const data = await this.request<{ content?: string }>(
      'GET',
      `/docx/v1/documents/${encodeURIComponent(input.documentId)}/raw_content`,
    )
    return {
      documentId: input.documentId,
      content: data.content ?? '',
      url: `https://feishu.cn/docx/${input.documentId}`,
    }
  }

  async resolveWikiNode(nodeToken: string): Promise<{ objType: string; objToken: string }> {
    const data = await this.request<{ node?: { obj_type?: string; obj_token?: string } }>(
      'GET',
      `/wiki/v2/spaces/get_node?token=${encodeURIComponent(nodeToken)}`,
    )
    const objType = data.node?.obj_type ?? ''
    const objToken = data.node?.obj_token ?? ''
    if (!objType || !objToken) throw new FeishuError('feishu_unknown', 'Feishu wiki node has no object')
    return { objType, objToken }
  }

  async createDocument(input: { title: string; folderToken?: string }): Promise<FeishuDoc> {
    const data = await this.request<{ document?: { document_id?: string }; document_id?: string }>(
      'POST',
      '/docx/v1/documents',
      {
        title: input.title,
        ...(input.folderToken ? { folder_token: input.folderToken } : {}),
      },
    )
    const documentId = data.document?.document_id ?? data.document_id ?? ''
    if (!documentId) throw new FeishuError('feishu_unknown', 'Feishu returned no document id')
    return {
      documentId,
      title: input.title,
      content: '',
      url: `https://feishu.cn/docx/${documentId}`,
    }
  }

  private async rootBlockId(documentId: string): Promise<string> {
    const data = await this.request<{ items?: Array<{ block_id?: string; block_type?: number }> }>(
      'GET',
      `/docx/v1/documents/${encodeURIComponent(documentId)}/blocks`,
      undefined,
      { page_size: '1' },
    )
    return data.items?.find((item) => item.block_type === 1)?.block_id ?? documentId
  }

  async appendDocument(input: {
    documentId: string
    markdown: string
    blockId?: string
    idempotencyKey?: string
  }): Promise<{ appended: number; failed: number; documentId: string }> {
    const blocks = markdownToBlocks(input.markdown)
    if (!blocks.length) return { appended: 0, failed: 0, documentId: input.documentId }

    const parent = input.blockId ?? (await this.rootBlockId(input.documentId))
    await this.request(
      'POST',
      `/docx/v1/documents/${encodeURIComponent(input.documentId)}/blocks/${encodeURIComponent(parent)}/children`,
      { children: blocks, index: 0 },
      { document_revision_id: '-1' },
    )
    return { appended: blocks.length, failed: 0, documentId: input.documentId }
  }

  async readSheet(input: {
    spreadsheetToken: string
    range?: string
  }): Promise<FeishuSheetMeta | FeishuRangeValues> {
    if (!input.range) {
      const data = await this.request<{
        sheets?: Array<{ sheet_id?: string; title?: string; grid_properties?: { row_count?: number; column_count?: number } }>
      }>('GET', `/sheets/v3/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/sheets/query`)
      return {
        spreadsheetToken: input.spreadsheetToken,
        sheets: (data.sheets ?? []).map((sheet) => ({
          sheetId: sheet.sheet_id ?? '',
          title: sheet.title ?? '',
          rowCount: sheet.grid_properties?.row_count ?? 0,
          columnCount: sheet.grid_properties?.column_count ?? 0,
        })),
      }
    }

    const data = await this.request<{ valueRange?: { values?: unknown[][] } }>(
      'GET',
      `/sheets/v2/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/values/${encodeURIComponent(input.range)}`,
    )
    return { range: input.range, values: data.valueRange?.values ?? [] }
  }

  async writeSheet(input: {
    spreadsheetToken: string
    range: string
    values: unknown[][]
    idempotencyKey?: string
  }): Promise<{ updatedCells: number }> {
    const data = await this.request<{ updatedCells?: number; updated_cells?: number }>(
      'PUT',
      `/sheets/v2/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/values`,
      { valueRange: { range: input.range, values: input.values } },
    )
    return { updatedCells: data.updatedCells ?? data.updated_cells ?? input.values.flat().length }
  }

  async appendSheet(input: {
    spreadsheetToken: string
    range: string
    values: unknown[][]
    idempotencyKey?: string
  }): Promise<{ updatedCells: number }> {
    const data = await this.request<{ updatedCells?: number; updated_cells?: number }>(
      'POST',
      `/sheets/v2/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/values_append`,
      { valueRange: { range: input.range, values: input.values } },
    )
    return { updatedCells: data.updatedCells ?? data.updated_cells ?? input.values.flat().length }
  }

  async uploadFile(input: {
    filePath: string
    fileName: string
    folderToken?: string
    idempotencyKey?: string
  }): Promise<FeishuUploadResult> {
    const bytes = await readFile(input.filePath)
    const form = new FormData()
    form.append('file_name', input.fileName)
    form.append('parent_type', 'explorer')
    form.append('parent_node', input.folderToken ?? '')
    form.append('size', String(bytes.byteLength))
    form.append('file', new Blob([bytes]), input.fileName)

    const data = await this.request<{ file_token?: string; url?: string }>(
      'POST',
      '/drive/v1/files/upload_all',
      form,
    )
    return {
      fileToken: data.file_token ?? '',
      ...(data.url ? { url: data.url } : {}),
    }
  }

  /**
   * Upload a local Office file and convert it into a native Feishu document.
   * Polls the import ticket until the task reports a result or a failure.
   */
  async importDocument(input: {
    filePath: string
    fileName: string
    fileExtension: 'docx' | 'xlsx' | 'pptx'
    folderToken?: string
    idempotencyKey?: string
  }): Promise<FeishuImportResult> {
    const upload = await this.uploadFile({
      filePath: input.filePath,
      fileName: input.fileName,
      ...(input.folderToken ? { folderToken: input.folderToken } : {}),
    })

    const created = await this.request<{ ticket?: string }>('POST', '/drive/v1/import_tasks', {
      file_extension: input.fileExtension,
      file_token: upload.fileToken,
      type: input.fileExtension,
      file_name: input.fileName,
      ...(input.folderToken ? { folder_token: input.folderToken } : {}),
    })
    const ticket = created.ticket
    if (!ticket) throw new FeishuError('feishu_unknown', 'Feishu returned no import ticket')

    for (let attempt = 0; attempt < 60; attempt += 1) {
      const task = await this.request<{
        result?: { token?: string; url?: string }
        job_status?: number
        job_error_msg?: string
      }>('GET', `/drive/v1/import_tasks/${encodeURIComponent(ticket)}`)

      if (task.job_error_msg) {
        throw new FeishuError('feishu_unknown', `Feishu import failed: ${task.job_error_msg}`)
      }
      if (task.result?.url || task.result?.token) {
        return {
          ticket,
          status: 'done',
          ...(task.result.url ? { url: task.result.url } : {}),
        }
      }
      if (task.job_status === 2) {
        throw new FeishuError('feishu_unknown', 'Feishu import task failed')
      }
      await delay(1000)
    }

    throw new FeishuError('feishu_unavailable', 'Feishu import task timed out')
  }

  async sendMessage(input: {
    receiveId: string
    receiveIdType: 'open_id' | 'chat_id'
    msgType: 'text' | 'interactive'
    content: string
    idempotencyKey?: string
  }): Promise<FeishuMessageResult> {
    const data = await this.request<{ message_id?: string }>(
      'POST',
      '/im/v1/messages',
      {
        receive_id: input.receiveId,
        msg_type: input.msgType,
        content: input.content,
      },
      { receive_id_type: input.receiveIdType },
    )
    return { messageId: data.message_id ?? '' }
  }

  /**
   * Chats the user can see, filtered by name. The screen reader only knows the
   * chat *name*; history needs the chat_id, and this is the endpoint that maps
   * one to the other for a user token.
   */
  async searchChats(input: { query: string; pageSize?: number }): Promise<FeishuChatSummary[]> {
    const data = await this.request<{ items?: Array<Record<string, unknown>> }>(
      'GET',
      '/im/v1/chats/search',
      undefined,
      {
        query: input.query,
        page_size: String(clamp(input.pageSize ?? 20, 1, 100)),
      },
    )
    return (data.items ?? []).map((item) => ({
      chatId: String(item.chat_id ?? ''),
      name: String(item.name ?? ''),
      ...(item.description ? { description: String(item.description) } : {}),
      ...(item.chat_mode ? { chatMode: String(item.chat_mode) } : {}),
    }))
  }

  /**
   * Message history of one chat in the requested order, oldest first for
   * `newest` requests. `maxPages × pageSize` bounds the cost of one call.
   */
  async listChatMessages(input: {
    chatId: string
    pageSize?: number
    maxPages?: number
    /** Milliseconds since epoch; Feishu expects seconds. */
    startTime?: number
    endTime?: number
    /** Walk the window from its newest or oldest end. Default `newest`. */
    order?: 'newest' | 'oldest'
  }): Promise<{ messages: FeishuChatMessage[]; hasMore: boolean }> {
    const pageSize = clamp(input.pageSize ?? 50, 1, 50)
    const maxPages = clamp(input.maxPages ?? 2, 1, 20)
    const collected: FeishuChatMessage[] = []
    let pageToken: string | undefined
    let hasMore = false
    for (let page = 0; page < maxPages; page += 1) {
      const data = await this.request<{
        items?: Array<Record<string, unknown>>
        page_token?: string
        has_more?: boolean
      }>('GET', '/im/v1/messages', undefined, {
        container_id_type: 'chat',
        container_id: input.chatId,
        sort_type: input.order === 'oldest' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc',
        page_size: String(pageSize),
        ...(pageToken ? { page_token: pageToken } : {}),
        ...(input.startTime ? { start_time: String(Math.floor(input.startTime / 1000)) } : {}),
        ...(input.endTime ? { end_time: String(Math.floor(input.endTime / 1000)) } : {}),
      })
      for (const item of data.items ?? []) {
        collected.push(readMessage(item, input.chatId))
      }
      hasMore = data.has_more === true
      pageToken = data.page_token
      if (!hasMore || !pageToken) break
    }
    return { messages: input.order === 'oldest' ? collected : collected.reverse(), hasMore }
  }

  /** One page of the connected user's tasks (`type=my_tasks`). */
  async listTasks(input: {
    completed?: boolean
    pageSize?: number
    pageToken?: string
  }): Promise<{ tasks: FeishuTask[]; hasMore: boolean; pageToken?: string }> {
    const data = await this.request<{
      items?: Array<Record<string, unknown>>
      has_more?: boolean
      page_token?: string
    }>('GET', '/task/v2/tasks', undefined, {
      page_size: String(clamp(input.pageSize ?? 50, 1, 100)),
      type: 'my_tasks',
      user_id_type: 'open_id',
      ...(input.completed === undefined ? {} : { completed: String(input.completed) }),
      ...(input.pageToken ? { page_token: input.pageToken } : {}),
    })
    return {
      tasks: (data.items ?? []).map((item) => readTask(item)),
      hasMore: data.has_more === true,
      ...(data.page_token ? { pageToken: data.page_token } : {}),
    }
  }

  /** Create a task; `dueMs` is milliseconds since epoch. `allDay` marks a date-only due. */
  async createTask(input: {
    summary: string
    description?: string
    dueMs?: number
    allDay?: boolean
    assigneeOpenId?: string
  }): Promise<{ taskGuid: string; summary: string }> {
    const data = await this.request<{ task?: Record<string, unknown> }>(
      'POST',
      '/task/v2/tasks',
      {
        summary: input.summary,
        ...(input.description ? { description: input.description } : {}),
        ...(input.dueMs === undefined
          ? {}
          : {
              due: {
                timestamp: String(input.dueMs),
                ...(input.allDay ? { is_all_day: true } : {}),
              },
            }),
        ...(input.assigneeOpenId
          ? { members: [{ id: input.assigneeOpenId, type: 'user', role: 'assignee' }] }
          : {}),
      },
      { user_id_type: 'open_id' },
    )
    const task = data.task ?? {}
    return { taskGuid: String(task.guid ?? ''), summary: String(task.summary ?? input.summary) }
  }

  /** Mark a task complete; Feishu stores the completion instant, not a flag. */
  async completeTask(input: { taskGuid: string }): Promise<{ taskGuid: string; completedAt: number }> {
    const completedAt = Date.now()
    await this.request(
      'PATCH',
      `/task/v2/tasks/${encodeURIComponent(input.taskGuid)}`,
      { task: { completed_at: String(completedAt) }, update_fields: ['completed_at'] },
      { user_id_type: 'open_id' },
    )
    return { taskGuid: input.taskGuid, completedAt }
  }

  /** Minute (妙记) metadata; transcripts go through the raw `getJson` route. */
  async getMinutes(input: { minuteToken: string }): Promise<FeishuMinutesNote> {
    const data = await this.request<Record<string, unknown>>(
      'GET',
      `/minutes/v1/minutes/${encodeURIComponent(input.minuteToken)}`,
    )
    const record = (data.minute as Record<string, unknown> | undefined) ?? data
    return {
      token: String(record.token ?? input.minuteToken),
      title: String(record.title ?? ''),
      ...(record.owner_id ? { ownerId: String(record.owner_id) } : {}),
      ...(record.url ? { url: String(record.url) } : {}),
      ...(record.duration ? { durationSeconds: Number(record.duration) } : {}),
    }
  }

  /**
   * Calendar events in `instance_view` for one window. Instance view expands
   * recurring events, and Feishu caps the window at 40 days; callers should
   * clamp before asking.
   */
  async calendarAgenda(input: {
    calendarId?: string
    startMs: number
    endMs: number
  }): Promise<{ events: FeishuCalendarEvent[]; hasMore: boolean }> {
    const calendarId = input.calendarId ?? '<primary>'
    const data = await this.request<{ items?: Array<Record<string, unknown>>; has_more?: boolean }>(
      'GET',
      `/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/instance_view`,
      undefined,
      {
        start_time: String(Math.floor(input.startMs / 1000)),
        end_time: String(Math.floor(input.endMs / 1000)),
      },
    )
    return {
      events: (data.items ?? []).map((item) => readEvent(item)),
      hasMore: data.has_more === true,
    }
  }

  /**
   * Raw GET for an endpoint without a typed wrapper (bitable, okr, …). Returns
   * the envelope's `data`; the caller owns the shape.
   */
  async getJson(path: string, query: Record<string, string> = {}): Promise<unknown> {
    return this.request<unknown>('GET', path, undefined, query)
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

export interface FeishuChatSummary {
  chatId: string
  name: string
  description?: string
  chatMode?: string
}

export interface FeishuChatMessage {
  messageId: string
  chatId: string
  chatType?: string
  msgType: string
  /** Milliseconds since epoch, as Feishu reports it. */
  createTime: number
  senderId: string
  senderType?: string
  text: string
}

export interface FeishuTask {
  guid: string
  summary: string
  completed: boolean
  description?: string
  dueMs?: number
}

export interface FeishuCalendarEvent {
  eventId: string
  summary: string
  /** Milliseconds since epoch. */
  startMs: number
  endMs: number
  location?: string
}

export interface FeishuMinutesNote {
  token: string
  title: string
  ownerId?: string
  url?: string
  durationSeconds?: number
}

/** Task v2 fields we surface; `completed_at` is "0" while the task is open. */
function readTask(item: Record<string, unknown>): FeishuTask {
  const due = item.due as { timestamp?: unknown } | undefined
  const dueMs = ms(due?.timestamp)
  return {
    guid: String(item.guid ?? ''),
    summary: String(item.summary ?? ''),
    completed: ms(item.completed_at) !== undefined,
    ...(item.description ? { description: String(item.description) } : {}),
    ...(dueMs === undefined ? {} : { dueMs }),
  }
}

function readEvent(item: Record<string, unknown>): FeishuCalendarEvent {
  const start = item.start_time as { timestamp?: unknown } | undefined
  const end = item.end_time as { timestamp?: unknown } | undefined
  const location = item.location as { name?: unknown } | undefined
  return {
    eventId: String(item.event_id ?? ''),
    summary: String(item.summary ?? ''),
    startMs: ms(start?.timestamp) ?? 0,
    endMs: ms(end?.timestamp) ?? 0,
    ...(location?.name ? { location: String(location.name) } : {}),
  }
}

/** Feishu sends both numbers and numeric strings; "0" means unset. */
function ms(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Flatten Feishu's per-type message body into readable text.
 *
 * The REST API wraps every payload twice: `body` is
 * `{ "content": "<json string>" }`, and that string is the per-type object.
 * Both shapes (wrapped and already-unwrapped) are accepted.
 */
export function messageText(msgType: string, body: unknown): string {
  const payload = unwrapBody(body)
  if (!payload || typeof payload !== 'object') {
    return msgType === 'text' ? '' : `[${msgType}]`
  }
  const record = payload as Record<string, unknown>
  if (msgType === 'text' || record.text !== undefined) {
    const text = String(record.text ?? '').trim()
    if (text) return text
  }
  if (msgType === 'post') {
    // Post content may itself be wrapped as {"zh_cn": {...}} for rich posts.
    const localized = record.zh_cn ?? record.en_us ?? record
    const post = (localized && typeof localized === 'object' ? localized : record) as Record<string, unknown>
    const title = typeof post.title === 'string' ? post.title.trim() : ''
    const lines: string[] = []
    const content = post.content
    if (Array.isArray(content)) {
      for (const paragraph of content) {
        if (!Array.isArray(paragraph)) continue
        const text = paragraph
          .map((node) => (node && typeof node === 'object' ? String((node as Record<string, unknown>).text ?? '') : ''))
          .join('')
          .trim()
        if (text) lines.push(text)
      }
    }
    if (title || lines.length > 0) return [title, ...lines].filter(Boolean).join('\n')
  }
  if (msgType === 'image') return '[图片]'
  if (msgType === 'file') return `[文件] ${String(record.file_name ?? '')}`.trim()
  if (msgType === 'audio') return '[语音]'
  if (msgType === 'media') return '[视频]'
  if (msgType === 'sticker') return '[表情]'
  if (msgType === 'interactive') return '[卡片]'
  const fallback = String(record.text ?? '').trim()
  return fallback || `[${msgType}]`
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * The REST API sends `body: { content: "<json string>" }`; the string holds the
 * per-type object. Flat shapes (already-unwrapped bodies, or `{text}`) pass
 * through unchanged.
 */
function unwrapBody(body: unknown): unknown {
  let value = body
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof value === 'string') {
      value = safeJson(value)
      continue
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>
      const content = record.content
      if (typeof content === 'string') {
        value = safeJson(content)
        continue
      }
      if (content && typeof content === 'object' && !Array.isArray(content)) {
        value = content
        continue
      }
    }
    break
  }
  return value
}

function readMessage(item: Record<string, unknown>, chatId: string): FeishuChatMessage {
  const sender = (item.sender ?? {}) as Record<string, unknown>
  const msgType = String(item.msg_type ?? 'unknown')
  return {
    messageId: String(item.message_id ?? ''),
    chatId: String(item.chat_id ?? chatId),
    ...(item.chat_type ? { chatType: String(item.chat_type) } : {}),
    msgType,
    createTime: Number(item.create_time ?? 0),
    senderId: String(sender.id ?? ''),
    ...(sender.sender_type ? { senderType: String(sender.sender_type) } : {}),
    text: messageText(msgType, item.body),
  }
}

/**
 * Pick the chat the user is looking at from a name search. Exact matches win;
 * otherwise the shortest candidate that starts with the queried name wins, so
 * "示例产品群" does not lose to "示例产品群（旧）" because of list order.
 */
export function resolveChatByName(
  candidates: FeishuChatSummary[],
  name: string,
): FeishuChatSummary | undefined {
  const wanted = name.trim()
  if (!wanted) return undefined
  const exact = candidates.find((candidate) => candidate.name.trim() === wanted)
  if (exact) return exact
  const byLength = (a: FeishuChatSummary, b: FeishuChatSummary) => a.name.length - b.name.length
  // The screen may show a truncated title: the chat whose name starts with what
  // we read is the better guess than a shorter chat that the title extends.
  const extendsName = candidates
    .filter((candidate) => candidate.name.trim().startsWith(wanted))
    .sort(byLength)
  if (extendsName[0]) return extendsName[0]
  const containedInName = candidates
    .filter((candidate) => wanted.startsWith(candidate.name.trim()))
    .sort(byLength)
  return containedInName[0] ?? candidates[0]
}
