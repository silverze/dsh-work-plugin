/**
 * Share a local artifact to Feishu Drive (upload) or as a native Feishu
 * document (import), optionally posting a card to a group.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { FeishuHttpClient } from './feishu-client.js'
import { shareArtifact } from './share-core.js'

function text(value: string): ContentBlock {
  return { type: 'text', text: value }
}

export function registerFeishuShareTool(ctx: Context, client: FeishuHttpClient): void {
  ctx.tools.register(
    defineTool({
      name: 'feishu_share_artifact',
      description:
        'Share a DSH Work artifact to Feishu: upload the original file, or import a docx/xlsx/pptx as a native Feishu document, then optionally send a card to a group. Externally visible: confirm the target and permissions first.',
      parameters: {
        artifactId: { type: 'string', description: 'Artifact id from work_artifact_list.' },
        filePath: { type: 'string', description: 'Absolute local path when no artifact id is given.' },
        fileName: { type: 'string', description: 'Display name in Feishu; defaults to the basename.' },
        mode: {
          type: 'string',
          enum: ['auto', 'upload', 'import'],
          description: 'auto imports docx/xlsx/pptx and uploads everything else.',
        },
        folderToken: { type: 'string', description: 'Target Feishu Drive folder token.' },
        chatId: { type: 'string', description: 'Optional group chat_id to send a card to.' },
        title: { type: 'string', description: 'Card title; defaults to the file name.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mode: { type: 'string' },
            token: { type: 'string' },
            url: { type: 'string' },
            messageId: { type: 'string' },
          },
        },
        render: (_args, value): ContentBlock[] => [
          text(
            `Shared as ${value.mode}: ${value.token}${value.url ? `\n${value.url}` : ''}${value.messageId ? `\nCard ${value.messageId}` : ''}`,
          ),
        ],
      },
      async execute(args) {
        return shareArtifact(ctx, client, args)
      },
    }),
  )
}
