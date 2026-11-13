/**
 * Screen presence: the semantic layer over DSH Computer Use.
 *
 * Computer Use (`@deepseek-ai/dsh-cua`) already owns the hard parts — the
 * signed helper app, macOS Accessibility/Screen-Recording permissions, and the
 * `cua` model tool that can return a screenshot or an accessibility tree. This
 * module does not duplicate that. It only answers the work-shaped questions on
 * top of a raw accessibility dump: which window is in front, which Feishu
 * conversation is focused, and what the last few visible messages say.
 *
 * Everything here is a pure function over text, so it is unit-testable without
 * any macOS permission.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** App names that only mean "Feishu is open", not "a conversation is open". */
const GENERIC_FEISHU_TITLES = new Set([
  'feishu',
  'lark',
  '飞书',
  '飞书文档',
  'feishu docs',
  'lark docs',
  'feishu open platform',
])

const TRUNCATION_MARKER = 'Accessibility tree truncated'

export interface PresenceApp {
  /** Frontmost application name as reported by System Events. */
  app: string | null
  /** True when the frontmost app is Feishu/Lark. */
  isFeishu: boolean
  /** Set when the probe itself failed (for example osascript was denied). */
  error?: string
}

export interface FocusCandidate {
  source: 'window-title' | 'selected-node' | 'focused-node'
  role: string
  label: string
}

export interface FeishuFocus {
  /** True when the dump contained any node that looks like a Feishu window. */
  detected: boolean
  /** Raw window titles found in the dump, most specific first. */
  windowTitles: string[]
  /** The focused conversation, if one could be identified. */
  chat: {
    name: string | null
    kind: 'group' | 'direct' | 'unknown'
    unread: number | null
  }
  /** The most recent visible message text, oldest first. */
  recentText: string[]
  /** Which nodes the chat name was taken from, best first. */
  candidates: FocusCandidate[]
  /** The provider capped the tree; a narrower window read is needed. */
  truncated: boolean
}

interface AxNode {
  depth: number
  role: string
  title: string | null
  value: string | null
  selected: boolean
  focused: boolean
}

const LINE = /^( *)- (?:\[(\d+)\] )?(\S+)(.*)$/
const QUOTED = /"((?:[^"\\]|\\.)*)"/
const VALUE = / = "((?:[^"\\]|\\.)*)"/g

function unescape(text: string): string {
  return text.replace(/\\(.)/g, '$1')
}

/** Parse the AX text format produced by `AXTextFormatter.swift`. */
export function parseAxTree(text: string): AxNode[] {
  const nodes: AxNode[] = []
  for (const raw of text.split('\n')) {
    const match = LINE.exec(raw)
    if (!match) continue
    const [, indent = '', , role = '', rest = ''] = match
    const title = QUOTED.exec(rest)
    let value: string | null = null
    for (const found of rest.matchAll(VALUE)) value = unescape(found[1] ?? '')
    nodes.push({
      depth: Math.floor(indent.length / 2),
      role,
      title: title ? unescape(title[1] ?? '') : null,
      value,
      selected: /(^|\s)selected(\s|$)/.test(rest),
      focused: /(^|\s)focused(\s|$)/.test(rest),
    })
  }
  return nodes
}

function isGeneric(title: string): boolean {
  return GENERIC_FEISHU_TITLES.has(title.trim().toLowerCase())
}

/** A persisted message region ends with the newest visible message. */
function recentStaticTexts(nodes: AxNode[], limit: number): string[] {
  const texts: string[] = []
  for (const node of nodes) {
    if (node.role !== 'AXStaticText') continue
    const text = node.title?.trim() ?? ''
    if (!text) continue
    if (isGeneric(text)) continue
    texts.push(text)
  }
  return texts.slice(-limit)
}

export function parseFeishuFocus(text: string, options: { recentLimit?: number } = {}): FeishuFocus {
  const nodes = parseAxTree(text)
  const truncated = text.includes(TRUNCATION_MARKER)

  const windowTitles = nodes
    .filter((node) => node.role.startsWith('AXWindow') && node.title)
    .map((node) => node.title as string)

  const candidates: FocusCandidate[] = []
  const specificWindow = windowTitles.find((title) => !isGeneric(title))
  if (specificWindow) candidates.push({ source: 'window-title', role: 'AXWindow', label: specificWindow })

  for (const node of nodes) {
    if (!node.selected || !node.title?.trim()) continue
    if (isGeneric(node.title)) continue
    candidates.push({ source: 'selected-node', role: node.role, label: node.title.trim() })
  }

  for (const node of nodes) {
    if (!node.focused || !node.title?.trim()) continue
    if (isGeneric(node.title)) continue
    candidates.push({ source: 'focused-node', role: node.role, label: node.title.trim() })
  }

  const name = candidates[0]?.label ?? null
  const unread = (() => {
    for (const node of nodes) {
      if (!node.selected) continue
      const count = Number.parseInt(node.value ?? '', 10)
      if (Number.isFinite(count)) return count
    }
    return null
  })()

  const detected = windowTitles.length > 0 || candidates.length > 0

  return {
    detected,
    windowTitles,
    chat: {
      name,
      kind: name ? (/[(（]\d+[)）]\s*$|\d+\s*人/.test(name) ? 'group' : 'unknown') : 'unknown',
      unread,
    },
    recentText: recentStaticTexts(nodes, options.recentLimit ?? 20),
    candidates,
    truncated,
  }
}

/** Which app currently has keyboard focus. Needs no macOS permission. */
/**
 * pid of the frontmost application, used to pick the right window when several
 * Feishu clients (official Lark + a company build) are running at once.
 */
export async function frontmostPid(): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'osascript',
      ['-e', 'tell application "System Events" to get unix id of first process whose frontmost is true'],
      { timeout: 5000 },
    )
    const pid = Number(stdout.trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

export async function frontmostApp(): Promise<PresenceApp> {
  try {
    const { stdout } = await execFileAsync(
      'osascript',
      ['-e', 'tell application "System Events" to get name of first process whose frontmost is true'],
      { timeout: 5000 },
    )
    const app = stdout.trim()
    // Company builds report their own display name (for example 小米办公Pro),
    // so match those too instead of only the official Lark/Feishu names.
    return { app: app || null, isFeishu: /lark|feishu|飞书|小米办公|saxmsa/i.test(app) }
  } catch (error) {
    return { app: null, isFeishu: false, error: (error as Error).message }
  }
}
