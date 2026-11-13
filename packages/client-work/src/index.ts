/**
 * Host half of the client-work package. DSH serves the `./client` export as a
 * browser bundle; this half only needs to exist so the package is a valid
 * client plugin row. W1 may move server-side data shaping here.
 */

export const name = 'dsh-work-client'

export function apply(_ctx: unknown): void {
  // Intentionally empty. The browser half is in `./client`.
}
