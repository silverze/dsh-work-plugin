/**
 * @dsh-work-plug/host — work task host plugin.
 *
 * Opens the `work` storage domain, provides `ctx.workTasks`, and registers the
 * model-facing Work tools. The client Remote namespace arrives in W1.5; for
 * now the workbench can call the same service in-process.
 */

import { writeFileSync } from 'node:fs'

import type { Context } from '@deepseek-ai/cordis'

import type { ArtifactLibrary } from './artifact-library.js'
import type { Config } from './config.js'
import { workDomain } from './domain.js'
import { isFeishuForeground } from './feishu-capture.js'
import { FeishuPresenceService } from './feishu-presence.js'
import { registerPresenceTools } from './presence-tools.js'
import { ensureOcrBinary } from './screen-ocr.js'
import { registerWorkTools } from './tools.js'
import { WorkTaskService } from './work-task-service.js'
import { WorkRemoteService } from './work-remote.js'

export const name = 'dsh-work-host'

/** W1 requires the storage domain, the Session controller, and the tool registry. */
export const inject = ['storageDomain', 'sessionController', 'tools', 'schedule']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Product-level work task service; registered by this plugin. */
    workTasks: WorkTaskService
    /** Artifact index used by the workbench and artifact tools. */
    workArtifacts: ArtifactLibrary
  }
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const domain = await ctx.storageDomain.open(workDomain)

  // The caller owns the domain handle; close it with the plugin.
  ctx.effect(() => () => {
    void domain.close()
  })

  const service = new WorkTaskService(ctx, domain, config)
  ctx.effect(() => () => service.dispose())
  ctx.provide('workTasks', service)
  ctx.provide('workArtifacts', service.artifacts)
  // One presence snapshot serves both the model tools and the composer chip, so
  // the two never race for the screen or compile the OCR helper twice.
  const presence =
    config.presence === false || process.platform !== 'darwin'
      ? undefined
      : new FeishuPresenceService({ isForeground: isFeishuForeground })
  if (config.remote !== false) new WorkRemoteService(ctx, service, presence)
  registerWorkTools(ctx, service)
  if (presence) {
    // Compile the Swift helper during boot rather than on the chip's first
    // read: a cold build takes 20-30 seconds and would look like a hang.
    void ensureOcrBinary().catch(() => undefined)
    registerPresenceTools(ctx)
    // Follow Feishu from the host: the chip's own polling stops as soon as its
    // window is hidden behind Feishu, which is exactly when following matters.
    ctx.effect(() => presence.startWatching())
  }

  // Settle task status and index deliverables at every turn boundary. The
  // handler is fire-and-forget: a failed scan must not fail the durable event.
  ctx.on('session/event', async (session, event) => {
    if (event.type !== 'turn/end' && event.type !== 'turn/start' && event.type !== 'user/message') return
    try {
      if (event.type === 'turn/start') await service.onTurnStart(String(session.id))
      else if (event.type === 'user/message') {
        const message = event.data as unknown as { source?: { kind?: string }; content?: ReadonlyArray<{ type?: string; text?: string }> }
        if (message.source?.kind === 'user') {
          const text = (message.content ?? [])
            .filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n')
          await service.onUserMessage(String(session.id), text)
        }
      } else await service.onTurnEnd(String(session.id), event.data.reason)
    } catch {
      // A scan or status write must not fail the durable turn event.
    }
  })

  // Optional user-facing /work command for interactive hosts. Headless hosts
  // have no command service and simply skip this registration.
  const commands = ctx.get('commands') as
    | { register(definition: Record<string, unknown>): () => void }
    | undefined
  if (commands) {
    try {
      commands.register({
        name: 'work',
        description: '把当前会话作为工作任务；可选目标或 status/cancel',
        input: { hint: '<目标>' },
        async handler({ agent, rawInput }: { agent: { session: { id: string } }; rawInput?: string }) {
          const sessionId = String(agent.session.id)
          const text = String(rawInput ?? '').trim()
          if (text === 'status') {
            const task = await service.get(sessionId)
            if (!task) return { kind: 'error' as const, text: '当前会话不是工作任务。' }
            return {
              kind: 'success' as const,
              text: `工作任务：${task.title}\n状态：${task.status}\n产物：${task.outputs.length}`,
            }
          }
          if (text === 'cancel') {
            await service.cancel(sessionId)
            return { kind: 'success' as const, text: '已取消当前工作任务。' }
          }
          const existing = await service.get(sessionId)
          if (existing) {
            if (text) await service.prompt(sessionId, text)
            return { kind: 'success' as const, text: '当前会话已是工作任务。' }
          }
          await service.attach(sessionId, text)
          return {
            kind: 'success' as const,
            text: text ? '已作为工作任务开始执行。' : '已开启工作模式，请输入目标或附件。',
          }
        },
      })
    } catch {
      // A command-name collision must not disable the rest of the plugin.
    }
  }

  // Opt-in boot marker for local smoke tests; never set in normal runs.
  const marker = process.env.DSH_WORK_HOST_MARKER
  if (marker) {
    const names = ctx.tools
      .definitions()
      .map((definition) => definition.name)
      .filter((name) => name.startsWith('work_'))
      .sort()
      .join(',')
    writeFileSync(marker, `host loaded; domain=work; tools=${names}\n`, 'utf8')
  }
}

export type { Config } from './config.js'
export { captureFeishuFocus, isFeishuForeground } from './feishu-capture.js'
export type { FeishuCaptureOptions, FeishuChatKind, FeishuFocusSnapshot } from './feishu-capture.js'
export { FeishuPresenceService } from './feishu-presence.js'
export type {
  FeishuPresenceEntry,
  FeishuPresenceOptions,
  FeishuPresenceSnapshot,
} from './feishu-presence.js'
export { frontmostApp, frontmostPid, parseAxTree, parseFeishuFocus } from './presence.js'
export { registerPresenceTools } from './presence-tools.js'
export type { FeishuFocus, FocusCandidate, PresenceApp } from './presence.js'
export {
  captureApp,
  describeCaptureFailure,
  ensureOcrBinary,
  findFeishuPids,
  listWindows,
  ocrBinaryPath,
  parseFeishuPids,
  parseFeishuScreen,
  preferFrontmost,
  screenTextLines,
} from './screen-ocr.js'
export type { FeishuScreenFocus, ScreenCapture, ScreenLine, WindowCandidate } from './screen-ocr.js'
export { WorkTaskService } from './work-task-service.js'
export { workDomain } from './domain.js'
export type {
  Artifact,
  ArtifactKind,
  ShareRecord,
  WorkTask,
  WorkTaskCreateInput,
  WorkTaskListQuery,
  WorkTaskStatus,
} from './types.js'
