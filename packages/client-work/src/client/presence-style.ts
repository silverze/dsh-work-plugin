/**
 * Appearance of the Feishu presence chip.
 *
 * The chip is a one-click quote of the conversation on screen, so its look is a
 * preference rather than a product decision: people who live in DSH want it to
 * blend in, people coming from other assistants want the affordance they know.
 * Three variants, chosen in Settings → 飞书 → 偏好 and stored on the host.
 */

import type { CSSProperties } from 'react'

export const PRESENCE_STYLES = ['dsh', 'codex', 'claude'] as const
export type PresenceStyle = (typeof PRESENCE_STYLES)[number]

export interface PresenceStyleOption {
  id: PresenceStyle
  label: string
  hint: string
}

export const PRESENCE_STYLE_OPTIONS: readonly PresenceStyleOption[] = [
  { id: 'dsh', label: 'DSH 默认', hint: '跟随主题的胶囊，蓝点标记，和工作模式 chip 一致' },
  { id: 'codex', label: 'Codex', hint: '等宽字体、方角、终端式前缀，像命令行里的引用' },
  { id: 'claude', label: 'Claude', hint: '暖陶土色、圆角放宽，低调的侧边标记' },
]

export function isPresenceStyle(value: unknown): value is PresenceStyle {
  return typeof value === 'string' && (PRESENCE_STYLES as readonly string[]).includes(value)
}

/** Unknown or missing values fall back to the DSH default. */
export function presenceStyle(value: unknown): PresenceStyle {
  return isPresenceStyle(value) ? value : 'dsh'
}

export interface PresenceChipTokens {
  pill: CSSProperties
  name: CSSProperties
  detail: CSSProperties
  glyph: string
  glyphStyle: CSSProperties
  caret: CSSProperties
}

/**
 * Sample conversation for the settings picker. It is fictional on purpose:
 * this string ships with the plugin and appears in its screenshots, so it must
 * never become a real chat name from someone's Feishu.
 */
export const PRESENCE_SAMPLE = {
  kindLabel: '群聊',
  chatName: '示例产品群',
  detail: '12 行 · 10:32',
} as const

const DSH_ACCENT = 'rgba(59,130,246,.55)'
const CODEX_ACCENT = 'rgba(120,180,255,.55)'
const CLAUDE_ACCENT = '#D97757'

/**
 * Style tokens for one variant. `active` means the chip currently holds a
 * conversation: quiet when empty, tinted when there is something to quote.
 */
export function presenceChipTokens(style: PresenceStyle, active: boolean): PresenceChipTokens {
  if (style === 'codex') {
    return {
      pill: {
        borderRadius: 3,
        border: `1px solid ${active ? CODEX_ACCENT : 'rgba(127,127,127,.35)'}`,
        background: active ? 'rgba(120,180,255,.10)' : 'rgba(127,127,127,.08)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11,
        letterSpacing: 0,
      },
      name: { fontSize: 11, letterSpacing: 0 },
      detail: { fontSize: 10, opacity: 0.75, letterSpacing: 0 },
      glyph: '›',
      glyphStyle: { fontSize: 13, lineHeight: 1, opacity: 0.7 },
      caret: { borderRadius: 3 },
    }
  }
  if (style === 'claude') {
    return {
      pill: {
        borderRadius: 10,
        border: `1px solid ${active ? 'rgba(217,119,87,.55)' : 'rgba(217,119,87,.28)'}`,
        background: active ? 'rgba(217,119,87,.12)' : 'rgba(217,119,87,.05)',
        fontSize: 11,
        letterSpacing: 0.1,
      },
      name: { fontSize: 12, letterSpacing: 0 },
      detail: { fontSize: 11, opacity: 0.8, color: CLAUDE_ACCENT },
      glyph: '●',
      glyphStyle: { fontSize: 8, lineHeight: 1, color: CLAUDE_ACCENT },
      caret: { borderRadius: 8 },
    }
  }
  return {
    pill: {
      borderRadius: 999,
      border: `1px solid ${active ? `var(--dsh-accent, ${DSH_ACCENT})` : 'var(--dsh-border, rgba(127,127,127,.3))'}`,
      background: active ? 'rgba(59,130,246,.10)' : 'transparent',
      fontSize: 11,
    },
    name: { fontSize: 12 },
    detail: { fontSize: 11, opacity: 0.75 },
    glyph: '飞',
    glyphStyle: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 14,
      height: 14,
      borderRadius: 4,
      background: '#3b82f6',
      color: '#fff',
      fontSize: 9,
      lineHeight: 1,
    },
    caret: { borderRadius: 999 },
  }
}
