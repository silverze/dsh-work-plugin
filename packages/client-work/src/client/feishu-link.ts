/** Parse a Feishu docx/sheets link into a token target. */

export type FeishuTarget =
  | { kind: 'docx'; token: string }
  | { kind: 'sheet'; token: string }
  | { kind: 'wiki'; token: string }

export function parseFeishuLink(input: string): FeishuTarget | undefined {
  const value = input.trim()
  if (!value) return undefined

  const prefixed = /^(docx|sheet|sheets|wiki):([A-Za-z0-9]+)$/.exec(value)
  if (prefixed?.[2]) {
    if (prefixed[1] === 'docx') return { kind: 'docx', token: prefixed[2] }
    if (prefixed[1] === 'wiki') return { kind: 'wiki', token: prefixed[2] }
    return { kind: 'sheet', token: prefixed[2] }
  }

  try {
    const url = new URL(value)
    if (!/(^|\.)feishu\.cn$|(^|\.)larksuite\.com$/.test(url.hostname)) return undefined
    const docx = /\/docx\/([A-Za-z0-9]+)/.exec(url.pathname)
    if (docx?.[1]) return { kind: 'docx', token: docx[1] }
    const sheets = /\/sheets\/([A-Za-z0-9]+)/.exec(url.pathname)
    if (sheets?.[1]) return { kind: 'sheet', token: sheets[1] }
    const wiki = /\/wiki\/([A-Za-z0-9]+)/.exec(url.pathname)
    if (wiki?.[1]) return { kind: 'wiki', token: wiki[1] }
  } catch {
    return undefined
  }
  return undefined
}
