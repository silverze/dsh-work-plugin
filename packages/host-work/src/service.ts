/**
 * Service contracts between the host-work plugin and its consumers
 * (Remote methods, client-work, notifications). Implemented in W1.
 */

import type {
  Artifact,
  ArtifactListQuery,
  ShareRecord,
  WorkTask,
  WorkTaskCreateInput,
  WorkTaskListQuery,
} from './types.js'

export interface WorkTaskApi {
  create(input: WorkTaskCreateInput): Promise<WorkTask>
  get(taskId: string): Promise<WorkTask | undefined>
  list(query?: WorkTaskListQuery): Promise<WorkTask[]>
  prompt(taskId: string, text: string): Promise<void>
  cancel(taskId: string): Promise<void>
  remove(taskId: string): Promise<void>
  schedule(taskId: string, rrule: string, target?: 'session' | 'new_once' | 'new', notifyChatId?: string): Promise<string>
}

export interface ArtifactLibrary {
  list(query?: ArtifactListQuery): Promise<Artifact[]>
  get(artifactId: string): Promise<Artifact | undefined>
  register(taskId: string, path: string): Promise<Artifact>
  remove(artifactId: string): Promise<void>
  share(
    artifactId: string,
    target: ShareRecord['target'],
    options?: { folderToken?: string; chatId?: string },
  ): Promise<ShareRecord>
}

export interface WorkScheduleBinding {
  bind(taskId: string, rrule: string, target?: 'new_once' | 'this_session' | 'new'): Promise<string>
  unbind(taskId: string): Promise<void>
  runs(taskId: string): Promise<Array<{ at: number; status: 'done' | 'failed' }>>
}

export interface WorkNotifyService {
  notifyTaskDone(taskId: string): Promise<void>
  notifyTaskFailed(taskId: string, error: string): Promise<void>
  notifyTest(): Promise<void>
}
