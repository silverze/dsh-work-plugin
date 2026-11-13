/**
 * Draft text for a Feishu presence quote.
 *
 * The quote is a Markdown blockquote so the model receives it as quoted context
 * rather than as the user's own instruction. It stays explicit about being an
 * OCR read of the visible screen: the model must not assume it saw the whole
 * conversation.
 */

import type { FeishuChatKind, FeishuPresenceEntry } from './controller.js'

export type { FeishuChatKind }

const KIND_LABEL: Record<FeishuChatKind, string> = {
  group: '群聊',
  direct: '单聊',
  unknown: '会话',
}

export function feishuKindLabel(kind: FeishuChatKind): string {
  return KIND_LABEL[kind] ?? KIND_LABEL.unknown
}

/** `HH:MM` in the user's local time; the chip shows when the screen was read. */
export function formatClock(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function visibleMessages(
  source: Pick<FeishuPresenceEntry, 'messages'>,
  maxMessages: number,
): string[] {
  const limit = Math.max(1, Math.min(Math.trunc(maxMessages), 40))
  return source.messages
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .slice(-limit)
}

/** Blockquote inserted into the composer; mentions the source and its limits. */
export function presenceQuoteMarkdown(
  source: FeishuPresenceEntry,
  options: { maxMessages?: number } = {},
): string {
  const messages = visibleMessages(source, options.maxMessages ?? 20)
  const header = `> 飞书${feishuKindLabel(source.chatKind)}「${source.chatName}」· ${formatClock(
    source.capturedAt,
  )} 屏幕可见 ${messages.length} 行（OCR，最旧在上）：`
  if (messages.length === 0) return `${header}\n>\n> （当前没有可见消息）`
  return [
    header,
    '>',
    ...messages.map((text, index) => `> ${index + 1}. ${text}`),
  ].join('\n')
}

export interface PresenceQuoteSummary {
  readonly label: string
  readonly title: string
  readonly detail?: string
  readonly body: string
}

/** Composer preview: compact inline label plus a readable popover. */
export function presenceQuoteSummary(
  source: FeishuPresenceEntry,
  options: { maxMessages?: number } = {},
): PresenceQuoteSummary {
  const messages = visibleMessages(source, options.maxMessages ?? 20)
  const clock = formatClock(source.capturedAt)
  // The last rows are often the tail of a wrapped line, so prefer the newest
  // lines that read like a sentence instead of blindly taking the last two.
  const preview = messages.filter((text) => text.length >= 4).slice(-2)
  return {
    label: '飞书',
    title: `${feishuKindLabel(source.chatKind)}｜${source.chatName}`,
    detail: `${messages.length} 行可见 · ${clock} 读取`,
    body:
      preview.length > 0
        ? preview.join(' / ').slice(0, 120)
        : messages.length > 0
          ? `${messages.length} 行可见消息 · ${clock} 读取`
          : '当前屏幕没有可见消息',
  }
}

/**
 * Turn a Host read failure into the shortest sentence that tells the user what
 * to do. The Host speaks English to the model tools; the chip should not.
 */
export function presenceErrorHint(error: string | undefined): string {
  if (!error) return '未读到飞书会话，稍后重试'
  if (/not on the current desktop|no window found/i.test(error)) {
    return '飞书窗口不在 DSH 所在的桌面（最小化或切到了别的桌面）；把飞书窗口放到当前桌面再点重试'
  }
  if (/No Feishu conversation recognized/i.test(error)) {
    return '飞书窗口在屏幕上了，但没识别出当前会话；把要引用的聊天切到前台再点重试'
  }
  if (/not running/i.test(error)) return '没有发现运行中的飞书，先打开飞书'
  if (/Screen Recording|capture failed/i.test(error)) {
    return '缺少屏幕录制权限：系统设置 → 隐私与安全性 → 屏幕录制，勾选 DeepSeek Harness'
  }
  if (/swiftc|helper/i.test(error)) return '屏幕 OCR 组件尚未就绪，需要安装 Xcode 命令行工具后重试'
  return error
}
