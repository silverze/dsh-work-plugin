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
        dryRun: {
          type: 'boolean',
          description: 'Describe the share instead of doing it. Nothing is uploaded, imported or sent.',
        },
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
            dryRun: { type: 'boolean' },
            preview: { type: 'string' },
          },
        },
        render: (_args, value): ContentBlock[] =>
          value.preview
            ? [text(value.preview)]
            : [
                text(
                  `Shared as ${value.mode}: ${value.token}${value.url ? `\n${value.url}` : ''}${value.messageId ? `\nCard ${value.messageId}` : ''}`,
                ),
              ],
      },
      async execute(args) {
        if (args.dryRun) {
          const request = {
            artifactId: args.artifactId ?? '',
            filePath: args.filePath ?? '',
            fileName: args.fileName ?? '',
            mode: args.mode ?? 'auto',
            folderToken: args.folderToken ?? '',
            chatId: args.chatId ?? '',
            title: args.title ?? '',
          }
          return {
            mode: request.mode,
            token: '',
            url: '',
            messageId: '',
            dryRun: true,
            preview: `Dry run for feishu_share_artifact — nothing was sent:\n${JSON.stringify(request, null, 2)}`,
          }
        }
        return shareArtifact(ctx, client, args)
      },
    }),
  )
}
