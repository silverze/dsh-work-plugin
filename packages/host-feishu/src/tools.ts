/**
 * Feishu P0 tools: identity, docx read/create/append, sheets read/write/append,
 * drive upload, and IM send. Write tools are externally visible; the deployment
 * policy (W3b) decides whether they require explicit approval.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { FeishuHttpClient } from './feishu-client.js'
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


function text(value: string): ContentBlock {
  return { type: 'text', text: value }
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
        'Create an empty Feishu docx document in a folder (or the user root). Externally visible: confirm with the user first.',
      parameters: {
        title: { type: 'string', required: true, description: 'Document title.' },
        folderToken: { type: 'string', description: 'Target folder token; omit for the user root.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            documentId: { type: 'string' },
            url: { type: 'string' },
          },
        },
        render: (_args, value): ContentBlock[] => [
          text(`Created Feishu document ${value.documentId}\n${value.url}`),
        ],
      },
      async execute(args) {
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
        'Append Markdown to a Feishu docx document. Supports headings, paragraphs, bullets, ordered lists, code fences and quotes. Externally visible: confirm with the user first.',
      parameters: {
        documentId: { type: 'string', required: true, description: 'Feishu docx document id.' },
        markdown: { type: 'string', required: true, description: 'Markdown content to append.' },
        blockId: { type: 'string', description: 'Parent block id; defaults to the document root.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            documentId: { type: 'string' },
            appended: { type: 'number' },
            failed: { type: 'number' },
          },
        },
        render: (_args, value): ContentBlock[] => [
          text(`Appended ${value.appended} block(s) to ${value.documentId}`),
        ],
      },
      async execute(args) {
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
        'Overwrite a Feishu spreadsheet range. Externally visible: confirm the range and values first.',
      parameters: {
        spreadsheetToken: { type: 'string', required: true, description: 'Spreadsheet token.' },
        range: { type: 'string', required: true, description: 'A1 range to overwrite.' },
        values: {
          type: 'array',
          required: true,
          items: { type: 'array', items: { type: 'json' } },
          description: 'Rows of cell values.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { updatedCells: { type: 'number' } },
        },
        render: (_args, value): ContentBlock[] => [text(`Updated ${value.updatedCells} cell(s).`)],
      },
      async execute(args) {
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
        'Append rows to a Feishu spreadsheet range. Externally visible: confirm the range and values first.',
      parameters: {
        spreadsheetToken: { type: 'string', required: true, description: 'Spreadsheet token.' },
        range: { type: 'string', required: true, description: 'A1 range used for the append operation.' },
        values: {
          type: 'array',
          required: true,
          items: { type: 'array', items: { type: 'json' } },
          description: 'Rows to append.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { updatedCells: { type: 'number' } },
        },
        render: (_args, value): ContentBlock[] => [text(`Appended ${value.updatedCells} cell(s).`)],
      },
      async execute(args) {
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
        'Upload a local file to Feishu Drive. Externally visible: confirm the file and folder first.',
      parameters: {
        filePath: { type: 'string', required: true, description: 'Absolute local file path.' },
        fileName: { type: 'string', required: true, description: 'Name shown in Feishu Drive.' },
        folderToken: { type: 'string', description: 'Target folder token; omit for the user root.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            fileToken: { type: 'string' },
            url: { type: 'string' },
          },
        },
        render: (_args, value): ContentBlock[] => [
          text(`Uploaded file ${value.fileToken}${value.url ? `\n${value.url}` : ''}`),
        ],
      },
      async execute(args) {
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
        'Send a Feishu text or interactive card message to a user or group. Externally visible: confirm the recipient and content first.',
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
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { messageId: { type: 'string' } },
        },
        render: (_args, value): ContentBlock[] => [text(`Sent message ${value.messageId}`)],
      },
      async execute(args) {
        const payload =
          args.msgType === 'text' && !args.content.trim().startsWith('{')
            ? JSON.stringify({ text: args.content })
            : args.content
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
}
