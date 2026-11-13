import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../../packages/client-work/lib/client.node.mjs'

test('client plugin registers native session work surfaces and one Feishu settings section', () => {
  const registrations = []
  const rightTabs = []
  const commands = []
  const ctx = {
    get(name) {
      if (name === 'contextMenus') return { notify() {} }
      if (name === 'sidebarRightTabs') {
        return {
          register(definition) {
            rightTabs.push(definition)
            return () => {}
          },
        }
      }
      if (name === 'commandUi') {
        return {
          register(contribution) {
            commands.push(contribution)
            return () => {}
          },
        }
      }
      if (name === 'sidebarRight') return { openTab() {} }
      return undefined
    },
    effect(callback) {
      return callback()
    },
    slots: {
      inject(_key, callback) {
        const effect = callback()
        if (typeof effect === 'function') effect()
        else for (const disposer of effect) disposer()
        return () => {}
      },
      register(options) {
        registrations.push(options)
        return () => {}
      },
    },
  }

  apply(ctx)

  const names = registrations.map((entry) => entry.name)
  assert.ok(!names.includes('main'))
  assert.ok(!names.includes('sidebar.panellist'))
  assert.ok(names.includes('conversation.input.dock'))
  assert.ok(!names.includes('conversation.input.left'))
  assert.ok(!names.includes('conversation.composer.dock'))
  assert.ok(names.includes('sidebar.workspaces.session.row.action'))
  assert.ok(names.includes('sidebar.workspaces.session.menu.item'))
  assert.ok(names.includes('conversation.session.header.actions'))
  assert.ok(names.includes('sidebar.right.pane.tab'))
  assert.ok(names.includes('settings.section'))

  // The Feishu chip and the work-mode toggle share the band above the composer.
  const contextRow = registrations.find((entry) => entry.name === 'conversation.input.dock')
  assert.equal(contextRow.id, 'dsh-work-context-row')
  assert.equal(contextRow.order, 10)

  const sections = registrations.filter((entry) => entry.name === 'settings.section')
  assert.deepEqual(sections.map((entry) => entry.id), ['feishu'])
  assert.equal(sections[0].label, '飞书')

  assert.equal(rightTabs.length, 1)
  assert.equal(rightTabs[0].kind, 'work')
  assert.equal(rightTabs[0].id, 'dsh-work/work')
  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'work-mode')
})
