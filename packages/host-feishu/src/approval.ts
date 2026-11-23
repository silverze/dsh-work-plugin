/**
 * Approval gate for Feishu write tools.
 *
 * Read tools flow through untouched. Every external write asks the session's
 * approval service and proceeds only on `allowed-once`; a missing agent, a
 * rejected ask, cancellation, or an unavailable answerer all fail closed.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-approval'

const FEISHU_WRITE_TOOLS = new Set([
  'feishu_doc_create',
  'feishu_doc_append',
  'feishu_sheet_write',
  'feishu_sheet_append',
  'feishu_drive_upload',
  'feishu_im_send',
  'feishu_share_artifact',
  'feishu_task_create',
  'feishu_task_complete',
  'feishu_auth_disconnect',
])

/** `dryRun: true` renders the request and sends nothing. */
function isDryRun(args: unknown): boolean {
  return typeof args === 'object' && args !== null && (args as { dryRun?: unknown }).dryRun === true
}

export function registerFeishuWriteApproval(ctx: Context): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!FEISHU_WRITE_TOOLS.has(exec.name)) return next()

    // A dry run never reaches Feishu, so it does not need the user's ask.
    if (isDryRun(exec.arguments)) return next()

    if (!exec.agent) {
      return { kind: 'deny', reason: `${exec.name} requires an active agent for approval` }
    }

    const outcome = await ctx.approval.request({
      agent: exec.agent,
      toolName: exec.name,
      ...(exec.callId ? { callId: exec.callId } : {}),
      reason: `Feishu write operation: ${exec.name}`,
      signal: exec.signal,
    })

    if (outcome === 'allowed-once') return next()
    return { kind: 'deny', reason: `Feishu write denied (${outcome})` }
  })
}
