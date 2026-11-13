/**
 * Feishu error vocabulary. Tools return these codes to the model/UI; the UI
 * maps them to actionable guidance. Never fall back to a tenant token when a
 * user token lacks permission.
 */

export type FeishuErrorCode =
  | 'feishu_not_connected'
  | 'feishu_auth_port_busy'
  | 'feishu_token_expired'
  | 'feishu_permission_denied'
  | 'feishu_rate_limited'
  | 'feishu_invalid_argument'
  | 'feishu_not_found'
  | 'feishu_scope_unavailable'
  | 'feishu_conflict'
  | 'feishu_unavailable'
  | 'feishu_unknown'

export interface FeishuErrorInput {
  status?: number
  code?: number | string
  message: string
  logId?: string
  retryable?: boolean
}

export class FeishuError extends Error {
  readonly code: FeishuErrorCode
  readonly status?: number
  readonly feishuCode?: number | string
  readonly logId?: string
  readonly retryable: boolean

  constructor(code: FeishuErrorCode, message: string, input: Omit<FeishuErrorInput, 'code' | 'message'> & { retryable?: boolean } = {}) {
    super(message)
    this.name = 'FeishuError'
    this.code = code
    this.status = input.status
    this.logId = input.logId
    this.retryable = input.retryable ?? (code === 'feishu_rate_limited' || code === 'feishu_unavailable')
  }
}

/**
 * Map an HTTP status + Feishu business code to our vocabulary.
 * 401/403 are never retried; 429/5xx are retryable with backoff.
 */
export function mapFeishuError(input: FeishuErrorInput): FeishuError {
  const status = input.status
  const message = input.message || 'Feishu request failed'

  if (status === 401) {
    return new FeishuError('feishu_token_expired', message, { ...input, retryable: false })
  }
  if (status === 403) {
    return new FeishuError('feishu_permission_denied', message, { ...input, retryable: false })
  }
  if (status === 404) {
    return new FeishuError('feishu_not_found', message, { ...input, retryable: false })
  }
  if (status === 409) {
    return new FeishuError('feishu_conflict', message, { ...input, retryable: false })
  }
  if (status === 429) {
    return new FeishuError('feishu_rate_limited', message, { ...input, retryable: true })
  }
  if (status !== undefined && status >= 500) {
    return new FeishuError('feishu_unavailable', message, { ...input, retryable: true })
  }
  if (status === 400) {
    return new FeishuError('feishu_invalid_argument', message, { ...input, retryable: false })
  }
  return new FeishuError('feishu_unknown', message, { ...input, retryable: input.retryable ?? false })
}
