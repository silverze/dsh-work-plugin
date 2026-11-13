import test from 'node:test'
import assert from 'node:assert/strict'

import { FeishuPresenceService } from '../../packages/host-work/lib/index.js'

function fakeFocus(chatName, messages, extra = {}) {
  return {
    detected: true,
    chatName,
    chatKind: 'group',
    messages,
    otherChats: [],
    ...extra,
  }
}

test('presence service serves the cache until it expires', async () => {
  let reads = 0
  const service = new FeishuPresenceService({
    capture: async () => {
      reads += 1
      return fakeFocus('项目讨论群', ['张三：方案看过了'])
    },
  })

  const first = await service.capture()
  assert.equal(first.cached, false)
  assert.equal(first.chatName, '项目讨论群')
  assert.deepEqual(first.messages, ['张三：方案看过了'])

  const second = await service.capture()
  assert.equal(second.cached, true)
  assert.equal(reads, 1)

  const forced = await service.capture({ force: true })
  assert.equal(forced.cached, false)
  assert.equal(reads, 2)
})

test('presence service shares one screen read between concurrent callers', async () => {
  let reads = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const service = new FeishuPresenceService({
    capture: async () => {
      reads += 1
      await gate
      return fakeFocus('销售群', ['李四：收到'])
    },
  })

  const [a, b] = [service.capture(), service.capture()]
  release()
  const results = await Promise.all([a, b])
  assert.equal(reads, 1)
  assert.equal(results[0].chatName, '销售群')
  assert.equal(results[1].chatName, '销售群')
})

test('presence service remembers recent conversations newest first, without duplicates', async () => {
  const chats = ['项目群', '销售群', '项目群']
  let index = 0
  const service = new FeishuPresenceService({
    capture: async () => fakeFocus(chats[index++], ['消息']),
  })

  await service.capture({ force: true })
  await service.capture({ force: true })
  const latest = await service.capture({ force: true })

  assert.equal(latest.chatName, '项目群')
  assert.deepEqual(
    latest.recent.map((entry) => entry.chatName),
    ['项目群', '销售群'],
  )
  assert.deepEqual(
    service.recent(1).map((entry) => entry.chatName),
    ['项目群'],
  )
})

test('a failed read keeps the last conversation on the chip and reports why', async () => {
  let call = 0
  let clock = 1_000_000
  const service = new FeishuPresenceService({
    now: () => clock,
    capture: async () => {
      call += 1
      if (call === 1) return fakeFocus('项目群', ['一'])
      return {
        detected: false,
        chatName: '',
        chatKind: 'unknown',
        messages: [],
        otherChats: [],
        error: 'Feishu is not running; open Feishu first',
      }
    },
  })

  await service.capture({ force: true })
  clock += 120_000 // long after the transient window
  const failed = await service.capture({ force: true })
  assert.equal(failed.detected, true)
  assert.equal(failed.chatName, '项目群')
  assert.equal(failed.stale, true)
  assert.match(failed.error, /Feishu is not running/)
  assert.equal(failed.recent[0].chatName, '项目群')
})

test('the cache is served without OCR while Feishu is not in front', async () => {
  let reads = 0
  let foreground = false
  let clock = 1_000_000
  const service = new FeishuPresenceService({
    now: () => clock,
    minIntervalMs: 0,
    capture: async () => {
      reads += 1
      return fakeFocus(`群${reads}`, ['消息'])
    },
    isForeground: async () => foreground,
  })

  const first = await service.capture({ force: true })
  assert.equal(first.chatName, '群1')

  clock += 5_000
  const idle = await service.capture()
  assert.equal(idle.cached, true)
  assert.equal(reads, 1)

  foreground = true
  clock += 5_000
  const followed = await service.capture()
  assert.equal(followed.cached, false)
  assert.equal(followed.chatName, '群2')
  assert.equal(reads, 2)
})

test('a failure right after a good read stays quiet instead of flagging the chip', async () => {
  let call = 0
  let clock = 1_000_000
  const service = new FeishuPresenceService({
    now: () => clock,
    capture: async () => {
      call += 1
      if (call === 1) return fakeFocus('项目群', ['一'])
      return {
        detected: false,
        chatName: '',
        chatKind: 'unknown',
        messages: [],
        otherChats: [],
        error: 'no window found for pid 1034',
      }
    },
  })

  await service.capture({ force: true })
  clock += 10_000
  const quiet = await service.capture({ force: true })
  assert.equal(quiet.detected, true)
  assert.equal(quiet.stale, undefined)
  assert.equal(quiet.error, undefined)
  assert.equal(quiet.cached, true)
})

test('the background follower only reads while a chip is asking and Feishu is in front', async () => {
  let reads = 0
  let foreground = true
  let clock = 1_000_000
  const service = new FeishuPresenceService({
    now: () => clock,
    capture: async () => {
      reads += 1
      return fakeFocus(`群${reads}`, ['消息'])
    },
    isForeground: async () => foreground,
  })

  // No chip has ever asked: the follower stays idle even though Feishu is open.
  await service.watch()
  assert.equal(reads, 0)

  await service.capture({ force: true })
  assert.equal(reads, 1)

  clock += 3_000
  await service.watch()
  assert.equal(reads, 2, 'follows the chat the user switched to in Feishu')

  foreground = false
  clock += 3_000
  await service.watch()
  assert.equal(reads, 2, 'does not spend OCR while the user is back in DSH')

  // Ten minutes without a chip request: following stops on its own.
  foreground = true
  clock += 11 * 60_000
  await service.watch()
  assert.equal(reads, 2)
})

test('a failed read backs off instead of retrying on every poll', async () => {
  let clock = 1_000
  let reads = 0
  const service = new FeishuPresenceService({
    minIntervalMs: 0,
    now: () => clock,
    capture: async () => {
      reads += 1
      return {
        detected: false,
        chatName: '',
        chatKind: 'unknown',
        messages: [],
        otherChats: [],
        error: 'Feishu is not running; open Feishu first',
      }
    },
  })

  const first = await service.capture()
  assert.equal(first.detected, false)
  assert.equal(reads, 1)

  clock += 1_000
  const second = await service.capture()
  assert.equal(second.cached, true, 'serves the failure from the cache')
  assert.equal(reads, 1, 'does not OCR again inside the backoff window')

  clock += 8_000
  await service.capture()
  assert.equal(reads, 2, 'retries once the backoff has passed')
})
