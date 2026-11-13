/**
 * Client workbench controller. All data comes from the Host's `work/*` and
 * `feishu/*` Remote endpoints through the authenticated Connection RPC.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'

import { presenceStyle, type PresenceStyle } from './presence-style.js'
import { callRemote } from './rpc.js'

export interface WorkTaskView {
  id: string
  title: string
  goal: string
  status: string
  outputs: string[]
  scheduleId?: string
  notifyChatId?: string
  artifactDir?: string
  lastError?: { code: string; message: string; at: number }
  createdAt: number
  updatedAt: number
}

export interface ArtifactView {
  id: string
  taskId: string
  kind: string
  path: string
  size: number
  version: number
  previewStatus: string
  createdAt: number
}

export interface FeishuStatusView {
  connected: boolean
  tokenState?: 'valid' | 'refresh_pending' | 'expired' | 'none'
  reason?: 'no_token' | 'access_expired' | 'refresh_expired'
  name?: string
  openId?: string
  expiresAt?: number
  refreshExpiresAt?: number
  scope?: string
}

export interface FeishuAuthStartView {
  url: string
  state: string
  expiresAt: number
}

export interface CreateWorkTaskInput {
  title: string
  goal: string
}

/** Group/direct guess for a Feishu conversation read from the screen. */
export type FeishuChatKind = 'group' | 'direct' | 'unknown'

export interface FeishuPresenceEntry {
  chatName: string
  chatKind: FeishuChatKind
  messages: string[]
  capturedAt: number
}

export interface FeishuPresenceSnapshot extends FeishuPresenceEntry {
  detected: boolean
  /** The Host answered from its short-lived cache instead of a new screen read. */
  cached: boolean
  /** The latest read failed; this snapshot still shows the previous conversation. */
  stale?: boolean
  /** Conversations seen recently, newest first, excluding the current one. */
  recent: FeishuPresenceEntry[]
  error?: string
}

export class WorkbenchController {
  constructor(private readonly ctx: ClientContext) {}

  openSession(taskId: string): void {
    openWorkSession(this.ctx, taskId)
  }

  openArtifact(taskId: string, path: string): void {
    openWorkArtifact(this.ctx, taskId, path)
  }

  runSchedule(scheduleId: string): Promise<unknown> {
    return callRemote(this.ctx, 'work/scheduleRun', { scheduleId })
  }

  exportData(): Promise<{ path: string; size: number; tasks: number; artifacts: number }> {
    return callRemote(this.ctx, 'work/exportData', {}, 120_000)
  }

  clearData(): Promise<{ tasks: number; artifacts: number }> {
    return callRemote(this.ctx, 'work/clearData', { confirm: 'DELETE' }, 60_000)
  }

  getSettings(): Promise<{
    defaultModel?: string
    notifyChatId?: string
    presenceStyle?: PresenceStyle
  }> {
    return callRemote(this.ctx, 'work/settingsGet', {})
  }

  setSettings(patch: {
    defaultModel?: string
    notifyChatId?: string
    presenceStyle?: PresenceStyle
  }): Promise<{
    defaultModel?: string
    notifyChatId?: string
    presenceStyle?: PresenceStyle
  }> {
    return callRemote(this.ctx, 'work/settingsSet', patch)
  }

  private taskIndex = new Map<string, WorkTaskView>()
  private indexListeners = new Set<() => void>()

  subscribeIndex = (listener: () => void): (() => void) => {
    this.indexListeners.add(listener)
    return () => this.indexListeners.delete(listener)
  }

  indexSnapshot = (): Map<string, WorkTaskView> => this.taskIndex

  taskFor(sessionId: string): WorkTaskView | undefined {
    return this.taskIndex.get(sessionId)
  }

  async refreshIndex(): Promise<Map<string, WorkTaskView>> {
    try {
      const tasks = await this.listTasks({ limit: 200 })
      this.taskIndex = new Map(tasks.map((task) => [task.id, task]))
      for (const listener of this.indexListeners) listener()
    } catch {
      // The badge/index is best-effort; the right panel reads authoritative state.
    }
    return this.taskIndex
  }

  startIndexPolling(): () => void {
    void this.refreshIndex()
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        void this.refreshIndex()
      }
    }, 10_000)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  private presence: FeishuPresenceSnapshot | undefined
  private presenceInflight: Promise<FeishuPresenceSnapshot> | undefined
  /** False until the first read succeeds, which is when the OCR helper exists. */
  private presenceSeen = false
  private presenceListeners = new Set<() => void>()

  subscribePresence = (listener: () => void): (() => void) => {
    this.presenceListeners.add(listener)
    return () => this.presenceListeners.delete(listener)
  }

  presenceSnapshot = (): FeishuPresenceSnapshot | undefined => this.presence

  private presenceStyleValue: PresenceStyle = 'dsh'
  private styleLoaded = false
  private styleListeners = new Set<() => void>()

  subscribePresenceStyle = (listener: () => void): (() => void) => {
    this.styleListeners.add(listener)
    return () => this.styleListeners.delete(listener)
  }

  presenceStyleSnapshot = (): PresenceStyle => this.presenceStyleValue

  /** Read the stored chip style once, when the chip first appears. */
  async loadPresenceStyle(): Promise<PresenceStyle> {
    if (this.styleLoaded) return this.presenceStyleValue
    this.styleLoaded = true
    try {
      const settings = await this.getSettings()
      this.applyPresenceStyle(settings.presenceStyle)
    } catch {
      // A failed read only means the default look; retry once, because the
      // chip may have mounted before the host Connection was ready.
      this.styleLoaded = false
      setTimeout(() => {
        void this.loadPresenceStyle().catch(() => undefined)
      }, 3_000)
    }
    return this.presenceStyleValue
  }

  /** Apply immediately for a responsive picker, then persist on the host. */
  async setPresenceStyle(style: PresenceStyle): Promise<void> {
    const previous = this.presenceStyleValue
    this.applyPresenceStyle(style)
    try {
      await this.setSettings({ presenceStyle: style })
    } catch (error) {
      // Keep the picker honest: a failed write must not look saved.
      this.applyPresenceStyle(previous)
      throw error
    }
  }

  private applyPresenceStyle(value: unknown): void {
    const next = presenceStyle(value)
    if (next === this.presenceStyleValue) return
    this.presenceStyleValue = next
    for (const listener of this.styleListeners) listener()
  }

  /**
   * Read the Feishu conversation on screen. Concurrent callers share one read,
   * and the Host serves a short-lived cache unless `force` asks for a fresh one.
   *
   * A forced retry never reuses the cached answer that is already in flight:
   * it waits for it, then asks the Host again, so tapping "retry" during a poll
   * cannot silently show the old result.
   */
  refreshPresence(force = false): Promise<FeishuPresenceSnapshot> {
    if (this.presenceInflight) {
      if (!force) return this.presenceInflight
      return this.presenceInflight
        .catch(() => undefined)
        .then(() => this.refreshPresence(true))
    }
    // The first read after boot compiles the OCR helper (20-30s), so it gets a
    // longer budget than later reads.
    const timeout = this.presenceSeen ? 30_000 : 60_000
    this.presenceInflight = callRemote<FeishuPresenceSnapshot>(
      this.ctx,
      'work/presenceCapture',
      { force },
      timeout,
    )
      .then((snapshot) => {
        this.presenceSeen = true
        // The chip polls every couple of seconds; a cached answer that says
        // nothing new must not re-render it.
        if (!samePresence(this.presence, snapshot)) {
          this.presence = snapshot
          for (const listener of this.presenceListeners) listener()
        }
        return snapshot
      })
      .finally(() => {
        this.presenceInflight = undefined
      })
    return this.presenceInflight
  }

  getTask(taskId: string): Promise<WorkTaskView | undefined> {
    return callRemote<WorkTaskView | undefined>(this.ctx, 'work/taskGet', { taskId })
  }

  async attachSession(sessionId: string): Promise<WorkTaskView> {
    const task = await callRemote<WorkTaskView>(this.ctx, 'work/attachSession', { sessionId })
    await this.refreshIndex()
    return task
  }

  async detachSession(sessionId: string): Promise<{ detached: boolean }> {
    const result = await callRemote<{ detached: boolean }>(this.ctx, 'work/detachSession', {
      sessionId,
      confirm: 'DETACH',
    })
    await this.refreshIndex()
    return result
  }

  async toggleWorkMode(sessionId: string): Promise<'on' | 'off'> {
    if (this.taskFor(sessionId)) {
      await this.detachSession(sessionId)
      return 'off'
    }
    await this.attachSession(sessionId)
    return 'on'
  }

  exportTask(taskId: string): Promise<{ path: string; size: number; artifacts: number }> {
    return callRemote(this.ctx, 'work/exportTask', { taskId }, 120_000)
  }

  async removeTask(taskId: string): Promise<{ artifacts: number }> {
    const result = await callRemote<{ artifacts: number }>(this.ctx, 'work/removeTask', {
      taskId,
      confirm: 'DELETE',
    }, 120_000)
    await this.refreshIndex()
    return result
  }

  schedulePause(scheduleId: string, active: boolean): Promise<{ active: boolean }> {
    return callRemote(this.ctx, 'work/schedulePause', { scheduleId, active })
  }

  listTasks(query: { query?: string; limit?: number } = {}): Promise<WorkTaskView[]> {
    return callRemote<WorkTaskView[]>(this.ctx, 'work/taskList', query)
  }

  async createTask(input: CreateWorkTaskInput): Promise<WorkTaskView> {
    const goal = input.goal.trim()
    if (!goal) throw new Error('任务目标不能为空')
    return callRemote<WorkTaskView>(this.ctx, 'work/taskCreate', {
      title: input.title.trim() || goal.slice(0, 60),
      goal,
    })
  }

  promptTask(taskId: string, text: string): Promise<{ accepted: boolean }> {
    const content = text.trim()
    if (!content) throw new Error('追加要求不能为空')
    return callRemote(this.ctx, 'work/taskPrompt', { taskId, text: content })
  }

  scheduleTask(
    taskId: string,
    rrule: string,
    chatId?: string,
  ): Promise<{ scheduleId: string }> {
    const rule = rrule.trim()
    if (!rule) throw new Error('RRULE 不能为空')
    return callRemote(this.ctx, 'work/taskSchedule', {
      taskId,
      rrule: rule,
      ...(chatId?.trim() ? { chatId: chatId.trim() } : {}),
    })
  }

  cancelTask(taskId: string): Promise<{ cancelled: boolean }> {
    return callRemote(this.ctx, 'work/taskCancel', { taskId })
  }

  listArtifacts(taskId: string): Promise<ArtifactView[]> {
    return callRemote<ArtifactView[]>(this.ctx, 'work/artifactList', { taskId, limit: 100 })
  }

  listLibrary(query: { kind?: string; query?: string; limit?: number } = {}): Promise<ArtifactView[]> {
    return callRemote<ArtifactView[]>(this.ctx, 'work/artifactList', {
      ...query,
      limit: query.limit ?? 200,
    })
  }

  scanArtifacts(taskId: string): Promise<{ count: number; artifacts: ArtifactView[] }> {
    return callRemote(this.ctx, 'work/artifactScan', { taskId })
  }

  feishuStatus(): Promise<FeishuStatusView> {
    return callRemote<FeishuStatusView>(this.ctx, 'feishu/status')
  }

  feishuAppInfo(): Promise<{ configured: boolean; appId?: string }> {
    return callRemote(this.ctx, 'feishu/appInfo', {}, 30_000)
  }

  configureFeishuApp(appId: string, appSecret: string): Promise<{ configured: true }> {
    return callRemote(this.ctx, 'feishu/configureApp', { appId, appSecret }, 30_000)
  }

  resolveFeishuWiki(nodeToken: string): Promise<{ objType: string; objToken: string }> {
    return callRemote(this.ctx, 'feishu/wikiResolve', { nodeToken }, 30_000)
  }

  readFeishuDocument(documentId: string): Promise<{ documentId: string; content: string; url: string }> {
    return callRemote(this.ctx, 'feishu/docRead', { documentId }, 60_000)
  }

  readFeishuSheet(
    spreadsheetToken: string,
    range?: string,
  ): Promise<
    | { spreadsheetToken: string; sheets: Array<{ sheetId: string; title: string; rowCount: number; columnCount: number }> }
    | { range: string; values: unknown[][] }
  > {
    return callRemote(
      this.ctx,
      'feishu/sheetRead',
      { spreadsheetToken, ...(range ? { range } : {}) },
      60_000,
    )
  }

  feishuStart(): Promise<FeishuAuthStartView> {
    return callRemote<FeishuAuthStartView>(this.ctx, 'feishu/startAuth', {}, 30_000)
  }

  feishuDisconnect(): Promise<{ disconnected: boolean }> {
    return callRemote(this.ctx, 'feishu/disconnect', {}, 30_000)
  }

  shareArtifact(
    artifactId: string,
    chatId?: string,
  ): Promise<{ mode: string; token: string; url: string; messageId?: string }> {
    return callRemote(
      this.ctx,
      'feishu/shareArtifact',
      {
        artifactId,
        ...(chatId?.trim() ? { chatId: chatId.trim() } : {}),
      },
      120_000,
    )
  }
}

function artifactAddress(taskId: string, path: string): string {
  return `dsh-resource://file/session/${encodeURIComponent(taskId)}/${encodeURIComponent(path)}`
}

export function openWorkSession(ctx: ClientContext, taskId: string): void {
  const workspace = ctx.get('uiWorkspace') as
    | { openSession(target: string): void }
    | undefined
  if (!workspace) throw new Error('工作区导航不可用')
  workspace.openSession(taskId)
}

export function openWorkArtifact(ctx: ClientContext, taskId: string, path: string): void {
  const tabs = ctx.get('sidebarRight') as
    | { openResource(address: string): void }
    | undefined
  if (!tabs) throw new Error('右侧预览不可用')
  tabs.openResource(artifactAddress(taskId, path))
}

/** Whether two snapshots would render the same chip. */
function samePresence(
  a: FeishuPresenceSnapshot | undefined,
  b: FeishuPresenceSnapshot,
): boolean {
  if (!a) return false
  return (
    a.capturedAt === b.capturedAt &&
    a.detected === b.detected &&
    a.chatName === b.chatName &&
    a.chatKind === b.chatKind &&
    a.cached === b.cached &&
    a.stale === b.stale &&
    (a.error ?? '') === (b.error ?? '') &&
    a.messages.length === b.messages.length &&
    a.recent.length === b.recent.length
  )
}
