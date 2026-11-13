/**
 * Minimal authenticated RPC helper for the workbench.
 *
 * The Host exposes `work/*` and `feishu/*` through Typert source-mode
 * descriptors; the browser reaches them on the Connection's `/api` channel.
 * This avoids generating a client descriptor bundle for every Host service.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'

export async function callRemote<T>(
  ctx: ClientContext,
  endpoint: string,
  args: Record<string, unknown> = {},
  timeoutMs = 60_000,
): Promise<T> {
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  const rpc = connection?.rpc
  if (!rpc) throw new Error('DSH connection RPC is unavailable')

  const result = await rpc.call(
    '/api',
    endpoint,
    {
      args:
        endpoint.startsWith('work/') || ['feishu/shareArtifact', 'feishu/configureApp', 'feishu/wikiResolve', 'feishu/docRead', 'feishu/sheetRead'].includes(endpoint)
          ? { request: args }
          : args,
    },
    AbortSignal.timeout(timeoutMs),
  )
  if (!result.ok) {
    throw new Error(`${endpoint}: ${result.error.message || result.error.code}`)
  }
  return result.value as T
}
