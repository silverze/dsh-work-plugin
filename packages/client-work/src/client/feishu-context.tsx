/**
 * Feishu presence chip above the composer card.
 *
 * Mirrors the "current screen context" affordance of enterprise chat
 * assistants: while work mode is on, the row directly above the composer shows
 * the Feishu conversation that was on screen, and one click quotes it into the
 * draft. Because people flip between chats in Feishu faster than they switch to
 * DSH, the chip also keeps the last few conversations it saw.
 *
 * The popover is hand-rolled on purpose: this plugin ships no CSS and keeps the
 * client bundle free of UI primitive imports, which keeps the Node-side render
 * tests dependency-free.
 */

import * as React from 'react'

import type {
  FeishuPresenceEntry,
  FeishuPresenceSnapshot,
  WorkbenchController,
} from './controller.js'
import {
  feishuKindLabel,
  formatClock,
  presenceErrorHint,
  presenceQuoteMarkdown,
  presenceQuoteSummary,
  type PresenceQuoteSummary,
} from './presence-quote.js'
import { presenceChipTokens, type PresenceStyle } from './presence-style.js'
import { useWorkTask, type WorkNotify } from './work-session-ui.js'

/** The part of `InputActions` the chip needs. */
export interface QuoteInserter {
  insertQuote(text: string, summary?: PresenceQuoteSummary): boolean
}

export interface FeishuContextChipProps {
  sessionId: string
  workbench: WorkbenchController
  notify: WorkNotify
  inputActions?: QuoteInserter | undefined
}

const CHIP_MAX_NAME = 18
/** Minimum gap between two focus-driven reads, to keep OCR off the typing path. */
const AUTO_REFRESH_MS = 1_500
/** Ignore bursts of focus events; a screen read already takes about a second. */
const MIN_READ_GAP_MS = 700
/** Poll cadence for following chat switches; the Host only reads while Feishu is in front. */
const POLL_MS = 2_500

const BORDER = '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3))'
const MUTED = 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.95))'

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function entryOf(snapshot: FeishuPresenceSnapshot): FeishuPresenceEntry {
  return {
    chatName: snapshot.chatName,
    chatKind: snapshot.chatKind,
    messages: snapshot.messages,
    capturedAt: snapshot.capturedAt,
  }
}

/** One selectable conversation row inside the popover. */
function QuoteRow({
  entry,
  onSelect,
}: {
  entry: FeishuPresenceEntry
  onSelect: (entry: FeishuPresenceEntry) => void
}): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  return (
    <button
      type="button"
      role="menuitem"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onSelect(entry)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 2,
        width: '100%',
        padding: '6px 8px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        background: hover ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))' : 'transparent',
        color: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
        font: 'inherit',
      }}
    >
      <span style={{ fontSize: 12, lineHeight: 1.4, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {entry.chatName}
      </span>
      <span style={{ fontSize: 11, color: MUTED }}>{presenceQuoteSummary(entry).detail}</span>
    </button>
  )
}

function GroupLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ padding: '6px 8px 2px', fontSize: 11, color: MUTED }}>{children}</div>
  )
}

function Separator(): React.ReactElement {
  return <div style={{ height: 1, margin: '4px 6px', background: 'var(--dsw-alias-border-l1, rgba(127,127,127,.2))' }} />
}

export function FeishuContextChip({
  sessionId,
  workbench,
  notify,
  inputActions,
}: FeishuContextChipProps): React.ReactElement | null {
  const task = useWorkTask(workbench, sessionId)
  const enabled = Boolean(task)
  const snapshot = React.useSyncExternalStore(
    workbench.subscribePresence,
    workbench.presenceSnapshot,
    workbench.presenceSnapshot,
  ) as FeishuPresenceSnapshot | undefined
  const style = React.useSyncExternalStore(
    workbench.subscribePresenceStyle,
    workbench.presenceStyleSnapshot,
    workbench.presenceStyleSnapshot,
  ) as PresenceStyle
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const rootRef = React.useRef<HTMLSpanElement | null>(null)
  const caretRef = React.useRef<HTMLButtonElement | null>(null)
  const menuRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    if (!enabled) return
    void workbench.loadPresenceStyle().catch(() => {})
  }, [enabled, workbench])

  const refresh = React.useCallback(
    async (force: boolean): Promise<FeishuPresenceSnapshot> => {
      setBusy(true)
      try {
        return await workbench.refreshPresence(force)
      } finally {
        setBusy(false)
      }
    },
    [workbench],
  )

  // Read as soon as the session turns into a work task, then follow the user:
  // a click back into DSH or into the composer asks for a fresh read, and a
  // slow poll keeps up with chat switches while Feishu stays in front.
  React.useEffect(() => {
    if (!enabled) return
    let last = 0
    const read = (force: boolean, visible: boolean): void => {
      const now = Date.now()
      if (now - last < MIN_READ_GAP_MS) return
      if (!force && now - last < AUTO_REFRESH_MS) return
      last = now
      const run = visible ? refresh(force) : workbench.refreshPresence(force)
      void run.catch(() => {
        // The chip stays on the last snapshot; the error is offered as a retry.
      })
    }
    // Entering work mode is exactly when the chip must show something.
    read(true, true)
    // Focusing the composer is not a reason to spend a second on OCR: a cached
    // snapshot is enough unless the window focus handler forces a fresh read.
    const onFocusIn = (): void => read(false, false)
    const onWindowFocus = (): void => {
      last = 0
      read(true, true)
    }
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') return
      last = 0
      read(true, false)
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onWindowFocus)
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      read(false, false)
    }, POLL_MS)
    return () => {
      clearInterval(timer)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onWindowFocus)
    }
  }, [enabled, refresh, workbench])

  // Dismiss the popover like any other menu: click outside or Escape, with
  // arrow keys moving between the rows.
  React.useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // DSH treats Esc Esc as "stop the reply"; this Esc only closes the menu.
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        caretRef.current?.focus()
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
      if (items.length === 0) return
      event.preventDefault()
      const index = items.indexOf(document.activeElement as HTMLElement)
      const step = event.key === 'ArrowDown' ? 1 : -1
      items[(index + step + items.length) % items.length]?.focus()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const insert = React.useCallback(
    (entry: FeishuPresenceEntry): void => {
      const text = presenceQuoteMarkdown(entry)
      if (!inputActions) {
        notify('输入框动作不可用，无法插入飞书引用', false)
        return
      }
      const inserted = inputActions.insertQuote(text, presenceQuoteSummary(entry))
      if (!inserted) {
        notify('无法插入引用：输入框正忙或不可编辑，稍后再试', false)
        return
      }
      notify(`已引用飞书${feishuKindLabel(entry.chatKind)}「${entry.chatName}」`, true)
      setOpen(false)
    },
    [inputActions, notify],
  )

  if (!enabled) return null

  const detected = snapshot?.detected === true
  // When the current screen cannot be read (Feishu on another Space, permission
  // revoked), offer the conversation seen last instead of a dead chip: that is
  // nearly always the one the user wants to quote.
  const lastKnown: FeishuPresenceEntry | undefined = detected ? undefined : snapshot?.recent[0]
  const current: FeishuPresenceEntry | undefined =
    detected && snapshot ? entryOf(snapshot) : lastKnown

  const isStale = Boolean(lastKnown || snapshot?.stale)
  const label = current
    ? `${lastKnown ? '上次 ' : ''}${feishuKindLabel(current.chatKind)}｜${shorten(current.chatName, CHIP_MAX_NAME)}`
    : !snapshot
      ? busy
        ? '正在读取飞书…'
        : '飞书'
      : busy
        ? '正在重新读取…'
        : '飞书未检测到'
  const detail = current
    ? `${current.messages.length} 行 · ${formatClock(current.capturedAt)}${isStale ? ' · 上次' : ''}`
    : ''
  const tooltip = current
    ? `引用飞书${feishuKindLabel(current.chatKind)}「${current.chatName}」的可见消息${
        isStale ? `\n最新一次读取失败：${presenceErrorHint(snapshot?.error)}` : ''
      }`
    : snapshot?.error
      ? `${presenceErrorHint(snapshot.error)}\n点击重试`
      : '读取飞书当前会话'
  const recent = (snapshot?.recent ?? []).filter(
    (entry) => !current || entry.chatName !== current.chatName || entry.chatKind !== current.chatKind,
  )

  const mainClick = (): void => {
    if (current) {
      insert(current)
      return
    }
    void refresh(true).then(
      (next) => {
        if (!next.detected) notify(presenceErrorHint(next.error), false)
      },
      (cause: unknown) => notify(cause instanceof Error ? cause.message : String(cause), false),
    )
  }

  const retry = (): void => {
    void refresh(true).catch((cause: unknown) =>
      notify(cause instanceof Error ? cause.message : String(cause), false),
    )
  }

  const active = Boolean(current)
  const tokens = presenceChipTokens(style, active)
  const pillStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    height: 24,
    padding: '0 8px',
    color: 'inherit',
    maxWidth: 320,
    cursor: busy ? 'progress' : 'pointer',
    opacity: busy ? 0.7 : 1,
    ...tokens.pill,
  }

  return (
    <span
      ref={rootRef}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        padding: '2px 0 4px',
        maxWidth: '100%',
      }}
    >
      <button
        type="button"
        onClick={mainClick}
        aria-label={tooltip}
        title={tooltip}
        style={{
          ...pillStyle,
          borderTopRightRadius: 0,
          borderBottomRightRadius: 0,
          borderRight: 'none',
        }}
      >
        <span aria-hidden="true" style={{ flex: '0 0 auto', ...tokens.glyphStyle }}>
          {tokens.glyph}
        </span>
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            ...tokens.name,
          }}
        >
          {label}
        </span>
        {detail ? (
          <span
            style={{
              color: MUTED,
              flex: '0 0 auto',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              ...tokens.detail,
            }}
          >
            · {detail}
          </span>
        ) : null}
      </button>
      <button
        ref={caretRef}
        type="button"
        aria-label="选择要引用的飞书会话"
        aria-haspopup="menu"
        aria-expanded={open}
        title="选择要引用的飞书会话"
        onClick={() => setOpen((value) => !value)}
        style={{
          ...pillStyle,
          padding: '0 5px',
          borderTopLeftRadius: 0,
          borderBottomLeftRadius: 0,
          maxWidth: 'none',
          height: 24,
          ...tokens.caret,
        }}
      >
        <span aria-hidden="true" style={{ fontSize: 9, lineHeight: 1 }}>
          ▼
        </span>
      </button>
      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="飞书当前会话"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: 0,
            zIndex: 40,
            minWidth: 280,
            maxWidth: 340,
            maxHeight: 320,
            overflowY: 'auto',
            padding: 5,
            borderRadius: 'var(--dsw-radius-md, 8px)',
            border: BORDER,
            background: 'var(--dsw-menu-surface-fill, var(--dsw-alias-bg-layer-2, Canvas))',
            boxShadow: 'var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.18))',
            color: 'inherit',
            fontSize: 12,
          }}
        >
          {current ? (
            <>
              <GroupLabel>当前屏幕</GroupLabel>
              <QuoteRow entry={current} onSelect={insert} />
            </>
          ) : (
            <>
              <GroupLabel>当前屏幕</GroupLabel>
              <div style={{ padding: '2px 8px 6px', color: MUTED }}>
                {snapshot?.error ? presenceErrorHint(snapshot.error) : '还没有读到飞书会话'}
              </div>
            </>
          )}
          {recent.length > 0 ? (
            <>
              <Separator />
              <GroupLabel>最近聚焦</GroupLabel>
              {recent.slice(0, 5).map((entry, index) => (
                <QuoteRow key={`recent-${index}`} entry={entry} onSelect={insert} />
              ))}
            </>
          ) : null}
          <Separator />
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={retry}
            style={{
              width: '100%',
              padding: '6px 8px',
              border: 'none',
              borderRadius: 'var(--dsw-radius-sm, 6px)',
              background: 'transparent',
              color: 'inherit',
              fontSize: 11,
              textAlign: 'left',
              cursor: busy ? 'progress' : 'pointer',
            }}
          >
            {busy ? '正在读取飞书屏幕…' : '重新读取当前屏幕'}
          </button>
          <div style={{ padding: '4px 8px 2px', fontSize: 11, color: MUTED }}>
            先在飞书切到目标会话，再回到这里点一下即可引用
          </div>
        </div>
      ) : null}
    </span>
  )
}
