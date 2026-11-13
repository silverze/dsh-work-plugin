/**
 * The `work` storage domain: tasks, artifacts, and share records.
 *
 * Record schemas are zod because `@deepseek-ai/dsh-storage-domain` validates
 * every stored record at the durable boundary. The interfaces in `types.ts`
 * stay the public surface; `satisfies` keeps the two in lockstep.
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

import type { Artifact, ShareRecord, WorkTask } from './types.js'

const feishuLinkSchema = z.object({
  kind: z.enum(['docx', 'sheet', 'file']),
  token: z.string(),
  url: z.string(),
})

const lastErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  at: z.number().int(),
})

const workSettingsSchema = z
  .object({
    defaultModel: z.string().optional(),
    notifyChatId: z.string().optional(),
  }) satisfies z.ZodType<import('./types.js').WorkSettings>

const workTaskSchema: z.ZodType<WorkTask> = z
  .object({
    id: z.string(),
    title: z.string(),
    goal: z.string(),
    status: z.enum([
      'draft',
      'queued',
      'running',
      'waiting_user',
      'done',
      'failed',
      'cancelled',
    ]),
    workspaceId: z.string(),
    preset: z.literal('work'),
    model: z.string().optional(),
    runtime: z.enum(['local', 'sandbox']),
    attachments: z.array(z.string()),
    skills: z.array(z.string()),
    outputs: z.array(z.string()),
    artifactDir: z.string().optional(),
    scheduleId: z.string().optional(),
    notifyChatId: z.string().optional(),
    retryCount: z.number().int().optional(),
    feishuLinks: z.array(feishuLinkSchema),
    lastError: lastErrorSchema.optional(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })

const artifactSchema: z.ZodType<Artifact> = z
  .object({
    id: z.string(),
    taskId: z.string(),
    kind: z.enum(['docx', 'pptx', 'xlsx', 'pdf', 'md', 'html', 'png', 'csv', 'other']),
    path: z.string(),
    size: z.number().int(),
    sha256: z.string(),
    version: z.number().int(),
    previewStatus: z.enum(['none', 'ready', 'failed']),
    source: z.enum(['generated', 'uploaded', 'feishu_import']),
    feishu: z
      .object({
        token: z.string(),
        url: z.string(),
        type: z.enum(['docx', 'sheet', 'file']),
      })
      .optional(),
    createdAt: z.number().int(),
  })

const shareRecordSchema: z.ZodType<ShareRecord> = z
  .object({
    id: z.string(),
    artifactId: z.string(),
    target: z.enum(['feishu_drive', 'feishu_doc', 'feishu_im']),
    feishuToken: z.string().optional(),
    url: z.string().optional(),
    chatId: z.string().optional(),
    status: z.enum(['pending', 'done', 'failed']),
    idempotencyKey: z.string(),
    error: z.string().optional(),
    createdAt: z.number().int(),
  })

export const workDomain = defineDomain({
  name: 'work',
  version: 1,
  global: {
    schema: workSettingsSchema,
    initial: {},
  },
  tables: {
    tasks: domainTable<string, WorkTask>(workTaskSchema),
    artifacts: domainTable<string, Artifact>(artifactSchema),
    shares: domainTable<string, ShareRecord>(shareRecordSchema),
  },
})
