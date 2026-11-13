/** Notification seam between host-work and a delivery plugin (Feishu IM). */

import type { WorkTask } from './types.js'

export type WorkNotificationEvent = 'done' | 'failed' | 'cancelled' | 'waiting_user'

export interface WorkNotification {
  task: WorkTask
  event: WorkNotificationEvent
}

export interface WorkNotifier {
  notify(input: WorkNotification): Promise<void>
}
