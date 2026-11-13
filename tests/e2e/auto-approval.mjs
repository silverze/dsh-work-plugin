/** E2E-only: auto-allow approvals in a disposable profile. Never ship. */
export const name = 'acme-e2e-auto-approval'

export function apply(ctx) {
  ctx.on('approval/request', async () => 'allowed-once')
}
