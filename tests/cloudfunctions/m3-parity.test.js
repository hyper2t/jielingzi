'use strict'
/**
 * 前后端校验一致性：同一份用例（tests/fixtures/topic-validation.json）喂给云函数的 parseTopic / parseReply，
 * 前端 src/features/topic/rules.ts 的测试读同一份。两边只要有一边改了规则或文案，另一边的测试会立刻失败。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { parseTopic, parseReply } = require('../../cloudfunctions/community/topics')

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/topic-validation.json'), 'utf8'))
const expand = (v) => (v && typeof v === 'object' && !Array.isArray(v) && 'repeat' in v ? v.repeat.repeat(v.times) : v)
const expandInput = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.map(expand) : expand(v)]))
const messageOf = (fn) => {
  try { fn(); return null } catch (e) {
    assert.equal(e.code, 40001, '校验失败必须是 40001')
    return e.message
  }
}

for (const c of fx.topics) {
  test(`话题校验：${c.name}`, () => {
    assert.equal(messageOf(() => parseTopic(expandInput(c.input))), c.error)
  })
}

for (const c of fx.replies) {
  test(`回复校验：${c.name}`, () => {
    const body = expand(c.body)
    assert.equal(messageOf(() => parseReply({ topicId: 't1', body })), c.error)
    if (c.error === null) assert.equal(parseReply({ topicId: 't1', body }).short, c.short)
  })
}
