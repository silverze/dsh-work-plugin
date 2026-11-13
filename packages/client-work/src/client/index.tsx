/**
 * DSH Work client plugin.
 *
 * Keeps work inside native DSH sessions:
 * - one context row above the composer card: a "work mode" chip + `work-mode`
 *   command, and the Feishu presence chip that quotes the conversation on screen
 *   into the draft,
 * - a status badge and per-session menu for WorkTasks,
 * - a session-header button opening the right-side work panel,
 * - one Feishu settings section with connection/preferences/data tabs.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'

import { ComposerContextRow } from './composer-context-row.js'
import { WorkbenchController } from './controller.js'
import { parseFeishuLink } from './feishu-link.js'
import { WORK_PARTNERS, composeTaskGoal } from './partners.js'
import { FeishuSettingsShell } from './settings.js'
import { WorkPanel } from './work-panel.js'
import {
  WorkHeaderButton,
  WorkSessionBadge,
  WorkSessionMenu,
  type WorkNotify,
} from './work-session-ui.js'

export { ComposerContextRow } from './composer-context-row.js'
export { WorkbenchController } from './controller.js'
export { WORK_PARTNERS, composeTaskGoal } from './partners.js'
export { FeishuContextChip } from './feishu-context.js'
export {
  PRESENCE_SAMPLE,
  PRESENCE_STYLE_OPTIONS,
  isPresenceStyle,
  presenceChipTokens,
  presenceStyle,
} from './presence-style.js'
export {
  feishuKindLabel,
  formatClock,
  presenceErrorHint,
  presenceQuoteMarkdown,
  presenceQuoteSummary,
} from './presence-quote.js'
export { parseFeishuLink } from './feishu-link.js'
export { DataSettings, FeishuSettingsSection, FeishuSettingsShell, WorkGeneralSettings } from './settings.js'
export { WorkPanel } from './work-panel.js'
export { WorkHeaderButton, WorkModeChip, WorkSessionBadge, WorkSessionMenu } from './work-session-ui.js'

export interface WorkbenchInject {
  workbench: WorkbenchController
}

export const inject = ['slots', 'connection', 'uiWorkspace', 'sidebarRight']

export function apply(ctx: ClientContext): void {
  const controller = new WorkbenchController(ctx)
  const contextMenus = ctx.get('contextMenus') as
    | { notify(text: string, success?: boolean): void }
    | undefined
  const notify: WorkNotify = (text, success = true) => {
    if (contextMenus) contextMenus.notify(text, success)
    else console.log(`[dsh-work] ${text}`)
  }

  ctx.effect(() => controller.startIndexPolling())

  // Context row above the composer card: the Feishu conversation being followed
  // plus the work-mode toggle, on the band DSH renders above the input.
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'dsh-work-context-row',
        order: 10,
        inject: () => ({ workbench: controller, notify }),
      },
      ComposerContextRow,
    ),
  )

  // Native session row status badge.
  ctx.slots.inject('sidebar.workspaces.session.row.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.workspaces.session.row.action',
        id: 'dsh-work-status',
        order: 20,
        inject: () => ({ workbench: controller }),
      },
      WorkSessionBadge,
    ),
  )

  // Native session menu: export/remove this WorkTask.
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
    ctx.slots.register(
      {
        name: 'sidebar.workspaces.session.menu.item',
        id: 'dsh-work-task-menu',
        order: 500,
        inject: () => ({ workbench: controller, notify }),
      },
      WorkSessionMenu,
    ),
  )

  // Session header button opens the right-side work panel.
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'dsh-work-header',
        order: 20,
        inject: () => ({ openPanel: () => ctx.sidebarRight.openTab('work') }),
      },
      WorkHeaderButton,
    ),
  )

  // Right-sidebar page type + body.
  const rightTabs = ctx.get('sidebarRightTabs') as
    | {
        register(definition: {
          id: string
          kind: string
          priority: 'extension' | 'builtin' | 'fallback'
          title: (address: string) => string
          guide?: Array<{ id: string; order: number; title: () => string }>
        }): () => void
      }
    | undefined
  if (rightTabs) {
    ctx.effect(() =>
      rightTabs.register({
        id: 'dsh-work/work',
        kind: 'work',
        priority: 'extension',
        title: () => '工作',
        guide: [{ id: 'work', order: 10, title: () => '工作' }],
      }),
    )
    ctx.slots.inject('sidebar.right.pane.tab', () =>
      ctx.slots.register(
        {
          name: 'sidebar.right.pane.tab',
          key: 'dsh-work/work',
          inject: () => ({ workbench: controller }),
        },
        WorkPanel,
      ),
    )
  }

  // One Feishu settings section with tabs.
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'feishu',
        order: 20,
        label: '飞书',
        inject: () => ({ workbench: controller }),
      },
      FeishuSettingsShell,
    ),
  )

  // `+` / `/` menu action: toggle work mode for the current session.
  const commandUi = ctx.get('commandUi') as
    | {
        register(contribution: {
          name: string
          label(): string
          description(): string
          available(): boolean
          ui: { kind: 'action'; run(session: { sessionId?: string }): void }
        }): () => void
      }
    | undefined
  if (commandUi) {
    ctx.effect(() =>
      commandUi.register({
        name: 'work-mode',
        label: () => '工作模式',
        description: () => '把当前会话切换为工作任务，或关闭 draft 任务',
        available: () => true,
        ui: {
          kind: 'action',
          run: (session) => {
            const sessionId = session?.sessionId ? String(session.sessionId) : ''
            if (!sessionId) return
            void (async () => {
              try {
                const state = await controller.toggleWorkMode(sessionId)
                notify(state === 'on' ? '已开启工作模式' : '已关闭工作模式', true)
              } catch (cause) {
                notify(cause instanceof Error ? cause.message : String(cause), false)
              }
            })()
          },
        },
      }),
    )
  }
}
