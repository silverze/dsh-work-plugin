/**
 * Which OAuth scope each Feishu tool needs.
 *
 * `feishu_auth_status` compares the granted scope list against this table so a
 * missing scope surfaces before the first failing call, not after it.
 */

/** Tool name → scopes the Feishu API requires for it. */
const TOOL_SCOPES: Record<string, string[]> = {
  feishu_whoami: ['contact:user.base:readonly'],
  feishu_wiki_get: ['wiki:wiki'],
  feishu_doc_read: ['docx:document'],
  feishu_doc_create: ['docx:document'],
  feishu_doc_append: ['docx:document'],
  feishu_sheet_read: ['sheets:spreadsheet'],
  feishu_sheet_write: ['sheets:spreadsheet'],
  feishu_sheet_append: ['sheets:spreadsheet'],
  feishu_drive_upload: ['drive:drive'],
  feishu_im_send: ['im:message:send_as_bot'],
  feishu_im_history: ['im:message'],
  feishu_share_artifact: ['drive:drive', 'docx:document', 'im:message:send_as_bot'],
  feishu_task_create: ['task:task:write'],
  feishu_task_complete: ['task:task:write'],
  feishu_task_list_mine: ['task:task:read'],
  feishu_minutes_get: ['minutes:minutes:readonly'],
  feishu_calendar_agenda: ['calendar:calendar:read'],
}

/** "docx:document sheets:spreadsheet" → ["docx:document", "sheets:spreadsheet"]. */
export function grantedScopes(scope?: string | null): string[] {
  return (scope ?? '')
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
}

/**
 * A granted scope covers a required one when it is the same scope or a parent
 * of it (`im:message` covers `im:message:send_as_bot`).
 */
function covers(granted: string, required: string): boolean {
  return required === granted || required.startsWith(`${granted}:`)
}

/** Tools that need a scope the grant does not carry. */
export function missingScopes(granted: string[]): Array<{ tool: string; scopes: string[] }> {
  const gaps: Array<{ tool: string; scopes: string[] }> = []
  for (const [tool, required] of Object.entries(TOOL_SCOPES)) {
    const missing = required.filter((scope) => !granted.some((value) => covers(value, scope)))
    if (missing.length > 0) gaps.push({ tool, scopes: missing })
  }
  return gaps
}
