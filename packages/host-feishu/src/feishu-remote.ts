/** `feishu/*` Remote namespace for the workbench/connection card. */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import type { FeishuAuthService } from './auth.js'
import type { FeishuHttpClient } from './feishu-client.js'
import { shareArtifact } from './share-core.js'

export class FeishuRemoteService extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly auth: FeishuAuthService,
    private readonly client: FeishuHttpClient,
  ) {
    super(ctx, 'feishuRemote', { namespace: 'feishu' })
  }
  async status() {
    return this.auth.status()
  }
  async appInfo() {
    return this.auth.appInfo()
  }

  async configureApp(request: { appId: string; appSecret: string }) {
    return this.auth.configureApp(request.appId, request.appSecret)
  }

  async wikiResolve(request: { nodeToken: string }) {
    return this.client.resolveWikiNode(request.nodeToken)
  }

  async docRead(request: { documentId: string }) {
    return this.client.readDocument(request)
  }

  async sheetRead(request: { spreadsheetToken: string; range?: string }) {
    return this.client.readSheet(request)
  }

  async startAuth() {
    return this.auth.startAuth()
  }
  async disconnect() {
    await this.auth.clear()
    return { disconnected: true }
  }

  async shareArtifact(request: {
    artifactId?: string
    filePath?: string
    fileName?: string
    mode?: 'auto' | 'upload' | 'import'
    folderToken?: string
    chatId?: string
    title?: string
  }) {
    return shareArtifact(this.ctx, this.client, request)
  }
}

Object.defineProperty(FeishuRemoteService.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods', {
  configurable: true,
  value: {
    version: 1,
    methods: ['status', 'appInfo', 'configureApp', 'wikiResolve', 'docRead', 'sheetRead', 'startAuth', 'disconnect', 'shareArtifact'].map((method) => ({
      method,
      invocation: { kind: 'direct' as const },
    })),
  },
})
