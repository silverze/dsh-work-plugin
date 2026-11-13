/**
 * Shared artifact→Feishu share implementation used by the model tool and the
 * client Remote method. Both paths perform the same upload/import/card flow.
 */

import { basename, extname } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import type { FeishuHttpClient } from './feishu-client.js'

export interface WorkArtifactLike {
  id: string
  path: string
  kind: string
}

interface ArtifactLookup {
  get(id: string): Promise<WorkArtifactLike | undefined>
}

const IMPORTABLE = new Set(['.docx', '.xlsx', '.pptx'])

export interface ShareArtifactInput {
  artifactId?: string
  filePath?: string
  fileName?: string
  mode?: 'auto' | 'upload' | 'import'
  folderToken?: string
  chatId?: string
  title?: string
}

export interface ShareArtifactResult {
  mode: 'upload' | 'import'
  token: string
  url: string
  messageId?: string
}

export async function shareArtifact(
  ctx: Context,
  client: FeishuHttpClient,
  args: ShareArtifactInput,
): Promise<ShareArtifactResult> {
  let artifact: WorkArtifactLike | undefined
  if (args.artifactId) {
    const library = ctx.get('workArtifacts') as ArtifactLookup | undefined
    if (!library) throw new Error('workArtifacts service is not available')
    artifact = await library.get(args.artifactId)
    if (!artifact) throw new Error(`artifact not found: ${args.artifactId}`)
  }

  const filePath = args.filePath ?? artifact?.path
  if (!filePath) throw new Error('feishu_share_artifact requires artifactId or filePath')
  const fileName = args.fileName ?? (artifact ? basename(artifact.path) : basename(filePath))
  const extension = extname(fileName).toLowerCase()

  const requested = args.mode ?? 'auto'
  const mode = requested === 'auto' ? (IMPORTABLE.has(extension) ? 'import' : 'upload') : requested

  let token = ''
  let url = ''
  if (mode === 'import') {
    if (!IMPORTABLE.has(extension)) {
      throw new Error(`feishu_share_artifact: cannot import ${extension}; use upload`)
    }
    const result = await client.importDocument({
      filePath,
      fileName,
      fileExtension: extension.slice(1) as 'docx' | 'xlsx' | 'pptx',
      ...(args.folderToken ? { folderToken: args.folderToken } : {}),
    })
    token = result.ticket
    url = result.url ?? ''
  } else {
    const result = await client.uploadFile({
      filePath,
      fileName,
      ...(args.folderToken ? { folderToken: args.folderToken } : {}),
    })
    token = result.fileToken
    url = result.url ?? ''
  }

  let messageId: string | undefined
  if (args.chatId) {
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: args.title ?? fileName } },
      elements: [
        { tag: 'markdown', content: `DSH Work 交付：**${fileName}**` },
        ...(url
          ? [
              {
                tag: 'action',
                actions: [
                  {
                    tag: 'button',
                    text: { tag: 'plain_text', content: '打开' },
                    type: 'primary',
                    url,
                  },
                ],
              },
            ]
          : []),
      ],
    }
    const sent = await client.sendMessage({
      receiveId: args.chatId,
      receiveIdType: 'chat_id',
      msgType: 'interactive',
      content: JSON.stringify(card),
    })
    messageId = sent.messageId
  }

  return {
    mode,
    token,
    url,
    ...(messageId ? { messageId } : {}),
  }
}
