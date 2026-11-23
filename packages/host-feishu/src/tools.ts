/**
 * Feishu P0 tools: identity, docx read/create/append, sheets read/write/append,
 * drive upload, and IM send. Write tools are externally visible; the deployment
 * policy (W3b) decides whether they require explicit approval.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { FeishuHttpClient } from './feishu-client.js'
import { FeishuError } from './errors.js'
import {
  formatStamp,
  formatTranscript,
  readChatHistory,
  type ChatHistoryResult,
  type ChatHistoryStats,
} from './im-history.js'

/** "6h" | "3d" | "4w" | "6m" → start of the window in milliseconds. */
function parseRecent(value: string | undefined): number | undefined {
  if (!value) return undefined
  const match = /^(\d+)\s*([hdwm])$/i.exec(value.trim())
  if (!match) return undefined
  const amount = Number(match[1])
  const unit = (match[2] ?? 'd').toLowerCase()
  const day = 86_400_000
  const size = unit === 'h' ? 3_600_000 : unit === 'd' ? day : unit === 'w' ? day * 7 : day * 30
  return Date.now() - amount * size
}

function formatRange(history: ChatHistoryResult): string {
  const first = history.messages[0]
  const last = history.messages[history.messages.length - 1]
  if (!first || !last) return ''
  return `${formatStamp(first.createTime)} → ${formatStamp(last.createTime)}`
}

function formatStats(stats: ChatHistoryStats): string {
  const lines = [`Range stats: ${stats.total} message(s)`]
  if (stats.days.length > 0) {
    lines.push('Per day: ' + stats.days.map((day) => `${day.date} ${day.count}`).join(', '))
  }
  if (stats.senders.length > 0) {
    lines.push(
      'Top senders: ' +
        stats.senders
          .slice(0, 8)
          .map((sender) => `${sender.senderId} ${sender.count}`)
          .join(', '),
    )
  }
  return lines.join('\n')
}

/** ISO 8601 or epoch milliseconds → milliseconds; undefined when unparseable. */
function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed)
    return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined
  }
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

const MAX_DOC_CHARS = 100_000
const DEFAULT_DOC_CHARS = 20_000

/** Services `feishu_api` may reach. Everything else has a typed tool. */
const API_SERVICES = new Set([
  'docx',
  'sheets',
  'drive',
  'wiki',
  'bitable',
  'im',
  'contact',
  'task',
  'calendar',
  'minutes',
  'okr',
  'approval',
  'attendance',
])


function text(value: string): ContentBlock {
  return { type: 'text', text: value }
}

/**
 * `dryRun` output for a write tool: the request it would have sent. Rendering
 * the JSON is the whole point — it can be reviewed before anything leaves the
 * machine.
 */
function preview(tool: string, request: Record<string, unknown>): string {
  return `Dry run for ${tool} — nothing was sent:\n${JSON.stringify(request, null, 2)}`
}

export function registerFeishuTools(ctx: Context, client: FeishuHttpClient): void {

  ctx.tools.register(
    defineTool({
      name: 'feishu_wiki_get',
      description: 'Resolve a Feishu wiki node token to its underlying docx/sheet object. Read-only.',
      parameters: {
        nodeToken: { type: 'string', description: 'Wiki node token from a /wiki/<token> link.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            objType: { type: 'string' },
            objToken: { type: 'string' },
          },
        },
        render: (_args, value): ContentBlock[] => [
          text(`Wiki node resolved: ${value.objType} ${value.objToken}`),
        ],
      },
      async execute(args) {
        if (!args.nodeToken) throw new Error('nodeToken is required')
        return client.resolveWikiNode(args.nodeToken)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'feishu_whoami',
      description: 'Return the connected Feishu user and tenant identity. Read-only.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            openId: { type: 'string' },
            unionId: { type: 'string' },
            name: { type: 'string' },
            tenantKey: { type: 'string' },
          },
        },
        render: (_args, value): ContentBlock[] => [
          text(`Feishu user ${value.name} (open_id=${value.openId})`),
        ],
      },
      async execute() {
        const identity = await client.whoami()
        return {
          openId: identity.openId,
          name: identity.name,
          ...(identity.unionId ? { unionId: identity.unionId } : {}),
          ...(identity.tenantKey ? { tenantKey: identity.tenantKey } : {}),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'feishu_doc_read',
      description:
        'Read a Feishu docx document as plain text. Requires the user token and the user\'s own document permission.',
      parameters: {
        documentId: { type: 'string', required: true, description: 'Feishu docx document id.' },
        maxChars: {
          type: 'number',
          description: `Maximum characters to return (default ${DEFAULT_DOC_CHARS}, cap ${MAX_DOC_CHARS}).`,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            documentId: { type: 'string' },
            content: { type: 'string' },
            truncated: { type: 'boolean' },
            url: { type: 'string' },
          },
        },
        render: (_args, value): ContentBlock[] => [
          text(
            `Feishu document ${value.documentId}${value.truncated ? ' (truncated)' : ''}\n\n${value.content}`,
          ),
        ],
      },
      async execute(args) {
        const doc = await client.readDocument({ documentId: args.documentId })
        const limit = Math.max(1, Math.min(args.maxChars ?? DEFAULT_DOC_CHARS, MAX_DOC_CHARS))
        const truncated = doc.content.length > limit
        return {
          documentId: doc.documentId,
          content: truncated ? doc.content.slice(0, limit) : doc.content,
          truncated,
          ...(doc.url ? { url: doc.url } : {}),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'feishu_doc_create',
      description:
        'Create an empty Feishu docx document in a folder (or the user root). Externally visible: confirm with the user first. Pass `dryRun: true` to preview the request without sending it.',
      parameters: {
        title: { type: 'string', required: true, description: 'Document title.' },
        folderToken: { type: 'string', description: 'Target folder token; omit for the user root.' },
        dryRun: {
          type: 'boolean',
          description: 'Describe the request instead of sending it. Nothing is created.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            documentId: { type: 'string' },
            url: { type: 'string' },
            dryRun: { type: 'boolean' },
            preview: { type: 'string' },
          },
        },
        render: (_args, value): ContentBlock[] =>
          value.preview
            ? [text(value.preview)]
            : [text(`Created Feishu document ${value.documentId}\n${value.url}`)],
      },
      async execute(args) {
        if (args.dryRun) {
          return {
            documentId: '',
            url: '',
            dryRun: true,
            preview: preview('feishu_doc_create', {
              title: args.title,
              ...(args.folderToken ? { folderToken: args.folderToken } : {}),
            }),
          }
        }
        const doc = await client.createDocument({
          title: args.title,
          ...(args.folderToken ? { folderToken: args.folderToken } : {}),
        })
        return { documentId: doc.documentId, url: doc.url ?? '' }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'feishu_doc_append',
      description:
        'Append Markdown to a Feishu docx document. Supports headings, paragraphs, bullets, ordered lists, code fences and quotes. Externally visible: confirm with the user first. Pass `dryRun: true` to preview the request without sending it.',
      parameters: {
        documentId: { type: 'string', required: true, description: 'Feishu docx document id.' },
        markdown: { type: 'string', required: true, description: 'Markdown content to append.' },
        blockId: { type: 'string', description: 'Parent block id; defaults to the document root.' },
        dryRun: {
          type: 'boolean',
          description: 'Describe the request instead of sending it. Nothing is appended.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            documentId: { type: 'string' },
            appended: { type: 'number' },
            failed: { type: 'number' },
            dryRun: { type: 'boolean' },
            preview: { type: 'string' },
          },
        },
        render: (_args, value): ContentBlock[] =>
          value.preview
            ? [text(value.preview)]
            : [text(`Appended ${value.appended} block(s) to ${value.documentId}`)],
      },
      async execute(args) {
        if (args.dryRun) {
          return {
            documentId: args.documentId,
            appended: 0,
            failed: 0,
            dryRun: true,
            preview: preview('feishu_doc_append', {
              documentId: args.documentId,
              ...(args.blockId ? { blockId: args.blockId } : {}),
              lines: args.markdown.split('\n').length,
              markdown: args.markdown,
            }),
          }
        }
        return client.appendDocument({
          documentId: args.documentId,
          markdown: args.markdown,
          ...(args.blockId ? { blockId: args.blockId } : {}),
        })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'feishu_sheet_read',
      description:
        'Read a Feishu spreadsheet range (for example `Sheet1!A1:D20`) or list its sheets. Read-only.',
      parameters: {
        spreadsheetToken: { type: 'string', required: true, description: 'Spreadsheet token.' },
        range: { type: 'string', description: 'A1 range; omit to list sheet metadata.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            spreadsheetToken: { type: 'string' },
            range: { type: 'string' },
            values: { type: 'array', items: { type: 'array', items: { type: 'json' } } },
            sheets: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  sheetId: { type: 'string' },
                  title: { type: 'string' },
                  rowCount: { type: 'number' },
                  columnCount: { type: 'number' },
                },
              },
            },
          },
        },
        render: (_args, value): ContentBlock[] => [
          text(
            value.sheets
              ? `Sheets: ${value.sheets.map((sheet) => `${sheet.title}(${sheet.sheetId})`).join(', ')}`
              : `Range ${value.range}: ${value.values?.length ?? 0} row(s)`,
          ),
        ],
      },
      async execute(args) {
        const result = await client.readSheet({
          spreadsheetToken: args.spreadsheetToken,
          ...(args.range ? { range: args.range } : {}),
        })
        if ('sheets' in result) {
          return { spreadsheetToken: result.spreadsheetToken, sheets: result.sheets }
        }
        return {
          spreadsheetToken: args.spreadsheetToken,
          range: result.range,
          values: result.values as never,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'feishu_sheet_write',
      description:
        'Overwrite a Feishu spreadsheet range. Externally visible: confirm the range and values first. Pass `dryRun: true` to preview the request without sending it.',
      parameters: {
        spreadsheetToken: { type: 'string', required: true, description: 'Spreadsheet token.' },
        range: { type: 'string', required: true, description: 'A1 range to overwrite.' },
        values: {
          type: 'array',
          required: true,
          items: { type: 'array', items: { type: 'json' } },
          description: 'Rows of cell values.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Describe the request instead of sending it. Nothing is written.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            updatedCells: { type: 'number' },
            dryRun: { type: 'boolean' },
            preview: { type: 'string' },
          },
        },
        render: (_args, value): ContentBlock[] =>
          value.preview
            ? [text(value.preview)]
            : [text(`Updated ${value.updatedCells} cell(s).`)],
      },
      async execute(args) {
        if (args.dryRun) {
          return {
            updatedCells: 0,
            dryRun: true,
            preview: preview('feishu_sheet_write', {
              spreadsheetToken: args.spreadsheetToken,
              range: args.range,
              values: args.values,
            }),
          }
        }
        return client.writeSheet({
          spreadsheetToken: args.spreadsheetToken,
          range: args.range,
          values: args.values,
        })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'feishu_sheet_append',
      description:
        'Append rows to a Feishu spreadsheet range. Externally visible: confirm the range and values first. Pass `dryRun: true` to preview the request without sending it.',
      parameters: {
        spreadsheetToken: { type: 'string', required: true, description: 'Spreadsheet token.' },
        range: { type: 'string', required: true, description: 'A1 range used for the append operation.' },
        values: {
          type: 'array',
          required: true,
          items: { type: 'array', items: { type: 'json' } },
          description: 'Rows to append.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Describe the request instead of sending it. Nothing is appended.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            updatedCells: { type: 'number' },
            dryRun: { type: 'boolean' },
            preview: { type: 'string' },
          },
        },
        render: (_args, value): ContentBlock[] =>
          value.preview
            ? [text(value.preview)]
            : [text(`Appended ${value.updatedCells} cell(s).`)],
      },
      async execute(args) {
        if (args.dryRun) {
          return {
            updatedCells: 0,
            dryRun: true,
            preview: preview('feishu_sheet_append', {
              spreadsheetToken: args.spreadsheetToken,
              range: args.range,
              values: args.values,
            }),
          }
        }
        return client.appendSheet({
          spreadsheetToken: args.spreadsheetToken,
          range: args.range,
          values: args.values,
        })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'feishu_drive_upload',
      description:
        'Upload a local file to Feishu Drive. Externally visible: confirm the file and folder first. Pass `dryRun: true` to preview the request without sending it.',
      parameters: {
        filePath: { type: 'string', required: true, description: 'Absolute local file path.' },
        fileName: { type: 'string', required: true, description: 'Name shown in Feishu Drive.' },
        folderToken: { type: 'string', description: 'Target folder token; omit for the user root.' },
        dryRun: {
          type: 'boolean',
          description: 'Describe the request instead of sending it. Nothing is uploaded.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            fileToken: { type: 'string' },
            url: { type: 'string' },
            dryRun: { type: 'boolean' },
            preview: { type: 'string' },
          },
        },
        render: (_args, value): ContentBlock[] =>
          value.preview
            ? [text(value.preview)]
            : [text(`Uploaded file ${value.fileToken}${value.url ? `\n${value.url}` : ''}`)],
      },
      async execute(args) {
        if (args.dryRun) {
          return {
            fileToken: '',
            url: '',
            dryRun: true,
            preview: preview('feishu_drive_upload', {
              filePath: args.filePath,
              fileName: args.fileName,
              ...(args.folderToken ? { folderToken: args.folderToken } : {}),
            }),
          }
        }
        return client.uploadFile({
          filePath: args.filePath,
          fileName: args.fileName,
          ...(args.folderToken ? { folderToken: args.folderToken } : {}),
        })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'feishu_im_send',
      description:
        'Send a Feishu text or interactive card message to a user or group. Externally visible: confirm the recipient and content first. Pass `dryRun: true` to preview the message without sending it.',
      parameters: {
        receiveId: { type: 'string', required: true, description: 'open_id or chat_id.' },
        receiveIdType: {
          type: 'string',
          required: true,
          enum: ['open_id', 'chat_id'],
          description: 'Recipient id type.',
        },
        msgType: {
          type: 'string',
          required: true,
          enum: ['text', 'interactive'],
          description: 'Message type.',
        },
        content: {
          type: 'string',
          required: true,
          description: 'Text for `text`, or a JSON card string for `interactive`.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Describe the message instead of sending it. Nothing is delivered.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            messageId: { type: 'string' },
            dryRun: { type: 'boolean' },
            preview: { type: 'string' },
          },
        },
        render: (_args, value): ContentBlock[] =>
          value.preview
            ? [text(value.preview)]
            : [text(`Sent message ${value.messageId}`)],
      },
      async execute(args) {
        const payload =
          args.msgType === 'text' && !args.content.trim().startsWith('{')
            ? JSON.stringify({ text: args.content })
            : args.content
        if (args.dryRun) {
          return {
            messageId: '',
            dryRun: true,
            preview: preview('feishu_im_send', {
              receiveId: args.receiveId,
              receiveIdType: args.receiveIdType,
              msgType: args.msgType,
              content: payload,
            }),
          }
        }
        return client.sendMessage({
          receiveId: args.receiveId,
          receiveIdType: args.receiveIdType,
          msgType: args.msgType,
          content: payload,
        })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'feishu_im_history',
      description:
        'Read the message history of a Feishu chat (group or direct) as a user. Pick a time window (or `recent: "7d"`) and the tool pages through it: one chunk per call, up to 1000 messages, plus per-day/per-sender stats. When `nextEndTime` is returned, pass it back as `endTime` to continue with older messages. Read-only; senders are open_ids.',
      parameters: {
        chatName: {
          type: 'string',
          description: 'Chat name as shown in Feishu, e.g. the group title read from the screen.',
        },
        chatId: { type: 'string', description: 'Exact chat_id; skips the name search.' },
        recent: {
          type: 'string',
          description: 'Shorthand for the start of the window: "6h", "3d", "7d", "4w", "6m". Ignored when startTime is given.',
        },
        startTime: {
          type: 'string',
          description:
            'Only messages at or after this time: ISO 8601 (2026-11-19T16:22:00+08:00) or epoch milliseconds.',
        },
        endTime: {
          type: 'string',
          description: 'Only messages at or before this time: ISO 8601 or epoch milliseconds.',
        },
        limit: {
          type: 'number',
          description: 'Messages in this chunk (default 100, cap 1000). Use order + nextEndTime to walk further.',
        },
        order: {
          type: 'string',
          enum: ['newest', 'oldest'],
          description: 'Which end of the window to start from. Default newest.',
        },
        stats: {
          type: 'boolean',
          description:
            'Also return per-day counts and a sender histogram for the chunk — cheap way to size a month before reading it.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            chatId: { type: 'string' },
            chatName: { type: 'string' },
            truncated: { type: 'boolean' },
            count: { type: 'number' },
            range: { type: 'string' },
            stats: { type: 'string' },
            nextEndTime: { type: 'string' },
            nextStartTime: { type: 'string' },
            transcript: { type: 'string' },
          },
        },
        render: (_args, value): ContentBlock[] => {
          const parts = [`Feishu chat ${value.chatName || value.chatId} — ${value.count} message(s)${value.range ? ` (${value.range})` : ''}`]
          if (value.truncated) {
            parts.push(
              value.nextEndTime
                ? `More messages in this window: call again with endTime=${value.nextEndTime} to continue older.`
                : `More messages in this window: call again with startTime=${value.nextStartTime} to continue newer.`,
            )
          }
          if (value.stats) parts.push(value.stats)
          parts.push(value.transcript ?? '')
          return [text(parts.filter(Boolean).join('\n\n'))]
        },
      },
      async execute(args) {
        const startTime = parseTime(args.startTime) ?? parseRecent(args.recent)
        const history = await readChatHistory(client, {
          ...(args.chatName ? { chatName: args.chatName } : {}),
          ...(args.chatId ? { chatId: args.chatId } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
          ...(args.order ? { order: args.order } : {}),
          ...(args.stats ? { stats: true } : {}),
          ...(startTime ? { startTime } : {}),
          ...(parseTime(args.endTime) ? { endTime: parseTime(args.endTime) } : {}),
        })
        return {
          chatId: history.chatId,
          chatName: history.chatName,
          truncated: history.truncated,
          count: history.messages.length,
          range: formatRange(history),
          stats: history.stats ? formatStats(history.stats) : '',
          nextEndTime: history.nextEndTime ? String(history.nextEndTime) : '',
          nextStartTime: history.nextStartTime ? String(history.nextStartTime) : '',
          transcript: formatTranscript(history.messages),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'feishu_api',
      description:
        'GET one read-only Feishu OpenAPI path as the connected user, for endpoints without a dedicated tool (bitable, okr, attendance, …). Only GET under /open-apis/ and a fixed service allowlist — writes must use a dedicated tool. Prefer a typed tool when one exists.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Path including the version, e.g. `/open-apis/bitable/v1/apps/<app_token>/tables`.',
        },
        query: {
          type: 'string',
          description: 'URL query string without `?`, e.g. `page_size=20&filter=…`.',
        },
        maxChars: {
          type: 'number',
          description: 'Truncate the JSON response (default 20000, cap 100000).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string' },
            json: { type: 'string' },
            truncated: { type: 'boolean' },
          },
        },
        render: (_args, value): ContentBlock[] => [
          text(
            `${value.path}${value.truncated ? ' (truncated)' : ''}\n\n${value.json}`,
          ),
        ],
      },
      async execute(args) {
        const path = args.path.trim()
        if (!path.startsWith('/open-apis/')) {
          throw new FeishuError(
            'feishu_invalid_argument',
            'path must start with /open-apis/ and name a versioned resource.',
          )
        }
        const service = path.slice('/open-apis/'.length).split('/')[0] ?? ''
        if (!API_SERVICES.has(service)) {
          throw new FeishuError(
            'feishu_invalid_argument',
            `service "${service}" is not on the read-only list (${[...API_SERVICES].join(', ')}).`,
          )
        }
        const query: Record<string, string> = {}
        for (const [key, value] of new URLSearchParams((args.query ?? '').replace(/^\?/, ''))) {
          query[key] = value
        }
        const data = await client.getJson(path.slice('/open-apis'.length), query)
        const json = JSON.stringify(data, null, 2) ?? ''
        const limit = Math.min(args.maxChars ?? DEFAULT_DOC_CHARS, MAX_DOC_CHARS)
        return {
          path,
          json: json.length > limit ? json.slice(0, limit) : json,
          truncated: json.length > limit,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'feishu_task_create',
      description:
        "Create a Feishu task (待办) for the connected user, or for assigneeOpenId when given. Externally visible: confirm the title and assignee first.",
      parameters: {
        summary: { type: 'string', required: true, description: 'Task title.' },
        description: { type: 'string', description: 'Longer description, plain text.' },
        due: {
          type: 'string',
          description:
            'Due date: ISO 8601, YYYY-MM-DD (an all-day due), or epoch milliseconds.',
        },
        assigneeOpenId: {
          type: 'string',
          description: 'Assign to this open_id instead of the connected user.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            taskGuid: { type: 'string' },
            summary: { type: 'string' },
          },
        },
        render: (_args, value): ContentBlock[] => [
          text(`Created Feishu task "${value.summary}" (${value.taskGuid})`),
        ],
      },
      async execute(args) {
        const dueMs = parseTime(args.due)
        if (args.due && dueMs === undefined) {
          throw new FeishuError(
            'feishu_invalid_argument',
            `could not read due "${args.due}" as ISO 8601 or epoch milliseconds.`,
          )
        }
        // A date-only due makes the task due that whole day, not at 00:00 UTC.
        const allDay = args.due !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(args.due.trim())
        return client.createTask({
          summary: args.summary,
          ...(args.description ? { description: args.description } : {}),
          ...(dueMs === undefined ? {} : { dueMs }),
          ...(allDay ? { allDay: true } : {}),
          ...(args.assigneeOpenId ? { assigneeOpenId: args.assigneeOpenId } : {}),
        })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'feishu_task_complete',
      description:
        'Mark one Feishu task complete. Externally visible: confirm the task first.',
      parameters: {
        taskGuid: { type: 'string', required: true, description: 'Task guid.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            taskGuid: { type: 'string' },
            completedAt: { type: 'number' },
          },
        },
        render: (_args, value): ContentBlock[] => [
          text(`Completed Feishu task ${value.taskGuid}`),
        ],
      },
      async execute(args) {
        return client.completeTask({ taskGuid: args.taskGuid })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'feishu_task_list_mine',
      description:
        'List tasks assigned to the connected user, one page per call. Read-only.',
      parameters: {
        completed: {
          type: 'boolean',
          description: 'true for completed tasks, false for open ones; omit for both.',
        },
        pageSize: { type: 'number', description: 'Tasks per page (default 50, cap 100).' },
        pageToken: { type: 'string', description: 'Continue from a previous page.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  guid: { type: 'string' },
                  summary: { type: 'string' },
                  completed: { type: 'boolean' },
                  due: { type: 'string' },
                },
              },
            },
            hasMore: { type: 'boolean' },
            pageToken: { type: 'string' },
          },
        },
        render: (_args, value): ContentBlock[] => {
          const tasks = value.tasks ?? []
          if (tasks.length === 0) return [text('No tasks match.')]
          const lines = tasks.map(
            (task) =>
              `- ${task.completed ? '[x]' : '[ ]'} ${task.summary}${task.due ? ` (due ${task.due})` : ''} — ${task.guid}`,
          )
          if (value.hasMore && value.pageToken) {
            lines.push(`More: pass pageToken=${value.pageToken}.`)
          }
          return [text(lines.join('\n'))]
        },
      },
      async execute(args) {
        const page = await client.listTasks({
          ...(args.completed === undefined ? {} : { completed: args.completed }),
          ...(args.pageSize ? { pageSize: args.pageSize } : {}),
          ...(args.pageToken ? { pageToken: args.pageToken } : {}),
        })
        return {
          tasks: page.tasks.map((task) => ({
            guid: task.guid,
            summary: task.summary,
            completed: task.completed,
            ...(task.dueMs === undefined ? {} : { due: new Date(task.dueMs).toISOString() }),
          })),
          hasMore: page.hasMore,
          pageToken: page.pageToken ?? '',
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'feishu_minutes_get',
      description:
        'Read one Feishu 妙记 (minutes) metadata: title, owner, duration, link. Transcripts and summaries are not exposed here; use feishu_api for those paths. Read-only.',
      parameters: {
        minuteToken: { type: 'string', required: true, description: 'Minute token from a 妙记 link.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            token: { type: 'string' },
            title: { type: 'string' },
            ownerId: { type: 'string' },
            url: { type: 'string' },
            durationSeconds: { type: 'number' },
          },
        },
        render: (_args, value): ContentBlock[] => [
          text(
            [
              `Minutes: ${value.title || value.token}`,
              value.durationSeconds === undefined ? '' : `Duration: ${Math.round(value.durationSeconds / 60)} min`,
              value.url ? `Link: ${value.url}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        ],
      },
      async execute(args) {
        return client.getMinutes({ minuteToken: args.minuteToken })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'feishu_calendar_agenda',
      description:
        "Read the connected user's calendar events in a window (default: now to seven days out), expanded from recurring series. Read-only; the window must be at most 40 days because that is Feishu's cap.",
      parameters: {
        startTime: { type: 'string', description: 'Window start: ISO 8601 or epoch milliseconds. Default now.' },
        endTime: { type: 'string', description: 'Window end: ISO 8601 or epoch milliseconds. Default start + 7 days.' },
        calendarId: { type: 'string', description: "Calendar id; omit for the user's primary calendar." },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            start: { type: 'string' },
            end: { type: 'string' },
            events: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  eventId: { type: 'string' },
                  summary: { type: 'string' },
                  start: { type: 'string' },
                  end: { type: 'string' },
                  location: { type: 'string' },
                },
              },
            },
            hasMore: { type: 'boolean' },
          },
        },
        render: (_args, value): ContentBlock[] => {
          const events = value.events ?? []
          if (events.length === 0) return [text(`No events between ${value.start} and ${value.end}.`)]
          const lines = events.map(
            (event) =>
              `- ${event.start} → ${event.end}  ${event.summary}${event.location ? ` @ ${event.location}` : ''}`,
          )
          return [text(lines.join('\n'))]
        },
      },
      async execute(args) {
        const startMs = parseTime(args.startTime) ?? Date.now()
        const endMs = parseTime(args.endTime) ?? startMs + 7 * 86_400_000
        if (endMs <= startMs) {
          throw new FeishuError('feishu_invalid_argument', 'endTime must be after startTime.')
        }
        if (endMs - startMs > 40 * 86_400_000) {
          throw new FeishuError('feishu_invalid_argument', 'the window must be at most 40 days.')
        }
        const agenda = await client.calendarAgenda({
          ...(args.calendarId ? { calendarId: args.calendarId } : {}),
          startMs,
          endMs,
        })
        return {
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString(),
          events: agenda.events.map((event) => ({
            eventId: event.eventId,
            summary: event.summary,
            start: new Date(event.startMs).toISOString(),
            end: new Date(event.endMs).toISOString(),
            ...(event.location ? { location: event.location } : {}),
          })),
          hasMore: agenda.hasMore,
        }
      },
    }),
  )
}
