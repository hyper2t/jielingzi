'use strict'
/**
 * M4 前置（BE-M4-00）：邀请码 / 圈子配置、新增索引登记、fakeDb 新增的条件操作符（名额原子扣减、一次性核销要用到）
 * 与 M4 夹具。业务逻辑用例在 m4.test.js（后续）。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { INVITE_RULES, CIRCLE_RULES, DAILY_LIMITS } = require('../../cloudfunctions/_shared/config')
const { COLLECTIONS, indexDefs } = require('../../cloudfunctions/_shared/collections')
const { createFakeDb } = require('./fakeDb')
const { CIRCLE_UNIQUE, circleDoc, memberDoc, inviteDoc } = require('./circleFixtures')

// ---------- 配置 ----------

test('INVITE_RULES：初始名额 3、7 天、8 位、Crockford 字母表（32 个互不重复，无 I L O U），且不可修改', () => {
  assert.equal(INVITE_RULES.initialQuota, 3)
  assert.equal(INVITE_RULES.ttlDays, 7)
  assert.equal(INVITE_RULES.codeLength, 8)
  assert.equal(INVITE_RULES.listMax, 50)
  const chars = [...INVITE_RULES.alphabet]
  assert.equal(chars.length, 32)
  assert.equal(new Set(chars).size, 32)
  for (const c of 'ILOU') assert.ok(!chars.includes(c), `字母表不应含 ${c}`)
  assert.ok(chars.every((c) => /[0-9A-Z]/.test(c)))
  assert.ok(Object.isFrozen(INVITE_RULES) && Object.isFrozen(CIRCLE_RULES))
  assert.throws(() => { 'use strict'; INVITE_RULES.initialQuota = 99 }, TypeError)
})

test('CIRCLE_RULES 与每日额度：兑换每天 10 次，签发每天 5 次', () => {
  assert.deepEqual({ ...CIRCLE_RULES }, { nameMax: 12, descMax: 60, rulesMax: 5, ruleMax: 60 })
  assert.equal(DAILY_LIMITS.redeemInvite, 10)
  assert.equal(DAILY_LIMITS.createInvite, 5)
})

// ---------- 索引登记 ----------

test('M4 新增索引：circles.uniq_slug（唯一）、memberships.idx_member、invites.idx_owner_time；已有索引不变', () => {
  const by = (name) => COLLECTIONS.find((c) => c.name === name)
  const idx = (c, n) => by(c).indexes.find((i) => i.name === n)
  assert.deepEqual(idx('circles', 'uniq_slug'), { name: 'uniq_slug', keys: [['slug', 1]], unique: true })
  assert.deepEqual(idx('memberships', 'idx_member').keys, [['_openid', 1], ['joinedAt', 1]])
  assert.ok(!idx('memberships', 'idx_member').unique)
  assert.deepEqual(idx('invites', 'idx_owner_time').keys, [['_openid', 1], ['createdAt', -1]])
  assert.ok(idx('memberships', 'uniq_circle_member').unique)
  assert.ok(idx('invites', 'uniq_code').unique)
  assert.ok(idx('topics', 'idx_circle_status_time'))
  // ensure-indexes 的登记项里能看到它们
  const names = indexDefs().map((d) => `${d.collection}.${d.name}`)
  for (const n of ['circles.uniq_slug', 'memberships.idx_member', 'invites.idx_owner_time']) assert.ok(names.includes(n), n)
})

// ---------- fakeDb 条件操作符 ----------

const rowsDb = () => createFakeDb({ data: { t: [
  { _id: 'a', n: 1, s: 'x', u: null },
  { _id: 'b', n: 5, s: 'y' },
  { _id: 'c', n: 10, s: 'x', u: 'someone' },
  { _id: 'd', s: 'z' },
] } })
const ids = async (db, where) => (await db.collection('t').where(where).get()).data.map((d) => d._id).sort()

test('fakeDb：gt / gte / lt / lte（缺失字段不参与比较）、neq、exists、nin', async () => {
  const db = rowsDb()
  const _ = db.command
  assert.deepEqual(await ids(db, { n: _.gte(5) }), ['b', 'c'])
  assert.deepEqual(await ids(db, { n: _.gt(5) }), ['c'])
  assert.deepEqual(await ids(db, { n: _.lt(5) }), ['a'])
  assert.deepEqual(await ids(db, { n: _.lte(5) }), ['a', 'b'])
  assert.deepEqual(await ids(db, { n: _.exists(false) }), ['d'])
  assert.deepEqual(await ids(db, { n: _.exists(true) }), ['a', 'b', 'c'])
  assert.deepEqual(await ids(db, { s: _.neq('x') }), ['b', 'd'])
  assert.deepEqual(await ids(db, { s: _.nin(['x', 'y']) }), ['d'])
  assert.deepEqual(await ids(db, { n: _.gte(1), s: 'x' }), ['a', 'c'])
  assert.deepEqual(await ids(db, { s: _.in(['y', 'z']) }), ['b', 'd'])
})

test('fakeDb：等值 null 同时匹配 null 与字段缺失（与云端一致）；neq(null) 只匹配有值的', async () => {
  const db = rowsDb()
  assert.deepEqual(await ids(db, { u: null }), ['a', 'b', 'd'])
  assert.deepEqual(await ids(db, { u: db.command.neq(null) }), ['c'])
})

test('fakeDb：不认识的条件直接抛错（避免测试悄悄通过）', async () => {
  const db = rowsDb()
  await assert.rejects(() => db.collection('t').where({ n: { $regex: 'x' } }).get(), /不支持的条件/)
})

test('名额扣减模式：where({ quota: gte(1) }).update(inc(-1))，updated 为 0 时不再扣；缺失字段不被扣成 -1', async () => {
  const db = createFakeDb({ data: { users: [{ _openid: 'A', inviteQuota: 1 }, { _openid: 'B' }] } })
  const _ = db.command
  const take = (id) => db.collection('users').where({ _openid: id, inviteQuota: _.gte(1) }).update({ inviteQuota: _.inc(-1) })
  assert.equal((await take('A')).updated, 1)
  assert.equal((await take('A')).updated, 0)
  assert.equal((await take('B')).updated, 0)
  assert.equal(db.store.users[0].inviteQuota, 0)
  assert.equal(db.store.users[1].inviteQuota, undefined)
})

test('名额懒初始化模式：where({ inviteQuota: exists(false) }).update({ inviteQuota: 3 }) 幂等，不覆盖已有值', async () => {
  const db = createFakeDb({ data: { users: [{ _openid: 'A' }, { _openid: 'B', inviteQuota: 1 }] } })
  const init = (id) => db.collection('users').where({ _openid: id, inviteQuota: db.command.exists(false) }).update({ inviteQuota: 3 })
  assert.equal((await init('A')).updated, 1)
  assert.equal((await init('A')).updated, 0)
  assert.equal((await init('B')).updated, 0)
  assert.deepEqual(db.store.users.map((u) => u.inviteQuota), [3, 1])
})

test('一次性核销模式：两个请求同时抢同一个码，只有一个 updated = 1（Promise.all 在 await 处交错）', async () => {
  const db = createFakeDb({ data: { invites: [inviteDoc('ABCD2345', 'circle-mindful', 'acct-a', { now: 1000 })] } })
  const _ = db.command
  const claim = (who) => db.collection('invites').where({ code: 'ABCD2345', usedBy: null, expiresAt: _.gt(2000) }).update({ usedBy: who, usedAt: 2000 })
  const [r1, r2] = await Promise.all([claim('b'), claim('c')])
  assert.equal(r1.updated + r2.updated, 1)
  assert.ok(['b', 'c'].includes(db.store.invites[0].usedBy))
  // 过期的码核销不了
  const expired = createFakeDb({ data: { invites: [inviteDoc('EXPIRED1', 'circle-mindful', 'acct-a', { now: 1000, expiresAt: 1500 })] } })
  const r = await expired.collection('invites').where({ code: 'EXPIRED1', usedBy: null, expiresAt: expired.command.gt(2000) }).update({ usedBy: 'b' })
  assert.equal(r.updated, 0)
})

// ---------- 夹具 ----------

test('夹具：默认值；唯一索引模拟（同圈同人不能重复加入、码不能重复、slug 不能重复）', async () => {
  const c = circleDoc({ slug: 'mindful' })
  assert.equal(c._id, 'circle-mindful')
  assert.equal(c.status, 'open')
  assert.equal(c.cover, 'circle:mindful')
  const m = memberDoc('circle-mindful', 'acct-a')
  assert.deepEqual([m.invitedBy, m.role], [null, 'member'])
  const official = inviteDoc('OFFICIAL', 'circle-mindful', null, { now: 0 })
  assert.equal(official.official, true)
  assert.equal(official._openid, null)
  assert.equal(official.expiresAt, 7 * 24 * 3600 * 1000)
  assert.deepEqual([official.usedBy, official.refunded], [null, false])
  assert.equal(inviteDoc('MINE0001', 'circle-mindful', 'acct-a').official, false)

  const db = createFakeDb({ data: { circles: [c], memberships: [m], invites: [official] }, unique: CIRCLE_UNIQUE })
  await assert.rejects(() => db.collection('memberships').add(memberDoc('circle-mindful', 'acct-a')), /duplicate/i)
  await db.collection('memberships').add(memberDoc('circle-mindful', 'acct-b'))
  await db.collection('memberships').add(memberDoc('circle-other', 'acct-a'))
  await assert.rejects(() => db.collection('invites').add(inviteDoc('OFFICIAL', 'circle-mindful', 'acct-a')), /duplicate/i)
  await assert.rejects(() => db.collection('circles').add(circleDoc({ slug: 'mindful' })), /duplicate/i)
})
