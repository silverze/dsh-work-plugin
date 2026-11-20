import test from 'node:test'
import assert from 'node:assert/strict'

import {
  WorkbenchController,
  shouldAutoAttach,
  shouldReleaseDraft,
} from '../../packages/client-work/lib/client.node.mjs'

/** Minimal `ctx.sessions` face: one list snapshot, no subscriptions needed. */
function sessionsCtx(byId) {
  return {
    get(name) {
      if (name !== 'sessions') return undefined
      return {
        list: {
          getSnapshot: () => ({ ids: Object.keys(byId), byId }),
          subscribe: () => () => {},
        },
      }
    },
  }
}

test('a session attaches its task exactly when it carries the work preset', () => {
  assert.equal(shouldAutoAttach('work', false), true)
  assert.equal(shouldAutoAttach('work', true), false)
  assert.equal(shouldAutoAttach('standard', false), false)
  assert.equal(shouldAutoAttach(undefined, false), false)
  assert.equal(shouldAutoAttach(null, false), false)
  assert.equal(shouldAutoAttach('ptc', false), false)
})

test('a draft task is released only when the session left the work preset', () => {
  const presetDraft = { origin: 'preset', status: 'draft' }
  const presetRunning = { origin: 'preset', status: 'running' }
  const manualDraft = { origin: 'manual', status: 'draft' }
  const legacyPlaceholder = { status: 'draft', title: '工作任务', goal: '待补充目标' }
  const legacyNamed = { status: 'draft', title: '周报', goal: '生成周报' }
  assert.equal(shouldReleaseDraft('standard', presetDraft), true)
  assert.equal(shouldReleaseDraft('ptc', presetDraft), true)
  assert.equal(shouldReleaseDraft(undefined, presetDraft), true)
  assert.equal(shouldReleaseDraft('work', presetDraft), false)
  assert.equal(shouldReleaseDraft('standard', presetRunning), false)
  assert.equal(shouldReleaseDraft('standard', manualDraft), false)
  assert.equal(shouldReleaseDraft('standard', legacyPlaceholder), true)
  assert.equal(shouldReleaseDraft('standard', legacyNamed), false)
  assert.equal(shouldReleaseDraft('standard', undefined), false)
})

test('the controller reads a session preset from the session-list projection', () => {
  const controller = new WorkbenchController(
    sessionsCtx({
      s1: { projectionValues: { agentPreset: 'work' } },
      s2: { projectionValues: { agentPreset: 'standard' } },
      s3: {},
      s4: { projectionValues: { agentPreset: null } },
    }),
  )
  assert.equal(controller.sessionPreset('s1'), 'work')
  assert.equal(controller.sessionPreset('s2'), 'standard')
  assert.equal(controller.sessionPreset('s3'), undefined)
  // A listed row that records no preset is `null` (unknown), not "no preset".
  assert.equal(controller.sessionPreset('s4'), null)
  assert.equal(controller.sessionPreset('missing'), undefined)
})

test('subagent sessions never become work surfaces of their own', () => {
  const controller = new WorkbenchController(
    sessionsCtx({
      root: { projectionValues: { agentPreset: 'work' } },
      child: { parentId: 'root', projectionValues: { agentPreset: 'work' } },
      spawn: { origin: 'subagent', projectionValues: { agentPreset: 'work' } },
    }),
  )
  assert.equal(controller.isSubagentSession('root'), false)
  assert.equal(controller.isSubagentSession('child'), true)
  assert.equal(controller.isSubagentSession('spawn'), true)
})

test('a client without the sessions service degrades to no preset sync', () => {
  const controller = new WorkbenchController({ get: () => undefined })
  assert.equal(controller.sessionPreset('s1'), undefined)
  assert.equal(controller.isSubagentSession('s1'), false)
  assert.equal(typeof controller.subscribeSessions(() => {}), 'function')
})

test('the controller releases exactly the drafts shouldReleaseDraft accepts', async () => {
  const detached = []
  const byId = {
    legacy: { projectionValues: { agentPreset: 'standard' } },
    manual: { projectionValues: { agentPreset: 'standard' } },
    preset: { projectionValues: { agentPreset: 'standard' } },
    stayed: { projectionValues: { agentPreset: 'work' } },
  }
  const ctx = {
    get(name) {
      if (name === 'sessions') {
        return {
          list: { getSnapshot: () => ({ byId }), subscribe: () => () => {} },
        }
      }
      if (name !== 'connection') return undefined
      return {
        rpc: {
          async call(_channel, endpoint, payload) {
            if (endpoint === 'work/taskList') {
              return {
                ok: true,
                value: [
                  { id: 'legacy', title: '工作任务', goal: '待补充目标', status: 'draft' },
                  { id: 'manual', title: '工作任务', goal: '待补充目标', status: 'draft', origin: 'manual' },
                  { id: 'preset', title: '工作任务', goal: '待补充目标', status: 'draft', origin: 'preset' },
                  { id: 'stayed', title: '工作任务', goal: '待补充目标', status: 'draft', origin: 'preset' },
                  { id: 'unlisted', title: '工作任务', goal: '待补充目标', status: 'draft' },
                ],
              }
            }
            if (endpoint === 'work/detachSession') {
              detached.push(payload.args.request.sessionId)
              return { ok: true, value: { detached: true } }
            }
            return { ok: false, error: { code: 'unexpected', message: endpoint } }
          },
        },
      }
    },
  }
  const controller = new WorkbenchController(ctx)
  await controller.refreshIndex()

  for (const id of ['legacy', 'manual', 'preset', 'stayed', 'unlisted']) {
    await controller.releasePresetTask(id)
  }

  // `unlisted` has a legacy placeholder but no session row yet: the unknown
  // preset must not take the draft away.
  assert.deepEqual(detached.sort(), ['legacy', 'preset'])
})
