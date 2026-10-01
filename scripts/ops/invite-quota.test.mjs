import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { addQuota, buildReport, monthRange, parseArgs, planQuota } from './invite-quota.mjs'
const require = createRequire(import.meta.url)
const { createFakeDb } = require('../../tests/cloudfunctions/fakeDb.js')
const { inviteDoc } = require('../../tests/cloudfunctions/circleFixtures.js')
const DAY = 24 * 3600 * 1000
const NOW = Date.UTC(2026, 9, 15, 4, 0, 0) // 北京时间 2026-10-15 12:00

test('invite-quota parseArgs：--report 与 --add 二选一；--add 1–20；账号三选一；--month 格式', () => {
  assert.equal(parseArgs(['--report']).report, true)
  assert.equal(parseArgs(['--report', '--month', '2026-09']).month, '2026-09')
  assert.throws(() => parseArgs(['--report', '--month', '2026-13']), /YYYY-MM/)
  assert.throws(() => parseArgs(['--report', '--month', '202610']), /YYYY-MM/)
  const a = parseArgs(['--account', 'oA', '--add', '2'])
  assert.deepEqual([a.account, a.add, a.apply], ['oA', 2, false])
  assert.equal(parseArgs(['--latest', '--add', '1', '--apply']).apply, true)
  assert.throws(() => parseArgs([]), /之一/)
  assert.throws(() => parseArgs(['--report', '--add', '1', '--account', 'oA']), /之一/)
  assert.throws(() => parseArgs(['--add', '2']), /之一/)
  assert.throws(() => parseArgs(['--account', 'oA', '--add', '0']), /1–20/)
  assert.throws(() => parseArgs(['--account', 'oA', '--add', '21']), /1–20/)
  assert.throws(() => parseArgs(['--account', 'oA', '--add', 'x']), /1–20/)
  assert.throws(() => parseArgs(['--account', 'oA', '--latest', '--add', '1']), /之一/)
  assert.throws(() => parseArgs(['--phone', '1', '--add', '1']), /11 位/)
  assert.throws(() => parseArgs(['--nope']), /未知参数/)
})

test('monthRange：按北京时间切月（10 月 = 9 月 30 日 16:00 UTC 起）；不传取当前月', () => {
  const r = monthRange('2026-10')
  assert.equal(r.from, Date.UTC(2026, 8, 30, 16))
  assert.equal(r.to, Date.UTC(2026, 9, 31, 16))
  assert.equal(monthRange('2026-12').to, Date.UTC(2026, 11, 31, 16))
  assert.equal(monthRange(null, NOW).month, '2026-10')
  assert.equal(monthRange(null, Date.UTC(2026, 8, 30, 16, 30)).month, '2026-10', '北京时间已是 10 月 1 日 00:30')
})

test('planQuota：未初始化按初始名额 3 起算；已有值累加；账号不存在报错', () => {
  assert.deepEqual(planQuota({}, 2), { initialized: false, from: 3, to: 5 })
  assert.deepEqual(planQuota({ inviteQuota: 0 }, 2), { initialized: true, from: 0, to: 2 })
  assert.deepEqual(planQuota({ inviteQuota: 4 }, 1), { initialized: true, from: 4, to: 5 })
  assert.throws(() => planQuota(null, 1), /账号不存在/)
})

test('addQuota：预览不写；已有值 inc；未初始化的写入「初始 + N」；执行后云函数懒初始化不会再覆盖', async () => {
  const db = createFakeDb({ data: { users: [{ _id: 'u1', _openid: 'A', inviteQuota: 1 }, { _id: 'u2', _openid: 'B' }] } })
  assert.deepEqual(await addQuota(db, 'A', 2, { apply: false }), { initialized: true, from: 1, to: 3 })
  assert.equal(db.store.users[0].inviteQuota, 1)
  await addQuota(db, 'A', 2, { apply: true })
  assert.equal(db.store.users[0].inviteQuota, 3)
  assert.deepEqual(await addQuota(db, 'B', 2, { apply: false }), { initialized: false, from: 3, to: 5 })
  assert.equal(db.store.users[1].inviteQuota, undefined)
  await addQuota(db, 'B', 2, { apply: true })
  assert.equal(db.store.users[1].inviteQuota, 5)
  const r = await db.collection('users').where({ _openid: 'B', inviteQuota: db.command.exists(false) }).update({ inviteQuota: 3 })
  assert.equal(r.updated, 0, '已初始化，不会被覆盖回 3')
  await assert.rejects(addQuota(db, 'nobody', 1, { apply: true }), /账号不存在/)
})

test('report：只统计本月（北京时间）状态 ok 且不少于 30 字的回复；汇总名额与邀请码使用情况；按回复数排序；只读', async () => {
  const from = Date.UTC(2026, 8, 30, 16)
  const reply = (id, who, o = {}) => ({ _id: id, _openid: who, topicId: 't', status: 'ok', short: false, createdAt: NOW, ...o })
  const db = createFakeDb({
    data: {
      replies: [
        reply('1', 'A'), reply('2', 'A'), reply('3', 'A', { short: true }), reply('4', 'A', { status: 'folded' }), reply('5', 'A', { createdAt: from - 1 }),
        reply('6', 'B'), reply('7', 'B', { createdAt: Date.UTC(2026, 9, 31, 16) }), reply('8', null),
      ],
      users: [{ _openid: 'A', inviteQuota: 1 }, { _openid: 'C', inviteQuota: 3 }],
      invites: [
        inviteDoc('AAAA0001', 'c', 'A', { now: NOW, usedBy: 'B' }),
        inviteDoc('AAAA0002', 'c', 'A', { now: NOW - 10 * DAY }),
        inviteDoc('AAAA0003', 'c', 'A', { now: NOW - 10 * DAY, refunded: true }),
        inviteDoc('AAAA0004', 'c', 'A', { now: NOW }),
        inviteDoc('OFFICE01', 'c', null, { now: NOW }),
      ],
    },
  })
  const before = JSON.stringify(db.store)
  const r = await buildReport(db, { month: '2026-10', now: NOW })
  assert.equal(r.month, '2026-10')
  assert.deepEqual(r.rows.map((x) => x.account), ['A', 'B', 'C'])
  assert.deepEqual(r.rows[0], { account: 'A', replies: 2, quota: 1, issued: 4, used: 1, expiredUnrefunded: 1 })
  assert.deepEqual(r.rows[1], { account: 'B', replies: 1, quota: null, issued: 0, used: 0, expiredUnrefunded: 0 })
  assert.deepEqual(r.rows[2], { account: 'C', replies: 0, quota: 3, issued: 0, used: 0, expiredUnrefunded: 0 })
  assert.equal(JSON.stringify(db.store), before)
  assert.deepEqual((await buildReport(createFakeDb({ strictCollections: true }), { now: NOW })).rows, [], '集合都不存在也不报错')
})
