'use strict'
/** BE-M5-01：打卡校验、幂等累加、按月聚合与本人数据隔离。 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const S = require('../../cloudfunctions/_shared')
const practice = require('../../cloudfunctions/practice/service')
const { createFakeDb } = require('./fakeDb')

const NOW = Date.UTC(2026, 9, 1, 4, 0, 0)
const OWNER = 'acct-practice-owner'
const OTHER = 'acct-practice-other'
const silent = { info() {}, error() {} }

function world (opts = {}) {
  return createFakeDb({
    unique: { checkins: [['_openid', 'dayKey']] },
    data: {
      users: [
        { _openid: OWNER, adultConfirmedAt: 1, phoneVerified: false },
        { _openid: OTHER, adultConfirmedAt: 1, phoneVerified: true }
      ],
      checkins: opts.checkins || []
    }
  })
}

function as (db, accountId = OWNER) {
  let now = NOW
  return S.createMain({
    actions: practice.actions,
    logger: silent,
    createContext: async () => ({ db, identity: { openid: accountId }, now: () => ++now, logger: silent })
  })
}

const event = (action, p = {}) => ({ action, ...p })
const valid = (p = {}) => ({ sessionId: 'session_20261001_a', date: '2026-10-01', practice: 'meditation', minutes: 20, ...p })

test('checkin 按日期 + 练习方式累加；同一 sessionId 重试幂等', async () => {
  const db = world()
  const call = as(db)
  const first = await call(event('checkin', valid()))
  assert.equal(first.code, 0)
  assert.deepEqual(first.data.checkin, { date: '2026-10-01', practice: 'meditation', minutes: 20, duplicate: false })

  const retry = await call(event('checkin', valid()))
  assert.equal(retry.code, 0)
  assert.deepEqual(retry.data.checkin, { date: '2026-10-01', practice: 'meditation', minutes: 20, duplicate: true })

  const secondSession = await call(event('checkin', valid({ sessionId: 'session_20261001_b', minutes: 5 })))
  assert.equal(secondSession.data.checkin.minutes, 25)
  assert.equal(secondSession.data.checkin.duplicate, false)
  assert.equal(db.store.checkins.length, 1, '同一日 + 練習方式只有一筆聚合記錄')
  assert.deepEqual(db.store.checkins[0].sessionIds, ['session_20261001_a', 'session_20261001_b'])
})

test('checkin 对不同日期 / 练习方式分别计数；手机号与禁言不阻止私人打卡', async () => {
  const db = world()
  const call = as(db)
  const first = await call(event('checkin', valid()))
  const nextDay = await call(event('checkin', valid({ sessionId: 'session_20261002_a', date: '2026-10-02', minutes: 10 })))
  const otherPractice = await call(event('checkin', valid({ sessionId: 'session_20261001_c', practice: 'yoga', minutes: 15 })))
  assert.equal(first.code, 0)
  assert.equal(nextDay.code, 0)
  assert.equal(otherPractice.code, 0)
  assert.equal(db.store.checkins.length, 3)

  db.store.users[0].mutedUntil = NOW + 100000
  assert.equal((await call(event('checkin', valid({ sessionId: 'session_20261001_d' })))).code, 0)
})

test('checkin 严格校验字段、日期、练习方式与分钟数', async () => {
  const call = as(world())
  const invalid = [
    valid({ extra: true }),
    valid({ sessionId: 'x' }),
    valid({ date: '2026-02-30' }),
    valid({ practice: 'unknown' }),
    valid({ minutes: 0 }),
    valid({ minutes: 181 }),
    valid({ minutes: '20' })
  ]
  for (const input of invalid) assert.equal((await call(event('checkin', input))).code, 40001, JSON.stringify(input))
})

test('checkin 仍拒绝未确认 18+ / 封禁账号；未登录调用被拒', async () => {
  const db = world()
  db.store.users.push({ _openid: 'acct-practice-kid', phoneVerified: true })
  db.store.users.push({ _openid: 'acct-practice-banned', adultConfirmedAt: 1, bannedUntil: NOW + 100000 })
  assert.equal((await as(db, 'acct-practice-kid')(event('checkin', valid()))).code, 40303)
  assert.equal((await as(db, 'acct-practice-banned')(event('checkin', valid()))).code, 40304)
  const noIdentity = S.createMain({ actions: practice.actions, logger: silent, createContext: async () => ({ db, identity: { openid: null }, now: () => NOW, logger: silent }) })
  assert.equal((await noIdentity(event('checkin', valid()))).code, 40101)
})

test('listCheckins 只查当前账号指定月份并按日期聚合', async () => {
  const db = world({ checkins: [
    { _openid: OWNER, dayKey: '2026-10-01:meditation', monthKey: '2026-10', date: '2026-10-01', practice: 'meditation', minutes: 25 },
    { _openid: OWNER, dayKey: '2026-10-01:yoga', monthKey: '2026-10', date: '2026-10-01', practice: 'yoga', minutes: 10 },
    { _openid: OWNER, dayKey: '2026-10-03:reading', monthKey: '2026-10', date: '2026-10-03', practice: 'reading', minutes: 15 },
    { _openid: OWNER, dayKey: '2026-09-30:meditation', monthKey: '2026-09', date: '2026-09-30', practice: 'meditation', minutes: 99 },
    { _openid: OTHER, dayKey: '2026-10-01:meditation', monthKey: '2026-10', date: '2026-10-01', practice: 'meditation', minutes: 300 }
  ] })
  const res = await as(db)(event('listCheckins', { month: '2026-10' }))
  assert.equal(res.code, 0)
  assert.deepEqual(res.data, {
    month: '2026-10',
    list: [
      { date: '2026-10-01', minutes: 35, practices: { meditation: 25, yoga: 10 } },
      { date: '2026-10-03', minutes: 15, practices: { reading: 15 } }
    ],
    totalMinutes: 50
  })
  const query = db.calls.find(c => c.op === 'get' && c.collection === 'checkins')
  assert.deepEqual(query.where, { _openid: OWNER, monthKey: '2026-10' })
  assert.equal((await as(db)(event('listCheckins', { month: '2026-13' }))).code, 40001)
  assert.equal((await as(db)(event('listCheckins', { month: '2026-10', _openid: OTHER }))).code, 40001)
})
