/**
 * One-shot Feishu screen read shared by the model tools and the composer chip.
 *
 * Both callers need the same policy: pick the Feishu process the user can
 * actually see, skip windows on another desktop, and report a single actionable
 * failure instead of a stack trace.
 */

import { frontmostPid } from './presence.js'
import {
  captureApp,
  describeCaptureFailure,
  findFeishuPids,
  frontmostNativePid,
  listWindows,
  parseFeishuScreen,
  preferFrontmost,
} from './screen-ocr.js'

export type FeishuChatKind = 'group' | 'direct' | 'unknown'

export interface FeishuFocusSnapshot {
  detected: boolean
  chatName: string
  chatKind: FeishuChatKind
  messages: string[]
  otherChats: string[]
  error?: string
}

export interface FeishuCaptureOptions {
  pid?: number
  maxMessages?: number
}

/**
 * Read the conversation in the focused Feishu window.
 *
 * Never throws: screen capture failures become `{ detected: false, error }` so
 * the caller can render a retry hint instead of breaking a tool call.
 */
export async function captureFeishuFocus(
  options: FeishuCaptureOptions = {},
): Promise<FeishuFocusSnapshot> {
  try {
    const discovered = options.pid ? [options.pid] : await findFeishuPids()
    // The native helper needs no Automation permission; AppleScript is only a
    // fallback for machines where the helper cannot be built or run.
    const nativePid = await frontmostNativePid().catch(() => -1)
    const frontPid = nativePid > 0 ? nativePid : await frontmostPid()
    const pids = preferFrontmost(discovered, options.pid ? undefined : frontPid)
    if (pids.length === 0) {
      return failure('Feishu is not running; open Feishu first')
    }

    // Several Feishu clients can run at once (official Lark plus a company
    // build). Read the one the user can actually see: an on-screen window wins
    // over any off-desktop instance, and discovery lists the company build
    // first so it wins a tie.
    const failures: string[] = []
    for (const pid of pids) {
      try {
        const capture = await captureApp(pid)
        if (capture.onScreen === false) {
          failures.push(
            'Feishu is running but its window is not on the current desktop (minimized or another Space); bring Feishu to the front and retry',
          )
          continue
        }
        const focus = parseFeishuScreen(capture, { maxMessages: options.maxMessages })
        if (focus.detected) {
          return {
            detected: true,
            chatName: focus.chatName ?? '',
            chatKind: focus.chatKind,
            messages: focus.messages,
            otherChats: focus.otherChats,
          }
        }
        failures.push(focus.error ?? 'no conversation recognized')
        // Feishu also opens document windows; when the chosen window is not the
        // chat window, try its siblings before declaring the read a failure.
        const siblings = (await listWindows().catch(() => [])).filter(
          (window) => window.pid === pid && window.windowNumber !== capture.windowNumber,
        )
        for (const sibling of siblings) {
          const other = await captureApp(pid, sibling.windowNumber).catch(() => undefined)
          if (!other) continue
          const parsed = parseFeishuScreen(other, { maxMessages: options.maxMessages })
          if (!parsed.detected) continue
          return {
            detected: true,
            chatName: parsed.chatName ?? '',
            chatKind: parsed.chatKind,
            messages: parsed.messages,
            otherChats: parsed.otherChats,
          }
        }
      } catch (error) {
        failures.push(describeCaptureFailure((error as Error).message))
      }
    }
    // Remember that Feishu could not be read so a newly launched client is
    // discovered on the next call instead of after the 15 second cache.
    if (!options.pid) pidsCache = undefined
    return failure([...new Set(failures)].join('; '))
  } catch (error) {
    return failure(describeCaptureFailure((error as Error).message))
  }
}

let pidsCache: { at: number; pids: number[] } | undefined

/** Feishu process ids, rediscovered at most every 15 seconds. */
export async function feishuProcessIds(): Promise<number[]> {
  const now = Date.now()
  if (pidsCache && now - pidsCache.at < 15_000) return pidsCache.pids
  const pids = await findFeishuPids()
  pidsCache = { at: now, pids }
  return pids
}

/**
 * Whether the user is currently working inside Feishu.
 *
 * The chip uses this to decide when a fresh screen read is worth a second of
 * OCR: while the user types in DSH nothing changes in Feishu, and while they
 * switch chats in Feishu every read is worth taking.
 */
export async function isFeishuForeground(): Promise<boolean> {
  try {
    const pids = await feishuProcessIds()
    if (pids.length === 0) return false
    const native = await frontmostNativePid().catch(() => -1)
    const pid = native > 0 ? native : (await frontmostPid()) ?? -1
    return pid > 0 && pids.includes(pid)
  } catch {
    return false
  }
}

function failure(error: string): FeishuFocusSnapshot {
  return { detected: false, chatName: '', chatKind: 'unknown', messages: [], otherChats: [], error }
}
