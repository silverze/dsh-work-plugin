/** Dev-only smoke plugin: verify source-mode Remote endpoints are claimable. */
import { writeFileSync } from 'node:fs'

export const name = 'acme-smoke-remote'
export const inject = ['typertGateway', 'workTasks']

export async function apply(ctx) {
  const marker = process.env.DSH_WORK_REMOTE_MARKER
  if (!marker) return
  const gateway = ctx.typertGateway
  const endpoints = [
    'work/taskCreate',
    'work/taskList',
    'work/taskGet',
    'work/artifactList',
    'work/artifactScan',
    'work/schedule',
    'feishu/status',
    'feishu/startAuth',
    'feishu/disconnect',
  ]
  setTimeout(() => {
    const lines = endpoints.map((endpoint) => `${endpoint}=${gateway.claimsEndpoint(endpoint)}`)
    writeFileSync(marker, lines.join('\n') + '\n', 'utf8')
  }, 2000)
}
