/** Session-scoped work UI: status badge, mode toggle, header button, row menu. */

import * as React from 'react'

import type { WorkbenchController, WorkTaskView } from './controller.js'

export interface WorkNotify {
  (text: string, success?: boolean): void
}

export interface WorkSessionInject {
  workbench: WorkbenchController
  notify: WorkNotify
}

export function useWorkTask(
  workbench: WorkbenchController,
  sessionId: string,
): WorkTaskView | undefined {
  const index = React.useSyncExternalStore(
    workbench.subscribeIndex,
    workbench.indexSnapshot,
    workbench.indexSnapshot,
  )
  return index.get(sessionId)
}

const STATUS_COLOR: Record<string, string> = {
  draft: '#c69026',
  queued: '#c69026',
  running: '#3b82f6',
  waiting_user: '#c69026',
  done: '#2f9e44',
  failed: '#d33',
  cancelled: 'rgba(127,127,127,.6)',
}

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  queued: '排队',
  running: '运行中',
  waiting_user: '等待确认',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

/** Tiny status dot + artifact count in the native sidebar row. */
export function WorkSessionBadge({
  sessionId,
  workbench,
}: { sessionId: string } & Pick<WorkSessionInject, 'workbench'>): React.ReactElement | null {
  const task = useWorkTask(workbench, sessionId)
  if (!task) return null
  const label = `${STATUS_LABEL[task.status] ?? task.status} · ${task.title}`
  return (
    <span
      title={label}
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: 10,
        opacity: 0.85,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: STATUS_COLOR[task.status] ?? 'rgba(127,127,127,.5)',
        }}
      />
      {task.outputs.length > 0 ? task.outputs.length : ''}
    </span>
  )
}

/** Work-mode toggle in the context row above the composer. */
export function WorkModeChip({
  sessionId,
  workbench,
  notify,
}: { sessionId: string } & WorkSessionInject): React.ReactElement {
  const task = useWorkTask(workbench, sessionId)
  const [busy, setBusy] = React.useState(false)
  const enabled = Boolean(task)
  return (
    <button
      type="button"
      disabled={busy}
      aria-pressed={enabled}
      title={enabled ? '关闭工作模式' : '开启工作模式：把当前会话作为工作任务'}
      onClick={() => {
        void (async () => {
          setBusy(true)
          try {
            const next = await workbench.toggleWorkMode(sessionId)
            notify(next === 'on' ? '已开启工作模式' : '已关闭工作模式', true)
            // Start the Feishu read immediately instead of waiting for the chip
            // to mount and its first timer tick.
            if (next === 'on') void workbench.refreshPresence(true).catch(() => {})
          } catch (cause) {
            notify(cause instanceof Error ? cause.message : String(cause), false)
          } finally {
            setBusy(false)
          }
        })()
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '4px 8px',
        borderRadius: 999,
        border: '1px solid',
        borderColor: enabled ? 'var(--dsh-accent, rgba(59,130,246,.7))' : 'var(--dsh-border, rgba(127,127,127,.3))',
        background: enabled ? 'rgba(59,130,246,.12)' : 'transparent',
        color: 'inherit',
        fontSize: 11,
        cursor: busy ? 'default' : 'pointer',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: enabled ? '#3b82f6' : 'rgba(127,127,127,.5)',
        }}
      />
      工作模式
      {enabled ? ' · 开' : ''}
    </button>
  )
}

/** Header action opening the right-side work panel. */
export function WorkHeaderButton({
  openPanel,
}: {
  openPanel: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={openPanel}
      title="打开工作任务面板"
      style={{
        padding: '4px 9px',
        borderRadius: 7,
        border: '1px solid var(--dsh-border, rgba(127,127,127,.3))',
        background: 'transparent',
        color: 'inherit',
        fontSize: 11,
        cursor: 'pointer',
      }}
    >
      工作
    </button>
  )
}

/** Per-session menu for export/remove of one WorkTask. */
export function WorkSessionMenu({
  sessionId,
  displayTitle,
  workbench,
  notify,
  useMenuOpenState,
}: {
  sessionId: string
  displayTitle: string
  workbench: WorkbenchController
  notify: WorkNotify
  useMenuOpenState: () => [boolean, (open: boolean) => void]
}): React.ReactElement | null {
  const task = useWorkTask(workbench, sessionId)
  const [, setOpen] = useMenuOpenState()
  if (!task) return null

  async function exportTask(): Promise<void> {
    setOpen(false)
    try {
      const result = await workbench.exportTask(sessionId)
      notify(`已导出工作任务：${result.path}`, true)
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), false)
    }
  }

  async function removeTask(): Promise<void> {
    setOpen(false)
    const ok = window.confirm(
      `移除此工作任务“${displayTitle}”？\n\n会删除任务记录、产物和分享记录，但保留 DSH 会话。`,
    )
    if (!ok) return
    try {
      const result = await workbench.removeTask(sessionId)
      notify(`已移除工作任务（${result.artifacts} 个产物），会话已保留`, true)
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), false)
    }
  }

  const itemStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    padding: '6px 10px',
    border: 0,
    background: 'transparent',
    color: 'inherit',
    textAlign: 'left',
    fontSize: 12,
    cursor: 'pointer',
  }
  return (
    <>
      <button type="button" role="menuitem" style={itemStyle} onClick={() => void exportTask()}>
        导出工作任务
      </button>
      <button type="button" role="menuitem" style={itemStyle} onClick={() => void removeTask()}>
        移除工作任务（保留会话）
      </button>
    </>
  )
}
