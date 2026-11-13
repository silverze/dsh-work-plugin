/**
 * WorkTaskService — the product layer over a DSH Session.
 *
 * A task is a Session plus a durable product record. Creation goes through
 * `ctx.sessionController`, the same path Web "new session" uses, so presets and
 * workspace membership stay consistent. The record is written before the first
 * prompt so a failed prompt still leaves a visible task with an error.
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { create as tarCreate } from 'tar'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-schedule'
import type { TurnEndReason } from '@deepseek-ai/dsh-session/types'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'

import { ArtifactLibrary } from './artifact-library.js'
import type { Config } from './config.js'
import type { WorkTaskApi } from './service.js'
import type { workDomain } from './domain.js'
import { PRESENCE_STYLES } from './types.js'
import type { WorkSettings, WorkTask, WorkTaskCreateInput, WorkTaskListQuery } from './types.js'
import type { WorkNotificationEvent, WorkNotifier } from './notifier.js'

const DEFAULT_LIST_LIMIT = 50
const WORK_TITLE_PREFIX = '[Work] '

export class WorkTaskService implements WorkTaskApi {
  /** Cached table handles; the domain owns their lifetime. */
  private readonly tasks
  private readonly retryTimers = new Set<NodeJS.Timeout>()
  readonly artifacts: ArtifactLibrary

  constructor(
    private readonly ctx: Context,
    private readonly domain: Domain<typeof workDomain>,
    private readonly config: Config = {},
  ) {
    this.tasks = domain.table('tasks')
    this.artifacts = new ArtifactLibrary(ctx, domain, config)
  }

  private async touch(
    taskId: string,
    patch: Partial<WorkTask>,
  ): Promise<WorkTask> {
    return this.tasks.update(taskId, (current) => ({
      ...current,
      ...patch,
      updatedAt: Date.now(),
    }))
  }

  /** Create a tar.gz snapshot of tasks, artifact index, shares, and files. */
  async exportData(): Promise<{ path: string; size: number; tasks: number; artifacts: number }> {
    const tasks = Array.from(this.tasks.entries(), ([, task]) => task)
    const artifacts = Array.from(this.domain.table('artifacts').entries(), ([, artifact]) => artifact)
    const shares = Array.from(this.domain.table('shares').entries(), ([, share]) => share)
    const workRoot = dirname(this.artifacts.rootFor(''))
    const exportDir = join(workRoot, 'exports')
    await mkdir(exportDir, { recursive: true })
    const staging = await mkdtemp(join(tmpdir(), 'dsh-work-export-'))
    try {
      await writeFile(join(staging, 'tasks.json'), JSON.stringify(tasks, null, 2))
      await writeFile(join(staging, 'artifacts.json'), JSON.stringify(artifacts, null, 2))
      await writeFile(join(staging, 'shares.json'), JSON.stringify(shares, null, 2))
      await cp(this.artifacts.rootFor(''), join(staging, 'artifacts'), { recursive: true, force: true }).catch(() => undefined)
      const path = join(exportDir, `work-export-${Date.now()}.tar.gz`)
      await tarCreate({ gzip: true, file: path, cwd: staging }, ['.'])
      const info = await stat(path)
      return { path, size: info.size, tasks: tasks.length, artifacts: artifacts.length }
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** Clear all product data: tasks, artifacts (rows+files), shares. */
  async clearData(): Promise<{ tasks: number; artifacts: number }> {
    const tasks = Array.from(this.tasks.entries(), ([id]) => id)
    for (const id of tasks) await this.tasks.delete(id)
    const shareTable = this.domain.table('shares')
    const shares = Array.from(shareTable.entries(), ([id]) => id)
    for (const id of shares) await shareTable.delete(id)
    const artifacts = await this.artifacts.clear()
    return { tasks: tasks.length, artifacts }
  }

  /** Editable preferences stored in the domain global. */
  settings(): WorkSettings {
    return this.domain.global.get()
  }

  async updateSettings(patch: Partial<WorkSettings>): Promise<WorkSettings> {
    const current = this.settings()
    const next: WorkSettings = { ...current }
    for (const key of ['defaultModel', 'notifyChatId'] as const) {
      const value = patch[key]
      if (value === undefined) continue
      const trimmed = value.trim()
      if (trimmed) next[key] = trimmed
      else delete next[key]
    }
    // The chip style is an enum, not free text: unknown values fall back to the
    // DSH default instead of being stored and ignored later.
    if (patch.presenceStyle !== undefined) {
      if (PRESENCE_STYLES.includes(patch.presenceStyle)) next.presenceStyle = patch.presenceStyle
      else delete next.presenceStyle
    }
    await this.domain.global.set(next)
    return next
  }

  /** Attach the current Session as a work task without submitting a prompt. */
  async attachSession(sessionId: string): Promise<WorkTask> {
    const existing = await this.get(sessionId)
    if (existing) return existing
    const now = Date.now()
    const artifactDir = this.artifacts.rootFor(sessionId)
    await mkdir(artifactDir, { recursive: true }).catch(() => undefined)
    const task: WorkTask = {
      id: sessionId,
      title: '工作任务',
      goal: '待补充目标',
      status: 'draft',
      workspaceId: '',
      preset: 'work',
      runtime: 'local',
      attachments: [],
      skills: [],
      outputs: [],
      artifactDir,
      feishuLinks: [],
      createdAt: now,
      updatedAt: now,
    }
    await this.tasks.put(task.id, task)
    try {
      await this.ctx.sessionController.rename({
        sessionId: task.id as never,
        title: `${WORK_TITLE_PREFIX}${task.title}`,
      })
    } catch {
      // Rename is cosmetic.
    }
    return task
  }

  /** Attach and optionally submit the first goal for `/work`. */
  async attach(sessionId: string, goal: string): Promise<WorkTask> {
    const text = goal.trim()
    const task = await this.attachSession(sessionId)
    if (!text) return task
    const title = text.slice(0, 40)
    const updated = await this.touch(task.id, {
      title,
      goal: text,
      status: 'queued',
    })
    try {
      await this.ctx.sessionController.rename({
        sessionId: task.id as never,
        title: `${WORK_TITLE_PREFIX}${title}`.slice(0, 120),
      })
    } catch {
      // Rename is cosmetic.
    }
    await this.ctx.sessionController.prompt(
      {
        requestId: randomUUID() as never,
        sessionId: task.id as never,
        mode: 'queue',
        content: [
          {
            type: 'text',
            text: buildTaskPrompt(
              { title, goal: text },
              updated.artifactDir ?? this.artifacts.rootFor(task.id),
            ),
          },
        ],
      },
      new AbortController().signal,
    )
    return this.touch(task.id, { status: 'running' })
  }

  /** Detach a draft task, keeping the Session and its conversation. */
  async detachSession(sessionId: string): Promise<void> {
    const task = await this.get(sessionId)
    if (!task) return
    if (task.status !== 'draft') {
      throw new Error('工作任务已开始运行，不能关闭工作模式；请先取消或用会话菜单移除任务。')
    }
    if (task.outputs.length > 0) {
      throw new Error('工作任务已有产物，不能关闭工作模式；请用会话菜单移除工作任务。')
    }
    const shareTable = this.domain.table('shares')
    const hasShare = Array.from(shareTable.entries()).some(([, share]) => share.artifactId.startsWith(`${sessionId}:`))
    if (hasShare) {
      throw new Error('工作任务已有分享记录，不能关闭工作模式；请用会话菜单移除工作任务。')
    }
    await this.tasks.delete(sessionId)
    await rm(task.artifactDir ?? this.artifacts.rootFor(sessionId), { recursive: true, force: true }).catch(() => undefined)
    try {
      await this.ctx.sessionController.rename({
        sessionId: sessionId as never,
        title: '新会话',
      })
    } catch {
      // Rename is cosmetic.
    }
  }

  /** Use the first human message as the task/session title when still generic. */
  async onUserMessage(sessionId: string, text: string): Promise<void> {
    const task = await this.get(sessionId)
    if (!task) return
    const value = text.trim()
    if (!value) return
    if (task.title !== '工作任务' && task.goal !== '待补充目标') return
    const title = value.replace(/\s+/g, ' ').slice(0, 40)
    await this.touch(sessionId, { title, goal: value })
    try {
      await this.ctx.sessionController.rename({
        sessionId: sessionId as never,
        title: `${WORK_TITLE_PREFIX}${title}`.slice(0, 120),
      })
    } catch {
      // Rename is cosmetic.
    }
  }

  /** Mark a draft task running when its first turn starts. */
  async onTurnStart(sessionId: string): Promise<void> {
    const task = await this.get(sessionId)
    if (!task || task.status !== 'draft') return
    await this.touch(sessionId, { status: 'running' })
  }

  /** Export one task's record, artifacts, shares, and files. */
  async exportTask(taskId: string): Promise<{ path: string; size: number; artifacts: number }> {
    const task = await this.get(taskId)
    if (!task) throw new Error(`work_export_task: task not found: ${taskId}`)
    const artifacts = Array.from(this.domain.table('artifacts').entries(), ([, artifact]) => artifact)
      .filter((artifact) => artifact.taskId === taskId)
    const shares = Array.from(this.domain.table('shares').entries(), ([, share]) => share)
      .filter((share) => share.artifactId.startsWith(`${taskId}:`))
    const workRoot = dirname(this.artifacts.rootFor(''))
    const exportDir = join(workRoot, 'exports')
    await mkdir(exportDir, { recursive: true })
    const staging = await mkdtemp(join(tmpdir(), 'dsh-work-export-'))
    try {
      await writeFile(join(staging, 'task.json'), JSON.stringify(task, null, 2))
      await writeFile(join(staging, 'artifacts.json'), JSON.stringify(artifacts, null, 2))
      await writeFile(join(staging, 'shares.json'), JSON.stringify(shares, null, 2))
      await cp(task.artifactDir ?? this.artifacts.rootFor(taskId), join(staging, 'artifacts'), { recursive: true, force: true }).catch(() => undefined)
      const safeTitle = task.title.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'task'
      const path = join(exportDir, `work-task-${safeTitle}-${Date.now()}.tar.gz`)
      await tarCreate({ gzip: true, file: path, cwd: staging }, ['.'])
      const info = await stat(path)
      return { path, size: info.size, artifacts: artifacts.length }
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** Remove one task and its artifacts/shares, leaving the Session intact. */
  async removeTask(taskId: string): Promise<{ artifacts: number }> {
    const task = await this.get(taskId)
    if (!task) return { artifacts: 0 }
    const artifactTable = this.domain.table('artifacts')
    const artifacts = Array.from(artifactTable.entries(), ([, artifact]) => artifact)
      .filter((artifact) => artifact.taskId === taskId)
    for (const artifact of artifacts) {
      await unlink(artifact.path).catch(() => undefined)
      await artifactTable.delete(artifact.id)
    }
    const shareTable = this.domain.table('shares')
    for (const [id, share] of Array.from(shareTable.entries())) {
      if (share.artifactId.startsWith(`${taskId}:`)) await shareTable.delete(id)
    }
    await rm(task.artifactDir ?? this.artifacts.rootFor(taskId), { recursive: true, force: true }).catch(() => undefined)
    await this.tasks.delete(taskId)
    try {
      const bare = task.title.replace(/^\[Work\]\s*/, '').trim() || '新会话'
      await this.ctx.sessionController.rename({ sessionId: taskId as never, title: bare })
    } catch {
      // Rename is cosmetic.
    }
    return { artifacts: artifacts.length }
  }

  /** Pause or resume one bound schedule. */
  async schedulePause(scheduleId: string, active: boolean): Promise<void> {
    await this.ctx.schedule.edit({
      id: scheduleId as never,
      action: 'update',
      patch: { active },
    })
  }

  async create(input: WorkTaskCreateInput): Promise<WorkTask> {
    const title = input.title.trim()
    const goal = input.goal.trim()
    if (!title) throw new Error('work_task_create: title must not be empty')
    if (!goal) throw new Error('work_task_create: goal must not be empty')

    // Same path as Web "new session": preset resolution and workspace rules
    // stay in one place. Branded ids are an internal detail here.
    const created = await this.ctx.sessionController.create({
      ...(input.workspaceId ? { workspaceId: input.workspaceId as never } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      agentPreset: 'work',
    })
    const taskId = String(created.sessionId)
    const now = Date.now()
    const artifactDir = this.artifacts.rootFor(taskId)
    await mkdir(artifactDir, { recursive: true }).catch(() => undefined)

    const task: WorkTask = {
      id: taskId,
      title,
      goal,
      status: 'queued',
      workspaceId: input.workspaceId ?? input.cwd ?? '',
      preset: 'work',
      ...(input.model ?? this.settings().defaultModel ?? this.config.defaultModel
        ? { model: input.model ?? this.settings().defaultModel ?? this.config.defaultModel }
        : {}),
      runtime: input.runtime ?? 'local',
      attachments: input.attachments ?? [],
      skills: input.skills ?? [],
      outputs: [],
      artifactDir,
      feishuLinks: [],
      createdAt: now,
      updatedAt: now,
    }

    await this.tasks.put(task.id, task)

    // The workbench lists tasks by this prefix; a rename failure is cosmetic,
    // so it must not fail task creation.
    try {
      await this.ctx.sessionController.rename({
        sessionId: task.id as never,
        title: `${WORK_TITLE_PREFIX}${title}`,
      })
    } catch {
      // Keep the session's automatic title when the Host rejects the rename.
    }

    try {
      await this.ctx.sessionController.prompt(
        {
          requestId: randomUUID() as never,
          sessionId: task.id as never,
          mode: 'queue',
          content: [{ type: 'text', text: buildTaskPrompt(input, artifactDir) }],
        },
        new AbortController().signal,
      )
      return await this.touch(task.id, { status: 'running' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.touch(task.id, {
        status: 'failed',
        lastError: { code: 'work_task_prompt_failed', message, at: Date.now() },
      })
      throw error
    }
  }

  async get(taskId: string): Promise<WorkTask | undefined> {
    return this.tasks.get(taskId)
  }

  async list(query: WorkTaskListQuery = {}): Promise<WorkTask[]> {
    const needle = query.query?.trim().toLowerCase()
    const limit = query.limit ?? DEFAULT_LIST_LIMIT
    const offset = query.offset ?? 0

    const rows = Array.from(this.tasks.entries(), ([, task]) => task)
      .filter((task) => {
        if (query.workspaceId && task.workspaceId !== query.workspaceId) return false
        if (query.status?.length && !query.status.includes(task.status)) return false
        if (needle) {
          const haystack = `${task.title}\n${task.goal}`.toLowerCase()
          if (!haystack.includes(needle)) return false
        }
        return true
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)

    return rows.slice(offset, offset + Math.max(1, Math.min(limit, 500)))
  }

  async prompt(taskId: string, text: string): Promise<void> {
    const task = await this.get(taskId)
    if (!task) throw new Error(`work_task_prompt: task not found: ${taskId}`)
    const content = text.trim()
    if (!content) throw new Error('work_task_prompt: text must not be empty')

    await this.ctx.sessionController.prompt(
      {
        requestId: randomUUID() as never,
        sessionId: taskId as never,
        mode: 'queue',
        content: [{ type: 'text', text: content }],
      },
      new AbortController().signal,
    )
    await this.touch(taskId, { status: 'running' })
  }

  /**
   * Create a DSH schedule that replays the task goal. The default target is
   * this task's own Session so turn-end artifact capture and status settle on
   * the same task record.
   */
  async schedule(
    taskId: string,
    rrule: string,
    target: 'session' | 'new_once' | 'new' = 'session',
    notifyChatId?: string,
  ): Promise<string> {
    notifyChatId = notifyChatId?.trim() || this.settings().notifyChatId
    const task = await this.get(taskId)
    if (!task) throw new Error(`work_task_schedule: task not found: ${taskId}`)
    if (target === 'new') {
      throw new Error(
        'work_task_schedule: target "new" cannot be attributed to a work task; use "session" or "new_once"',
      )
    }

    const buildPrompt = (artifactDir?: string) =>
      [
        `继续工作任务：${task.goal}`,
        artifactDir ? `产物目录：${artifactDir}` : undefined,
        '完成后把产物写入成果库，并用 present 声明。',
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n')

    const targetSpec =
      target === 'session'
        ? { kind: 'session' as const, sessionId: taskId as never }
        : { kind: 'new_once' as const, create: { agentPreset: 'work' } }

    const entry = await this.ctx.schedule.create(
      {
        title: `[Work] ${task.title}`.slice(0, 120),
        prompt: buildPrompt(task.artifactDir),
        timing: { kind: 'rrule', rrule },
        target: targetSpec,
      },
      taskId as never,
    )

    if (target === 'new_once' && entry.target.kind === 'new_once') {
      const reservedId = String(entry.target.sessionId)
      const artifactDir = this.artifacts.rootFor(reservedId)
      await mkdir(artifactDir, { recursive: true }).catch(() => undefined)
      const now = Date.now()
      const companion: WorkTask = {
        id: reservedId,
        title: task.title,
        goal: task.goal,
        status: 'queued',
        workspaceId: task.workspaceId,
        preset: 'work',
        ...(task.model ? { model: task.model } : {}),
        runtime: task.runtime,
        attachments: task.attachments,
        skills: task.skills,
        outputs: [],
        artifactDir,
        scheduleId: String(entry.id),
        ...(notifyChatId ? { notifyChatId } : {}),
        feishuLinks: [],
        createdAt: now,
        updatedAt: now,
      }
      await this.tasks.put(reservedId, companion)

      try {
        await this.ctx.schedule.edit(
          {
            id: entry.id,
            action: 'update',
            patch: { prompt: buildPrompt(artifactDir) },
          },
          taskId as never,
        )
      } catch (error) {
        await this.tasks.delete(reservedId)
        throw error
      }

      await this.touch(taskId, {
        scheduleId: String(entry.id),
        ...(notifyChatId ? { notifyChatId } : {}),
      })
      return String(entry.id)
    }

    await this.touch(taskId, {
      scheduleId: String(entry.id),
      ...(notifyChatId ? { notifyChatId } : {}),
    })
    return String(entry.id)
  }

  async cancel(taskId: string): Promise<void> {
    const task = await this.get(taskId)
    if (!task) throw new Error(`work_task_cancel: task not found: ${taskId}`)
    this.ctx.sessionController.cancel({ sessionId: taskId as never })
    await this.touch(taskId, { status: 'cancelled' })
  }

  async remove(taskId: string): Promise<void> {
    const task = await this.get(taskId)
    if (!task) return
    await this.tasks.delete(taskId)
  }

  /** Scan the task directory and mirror its files into `task.outputs`. */
  async scanArtifacts(taskId: string) {
    const task = await this.get(taskId)
    if (!task) return []
    const artifacts = await this.artifacts.scan(taskId, task.artifactDir)
    await this.touch(taskId, { outputs: artifacts.map((artifact) => artifact.id) })
    return artifacts
  }

  /**
   * Turn-end hook: index deliverables, settle status, retry a scheduled
   * failure, and notify the configured deliverer.
   */
  async onTurnEnd(taskId: string, reason: TurnEndReason): Promise<void> {
    const task = await this.get(taskId)
    if (!task) return

    const artifacts = await this.artifacts.scan(taskId, task.artifactDir)
    const patch: Partial<WorkTask> = { outputs: artifacts.map((artifact) => artifact.id) }

    switch (reason.kind) {
      case 'completed':
        patch.status = 'done'
        break
      case 'aborted':
        patch.status = 'cancelled'
        break
      case 'blocked':
        patch.status = 'waiting_user'
        break
      case 'error': {
        const failure = reason.error as { message?: string }
        patch.status = 'failed'
        patch.lastError = {
          code: 'turn_failed',
          message: failure.message ?? 'turn failed',
          at: Date.now(),
        }
        break
      }
      case 'max-tokens':
        patch.status = 'failed'
        patch.lastError = {
          code: 'turn_max_tokens',
          message: 'turn reached the output token ceiling',
          at: Date.now(),
        }
        break
      default:
        patch.status = 'failed'
        break
    }

    const noRecordedSideEffects = artifacts.length === 0 && task.feishuLinks.length === 0
    const retryable =
      noRecordedSideEffects &&
      (reason.kind === 'error' || reason.kind === 'max-tokens') &&
      Boolean(task.scheduleId) &&
      (task.retryCount ?? 0) < (this.config.maxScheduleRetries ?? 1)

    if (retryable) {
      const retryCount = (task.retryCount ?? 0) + 1
      const updated = await this.touch(taskId, {
        ...patch,
        status: 'queued',
        retryCount,
      })
      this.scheduleRetry(updated)
      return
    }

    const updated = await this.touch(taskId, patch)
    const event = eventForStatus(updated.status)
    if (event) await this.notify(updated, event)
  }

  /** Clear pending retry timers when the plugin unloads. */
  dispose(): void {
    for (const timer of this.retryTimers) clearTimeout(timer)
    this.retryTimers.clear()
  }

  private scheduleRetry(task: WorkTask): void {
    const delay = this.config.retryDelayMs ?? 5000
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer)
      const text = [
        `上一次定时运行失败：${task.lastError?.message ?? '未知错误'}。`,
        '请检查失败原因后重试；不要重复已经完成的外部写操作。',
      ].join('\n')
      void this.ctx.sessionController
        .prompt(
          {
            requestId: randomUUID() as never,
            sessionId: task.id as never,
            mode: 'queue',
            content: [{ type: 'text', text }],
          },
          new AbortController().signal,
        )
        .then(() => this.touch(task.id, { status: 'running' }))
        .catch(async (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          const failed = await this.touch(task.id, {
            status: 'failed',
            lastError: { code: 'work_retry_prompt_failed', message, at: Date.now() },
          })
          await this.notify(failed, 'failed')
        })
    }, delay)
    timer.unref?.()
    this.retryTimers.add(timer)
  }

  private async notify(task: WorkTask, event: WorkNotificationEvent): Promise<void> {
    const notifier = this.ctx.get('workNotifier') as WorkNotifier | undefined
    if (!notifier) return
    try {
      await notifier.notify({ task, event })
    } catch {
      // Notifications are best-effort and never fail the durable turn.
    }
  }

}

function eventForStatus(status: WorkTask['status']): WorkNotificationEvent | undefined {
  switch (status) {
    case 'done':
      return 'done'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'waiting_user':
      return 'waiting_user'
    default:
      return undefined
  }
}

function buildTaskPrompt(input: WorkTaskCreateInput, artifactDir: string): string {
  const formats =
    input.outputFormats?.length
      ? input.outputFormats.join(', ')
      : '按任务需要选择 docx / xlsx / pptx / md'

  return [
    '你是 DSH Work 的工作任务执行者。',
    `任务目标：${input.goal}`,
    input.attachments?.length
      ? `输入文件：${input.attachments.join(', ')}`
      : undefined,
    `期望输出：${formats}`,
    `产物目录：${artifactDir}`,
    '执行要求：',
    '1. 先用一句话重述目标与验收标准，再给出简要计划。',
    '2. 需要外部资料时使用搜索/抓取工具；需要 Office 产物时先加载对应 office 技能。',
    `3. 所有产物写入 ${artifactDir}，完成后用 present 声明；不要写到其他目录。`,
    '4. 涉及飞书写入、发消息或对外发布时，先向用户确认目标与范围。',
    '5. 不确定的信息要标注“待确认”，不要编造。',
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')
}
