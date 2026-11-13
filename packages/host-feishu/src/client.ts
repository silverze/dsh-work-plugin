/**
 * Narrow Feishu client contract used by the model-facing tools. The W3
 * implementation wraps `@larksuiteoapi/node-sdk` and owns token refresh,
 * rate limiting, idempotency and audit logging.
 */

export interface FeishuIdentity {
  openId: string
  unionId?: string
  name: string
  avatarUrl?: string
  tenantKey?: string
}

export interface FeishuDoc {
  documentId: string
  title?: string
  url?: string
  /** Plain-text projection used for model context. */
  content: string
  revision?: number
}

export interface FeishuDocBlock {
  blockId: string
  blockType: number
  text?: string
}

export interface FeishuSheetMeta {
  spreadsheetToken: string
  sheets: Array<{ sheetId: string; title: string; rowCount: number; columnCount: number }>
}

export interface FeishuRangeValues {
  range: string
  values: unknown[][]
}

export interface FeishuUploadResult {
  fileToken: string
  url?: string
}

export interface FeishuImportResult {
  ticket: string
  url?: string
  status: 'pending' | 'done' | 'failed'
}

export interface FeishuMessageResult {
  messageId: string
}

export interface FeishuClient {
  whoami(): Promise<FeishuIdentity>

  readDocument(input: { documentId: string }): Promise<FeishuDoc>
  createDocument(input: { title: string; folderToken?: string }): Promise<FeishuDoc>
  appendDocument(input: {
    documentId: string
    markdown: string
    blockId?: string
    idempotencyKey?: string
  }): Promise<{ appended: number; failed: number; documentId: string }>
  updateDocumentBlock(input: {
    documentId: string
    blockId: string
    markdown: string
    idempotencyKey?: string
  }): Promise<{ documentId: string; blockId: string }>

  readSheet(input: { spreadsheetToken: string; range?: string }): Promise<FeishuSheetMeta | FeishuRangeValues>
  writeSheet(input: {
    spreadsheetToken: string
    range: string
    values: unknown[][]
    idempotencyKey?: string
  }): Promise<{ updatedCells: number }>
  appendSheet(input: {
    spreadsheetToken: string
    range: string
    values: unknown[][]
    idempotencyKey?: string
  }): Promise<{ updatedCells: number }>

  uploadFile(input: {
    filePath: string
    fileName: string
    folderToken?: string
    idempotencyKey?: string
  }): Promise<FeishuUploadResult>
  importDocument(input: {
    filePath: string
    fileName: string
    fileExtension: 'docx' | 'xlsx' | 'pptx'
    folderToken?: string
    idempotencyKey?: string
  }): Promise<FeishuImportResult>

  sendMessage(input: {
    receiveId: string
    receiveIdType: 'open_id' | 'chat_id'
    msgType: 'text' | 'interactive'
    content: string
    idempotencyKey?: string
  }): Promise<FeishuMessageResult>
}
