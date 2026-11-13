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
}
