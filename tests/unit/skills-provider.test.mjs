import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from '../../packages/skills-work/index.js'

test('skills provider exposes the Cordis plugin contract', () => {
  assert.equal(name, 'work-skills')
  assert.deepEqual(inject, ['skills'])
  assert.equal(typeof apply, 'function')
})

test('apply registers one bundled provider listing every bundled skill', async () => {
  const registrations = []
  apply({
    skills: {
      registerProvider(factory) {
        registrations.push(factory())
      },
    },
  })
  assert.equal(registrations.length, 1)
  const provider = registrations[0]
  assert.equal(provider.name, 'work-skills')
  assert.equal(typeof provider.list, 'function')
  assert.equal(typeof provider.get, 'function')

  const candidates = await provider.list()
  assert.deepEqual(
    candidates.map((candidate) => candidate.name).sort(),
    [
      'work-data-analysis',
      'work-deck',
      'work-doc-polish',
      'work-meeting-minutes',
      'work-research',
      'work-screen-awareness',
      'work-weekly-report',
    ],
  )
  for (const candidate of candidates) {
    assert.equal(candidate.provider, 'work-skills')
    assert.equal(candidate.source, 'bundled')
    assert.ok(candidate.description.length > 0, `${candidate.name} needs a description`)
    assert.equal(candidate.invocation.modelInvocable, true)
    assert.equal(candidate.invocation.userInvocable, true)
    assert.ok(candidate.locator.href.endsWith('/SKILL.md'))
  }
})

test('get returns the full SKILL.md body for a candidate', async () => {
  const registrations = []
  apply({
    skills: {
      registerProvider(factory) {
        registrations.push(factory())
      },
    },
  })
  const provider = registrations[0]
  const [candidate] = await provider.list()
  const definition = await provider.get(candidate)
  assert.equal(definition.name, candidate.name)
  assert.equal(definition.provider, 'work-skills')
  assert.match(definition.content, /^---\n/)
  assert.match(definition.content, new RegExp(`^name: ${candidate.name}$`, 'm'))
})
