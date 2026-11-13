/**
 * Feishu presence snapshots for the composer chip.
 *
 * A screen read costs about a second, so the service coalesces concurrent
 * callers and serves a short-lived cache. It also keeps a small history of the
 * conversations it has seen, because the user usually switches chats in Feishu
 * faster than they can switch to DSH: the chip can then offer the conversation
 * they just had open instead of only the one that is visible now.
 */

import {
  captureFeishuFocus,
  type FeishuChatKind,
  type FeishuFocusSnapshot,
} from './feishu-capture.js'

export interface FeishuPresenceEntry {
  chatName: string
  chatKind: FeishuChatKind
  messages: string[]
  capturedAt: number
}

export interface FeishuPresenceSnapshot extends FeishuPresenceEntry {
  detected: boolean
  /** True when this answer came from the cache instead of a new screen read. */
  cached: boolean
  /**
   * True when the latest read failed and this snapshot still describes the
   * previous conversation, for example because Feishu moved to another Space.
   */
  stale?: boolean
  /** Most recently seen conversations, newest first, current one included. */
  recent: FeishuPresenceEntry[]
  error?: string
}

export interface FeishuPresenceOptions {
  /** Minimum gap between two screen reads, in milliseconds. */
  minIntervalMs?: number
  /** How many previous conversations to remember. */
  history?: number
  /** Visible message lines kept per conversation. */
  maxMessages?: number
  /** Screen reader; injected by tests so no real window is captured. */
  capture?: (options: { maxMessages?: number }) => Promise<FeishuFocusSnapshot>
  /**
   * Reports whether Feishu currently has keyboard focus. When provided, an
   * unfocused Feishu is treated as unchanged and the cache is served instead
   * of spending a second on OCR that cannot show a new conversation.
   */
  isForeground?: () => Promise<boolean>
  /** Clock, injected by tests to exercise the cache windows. */
  now?: () => number
}

const DEFAULT_MIN_INTERVAL_MS = 1_500
/** A failed read this soon after a good one is treated as transient, not stale. */
const TRANSIENT_FAILURE_MS = 90_000
/** Do not retry a failed screen read within this window. */
const FAILURE_BACKOFF_MS = 8_000
/** Background tick that follows Feishu while the user works inside it. */
const WATCH_INTERVAL_MS = 3_000
/** Two background reads are never closer than this, so client polls still win. */
const WATCH_MIN_INTERVAL_MS = 2_000
/** Stop following Feishu once no DSH chip has asked for a snapshot for this long. */
const WATCH_WINDOW_MS = 10 * 60_000
const DEFAULT_HISTORY = 6
const DEFAULT_MESSAGES = 20

export class FeishuPresenceService {
  private readonly minIntervalMs: number
  private readonly historySize: number
  private readonly maxMessages: number
  private readonly readScreen: (options: { maxMessages?: number }) => Promise<FeishuFocusSnapshot>
  private readonly isForeground: (() => Promise<boolean>) | undefined
  private readonly now: () => number
  private last: FeishuPresenceSnapshot | undefined
  /** Last time the chip asked; the background follower idles out without it. */
  private engagedAt = 0
  private inflight: Promise<FeishuPresenceSnapshot> | undefined
  /** When the last read failed, so retries back off instead of OCR-ing in a loop. */
  private failedAt = 0
  private lastError: string | undefined
  private history: FeishuPresenceEntry[] = []

  constructor(options: FeishuPresenceOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    this.historySize = options.history ?? DEFAULT_HISTORY
    this.maxMessages = options.maxMessages ?? DEFAULT_MESSAGES
    this.readScreen = options.capture ?? captureFeishuFocus
    this.isForeground = options.isForeground
    this.now = options.now ?? Date.now
  }

  /**
   * Snapshot for the chip. Asking for one also keeps the background follower
   * alive: the chip is the only caller, so an idle chip means no watcher.
   */
  async capture(request: { force?: boolean } = {}): Promise<FeishuPresenceSnapshot> {
    this.engagedAt = this.now()
    return this.read(request)
  }

  /**
   * Follow the focused Feishu conversation from the host.
   *
   * A DSH window hidden behind Feishu throttles its own polling, so the chip
   * alone cannot see the chats the user switches through while reading Feishu;
   * this tick keeps the snapshot fresh for when they come back. It only spends
   * OCR while Feishu actually has focus, and only while a chip is still asking.
   */
  async watch(): Promise<void> {
    if (this.now() - this.engagedAt > WATCH_WINDOW_MS) return
    if (this.inflight) return
    if (!this.isForeground) {
      await this.read({}).catch(() => undefined)
      return
    }
    if (!(await this.isForeground().catch(() => false))) return
    if (this.last && this.now() - this.last.capturedAt < WATCH_MIN_INTERVAL_MS) return
    await this.read({}).catch(() => undefined)
  }

  /** Starts the follower; the returned function stops it. */
  startWatching(intervalMs = WATCH_INTERVAL_MS): () => void {
    const timer = setInterval(() => {
      void this.watch()
    }, intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  private async read(request: { force?: boolean }): Promise<FeishuPresenceSnapshot> {
    if (this.inflight) return this.inflight
    if (!request.force && this.failedAt && this.now() - this.failedAt < FAILURE_BACKOFF_MS) {
      return this.last ? this.cached() : this.failureSnapshot()
    }
    if (!request.force && this.last) {
      const age = this.now() - this.last.capturedAt
      if (age < this.minIntervalMs) return this.cached()
      // A chip that polls while the user types in DSH should not keep paying
      // for OCR: nothing in Feishu changes until the user goes back to it.
      if (this.isForeground && !(await this.isForeground().catch(() => false))) {
        return this.cached()
      }
    }
    this.inflight ??= this.readScreen({ maxMessages: this.maxMessages }).then(
      (focus) => this.commit(focus),
    ).finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  private cached(): FeishuPresenceSnapshot {
    return { ...(this.last as FeishuPresenceSnapshot), cached: true, recent: this.recent() }
  }

  private failureSnapshot(): FeishuPresenceSnapshot {
    return {
      detected: false,
      chatName: '',
      chatKind: 'unknown',
      messages: [],
      capturedAt: this.failedAt,
      cached: true,
      recent: this.recent(),
      ...(this.lastError ? { error: this.lastError } : {}),
    }
  }

  recent(limit = this.historySize): FeishuPresenceEntry[] {
    return this.history.slice(0, Math.max(0, limit))
  }

  private commit(focus: FeishuFocusSnapshot): FeishuPresenceSnapshot {
    if (focus.detected) {
      this.failedAt = 0
      this.lastError = undefined
    } else {
      this.failedAt = this.now()
      this.lastError = focus.error
    }
    // A failed read keeps the last conversation on the chip: the user almost
    // always wants the chat they just left, and the error only explains why a
    // newer one is not available.
    if (!focus.detected && this.last?.detected) {
      // Coming back to DSH usually puts Feishu on another Space, which makes the
      // read fail even though the last conversation is the right one: keep it
      // quietly instead of flagging the chip as outdated.
      if (this.now() - this.last.capturedAt < TRANSIENT_FAILURE_MS) return this.cached()
      const stale: FeishuPresenceSnapshot = {
        ...this.last,
        cached: false,
        stale: true,
        recent: this.recent(),
        ...(focus.error ? { error: focus.error } : {}),
      }
      this.last = stale
      return stale
    }
    const capturedAt = this.now()
    const snapshot: FeishuPresenceSnapshot = {
      detected: focus.detected,
      chatName: focus.chatName,
      chatKind: focus.chatKind,
      messages: focus.messages,
      capturedAt,
      cached: false,
      recent: [],
      ...(focus.error ? { error: focus.error } : {}),
    }
    // A failed read keeps the previous snapshot's place in history, but the
    // failure itself is not worth remembering as a conversation.
    if (focus.detected && focus.chatName) {
      this.remember({
        chatName: focus.chatName,
        chatKind: focus.chatKind,
        messages: focus.messages,
        capturedAt,
      })
    }
    this.last = snapshot
    return { ...snapshot, recent: this.recent() }
  }

  private remember(entry: FeishuPresenceEntry): void {
    this.history = [
      entry,
      ...this.history.filter(
        (candidate) =>
          candidate.chatName !== entry.chatName || candidate.chatKind !== entry.chatKind,
      ),
    ].slice(0, this.historySize)
  }
}
