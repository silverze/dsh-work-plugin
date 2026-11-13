import test from 'node:test'
import assert from 'node:assert/strict'

import { parseFeishuLink } from '../../packages/client-work/lib/client.node.mjs'

test('parses docx and sheets links', () => {
  assert.deepEqual(parseFeishuLink('https://acme.feishu.cn/docx/doxcnABC123'), { kind: 'docx', token: 'doxcnABC123' })
  assert.deepEqual(parseFeishuLink('https://acme.feishu.cn/sheets/shtABC123?sheet=1'), { kind: 'sheet', token: 'shtABC123' })
  assert.deepEqual(parseFeishuLink('https://acme.larksuite.com/docx/doxcnLark1'), { kind: 'docx', token: 'doxcnLark1' })
  assert.deepEqual(parseFeishuLink('https://acme.feishu.cn/wiki/wikcnABC123'), { kind: 'wiki', token: 'wikcnABC123' })
})

test('parses prefixed tokens and rejects other hosts/empty input', () => {
  assert.deepEqual(parseFeishuLink('docx:t1'), { kind: 'docx', token: 't1' })
  assert.deepEqual(parseFeishuLink('sheet:t2'), { kind: 'sheet', token: 't2' })
  assert.deepEqual(parseFeishuLink('wiki:w1'), { kind: 'wiki', token: 'w1' })
  assert.equal(parseFeishuLink(''), undefined)
  assert.equal(parseFeishuLink('https://example.com/docx/x'), undefined)

})
