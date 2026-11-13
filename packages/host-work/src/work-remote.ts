/**
 * `work/*` Remote namespace for the client workbench.
 *
 * Source-mode Typert descriptors are derived from the decorated methods; the
 * client calls them through the authenticated Connection RPC channel. This
 * keeps the Host service as the single source of task/artifact truth.
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import type { FeishuPresenceService } from './feishu-presence.js'
import type { WorkTaskService } from './work-task-service.js'

export class WorkRemoteService extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly service: WorkTaskService,
    private readonly presence?: FeishuPresenceService,
  ) {
    super(ctx, 'workRemote', { namespace: 'work' })
  }

  async presenceCapture(request: { force?: boolean }) {
    if (!this.presence) throw new Error('Feishu presence is disabled in this profile')
    return this.presence.capture({ force: request.force === true })
  }

  async exportData() {
    return this.service.exportData()
  }

  async clearData(request: { confirm: string }) {
    if (request.confirm !== 'DELETE') throw new Error('clearData requires confirm=DELETE')
    return this.service.clearData()
  }

  async scheduleRun(request: { scheduleId: string }) {
    return this.ctx.schedule.run({ id: request.scheduleId as never })
  }

  async settingsGet(request: Record<string, never>) {
    void request
    return this.service.settings()
  }

  async settingsSet(request: {
    defaultModel?: string
    notifyChatId?: string
    presenceStyle?: 'dsh' | 'codex' | 'claude'
  }) {
    return this.service.updateSettings(request)
  }

  async attachSession(request: { sessionId: string }) {
    return this.service.attachSession(request.sessionId)
  }

  async detachSession(request: { sessionId: string; confirm: string }) {
    if (request.confirm !== 'DETACH') throw new Error('detachSession requires confirm=DETACH')
    await this.service.detachSession(request.sessionId)
    return { detached: true }
  }

  async exportTask(request: { taskId: string }) {
    return this.service.exportTask(request.taskId)
  }

  async removeTask(request: { taskId: string; confirm: string }) {
    if (request.confirm !== 'DELETE') throw new Error('removeTask requires confirm=DELETE')
    return this.service.removeTask(request.taskId)
  }

  async schedulePause(request: { scheduleId: string; active: boolean }) {
    await this.service.schedulePause(request.scheduleId, request.active)
    return { active: request.active }
  }

  async taskCreate(request: {
    title: string
    goal: string
    workspaceId?: string
    cwd?: string
    model?: string
  }) {
    return this.service.create(request)
  }
  async taskList(request: {
    query?: string
    status?: string[]
    limit?: number
    offset?: number
  }) {
    return this.service.list(request as never)
  }
  async taskGet(request: { taskId: string }) {
    return this.service.get(request.taskId)
  }

  async taskPrompt(request: { taskId: string; text: string }) {
    await this.service.prompt(request.taskId, request.text)
    return { accepted: true }
  }

  async taskSchedule(request: {
    taskId: string
    rrule: string
    target?: 'session' | 'new_once' | 'new'
    chatId?: string
  }) {
    const scheduleId = await this.service.schedule(
      request.taskId,
      request.rrule,
      request.target ?? 'session',
      request.chatId,
    )
    return { scheduleId }
  }

  async taskCancel(request: { taskId: string }) {
    await this.service.cancel(request.taskId)
    return { cancelled: true }
  }
  async artifactList(request: { taskId?: string; kind?: string; limit?: number }) {
    return this.service.artifacts.list(request as never)
  }
  async artifactScan(request: { taskId: string }) {
    const artifacts = await this.service.scanArtifacts(request.taskId)
    return { count: artifacts.length, artifacts }
  }
  async schedule(request: {
    taskId: string
    rrule: string
    target?: 'session' | 'new_once' | 'new'
    chatId?: string
  }) {
    const scheduleId = await this.service.schedule(
      request.taskId,
      request.rrule,
      request.target ?? 'session',
      request.chatId,
    )
    return { scheduleId }
  }
}

// Typert stores method markers under this string key on the prototype. The
// decorator form is equivalent; writing the descriptor avoids needing the
// build pipeline to transform standard decorators.
Object.defineProperty(WorkRemoteService.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods', {
  configurable: true,
  value: {
    version: 1,
    methods: [
      'attachSession',
      'detachSession',
      'exportTask',
      'removeTask',
      'schedulePause',
      'taskCreate',
      'taskList',
      'taskGet',
      'taskPrompt',
      'taskCancel',
      'taskSchedule',
      'artifactList',
      'artifactScan',
      'exportData',
      'clearData',
      'scheduleRun',
      'settingsGet',
      'settingsSet',
      'schedule',
      'presenceCapture',
    ].map(
      (method) => ({ method, invocation: { kind: 'direct' as const } }),
    ),
  },
})
