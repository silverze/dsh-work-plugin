import test from 'node:test'
import assert from 'node:assert/strict'

import { WORK_PARTNERS, composeTaskGoal } from '../../packages/client-work/lib/client.node.mjs'

test('three built-in partners are available', () => {
  assert.deepEqual(WORK_PARTNERS.map((partner) => partner.id), ['researcher', 'analyst', 'presenter'])
  for (const partner of WORK_PARTNERS) assert.ok(partner.prompt.length > 20)
})

test('composeTaskGoal prefixes the partner prompt and trims the goal', () => {
  const composed = composeTaskGoal('researcher', '  调研 AI 芯片市场  ')
  assert.match(composed, /资深行业研究员/)
  assert.match(composed, /任务目标：调研 AI 芯片市场$/)
})

test('no partner leaves the goal unchanged except trimming', () => {
  assert.equal(composeTaskGoal(undefined, '  做一份周报  '), '做一份周报')
  assert.equal(composeTaskGoal('missing', '  x  '), 'x')
})
