/**
 * Feishu P0 tools: identity, docx read/create/append, sheets read/write/append,
 * drive upload, and IM send. Write tools are externally visible; the deployment
 * policy (W3b) decides whether they require explicit approval.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { FeishuHttpClient } from './feishu-client.js'

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
}
