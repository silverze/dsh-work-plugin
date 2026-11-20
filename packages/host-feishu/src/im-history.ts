/**
 * Chat history by name or id.
 *
 * The screen reader only ever knows the chat *name* (the title text), while the
 * history API needs a chat_id. Both the model tool and the client chip go
 * through this module so the name → id → messages path is identical.
 *
 * Scope: Feishu has no "count messages" endpoint and no arbitrary offset, only
 * a time window plus a page token. So the caller chooses a *time range*, and this
 * module pages through it. Because a month of a busy group can be thousands of
 * messages, the range is walked in cursor chunks: `stats` answers "how much is
 * there" and "when did it happen" without dumping text, and `nextEndTime` /
 * `nextStartTime` let the caller continue exactly where the chunk stopped.
 */

import { FeishuError } from './errors.js'
import {
  resolveChatByName,
  type FeishuChatMessage,
  type FeishuHttpClient,
} from './feishu-client.js'

export type ChatHistoryOrder = 'newest' | 'oldest'

export interface ChatHistoryInput {
  chatName?: string
  chatId?: string
  /** Maximum messages to return in this chunk (default 100, cap 1000). */
  limit?: number
  /** Inclusive lower bound, milliseconds since epoch. */
  startTime?: number
  /** Inclusive upper bound, milliseconds since epoch. */
  endTime?: number
  /** Which end of the range the chunk starts from. Default `newest`. */
  order?: ChatHistoryOrder
  /** Also return per-day counts and a sender histogram for the chunk. */
  stats?: boolean
}

export interface ChatHistoryStats {
  /** Messages in this chunk. */
  total: number
  /** Oldest and newest message timestamps in this chunk (ms). */
  firstAt?: number
  lastAt?: number
  /** Per local-day counts, oldest day first. */
  days: Array<{ date: string; count: number }>
  /** Messages per sender open_id, most active first. */
  senders: Array<{ senderId: string; count: number }>
}

export interface ChatHistoryResult {
  chatId: string
  chatName: string
  messages: FeishuChatMessage[]
  /** More messages exist inside the requested range than this chunk returned. */
  truncated: boolean
  order: ChatHistoryOrder
  stats?: ChatHistoryStats
  /** Set when truncated and order is `newest`: pass as endTime to continue. */
  nextEndTime?: number
  /** Set when truncated and order is `oldest`: pass as startTime to continue. */
  nextStartTime?: number
}

/** Feishu caps one page at 50; 20 pages is one chunk of up to 1000 messages. */
const PAGE_SIZE = 50
const MAX_PAGES = 20
const MAX_MESSAGES = PAGE_SIZE * MAX_PAGES

export async function readChatHistory(
  client: FeishuHttpClient,
  input: ChatHistoryInput,
): Promise<ChatHistoryResult> {
  let chatId = input.chatId?.trim() ?? ''
  let chatName = ''
  if (!chatId) {
    const name = input.chatName?.trim() ?? ''
    if (!name) throw new FeishuError('feishu_invalid_argument', 'chatName or chatId is required')
    const candidates = await client.searchChats({ query: name })
    const chat = resolveChatByName(candidates, name)
    if (!chat) {
      throw new FeishuError(
        'feishu_not_found',
        `No Feishu chat matches "${name}". A user token only sees chats the user is a member of.`,
      )
    }
    chatId = chat.chatId
    chatName = chat.name
  }

  const limit = Math.max(1, Math.min(input.limit ?? 100, MAX_MESSAGES))
  const pageSize = Math.min(limit, PAGE_SIZE)
  const order: ChatHistoryOrder = input.order === 'oldest' ? 'oldest' : 'newest'
  const { messages, hasMore } = await client.listChatMessages({
    chatId,
    pageSize,
    maxPages: Math.min(Math.ceil(limit / pageSize), MAX_PAGES),
    order,
    ...(input.startTime ? { startTime: input.startTime } : {}),
    ...(input.endTime ? { endTime: input.endTime } : {}),
  })

  const selected = order === 'oldest' ? messages.slice(0, limit) : messages.slice(-limit)
  const truncated = hasMore || messages.length > selected.length
  const first = selected[0]
  const last = selected[selected.length - 1]
  const result: ChatHistoryResult = {
    chatId,
    chatName,
    messages: selected,
    truncated,
    order,
  }
  if (input.stats) result.stats = summarize(selected)
  if (truncated && first && last) {
    if (order === 'newest') result.nextEndTime = first.createTime - 1
    else result.nextStartTime = last.createTime + 1
  }
  return result
}

/** Per-day and per-sender counts for a chunk, without any extra API calls. */
export function summarize(messages: FeishuChatMessage[]): ChatHistoryStats {
  const days = new Map<string, number>()
  const senders = new Map<string, number>()
  let firstAt: number | undefined
  let lastAt: number | undefined
  for (const message of messages) {
    if (!Number.isFinite(message.createTime) || message.createTime <= 0) continue
    const date = localDate(message.createTime)
    days.set(date, (days.get(date) ?? 0) + 1)
    const sender = message.senderId || 'unknown'
    senders.set(sender, (senders.get(sender) ?? 0) + 1)
    firstAt = firstAt === undefined ? message.createTime : Math.min(firstAt, message.createTime)
    lastAt = lastAt === undefined ? message.createTime : Math.max(lastAt, message.createTime)
  }
  return {
    total: messages.length,
    ...(firstAt !== undefined ? { firstAt } : {}),
    ...(lastAt !== undefined ? { lastAt } : {}),
    days: [...days.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    senders: [...senders.entries()]
      .map(([senderId, count]) => ({ senderId, count }))
      .sort((a, b) => b.count - a.count),
  }
}

function localDate(ms: number): string {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** One line per message: `MM-DD HH:MM sender: text`. */
export function formatTranscript(messages: FeishuChatMessage[]): string {
  return messages
    .map((message) => {
      const stamp = formatStamp(message.createTime)
      const who = message.senderId || 'unknown'
      return `${stamp} ${who}: ${message.text}`.trim()
    })
    .join('\n')
}

export function formatStamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '--:--'
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${month}-${day} ${hours}:${minutes}`
}
