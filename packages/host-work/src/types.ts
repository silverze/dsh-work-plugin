/**
 * DSH Work host domain types.
 *
 * These are the product-level records stored in the `work` storageDomain.
 * Session events remain the source of truth for run state; these records only
 * carry what the product UI and sharing flows need.
 */

export type WorkTaskStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'done'
  | 'failed'
  | 'cancelled'

export type WorkTaskRuntime = 'local' | 'sandbox'

export type ArtifactKind =
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'pdf'
  | 'md'
  | 'html'
  | 'png'
  | 'csv'
  | 'other'

export type ArtifactSource = 'generated' | 'uploaded' | 'feishu_import'

export interface FeishuLink {
  kind: 'docx' | 'sheet' | 'file'
  token: string
  url: string
}

export interface WorkTask {
  /** Session id. A task is a session plus product metadata. */
  id: string
  title: string
  goal: string
  status: WorkTaskStatus
  workspaceId: string
  preset: 'work'
  model?: string
  runtime: WorkTaskRuntime
  attachments: string[]
  skills: string[]
  outputs: string[]
  /** Absolute directory the agent writes deliverables to. */
  artifactDir?: string
  scheduleId?: string
  /** Optional Feishu chat_id for scheduled-run notifications. */
  notifyChatId?: string
  /** Automatic retries already attempted for a scheduled run. */
  retryCount?: number
  feishuLinks: FeishuLink[]
  lastError?: {
    code: string
    message: string
    at: number
  }
  createdAt: number
  updatedAt: number
}

export interface Artifact {
  id: string
  taskId: string
  kind: ArtifactKind
  path: string
  size: number
  sha256: string
  version: number
  previewStatus: 'none' | 'ready' | 'failed'
  source: ArtifactSource
  feishu?: {
    token: string
    url: string
    type: 'docx' | 'sheet' | 'file'
  }
  createdAt: number
}

export interface ShareRecord {
  id: string
  artifactId: string
  target: 'feishu_drive' | 'feishu_doc' | 'feishu_im'
  feishuToken?: string
  url?: string
  chatId?: string
  status: 'pending' | 'done' | 'failed'
  idempotencyKey: string
  error?: string
  createdAt: number
}

export interface WorkTaskCreateInput {
  title: string
  goal: string
  /** Workspace id; omit when `cwd` names the working directory instead. */
  workspaceId?: string
  /** Working directory when no workspace is named. */
  cwd?: string
  model?: string
  runtime?: WorkTaskRuntime
  attachments?: string[]
  skills?: string[]
  outputFormats?: Array<'docx' | 'pptx' | 'xlsx' | 'md' | 'html' | 'pdf'>
  schedule?: {
    rrule: string
    target?: 'session' | 'new_once' | 'new'
    notifyChatId?: string
  }
}

export interface WorkTaskListQuery {
  status?: WorkTaskStatus[]
  workspaceId?: string
  query?: string
  limit?: number
  offset?: number
}

export interface ArtifactListQuery {
  taskId?: string
  kind?: ArtifactKind
  query?: string
  limit?: number
  offset?: number
}

/** Visual style of the Feishu presence chip above the composer. */
export const PRESENCE_STYLES = ['dsh', 'codex', 'claude'] as const
export type PresenceStyle = (typeof PRESENCE_STYLES)[number]

/** Editable work preferences stored in the domain global. */
export interface WorkSettings {
  defaultModel?: string
  notifyChatId?: string
  /** Chip appearance; absent means the DSH default. */
  presenceStyle?: PresenceStyle
}
