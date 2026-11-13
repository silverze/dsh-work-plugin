/**
 * Model-facing Work tools. These are intentionally small: they create, read,
 * list, cancel and continue a work task. Artifact and Feishu tools arrive in
 * W2/W3.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { WorkTask } from './types.js'
import type { WorkTaskService } from './work-task-service.js'

const taskSummarySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string' },
  },
} as const

const taskDetailSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    goal: { type: 'string' },
    status: { type: 'string' },
    outputs: { type: 'array', items: { type: 'string' } },
    createdAt: { type: 'number' },
    updatedAt: { type: 'number' },
  },
} as const

const taskListSchema = {
  type: 'array',
  items: taskSummarySchema,
} as const

const artifactSummarySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    kind: { type: 'string' },
    path: { type: 'string' },
    size: { type: 'number' },
    version: { type: 'number' },
  },
} as const

const artifactListSchema = {
  type: 'array',
  items: artifactSummarySchema,
} as const

function summary(task: WorkTask) {
  return { id: task.id, title: task.title, status: task.status }
}

function artifactSummary(artifact: {
  id: string
  kind: string
  path: string
  size: number
  version: number
}) {
  return {
    id: artifact.id,
    kind: artifact.kind,
    path: artifact.path,
    size: artifact.size,
    version: artifact.version,
  }
}

function detail(task: WorkTask) {
  return {
    id: task.id,
    title: task.title,
    goal: task.goal,
    status: task.status,
    outputs: task.outputs,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

export function registerWorkTools(ctx: Context, service: WorkTaskService): void {
  ctx.tools.register(
    defineTool({
      name: 'work_task_create',
      description:
        'Create a DSH Work task and start it in a new session. Returns the task id, which is also the session id. Use this when the user states a work goal that needs multiple steps or deliverables.',
      parameters: {
        title: { type: 'string', required: true, description: 'Short task title, at most 60 characters.' },
        goal: {
          type: 'string',
          required: true,
          description:
            'What to accomplish, for whom, with deliverables and acceptance criteria. Include format, length, and time range when known.',
        },
        workspaceId: {
          type: 'string',
          description: 'Workspace id. Omit to use the current/default workspace.',
        },
        model: { type: 'string', description: 'Optional model id override for this task.' },
      },
      output: {
        schema: taskSummarySchema,
        render: (_args, value): ContentBlock[] => [
          { type: 'text', text: `Created task ${value.id} (${value.title}) status=${value.status}` },
        ],
      },
      async execute(args) {
        const task = await service.create({
          title: args.title,
          goal: args.goal,
          ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
          ...(args.model ? { model: args.model } : {}),
          runtime: 'local',
        })
        return summary(task)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'work_task_list',
      description: 'List DSH Work tasks, newest first. Filter by a text query or status.',
      parameters: {
        query: { type: 'string', description: 'Optional text to match in title or goal.' },
        status: {
          type: 'string',
          enum: ['draft', 'queued', 'running', 'waiting_user', 'done', 'failed', 'cancelled'],
          description: 'Optional exact status filter.',
        },
        limit: { type: 'number', description: 'Maximum rows, 1-100. Defaults to 20.' },
      },
      output: {
        schema: taskListSchema,
        render: (_args, value): ContentBlock[] => [
          {
            type: 'text',
            text: value.length
              ? value.map((task) => `${task.id}\t${task.status}\t${task.title}`).join('\n')
              : 'No work tasks.',
          },
        ],
      },
      async execute(args) {
        const tasks = await service.list({
          ...(args.query ? { query: args.query } : {}),
          ...(args.status ? { status: [args.status] } : {}),
          limit: Math.max(1, Math.min(args.limit ?? 20, 100)),
        })
        return tasks.map(summary)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'work_task_get',
      description: 'Read one DSH Work task by id, including its goal, status, and output ids.',
      parameters: {
        taskId: { type: 'string', required: true, description: 'Task id (same as session id).' },
      },
      output: {
        schema: taskDetailSchema,
        render: (_args, value): ContentBlock[] => [
          {
            type: 'text',
            text: `Task ${value.id}\nstatus: ${value.status}\ntitle: ${value.title}\ngoal: ${value.goal}\noutputs: ${value.outputs?.length ?? 0}`,
          },
        ],
      },
      async execute(args) {
        const task = await service.get(args.taskId)
        if (!task) throw new Error(`work_task_get: task not found: ${args.taskId}`)
        return detail(task)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'work_task_prompt',
      description:
        'Continue an existing DSH Work task by queueing another instruction in its session. Use for revisions and follow-ups.',
      parameters: {
        taskId: { type: 'string', required: true, description: 'Task id (same as session id).' },
        text: { type: 'string', required: true, description: 'Follow-up instruction.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { accepted: { type: 'boolean' } } },
        render: (_args, value): ContentBlock[] => [
          { type: 'text', text: value.accepted ? 'Follow-up accepted.' : 'Follow-up was not accepted.' },
        ],
      },
      async execute(args) {
        await service.prompt(args.taskId, args.text)
        return { accepted: true }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'work_task_cancel',
      description: 'Cancel the active run of a DSH Work task. Pending inbox work is retained by the session.',
      parameters: {
        taskId: { type: 'string', required: true, description: 'Task id (same as session id).' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { cancelled: { type: 'boolean' } } },
        render: (): ContentBlock[] => [{ type: 'text', text: 'Cancellation requested.' }],
      },
      async execute(args) {
        await service.cancel(args.taskId)
        return { cancelled: true }
      },
    }),
  )


  ctx.tools.register(
    defineTool({
      name: 'work_artifact_list',
      description: 'List deliverables indexed for work tasks, newest first. Use this after a task runs to discover docx/pptx/xlsx outputs.',
      parameters: {
        taskId: { type: 'string', description: 'Optional task id filter.' },
        limit: { type: 'number', description: 'Maximum rows, 1-100. Defaults to 50.' },
      },
      output: {
        schema: artifactListSchema,
        render: (_args, value): ContentBlock[] => [
          {
            type: 'text',
            text: value.length
              ? value.map((artifact) => `${artifact.id}\t${artifact.kind}\t${artifact.path}`).join('\n')
              : 'No artifacts.',
          },
        ],
      },
      async execute(args) {
        const artifacts = await service.artifacts.list({
          ...(args.taskId ? { taskId: args.taskId } : {}),
          limit: Math.max(1, Math.min(args.limit ?? 50, 100)),
        })
        return artifacts.map(artifactSummary)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'work_artifact_scan',
      description: 'Scan a task artifact directory and index new or changed files. Call after writing deliverables.',
      parameters: {
        taskId: { type: 'string', required: true, description: 'Task id (same as session id).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'number' },
            artifacts: artifactListSchema,
          },
        },
        render: (_args, value): ContentBlock[] => [
          { type: 'text', text: `Indexed ${value.count} artifact(s).` },
        ],
      },
      async execute(args) {
        const artifacts = await service.scanArtifacts(args.taskId)
        return { count: artifacts.length, artifacts: artifacts.map(artifactSummary) }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'work_artifact_get',
      description: 'Read one indexed artifact record by id, including size, hash, version and preview status.',
      parameters: {
        artifactId: { type: 'string', required: true, description: 'Artifact id from work_artifact_list.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            taskId: { type: 'string' },
            kind: { type: 'string' },
            path: { type: 'string' },
            size: { type: 'number' },
            sha256: { type: 'string' },
            version: { type: 'number' },
            previewStatus: { type: 'string' },
            createdAt: { type: 'number' },
          },
        },
        render: (_args, value): ContentBlock[] => [
          {
            type: 'text',
            text: `Artifact ${value.id}\nkind: ${value.kind}\npath: ${value.path}\nsize: ${value.size}\nversion: ${value.version}`,
          },
        ],
      },
      async execute(args) {
        const artifact = await service.artifacts.get(args.artifactId)
        if (!artifact) throw new Error(`work_artifact_get: not found: ${args.artifactId}`)
        return {
          id: artifact.id,
          taskId: artifact.taskId,
          kind: artifact.kind,
          path: artifact.path,
          size: artifact.size,
          sha256: artifact.sha256,
          version: artifact.version,
          previewStatus: artifact.previewStatus,
          createdAt: artifact.createdAt,
        }
      },
    }),
  )


  ctx.tools.register(
    defineTool({
      name: 'work_task_schedule',
      description:
        'Schedule a work task to run on a recurring RRULE. The default target is the task\'s own session so results land in the same task and artifact library.',
      parameters: {
        taskId: { type: 'string', required: true, description: 'Task id (same as session id).' },
        rrule: {
          type: 'string',
          required: true,
          description: 'One DTSTART line and one RRULE line, for example "DTSTART;TZID=Asia/Shanghai:20261110T090000\\nRRULE:FREQ=WEEKLY;BYDAY=MO".',
        },
        target: {
          type: 'string',
          enum: ['session', 'new_once', 'new'],
          description: 'Delivery target. Defaults to the task session.',
        },
        chatId: {
          type: 'string',
          description: 'Optional Feishu group chat_id for completion/failure notifications.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { scheduleId: { type: 'string' } },
        },
        render: (_args, value): ContentBlock[] => [
          { type: 'text', text: `Scheduled task ${value.scheduleId}.` },
        ],
      },
      async execute(args) {
        const scheduleId = await service.schedule(
          args.taskId,
          args.rrule,
          args.target ?? 'session',
          args.chatId,
        )
        return { scheduleId }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'work_ping',
      description: 'Health check for the DSH Work host services. Returns the task count and version.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            version: { type: 'string' },
            tasks: { type: 'number' },
          },
        },
        render: (_args, value): ContentBlock[] => [
          { type: 'text', text: `DSH Work host ok=${value.ok} version=${value.version} tasks=${value.tasks}` },
        ],
      },
      async execute() {
        const tasks = await service.list({ limit: 500 })
        return { ok: true, version: '0.1.0', tasks: tasks.length }
      },
    }),
  )
}
