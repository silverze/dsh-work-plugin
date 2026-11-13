/**
 * Feishu IM notifier for scheduled work-task completion/failure.
 *
 * The chat is pre-authorized when the schedule is created (or by deployment
 * config); notification sends do not ask for per-run approval, because a
 * scheduled run has no interactive answerer.
 */

import type { Context } from '@deepseek-ai/cordis'

import type { FeishuHttpClient } from './feishu-client.js'

export type WorkNotificationEvent = 'done' | 'failed' | 'cancelled' | 'waiting_user'

export interface WorkNotificationTask {
  id: string
  title: string
  status: string
  scheduleId?: string
  notifyChatId?: string
  outputs?: string[]
  lastError?: { message?: string }
}

export interface WorkNotification {
  task: WorkNotificationTask
  event: WorkNotificationEvent
}

export interface WorkNotifier {
  notify(input: WorkNotification): Promise<void>
}

const EVENT_LABEL: Record<WorkNotificationEvent, string> = {
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  waiting_user: '等待确认',
}

export class FeishuWorkNotifier implements WorkNotifier {
  constructor(
    private readonly client: FeishuHttpClient,
    private readonly defaultChatId?: string,
  ) {}

  async notify({ task, event }: WorkNotification): Promise<void> {
    const chatId = task.notifyChatId ?? this.defaultChatId
    if (!chatId) return

    const outputs = task.outputs?.length ?? 0
    const lines = [
      `**${task.title}**`,
      `状态：${EVENT_LABEL[event]}`,
      `产物：${outputs} 个`,
      ...(task.scheduleId ? [`定时任务：${task.scheduleId}`] : []),
      ...(task.lastError?.message ? [`失败原因：${task.lastError.message}`] : []),
    ]

    const card = {
      config: { wide_screen_mode: true },
      header: {
        template: event === 'done' ? 'green' : event === 'failed' ? 'red' : 'grey',
        title: { tag: 'plain_text', content: `DSH Work · ${EVENT_LABEL[event]}` },
      },
      elements: [{ tag: 'markdown', content: lines.join('\n') }],
    }

    await this.client.sendMessage({
      receiveId: chatId,
      receiveIdType: 'chat_id',
      msgType: 'interactive',
      content: JSON.stringify(card),
    })
  }
}

export function registerFeishuWorkNotifier(
  ctx: Context,
  client: FeishuHttpClient,
  defaultChatId?: string,
): void {
  const notifier = new FeishuWorkNotifier(client, defaultChatId)
  ;(ctx.provide as (name: string, value: unknown) => () => void)('workNotifier', notifier)
}
