/**
 * Local screen reading for DSH Work.
 *
 * Feishu is a Chromium app whose web content is nearly invisible to the
 * accessibility tree (see presence.ts, which needs a 26+ level dump costing
 * tens of thousands of tokens). Screen Recording + Apple's Vision OCR reads the
 * same window in about a second for a few hundred tokens instead, so that is
 * the default path; the accessibility parser stays as a fallback.
 *
 * The Swift helper is compiled once with `swiftc -O` into the user cache
 * directory and reused afterwards. Compilation only needs the Command Line
 * Tools, not a full Xcode install.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ScreenLine {
  text: string
  x: number
  y: number
  w: number
  h: number
}

export interface ScreenCapture {
  pid: number
  windowNumber: number
  /** False when the window exists but sits on another desktop / is minimized. */
  onScreen?: boolean
  bounds: { x: number; y: number; width: number; height: number }
  imageWidth: number
  imageHeight: number
  lines: ScreenLine[]
}

export interface FeishuScreenFocus {
  detected: boolean
  chatName?: string
  chatKind: 'group' | 'direct' | 'unknown'
  /** Visible message lines of the focused conversation, oldest first. */
  messages: string[]
  /** Conversation names visible in the left list, used to spot the focused one. */
  otherChats: string[]
  window?: { width: number; height: number; windowNumber: number }
  error?: string
}

const MAC_ONLY = 'screen reading requires macOS'

/** Lower bound for a composer-derived pane edge, so noise cannot collapse it. */
const PANE_LEFT_MIN = 0.18
/**
 * The chat list is a fixed width in points, so its right edge is not a fixed
 * fraction of the window: in a 1920px window it ends near 0.24, where a 0.30
 * cut would already eat the conversation title. Nothing left of this belongs to
 * the open conversation.
 */
const LIST_EDGE_MIN = 0.24
/** Chat title band at the top of the conversation pane. */
const TITLE_MAX_Y = 0.09

/**
 * Toolbar glyphs and stray ASCII chips ("0o", "Aa©", "CC") that OCR picks up
 * near the window controls and composer. None of them can be a chat name.
 */
const GLYPH_NOISE = /^[A-Za-z0-9©®™·•\s.,:;!?/\\|+=~^_-]{1,3}$/

/**
 * OCR reads sticker/emoji glyphs as a few Latin letters with a symbol (real
 * example: `Aaeo%`). Those are not messages, while IDs (`ST26176346`) and any
 * CJK text are real content and must survive.
 */
function looksLikeGlyphFragment(text: string): boolean {
  if (text.length > 8) return false
  if (/[\u3400-\u9fff]/.test(text)) return false
  if (/\d{4,}/.test(text)) return false
  if (/\s/.test(text)) return false
  return /[^\p{L}\p{N}]/u.test(text)
}

/** A plausible conversation title: CJK text, or a word of four or more letters. */
export function plausibleChatName(text: string): boolean {
  const value = text.trim()
  if (value.length < 2) return false
  if (GLYPH_NOISE.test(value)) return false
  if (/[\u3400-\u9fff]/.test(value)) return true
  return value.length >= 4 && /[A-Za-z]/.test(value)
}

/**
 * The conversation title is the tallest text in the top band (its font is
 * larger than the tab strip); y then width break ties. Corner glyphs are
 * rejected before ranking, so a window with no readable title returns nothing
 * instead of naming the chat after the nearest stray symbol.
 */
function pickChatTitle(headerLines: ScreenLine[]): ScreenLine | undefined {
  const candidates = headerLines.filter(
    (line) => line.x >= LIST_EDGE_MIN && plausibleChatName(line.text),
  )
  if (candidates.length === 0) return undefined
  // The title is rendered at a larger size than the tab labels beside it. When
  // every plausible line in the band is the same size, no enlarged title was
  // read: say so instead of promoting a tab label to the chat name.
  const smallest = Math.min(...candidates.map((line) => line.h))
  const ranked =
    candidates.length === 1 ? candidates : candidates.filter((line) => line.h > smallest)
  if (ranked.length === 0) return undefined
  return [...ranked].sort((a, b) => b.h - a.h || a.y - b.y || b.w - a.w)[0]
}

const TIME_LINE =
  /^(?:\d{1,2}:\d{2}(?:\s*[-–~]\s*\d{1,2}:\d{2})?|昨天|前天|今天|星期[一二三四五六日天]|\d{1,2}月\d{1,2}日|上午|下午)$/
const COMPOSER_LINE = /^发送给\s*(.+?)\s*$/

function runFile(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stderr: String(stderr || '') }))
          return
        }
        resolve({ stdout: String(stdout), stderr: String(stderr || '') })
      },
    )
  })
}

export function ocrSourcePath(): string {
  return fileURLToPath(new URL('../native/screen-ocr.swift', import.meta.url))
}

export function ocrBinaryPath(): string {
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'DSH Work', 'bin')
      : join(homedir(), '.dsh', 'work', 'bin')
  return join(base, 'screen-ocr')
}

let buildPromise: Promise<string> | undefined

/**
 * Compile the helper on first use and reuse it while the Swift source is
 * unchanged. Concurrent callers share one compilation.
 */
export function ensureOcrBinary(): Promise<string> {
  if (process.platform !== 'darwin') return Promise.reject(new Error(MAC_ONLY))
  buildPromise ??= buildOcrBinary().catch((error: unknown) => {
    buildPromise = undefined
    throw error
  })
  return buildPromise
}

async function buildOcrBinary(): Promise<string> {
  const source = ocrSourcePath()
  const binary = ocrBinaryPath()
  if (!existsSync(source)) {
    throw new Error(`screen OCR helper is missing from the package: ${source}`)
  }
  if (existsSync(binary)) {
    const [sourceInfo, binaryInfo] = await Promise.all([stat(source), stat(binary)])
    if (binaryInfo.mtimeMs >= sourceInfo.mtimeMs && binaryInfo.size > 0) return binary
  }
  await mkdir(join(binary, '..'), { recursive: true })
  const staging = `${binary}.${process.pid}.tmp`
  try {
    await runFile(
      '/usr/bin/xcrun',
      ['swiftc', '-O', source, '-o', staging],
      180_000,
    )
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim()
    throw new Error(
      `failed to build the screen OCR helper with swiftc${
        detail ? `: ${detail}` : ''
      }. Install the Xcode Command Line Tools (\`xcode-select --install\`) and retry.`,
    )
  }
  await chmod(staging, 0o755)
  await rename(staging, binary)
  return binary
}

export function describeCaptureFailure(message: string): string {
  if (/not on the current desktop/i.test(message)) {
    return 'Feishu is running but its window is not on the current desktop (minimized or another Space). Ask the user to bring Feishu to the front and retry.'
  }
  if (/Screen Recording/i.test(message)) {
    return 'Screen Recording permission is missing: enable it for DeepSeek Harness in System Settings > Privacy & Security > Screen Recording.'
  }
  return message
}

export async function captureApp(
  pid: number,
  windowNumber?: number,
): Promise<ScreenCapture> {
  const binary = await ensureOcrBinary()
  const args = [String(pid)]
  if (typeof windowNumber === 'number' && Number.isInteger(windowNumber)) {
    args.push(String(windowNumber))
  }
  const { stdout } = await runFile(binary, args, 30_000)
  const parsed = JSON.parse(stdout) as ScreenCapture
  if (!Array.isArray(parsed.lines)) throw new Error('screen OCR helper returned no lines')
  return parsed
}

/**
 * The application that currently has keyboard focus, read through the native
 * helper so a poll costs a few milliseconds instead of an AppleScript launch.
 * Returns -1 when the helper cannot report it.
 */
export async function frontmostNativePid(): Promise<number> {
  const binary = await ensureOcrBinary()
  const { stdout } = await runFile(binary, ['--frontmost'], 5_000)
  const parsed = JSON.parse(stdout) as { pid?: number }
  return typeof parsed.pid === 'number' ? parsed.pid : -1
}

export interface WindowCandidate {
  pid: number
  windowNumber: number
  owner: string
  title: string
  width: number
  height: number
  /** Only present for windows matched by `--list`; always true there. */
  onScreen?: boolean
}

export async function listWindows(): Promise<WindowCandidate[]> {
  const binary = await ensureOcrBinary()
  const { stdout } = await runFile(binary, ['--list'], 20_000)
  return JSON.parse(stdout) as WindowCandidate[]
}

/** Process names that host a Feishu client, most specific first. */
/** Main process names of a Feishu client (custom/company builds included). */
const FEISHU_MAIN = /^(?:MiWorkSaaS|saxmsa667|Feishu|Lark|LarkInternational)$/i
/** Child processes that never own the conversation window even if they render one. */
const FEISHU_HELPER =
  /Helper|Crashpad|Renderer|GPU|Plugins?|Electron|Network Service|Notification|Service|Updater/i

export interface PsEntry {
  pid: number
  ppid: number
  command: string
}

export function parsePsEntries(psOutput: string): PsEntry[] {
  const entries: PsEntry[] = []
  for (const raw of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(raw)
    if (!match) continue
    entries.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? '' })
  }
  return entries
}

/**
 * Candidate Feishu pids, company/internal builds first.
 *
 * Several Feishu bundles usually run at once on a work Mac (official Lark plus a
 * company build such as 小米办公Pro), so the pid cannot be chosen by app name
 * alone. Windows may also be owned by a child process rather than the main one,
 * hence the ancestor check: a process counts as Feishu when its own name matches
 * or when a parent main process inside a Feishu .app bundle owns it.
 */
export function parseFeishuPids(psOutput: string): number[] {
  const entries = parsePsEntries(psOutput)
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]))
  const found: { pid: number; priority: number }[] = []
  for (const entry of entries) {
    const name = entry.command.slice(entry.command.lastIndexOf('/') + 1)
    if (FEISHU_HELPER.test(name)) continue
    if (FEISHU_MAIN.test(name)) {
      const company = /^(MiWorkSaaS|saxmsa667)$/i.test(name)
      found.push({ pid: entry.pid, priority: company ? 0 : 1 })
      continue
    }
    let current: PsEntry | undefined = entry
    for (let hops = 0; hops < 4; hops += 1) {
      const parent = byPid.get(current?.ppid ?? 0)
      if (!parent) break
      const parentName = parent.command.slice(parent.command.lastIndexOf('/') + 1)
      if (FEISHU_MAIN.test(parentName) && /\.app\//.test(parent.command)) {
        found.push({ pid: entry.pid, priority: 2 })
        break
      }
      current = parent
    }
  }
  found.sort((a, b) => a.priority - b.priority || a.pid - b.pid)
  return [...new Set(found.map((entry) => entry.pid))]
}

export async function findFeishuPids(): Promise<number[]> {
  const { stdout } = await runFile('/bin/ps', ['-axo', 'pid=,ppid=,comm='], 10_000)
  return parseFeishuPids(stdout)
}

/**
 * Move the frontmost pid to the front: with both official Lark and a company
 * build open, the window the user is actually looking at should win.
 */
export function preferFrontmost(pids: number[], frontPid?: number): number[] {
  if (!frontPid || !pids.includes(frontPid)) return pids
  return [frontPid, ...pids.filter((pid) => pid !== frontPid)]
}

/**
 * Turn OCR lines of a Feishu window into the focused conversation.
 *
 * Layout facts this relies on (measured on Feishu macOS 2026 builds):
 * - left column: conversation list (name / preview / timestamp)
 * - right pane: the open conversation, its title in the top 9% band, the
 *   composer placeholder (`发送给 <name>`) at the bottom, messages between.
 * The pane edge is not a fixed fraction: the chat list can be dragged wider,
 * so it is derived from the composer's left edge instead.
 */
export function parseFeishuScreen(
  capture: Pick<ScreenCapture, 'lines' | 'imageWidth' | 'imageHeight' | 'windowNumber'>,
  options: { maxMessages?: number } = {},
): FeishuScreenFocus {
  const maxMessages = Math.max(1, Math.min(options.maxMessages ?? 20, 60))
  const lines = [...capture.lines].sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y))
  // The chat list is resizable, so the conversation pane does not start at a
  // fixed fraction of the window: in a maximized 1651px window it begins at
  // 0.30, where a fixed 0.36 cut would drop every title, bubble and the
  // composer. Anchor on the composer instead — it always sits at the pane's
  // left padding — and derive the pane edge from it.
  const composer = [...lines].reverse().find((line) => COMPOSER_LINE.test(line.text))
  const composerText = composer ? COMPOSER_LINE.exec(composer.text)?.[1]?.trim() : undefined
  // A half-recognized placeholder ("发送给 0o") must not name the chat either.
  const composerName = composerText && plausibleChatName(composerText) ? composerText : undefined
  const headerLines = lines.filter((line) => line.y <= TITLE_MAX_Y)
  const titleLine = pickChatTitle(headerLines)
  const titleName = titleLine ? titleLine.text.trim() : undefined

  // Both the title and the composer sit at the pane's left padding, so either
  // can anchor the pane edge. On a wide window the input box is inset far right
  // of the title, so the leftmost anchor wins: anchored on the composer alone,
  // the 1920px layout put the edge at 0.59 and dropped the title with it.
  const paneAnchors: number[] = []
  if (composer) paneAnchors.push(composer.x - 0.03)
  if (titleLine) paneAnchors.push(titleLine.x - 0.02)
  const paneLeft = Math.max(
    PANE_LEFT_MIN,
    paneAnchors.length > 0 ? Math.min(...paneAnchors) : LIST_EDGE_MIN,
  )
  const right = lines.filter((line) => line.x >= paneLeft)
  const left = lines.filter((line) => line.x < paneLeft)

  const paneHeader = headerLines.filter((line) => line.x >= paneLeft)
  const header = paneHeader.map((line) => line.text)
  // Only the title itself names the chat: any other plausible line in the band
  // is a tab label or the job-title subtitle, and naming a chat after those was
  // the "0o"-style failure with extra steps.
  const chatName = composerName || titleName || ''

  const titleBottom = composer ? composer.y : 1
  const messages = right
    .filter((line) => line.y > TITLE_MAX_Y && line.y < titleBottom)
    .map((line) => line.text.trim())
    .filter((text) => text.length > 0 && !TIME_LINE.test(text))
    // Stray glyphs ("◎", "•") carry no content.
    .filter((text) => /[A-Za-z0-9\u3400-\u9fff]/.test(text))
    // System notices sit in the message area but are not conversation content.
    .filter(
      (text) =>
        !/(撤回了一条消息|加入了群聊|将群名称改|拍了拍你|邀请你加入|了禁言|^群公告[:：]?$)/.test(text),
    )
    // Drop toolbar glyphs and stray ASCII chips ("Aa©", "CC") that OCR picks up
    // around the composer without carrying message content.
    .filter((text) => !/^[A-Za-z0-9©®™·•\s.,:;!?/\\|+=~^_-]{1,4}$/.test(text))
    .filter((text) => !looksLikeGlyphFragment(text))
    .slice(-maxMessages)

  // System notifications ("X 将群名称改成了…", "X 邀请你加入日程…") share the
  // left column with conversation names but are not conversations.
  const LEFT_NOISE = /将群名称|邀请你|分享[了]?(?:视频会议|文档|日程)|没有权限访问|加入了群聊|撤回了一条消息/
  const otherChats: string[] = []
  for (const line of left) {
    const text = line.text.trim()
    if (text.length < 2 || line.w < 0.08 || line.y <= 0.04) continue
    if (text.includes('：') || TIME_LINE.test(text) || LEFT_NOISE.test(text)) continue
    if (otherChats.includes(text)) continue
    otherChats.push(text)
  }

  // Telling a group from a direct chat from pixels alone is guesswork, so only
  // claim a kind on positive evidence and otherwise say 会话 (`unknown`).
  // `外部` is deliberately not a group marker: a direct chat with an external
  // contact prints it too, which used to label every such chat as a group.
  const paneText = [...right.map((line) => line.text), ...messages].join('\n')
  const headerText = header.join('\n')
  // Rows on the title's own line (tab strip, icon labels) must not count as the
  // subtitle that marks a direct chat; only lines below it do.
  const titleRowY = titleLine?.y ?? paneHeader[0]?.y ?? 0
  const headerSubtitle = paneHeader
    .filter((line) => line.y > titleRowY + 0.008)
    .map((line) => line.text)
    .join('\n')
  const GROUP_SIGNAL = /群公告|群成员|添加成员|邀请成员|群主[:：]|[(（]\d{1,5}\s*人[)）]|外部群|^\s*\d{1,5}\s*人\s*$/m
  const SUBTITLE_SIGNAL = /外部联系人|事业部|中心|工程师|经理|总监|主管|专员|助理|顾问|采购|销售|财务/
  // Direct chats are titled `Name（Nickname）`; groups usually end in 群/组.
  // The composer placeholder and the title band usually agree, so test both.
  const NICKNAME_TITLE = /[(（][A-Za-z][^)）]{0,24}[)）]\s*$/
  const nicknameTitle = NICKNAME_TITLE.test(chatName) || NICKNAME_TITLE.test(titleName ?? '')
  const chatKind: FeishuScreenFocus['chatKind'] = GROUP_SIGNAL.test(headerText)
    ? 'group'
    : /群$/.test(chatName) || /群$/.test(titleName ?? '')
      ? 'group'
      : nicknameTitle
        ? 'direct'
        : SUBTITLE_SIGNAL.test(headerSubtitle)
          ? 'direct'
          : GROUP_SIGNAL.test(paneText)
            ? 'group'
            : 'unknown'

  // A Feishu conversation window always names the chat (title band or composer
  // placeholder). Without a name this is some other app's window.
  if (!chatName) {
    return {
      detected: false,
      chatKind: 'unknown',
      messages: [],
      otherChats,
      error:
        'No Feishu conversation recognized. Make sure the Feishu window is on screen and Screen Recording permission is granted.',
    }
  }

  return {
    detected: true,
    chatName,
    chatKind,
    messages,
    otherChats: otherChats.slice(0, 12),
    window: {
      width: capture.imageWidth,
      height: capture.imageHeight,
      windowNumber: capture.windowNumber,
    },
  }
}

/** Plain text lines of an app window, top to bottom, for general screen reading. */
export function screenTextLines(
  capture: Pick<ScreenCapture, 'lines'>,
  limit = 150,
): string[] {
  return [...capture.lines]
    .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y))
    .map((line) => line.text.trim())
    .filter((text) => text.length > 0)
    .slice(0, limit)
}
