'use strict'
/**
 * M4 邀请码（BE-M4-02）：规范化、createInvite / listInvites / redeemInvite、名额与并发、过期退名额。
 * 圈子读取见 m4.test.js；夹具见 circleFixtures.js；用例索引 docs/test/cases/M4.md。
 */
const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const S = require('../../cloudfunctions/_shared')
const community = require('../../cloudfunctions/community/service')
const { normalizeInviteCode } = require('../../cloudfunctions/community/invites')
const { createFakeDb } = require('./fakeDb')
const { CIRCLE_UNIQUE, circleDoc, memberDoc, inviteDoc, DAY } = require('./circleFixtures')
const FIXTURE = require('../fixtures/invite-code.json')

beforeEach(() => S.restoreOwnedCollections())
const NOW = Date.UTC(2026, 9, 1, 4, 0, 0)
const silent = { info() {}, error() {} }
let tick = NOW
const ID = { alice: 'acct-alice-001', bob: 'acct-bob-002', carol: 'acct-carol-004', dan: 'acct-dan-005', kid: 'acct-kid-003' }
const MINDFUL = circleDoc({ slug: 'mindful', name: '静观练习', sort: 1, memberCount: 12 })
const TRADITION = circleDoc({ slug: 'tradition', name: '传统养生', sort: 2 })
const CLOSED = circleDoc({ slug: 'old', name: '已关闭的圈子', sort: 0, status: 'closed' })
const INVALID_MSG = '邀请码无效、已被使用或已过期'
const ok = { adultConfirmedAt: 1, phoneVerified: true }

/** alice：静观 + 传统 + 已关闭圈子的成员；bob：静观成员；carol / dan：没加入任何圈子；kid 未确认 18+ */
function world({ invites = [], users = [] } = {}) {
  return createFakeDb({
    unique: { profiles: ['_openid', 'anonAlias'], ...CIRCLE_UNIQUE },
    data: {
      users: [
        { _openid: ID.alice, ...ok },
        { _openid: ID.bob, ...ok },
        { _openid: ID.carol, ...ok },
        { _openid: ID.dan, ...ok },
        { _openid: ID.kid, phoneVerified: true },
        ...users,
      ],
      circles: [MINDFUL, TRADITION, CLOSED],
      memberships: [
        memberDoc(MINDFUL._id, ID.alice), memberDoc(TRADITION._id, ID.alice), memberDoc(CLOSED._id, ID.alice), memberDoc(MINDFUL._id, ID.bob),
      ],
      invites,
    },
  })
}
const as = (db, accountId, extra = {}) =>
  S.createMain({ actions: community.actions, logger: silent, createContext: async () => ({ db, identity: accountId === null ? {} : { openid: accountId }, now: () => ++tick, logger: silent, ...extra }) })
const create = (db, who, circleId = MINDFUL._id, extra) => as(db, who, extra)({ action: 'createInvite', circleId })
const redeem = (db, who, code, extra) => as(db, who, extra)({ action: 'redeemInvite', code })
const list = (db, who) => as(db, who)({ action: 'listInvites' })
const user = (db, id) => db.store.users.find((u) => u._openid === id)
const invite = (db, code) => db.store.invites.find((i) => i.code === code)
const memberOf = (db, circleId, id) => db.store.memberships.find((m) => m.circleId === circleId && m._openid === id)
/** 让某个集合的某个方法抛错（其余原样透传） */
function failing(db, collection, method, makeError) {
  return { ...db, collection: (name) => { const q = db.collection(name); return name === collection ? { ...q, [method]: async () => { throw makeError() } } : q } }
}
/** 让 where(...).update 抛错，用于证明前置拒绝分支不会尝试核销邀请码 */
function failingWhereUpdate(db, collection, makeError) {
  return {
    ...db,
    collection: (name) => {
      const q = db.collection(name)
      return name === collection
        ? { ...q, where: (...args) => ({ ...q.where(...args), update: async () => { throw makeError() } }) }
        : q
    },
  }
}
function assertNoLeak(data) {
  const s = JSON.stringify(data)
  for (const f of ['_openid', '_id', 'usedBy', 'refunded', 'official', 'invitedBy']) assert.ok(!s.includes(`"${f}"`), `返回体含内部字段 ${f}`)
  for (const id of Object.values(ID)) assert.ok(!s.includes(id), `返回体含账号标识 ${id}`)
}

// ---------- 规范化（与前端共享 fixture） ----------
test('normalizeInviteCode：共享 fixture 的有效 / 无效用例', () => {
  assert.ok(FIXTURE.valid.length >= 8 && FIXTURE.invalid.length >= 6)
  for (const c of FIXTURE.valid) assert.equal(normalizeInviteCode(c.input), c.expected, JSON.stringify(c.input))
  for (const c of FIXTURE.invalid) assert.throws(() => normalizeInviteCode(c.input), (e) => e.code === 40001 && e.message === c.message, JSON.stringify(c.input))
  for (const v of [undefined, null, 12345678, {}, ['ABCD2345']]) assert.throws(() => normalizeInviteCode(v), (e) => e.code === 40001)
})

// ---------- createInvite ----------
test('createInvite：成员签发——扣 1 个名额（首次懒初始化为 3）、7 天有效、返回体不含内部字段', async () => {
  const db = world()
  assert.equal(user(db, ID.alice).inviteQuota, undefined)
  const r = await create(db, ID.alice)
  assert.equal(r.code, 0)
  assert.equal(r.data.quota, 2)
  const inv = r.data.invite
  assert.deepEqual(Object.keys(inv).sort(), ['circle', 'code', 'createdAt', 'expiresAt', 'status', 'usedAt'])
  assert.match(inv.code, /^[0-9A-HJKMNP-TV-Z]{8}$/)
  assert.deepEqual(inv.circle, { id: MINDFUL._id, name: '静观练习' })
  assert.equal(inv.status, 'active')
  assert.equal(inv.usedAt, null)
  assert.equal(inv.expiresAt - inv.createdAt, 7 * DAY)
  assertNoLeak(r.data)
  assert.equal(db.store.invites.length, 1)
  assert.deepEqual({ ...db.store.invites[0] , _id: undefined }, { _id: undefined, code: inv.code, circleId: MINDFUL._id, _openid: ID.alice, official: false, createdAt: inv.createdAt, expiresAt: inv.expiresAt, usedBy: null, usedAt: null, refunded: false })
  assert.equal(user(db, ID.alice).inviteQuota, 2)
  assert.equal(user(db, ID.bob).inviteQuota, undefined, '别人的名额不动')
})

test('createInvite：名额只有 3 个，用完 42901，且不多写码；别人不受影响', async () => {
  const db = world()
  const quotas = []
  for (let i = 0; i < 3; i++) quotas.push((await create(db, ID.alice)).data.quota)
  assert.deepEqual(quotas, [2, 1, 0])
  const r = await create(db, ID.alice)
  assert.equal(r.code, 42901)
  assert.match(r.msg, /邀请名额已用完/)
  assert.equal(db.store.invites.length, 3)
  assert.equal(new Set(db.store.invites.map((i) => i.code)).size, 3)
  assert.equal((await create(db, ID.bob)).data.quota, 2)
})

test('createInvite：只有该圈成员能签发——非成员 / 圈子不存在 / 圈子已关闭都是 40301，且不扣名额', async () => {
  const db = world()
  for (const circleId of [TRADITION._id, 'no-such-circle']) {
    const r = await create(db, ID.bob, circleId)
    assert.equal(r.code, 40301, circleId)
    assert.equal(r.msg, '加入圈子后才能邀请')
  }
  assert.equal((await create(db, ID.alice, CLOSED._id)).code, 40301, '已关闭的圈子不能再签发')
  assert.equal(db.store.invites.length, 0)
  assert.equal(user(db, ID.bob).inviteQuota, undefined)
  assert.equal(user(db, ID.alice).inviteQuota, undefined)
})

test('createInvite：账号与参数错误码（40001 / 40101 / 40302 / 40303 / 40304 / 42901 日额度）', async () => {
  const db = world({ users: [{ _openid: 'acct-nophone', adultConfirmedAt: 1 }, { _openid: 'acct-banned', ...ok, bannedUntil: NOW + 100 * DAY }, { _openid: 'acct-muted', ...ok, mutedUntil: NOW + 100 * DAY }] })
  db.store.memberships.push(memberDoc(MINDFUL._id, 'acct-nophone'), memberDoc(MINDFUL._id, 'acct-banned'), memberDoc(MINDFUL._id, 'acct-muted'))
  assert.equal((await as(db, null)({ action: 'createInvite', circleId: MINDFUL._id })).code, 40101)
  assert.equal((await create(db, ID.kid)).code, 40303)
  assert.equal((await create(db, 'acct-nophone')).code, 40302)
  assert.equal((await create(db, 'acct-banned')).code, 40304)
  assert.equal((await create(db, 'acct-muted')).code, 40305, '禁言不能签发')
  assert.equal((await as(db, ID.alice)({ action: 'createInvite' })).code, 40001)
  assert.equal((await as(db, ID.alice)({ action: 'createInvite', circleId: MINDFUL._id, quota: 99 })).code, 40001)
  assert.equal((await as(db, ID.alice)({ action: 'createInvite', circleId: 'bad id!' })).code, 40001)
  assert.equal(db.store.invites.length, 0)
  // 日额度：每天 5 次
  user(db, ID.alice).inviteQuota = 99
  for (let i = 0; i < 5; i++) assert.equal((await create(db, ID.alice)).code, 0)
  assert.equal((await create(db, ID.alice)).code, 42901)
  assert.equal(user(db, ID.alice).inviteQuota, 94, '被日额度拒绝时不扣名额')
})

test('createInvite：只剩 1 个名额时并发两次——只有一个成功，名额不会扣成负数', async () => {
  const db = world({ users: [] })
  user(db, ID.alice).inviteQuota = 1
  const [a, b] = await Promise.all([create(db, ID.alice), create(db, ID.alice)])
  assert.deepEqual([a.code, b.code].sort(), [0, 42901])
  assert.equal(db.store.invites.length, 1)
  assert.equal(user(db, ID.alice).inviteQuota, 0)
})

test('createInvite：写码失败把名额退回；撞码自动重试；一直撞码则放弃并退名额', async () => {
  // 写库失败
  const db = world()
  const r = await create(failing(db, 'invites', 'add', () => new Error('boom')), ID.alice)
  assert.notEqual(r.code, 0)
  assert.equal(user(db, ID.alice).inviteQuota, 3, '名额应已退回')
  assert.equal(db.store.invites.length, 0)
  // 撞码一次后重试成功
  const db2 = world({ invites: [inviteDoc('00000000', MINDFUL._id, ID.bob, { now: NOW })] })
  const seq = [...Array(8).fill(0), ...Array(8).fill(0.999)]
  let i = 0
  const r2 = await create(db2, ID.alice, MINDFUL._id, { random: () => seq[i++] })
  assert.equal(r2.code, 0)
  assert.equal(r2.data.invite.code, 'ZZZZZZZZ')
  assert.equal(r2.data.quota, 2, '撞码重试不重复扣名额')
  // 一直撞码
  const r3 = await create(db2, ID.alice, MINDFUL._id, { random: () => 0 })
  assert.notEqual(r3.code, 0)
  assert.equal(user(db2, ID.alice).inviteQuota, 2, '放弃后名额退回')
  assert.equal(db2.store.invites.length, 2)
})

// ---------- listInvites ----------
test('listInvites：名额懒初始化；新的在前；active / used / expired；过期未用退 1 个名额且只退一次；官方码与已用码不退', async () => {
  const db = world({
    invites: [
      inviteDoc('ZSED0001', MINDFUL._id, ID.alice, { now: NOW - 2000, usedBy: ID.bob, usedAt: NOW - 1000 }),
      inviteDoc('ACTVE001', MINDFUL._id, ID.alice, { now: NOW }),
      inviteDoc('EXPRED01', TRADITION._id, ID.alice, { now: NOW - 10 * DAY }),
      inviteDoc('FREE2026', MINDFUL._id, null, { now: NOW - 10 * DAY }),
      inviteDoc('B0BS0001', MINDFUL._id, ID.bob, { now: NOW - 10 * DAY }),
    ],
  })
  const r = await list(db, ID.alice)
  assert.equal(r.code, 0)
  assert.equal(r.data.quota, 4, '初始 3 + 过期退回 1')
  assert.equal(r.data.ttlDays, 7)
  assert.deepEqual(r.data.list.map((i) => [i.code, i.status]), [['ACTVE001', 'active'], ['ZSED0001', 'used'], ['EXPRED01', 'expired']])
  assert.deepEqual(r.data.list[2].circle, { id: TRADITION._id, name: '传统养生' })
  assert.equal(r.data.list[1].usedAt, NOW - 1000)
  assertNoLeak(r.data)
  assert.equal(invite(db, 'EXPRED01').refunded, true)
  assert.equal(invite(db, 'ZSED0001').refunded, false)
  assert.equal(invite(db, 'FREE2026').refunded, false)
  assert.equal(invite(db, 'B0BS0001').refunded, false, '别人的码不会被我的请求退掉')
  // 幂等：再次读取、并发读取都不会重复退
  assert.equal((await list(db, ID.alice)).data.quota, 4)
  await Promise.all([list(db, ID.alice), list(db, ID.alice), list(db, ID.alice)])
  assert.equal(user(db, ID.alice).inviteQuota, 4)
  // 别人只看到自己的
  const bob = await list(db, ID.bob)
  assert.deepEqual(bob.data.list.map((i) => i.code), ['B0BS0001'])
  assert.equal(bob.data.quota, 4)
  assert.equal((await list(db, ID.carol)).data.list.length, 0)
})

test('listInvites：最多 50 条；账号与参数错误码', async () => {
  const many = Array.from({ length: 60 }, (_, i) => inviteDoc(`C${String(i).padStart(7, '0')}`, MINDFUL._id, ID.alice, { now: NOW + i }))
  const db = world({ invites: many })
  const r = await list(db, ID.alice)
  assert.equal(r.data.list.length, 50)
  assert.equal(r.data.list[0].code, 'C0000059')
  assert.equal((await as(db, null)({ action: 'listInvites' })).code, 40101)
  assert.equal((await list(db, ID.kid)).code, 40303)
  assert.equal((await as(db, ID.alice)({ action: 'listInvites', page: 1 })).code, 40001)
})

test('createInvite 会先回收过期码：名额为 0 但有过期未用的码时仍可签发', async () => {
  const db = world({ invites: [inviteDoc('EXPRED01', MINDFUL._id, ID.alice, { now: NOW - 10 * DAY })] })
  user(db, ID.alice).inviteQuota = 0
  const r = await create(db, ID.alice)
  assert.equal(r.code, 0)
  assert.equal(r.data.quota, 0)
  assert.equal(invite(db, 'EXPRED01').refunded, true)
})

// ---------- redeemInvite ----------
test('redeemInvite：全链路——成员签发 → 新人兑换（大小写 / 连字符均可）→ 入圈、成员数 +1、码作废；新成员也能签发', async () => {
  const db = world()
  const issued = (await create(db, ID.alice)).data.invite.code
  const dashed = `${issued.slice(0, 4)}-${issued.slice(4)}`.toLowerCase()
  const r = await redeem(db, ID.carol, dashed)
  assert.equal(r.code, 0)
  assert.equal(r.data.joined, true)
  assert.deepEqual(r.data.circle, { id: MINDFUL._id, slug: 'mindful', name: '静观练习', desc: MINDFUL.desc, cover: 'circle:mindful', memberCount: 13, topicCount: 0, joined: true })
  assertNoLeak(r.data)
  const m = memberOf(db, MINDFUL._id, ID.carol)
  assert.equal(m.invitedBy, ID.alice)
  assert.equal(m.inviteCode, issued)
  assert.equal(m.role, 'member')
  assert.equal(typeof m.joinedAt, 'number')
  assert.equal(invite(db, issued).usedBy, ID.carol)
  assert.equal(typeof invite(db, issued).usedAt, 'number')
  assert.equal(db.store.circles.find((c) => c._id === MINDFUL._id).memberCount, 13)
  // 已入圈：listCircles 看到 joined；自己也能签发
  const circles = await as(db, ID.carol)({ action: 'listCircles' })
  assert.equal(circles.data.list.find((c) => c.slug === 'mindful').joined, true)
  assert.equal((await create(db, ID.carol)).data.quota, 2)
  // 签发人的列表里这个码变成 used，且看不到兑换人
  const mine = await list(db, ID.alice)
  assert.equal(mine.data.list.find((i) => i.code === issued).status, 'used')
  assertNoLeak(mine.data)
  // 同一个码不能再用
  const again = await redeem(db, ID.dan, issued)
  assert.equal(again.code, 40401)
  assert.ok(!memberOf(db, MINDFUL._id, ID.dan))
})

test('redeemInvite：官方码（运维签发）——invitedBy 为空，不占任何人名额', async () => {
  const db = world({ invites: [inviteDoc('FREE2026', TRADITION._id, null, { now: NOW })] })
  const r = await redeem(db, ID.carol, 'free2026')
  assert.equal(r.code, 0)
  assert.equal(memberOf(db, TRADITION._id, ID.carol).invitedBy, null)
  assert.equal(r.data.circle.slug, 'tradition')
})

test('redeemInvite：不存在 / 已用 / 已过期 / 圈子已关闭统一 40401（同一句话），不入圈', async () => {
  const db = world({
    invites: [
      inviteDoc('ZSED0001', MINDFUL._id, ID.alice, { now: NOW, usedBy: ID.bob, usedAt: NOW }),
      inviteDoc('EXPRED01', MINDFUL._id, ID.alice, { now: NOW - 10 * DAY }),
      inviteDoc('CZSED001', CLOSED._id, ID.alice, { now: NOW }),
      inviteDoc('GHZST001', 'circle-missing', ID.alice, { now: NOW }),
    ],
  })
  for (const code of ['NZPE0000', 'ZSED0001', 'EXPRED01', 'CZSED001', 'GHZST001']) {
    const r = await redeem(db, ID.carol, code)
    assert.equal(r.code, 40401, code)
    assert.equal(r.msg, INVALID_MSG, code)
  }
  assert.equal(db.store.memberships.filter((m) => m._openid === ID.carol).length, 0)
  assert.equal(invite(db, 'CZSED001').usedBy, null, '圈子已关闭的码不被消耗')
})

test('redeemInvite：已是成员 40901，且不消耗邀请码', async () => {
  const db = world({ invites: [inviteDoc('FB0B0001', MINDFUL._id, ID.alice, { now: NOW })] })
  const r = await redeem(failingWhereUpdate(db, 'invites', () => new Error('已是成员时不应核销邀请码')), ID.bob, 'FB0B0001')
  assert.equal(r.code, 40901)
  assert.equal(r.msg, '你已在这个圈子里')
  assert.equal(invite(db, 'FB0B0001').usedBy, null)
  assert.equal(db.store.memberships.filter((m) => m._openid === ID.bob).length, 1)
  assert.equal((await redeem(db, ID.carol, 'FB0B0001')).code, 0, '别人仍可用')
})

test('redeemInvite：格式错误 40001（不计日额度）；每次尝试含失败共 10 次/天，第 11 次 42901，即使码是对的', async () => {
  const db = world({ invites: [inviteDoc('G00DC0DE', MINDFUL._id, ID.alice, { now: NOW })] })
  for (const bad of ['', 'short', 'ABCD234U', 'ABCD-23456']) assert.equal((await redeem(db, ID.carol, bad)).code, 40001)
  assert.equal((await as(db, ID.carol)({ action: 'redeemInvite' })).code, 40001)
  assert.equal((await as(db, ID.carol)({ action: 'redeemInvite', code: 'G00DC0DE', extra: 1 })).code, 40001)
  for (let i = 0; i < 10; i++) assert.equal((await redeem(db, ID.carol, `WRXNG${String(i).padStart(3, '0')}`)).code, 40401)
  const r = await redeem(db, ID.carol, 'G00DC0DE')
  assert.equal(r.code, 42901)
  assert.equal(invite(db, 'G00DC0DE').usedBy, null)
  assert.equal((await redeem(db, ID.dan, 'G00DC0DE')).code, 0, '额度按人计')
})

test('redeemInvite：两人同时抢同一个码——只有一人入圈', async () => {
  const db = world({ invites: [inviteDoc('RACE0001', MINDFUL._id, ID.alice, { now: NOW })] })
  const [a, b] = await Promise.all([redeem(db, ID.carol, 'RACE0001'), redeem(db, ID.dan, 'RACE0001')])
  assert.deepEqual([a.code, b.code].sort(), [0, 40401])
  assert.equal(db.store.memberships.filter((m) => m.circleId === MINDFUL._id && [ID.carol, ID.dan].includes(m._openid)).length, 1)
  assert.equal(db.store.circles.find((c) => c._id === MINDFUL._id).memberCount, 13)
})

test('redeemInvite：写成员关系失败时还原邀请码（撞唯一索引 → 40901；其他错误 → 报错），成员数不变', async () => {
  const db = world({ invites: [inviteDoc('RBACK123', MINDFUL._id, ID.alice, { now: NOW })] })
  const dup = await redeem(failing(db, 'memberships', 'add', () => new Error('E11000 duplicate key error')), ID.carol, 'RBACK123')
  assert.equal(dup.code, 40901)
  assert.equal(invite(db, 'RBACK123').usedBy, null)
  const boom = await redeem(failing(db, 'memberships', 'add', () => new Error('boom')), ID.carol, 'RBACK123')
  assert.notEqual(boom.code, 0)
  assert.notEqual(boom.code, 40901)
  assert.equal(invite(db, 'RBACK123').usedBy, null)
  assert.equal(invite(db, 'RBACK123').usedAt, null)
  assert.equal(db.store.circles.find((c) => c._id === MINDFUL._id).memberCount, 12)
  assert.equal((await redeem(db, ID.carol, 'RBACK123')).code, 0, '还原后仍可正常兑换')
})

test('redeemInvite：账号门槛——未登录 40101、未确认 18+ 40303、未实名 40302、封禁 40304；禁言不影响入圈', async () => {
  const db = world({
    users: [{ _openid: 'acct-nophone', adultConfirmedAt: 1 }, { _openid: 'acct-banned', ...ok, bannedUntil: NOW + 100 * DAY }, { _openid: 'acct-muted', ...ok, mutedUntil: NOW + 100 * DAY }],
    invites: ['AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC', 'DDDDDDDD', 'EEEEEEEE'].map((c) => inviteDoc(c, MINDFUL._id, ID.alice, { now: NOW })),
  })
  assert.equal((await redeem(db, null, 'AAAAAAAA')).code, 40101)
  assert.equal((await redeem(db, ID.kid, 'AAAAAAAA')).code, 40303)
  assert.equal((await redeem(db, 'acct-nophone', 'AAAAAAAA')).code, 40302)
  assert.equal((await redeem(db, 'acct-banned', 'AAAAAAAA')).code, 40304)
  assert.equal(invite(db, 'AAAAAAAA').usedBy, null)
  assert.equal((await redeem(db, 'acct-muted', 'AAAAAAAA')).code, 0)
  assert.ok(memberOf(db, MINDFUL._id, 'acct-muted'))
})

test('过期退名额：三个请求同时回收同一个过期码——只退 1 次', async () => {
  const db = world({ invites: [inviteDoc('EXPRED01', MINDFUL._id, ID.alice, { now: NOW - 10 * DAY })] })
  const rs = await Promise.all([list(db, ID.alice), list(db, ID.alice), create(db, ID.alice)])
  assert.ok(rs.every((r) => r.code === 0))
  // 初始 3 + 退 1 = 4，其中 createInvite 扣 1 → 3
  assert.equal(user(db, ID.alice).inviteQuota, 3)
  assert.equal(invite(db, 'EXPRED01').refunded, true)
})

