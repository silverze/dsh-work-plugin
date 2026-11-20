/**
 * Preset-driven work tasks.
 *
 * The work mode is a DSH agent preset (`work`), chosen in the native mode
 * picker before a session starts. Once a session records that preset the plugin
 * attaches its WorkTask, so there is no separate toggle: the preset is the
 * single source of truth and the native header label is the only indicator.
 *
 * Switching away from the preset on a still-blank session takes the draft back
 * off again, so the Feishu chip, the work badge and the `[Work]` title cannot
 * outlive the mode they belong to.
 */

import * as React from 'react'

import type { WorkbenchController } from './controller.js'

/** The `work` agent preset id declared in `packages/bundle/presets/work.patch.yml`. */
export const WORK_PRESET = 'work'

/**
 * `true` when a session carrying `preset` should get a WorkTask attached.
 *
 * Pure so the rule is testable without React or RPC.
 */
export function shouldAutoAttach(
  preset: string | null | undefined,
  hasTask: boolean,
): boolean {
  return preset === WORK_PRESET && !hasTask
}

/**
 * `true` when the draft task should be released because the session is not on
 * the work preset. A task that already started running cannot be switched away
 * from anyway, and manually attached tasks (the session menu, the `/work`
 * command with a goal) stay where a person put them.
 *
 * Tasks attached before `origin` existed carry no marker; they are released
 * only while they are still untouched placeholders, which is the shape the
 * preset auto-attach left behind (and the old toggle that this replaced).
 *
 * Pure so the rule is testable without React or RPC.
 */
export function shouldReleaseDraft(
  preset: string | null | undefined,
  task:
    | { origin?: 'preset' | 'manual'; status: string; title?: string; goal?: string }
    | undefined,
): boolean {
  if (preset === WORK_PRESET) return false
  if (!task || task.status !== 'draft') return false
  if (task.origin === 'preset') return true
  if (task.origin === 'manual') return false
  return task.title === '工作任务' && task.goal === '待补充目标'
}

/** Snapshot key for `useSyncExternalStore`: stable while the task is unchanged. */
function taskKey(workbench: WorkbenchController, sessionId: string): string {
  const task = workbench.taskFor(sessionId)
  return task ? `${task.origin ?? ''}/${task.status}` : ''
}

/**
 * Keep the session's WorkTask in sync with its `work` preset.
 *
 * Subscribes to the session list and the task index so both a freshly created
 * (or re-presetted) session and a preset switch away take effect without
 * remounting the conversation. Subagent sessions are skipped: their preset is a
 * parent detail, not a work surface.
 *
 * @returns the session's agent preset: `null` when the listed row carries none,
 *   `undefined` before the row arrives or when the client cannot read sessions.
 */
export function useWorkPresetSync(
  sessionId: string,
  workbench: WorkbenchController,
): string | null | undefined {
  const preset = React.useSyncExternalStore(
    workbench.subscribeSessions,
    () => workbench.sessionPreset(sessionId),
    () => undefined,
  )
  const key = React.useSyncExternalStore(
    workbench.subscribeIndex,
    () => taskKey(workbench, sessionId),
    () => '',
  )
  React.useEffect(() => {
    // `undefined` means the session list has not listed this row yet: neither
    // attaching nor releasing is safe until the preset is actually known.
    if (preset === undefined) return
    const hasTask = workbench.taskFor(sessionId) !== undefined
    if (shouldAutoAttach(preset, hasTask) && !workbench.isSubagentSession(sessionId)) {
      void workbench.ensureWorkTask(sessionId)
      return
    }
    // No-op unless the draft is one this client may take back; the controller
    // owns that decision so the rule and the release agree on one predicate.
    void workbench.releasePresetTask(sessionId)
  }, [preset, key, sessionId, workbench])
  return preset
}
