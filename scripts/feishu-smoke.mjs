#!/usr/bin/env node
/**
 * Real-tenant Feishu smoke. Requires a user access token (from the OAuth flow
 * or a short-lived manual token) and, optionally, a document id and chat id.
 *
 *   FEISHU_USER_ACCESS_TOKEN=u-... \
 *   FEISHU_SMOKE_DOC_ID=doxcn... \
 *   FEISHU_SMOKE_CHAT_ID=oc_... \
 *   node scripts/feishu-smoke.mjs
 */

import { FeishuHttpClient } from '../packages/host-feishu/lib/client.js'

const token = process.env.FEISHU_USER_ACCESS_TOKEN?.trim()
if (!token) {
  console.error('FEISHU_USER_ACCESS_TOKEN is required')
  process.exit(2)
}

const client = new FeishuHttpClient({
  accessToken: async () => token,
  ...(process.env.FEISHU_OPEN_API_BASE ? { baseUrl: process.env.FEISHU_OPEN_API_BASE } : {}),
})

try {
  const me = await client.whoami()
  console.log(`whoami: ${me.name} open_id=${me.openId} tenant=${me.tenantKey ?? '-'}`)

  const documentId = process.env.FEISHU_SMOKE_DOC_ID?.trim()
  if (documentId) {
    const doc = await client.readDocument({ documentId })
    console.log(`doc ${documentId}: ${doc.content.length} chars`)
    console.log(doc.content.slice(0, 200).replace(/\s+/g, ' '))
  }

  const chatId = process.env.FEISHU_SMOKE_CHAT_ID?.trim()
  if (chatId) {
    const sent = await client.sendMessage({
      receiveId: chatId,
      receiveIdType: 'chat_id',
      msgType: 'text',
      content: JSON.stringify({ text: 'DSH Work smoke: connection OK' }),
    })
    console.log(`message: ${sent.messageId}`)
  }

  console.log('smoke OK')
} catch (error) {
  console.error(`smoke failed: ${error?.code ?? 'unknown'} ${error?.message ?? error}`)
  if (error?.logId) console.error(`log_id: ${error.logId}`)
  process.exit(1)
}
