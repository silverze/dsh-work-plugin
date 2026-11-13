/**
 * Model-facing presence tools. They are deliberately read-only: they observe
 * the frontmost app and parse an accessibility dump the model already obtained
 * through Computer Use. Any action (click, type) stays with `cua` so that
 * permissions and audit live in one place.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { captureFeishuFocus } from './feishu-capture.js'
import { frontmostApp, parseFeishuFocus } from './presence.js'
import { captureApp, describeCaptureFailure, screenTextLines } from './screen-ocr.js'

interface FrontmostValue {
  app?: string
  isFeishu?: boolean
  error?: string
}

interface ScreenTextValue {
  windowNumber?: number
  lines?: string[]
  error?: string
}

interface ScreenFocusValue extends FocusValue {
  messages?: string[]
  otherChats?: string[]
  error?: string
}

interface FocusValue {
  detected?: boolean
  windowTitles?: string[]
  chatName?: string
  chatKind?: string
  unread?: number
  recentText?: string[]
  truncated?: boolean
}

const focusSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    detected: { type: 'boolean' },
    windowTitles: { type: 'array', items: { type: 'string' } },
    chatName: { type: 'string' },
    chatKind: { type: 'string' },
    unread: { type: 'number' },
    recentText: { type: 'array', items: { type: 'string' } },
    truncated: { type: 'boolean' },
  },
} as const

export function registerPresenceTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'work_frontmost_app',
      description:
        'Report which macOS app currently has keyboard focus. Use it to check whether the user is looking at Feishu before reading the screen. Requires no macOS permission.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            app: { type: 'string' },
            isFeishu: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        render: (_args, value: FrontmostValue): ContentBlock[] => [
          {
            type: 'text',
            text: value.error
              ? `frontmost app unknown: ${value.error}`
              : `frontmost app: ${value.app || 'unknown'}${value.isFeishu ? ' (Feishu)' : ''}`,
          },
        ],
      },
      async execute() {
        const result = await frontmostApp()
        return {
          app: result.app ?? '',
          isFeishu: result.isFeishu,
          ...(result.error ? { error: result.error } : {}),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'work_feishu_focus',
      description:
        'Identify the Feishu conversation currently in focus from a Computer Use accessibility dump. Pass the raw text of `cua` getAccessibilityTree for the Feishu window. Returns the chat name, group/direct guess, unread count and the last visible messages, so a large tree does not have to be read by eye. Read-only and deterministic.',
      parameters: {
        axText: {
          type: 'string',
          required: true,
          description:
            'Raw accessibility tree text from the `cua` tool (method getAccessibilityTree), for the Feishu window.',
        },
        recentLimit: {
          type: 'number',
          description: 'How many trailing visible texts to return as recent messages. Defaults to 20.',
        },
      },
      output: {
        schema: focusSchema,
        render: (_args, value: FocusValue): ContentBlock[] => {
          if (!value.detected) {
            return [
              {
                type: 'text',
                text: 'No Feishu conversation found in this dump. Confirm the dump is the Feishu window (cua getApp/getWindows first) and that Accessibility permission is granted.',
              },
            ]
          }
          const titles = value.windowTitles ?? []
          const recent = value.recentText ?? []
          const unread = value.unread ?? -1
          const lines = [
            `chat: ${value.chatName || 'unknown'} (${value.chatKind ?? 'unknown'})`,
            titles.length > 0 ? `windows: ${titles.join(' | ')}` : '',
            unread >= 0 ? `unread: ${unread}` : '',
            value.truncated ? 'note: the tree was truncated; read a narrower window for the message list.' : '',
            recent.length > 0
              ? `recent text (oldest first):\n${recent.map((text) => `- ${text}`).join('\n')}`
              : '',
          ].filter(Boolean)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args) {
        const focus = parseFeishuFocus(args.axText ?? '', { recentLimit: args.recentLimit })
        return {
          detected: focus.detected,
          windowTitles: focus.windowTitles,
          chatName: focus.chat.name ?? '',
          chatKind: focus.chat.kind,
          unread: focus.chat.unread ?? -1,
          recentText: focus.recentText,
          truncated: focus.truncated,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'work_screen_text',
      description:
        'Read the text currently visible in one app window with macOS Vision OCR: about a second, cheap, and no model image input required. Pass a pid (from work_frontmost_app or cua listApps); the largest on-screen window of that process is captured. Returns visible text lines top to bottom and reuses the screen scan for any app.',
      parameters: {
        pid: { type: 'number', required: true, description: 'Process id of the app to read.' },
        windowNumber: {
          type: 'number',
          description: 'Optional CGWindowID to read instead of the largest window of the pid.',
        },
        limit: { type: 'number', description: 'Maximum text lines to return. Defaults to 150.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            windowNumber: { type: 'number' },
            lines: { type: 'array', items: { type: 'string' } },
            error: { type: 'string' },
          },
        },
        render: (_args, value: ScreenTextValue): ContentBlock[] => {
          if (value.error) return [{ type: 'text', text: `screen read failed: ${value.error}` }]
          const lines = value.lines ?? []
          return [
            {
              type: 'text',
              text: `window ${value.windowNumber ?? '?'}: ${lines.length} text lines\n${lines
                .map((line) => `- ${line}`)
                .join('\n')}`,
            },
          ]
        },
      },
      async execute(args) {
        try {
          const capture = await captureApp(args.pid, args.windowNumber)
          return {
            windowNumber: capture.windowNumber,
            lines: screenTextLines(capture, args.limit ?? 150),
          }
        } catch (error) {
          return { lines: [], error: describeCaptureFailure((error as Error).message) }
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'work_feishu_screen',
      description:
        'Locate the Feishu conversation the user is looking at by reading the Feishu window with local OCR, then return its name, group/direct guess and the visible messages. Cheapest and most reliable way to answer "what am I looking at in Feishu"; the AX-based work_feishu_focus stays as a fallback.',
      parameters: {
        pid: {
          type: 'number',
          description: 'Optional Feishu process id; discovered automatically when omitted.',
        },
        maxMessages: {
          type: 'number',
          description: 'How many visible message lines to return, oldest first. Defaults to 20.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            detected: { type: 'boolean' },
            chatName: { type: 'string' },
            chatKind: { type: 'string' },
            messages: { type: 'array', items: { type: 'string' } },
            otherChats: { type: 'array', items: { type: 'string' } },
            unread: { type: 'number' },
            recentText: { type: 'array', items: { type: 'string' } },
            truncated: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        render: (_args, value: ScreenFocusValue): ContentBlock[] => {
          if (!value.detected) {
            return [
              {
                type: 'text',
                text: `could not locate a Feishu conversation${value.error ? `: ${value.error}` : ''}`,
              },
            ]
          }
          const messages = value.messages ?? []
          const others = value.otherChats ?? []
          const lines = [
            `chat: ${value.chatName || 'unknown'} (${value.chatKind ?? 'unknown'})`,
            messages.length > 0
              ? `visible messages (oldest first):\n${messages.map((text) => `- ${text}`).join('\n')}`
              : 'visible messages: none',
            others.length > 0 ? `other open conversations: ${others.join(' | ')}` : '',
          ].filter(Boolean)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args) {
        const focus = await captureFeishuFocus({ pid: args.pid, maxMessages: args.maxMessages })
        return {
          detected: focus.detected,
          chatName: focus.chatName,
          chatKind: focus.chatKind,
          messages: focus.messages,
          otherChats: focus.otherChats,
          ...(focus.error ? { error: focus.error } : {}),
        }
      },
    }),
  )
}
