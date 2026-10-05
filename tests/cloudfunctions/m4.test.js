'use strict'
/**
 * M4 官方圈子与邀请码：BE-M4-01 listCircles / getCircle（本文件先写圈子部分，邀请码与成员校验随后续任务追加）。
 * 前置夹具见 circleFixtures.js；用例索引见 docs/test/cases/M4.md。
 */
const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const S = require('../../cloudfunctions/_shared')
const community = require('../../cloudfunctions/community/service')
const { myCircleIds, isMember } = require('../../cloudfunctions/community/circles')
const { createFakeDb } = require('./fakeDb')
const { CIRCLE_UNIQUE, circleDoc, memberDoc } = require('./circleFixtures')

beforeEach(() => S.restoreOwnedCollections())

const NOW = Date.UTC(2026, 9, 1, 4, 0, 0)
const silent = { info() {}, error() {} }
const ADULT = { adultConfirmedAt: 1 }
let tick = NOW

/** 账号 id 故意取得足够独特，便于在返回体里搜索泄露 */
const ID = { alice: 'acct-alice-001', bob: 'acct-bob-002', kid: 'acct-kid-003' }

const MINDFUL = circleDoc({ slug: 'mindful', name: '静观练习', desc: '冥想、正念、内观的日常练习与困惑', sort: 1, memberCount: 12, topicCount: 30, rules: ['说具体：做法、时长、当时的感受，少下结论。', '不评判他人的练习方式。'] })
const TRADITION = circleDoc({ slug: 'tradition', name: '传统养生', desc: '太极、站桩、传统养生功法的身体经验', sort: 2 })
const LIFESTYLE = circleDoc({ slug: 'lifestyle', name: '正念生活', desc: '把练习带进工作、家庭与日常', sort: 3 })
const CLOSED = circleDoc({ slug: 'old', name: '已关闭的圈子', sort: 0, status: 'closed' })

function world({ circles = [MINDFUL, TRADITION, LIFESTYLE, CLOSED], memberships } = {}) {
  return createFakeDb({
    unique: { profiles: ['_openid', 'anonAlias'], ...CIRCLE_UNIQUE },
    data: {
      users: [
        { _openid: ID.alice, ...ADULT, phoneVerified: true },
        { _openid: ID.bob, ...ADULT, phoneVerified: true },
        { _openid: ID.kid, phoneVerified: true },
      ],
      circles,
      memberships: memberships || [
        memberDoc(MINDFUL._id, ID.alice, { invitedBy: 'acct-secret-inviter' }),
        memberDoc(TRADITION._id, ID.alice),
        memberDoc(MINDFUL._id, ID.bob),
        memberDoc(LIFESTYLE._id, 'acct-someone-else-009'),
      ],
    },
  })
}
const as = (db, accountId) =>
  S.createMain({ actions: community.actions, logger: silent, createContext: async () => ({ db, identity: accountId === null ? {} : { openid: accountId }, now: () => ++tick, logger: silent }) })

const LIST_KEYS = ['cover', 'desc', 'id', 'joined', 'memberCount', 'name', 'slug', 'topicCount']

/** 返回体里不得出现内部字段与任何账号 id（成员名单、邀请人等） */
function assertNoLeak(data) {
  const s = JSON.stringify(data)
  for (const f of ['_openid', '_id', 'invitedBy', 'inviteCode', 'usedBy', 'status', 'sort', 'joinedAt', 'role']) assert.ok(!s.includes(`"${f}"`), `返回体含内部字段 ${f}`)
  for (const id of [...Object.values(ID), 'acct-secret-inviter', 'acct-someone-else-009']) assert.ok(!s.includes(id), `返回体含账号标识 ${id}`)
}

// ---------- BE-M4-01 listCircles ----------

test('listCircles：只含 open，按 sort；成员标 joined；字段是白名单，不含公约 / 成员信息', async () => {
  const db = world()
  const r = await as(db, ID.alice)({ action: 'listCircles' })
  assert.equal(r.code, 0)
  assert.deepEqual(r.data.list.map((c) => [c.slug, c.joined]), [['mindful', true], ['tradition', true], ['lifestyle', false]])
  assert.deepEqual(Object.keys(r.data.list[0]).sort(), LIST_KEYS)
  assert.deepEqual(r.data.list[0], { id: MINDFUL._id, slug: 'mindful', name: '静观练习', desc: '冥想、正念、内观的日常练习与困惑', cover: 'circle:mindful', memberCount: 12, topicCount: 30, joined: true })
  assert.ok(!('rules' in r.data.list[0]))
  assert.ok(!r.data.list.some((c) => c.slug === 'old'), '已关闭的圈子不应出现')
  assertNoLeak(r.data)
})

test('listCircles：没有加入任何圈子的人也能看到全部开放圈子（未入圈引导页），joined 全为 false', async () => {
  const db = world({ memberships: [] })
  const r = await as(db, ID.alice)({ action: 'listCircles' })
  assert.equal(r.code, 0)
  assert.equal(r.data.list.length, 3)
  assert.ok(r.data.list.every((c) => c.joined === false))
})

test('listCircles：joined 只看自己的成员关系（别人的不算）；同 sort 按 slug 稳定排序', async () => {
  const a = circleDoc({ slug: 'bbb', sort: 5, name: 'B' })
  const b = circleDoc({ slug: 'aaa', sort: 5, name: 'A' })
  const c = circleDoc({ slug: 'zzz', sort: 1, name: 'Z' })
  const db = world({ circles: [a, b, c], memberships: [memberDoc(a._id, ID.bob)] })
  const r = await as(db, ID.alice)({ action: 'listCircles' })
  assert.deepEqual(r.data.list.map((x) => x.slug), ['zzz', 'aaa', 'bbb'])
  assert.ok(r.data.list.every((x) => x.joined === false))
  const rb = await as(db, ID.bob)({ action: 'listCircles' })
  assert.deepEqual(rb.data.list.filter((x) => x.joined).map((x) => x.slug), ['bbb'])
})

test('listCircles：参数一律 40001；未确认 18+ 40303；拿不到身份 40101', async () => {
  const db = world()
  assert.equal((await as(db, ID.alice)({ action: 'listCircles', page: 1 })).code, 40001)
  assert.equal((await as(db, ID.alice)({ action: 'listCircles', circleId: 'x' })).code, 40001)
  assert.equal((await as(db, ID.kid)({ action: 'listCircles' })).code, 40303)
  assert.equal((await as(db, null)({ action: 'listCircles' })).code, 40101)
  assert.equal((await as(db, 'acct-nobody-404')({ action: 'listCircles' })).code, 40101, '没有用户记录按未登录处理')
})

test('listCircles：circles / memberships 集合还没建时返回空列表，不报错', async () => {
  const db = createFakeDb({ strictCollections: true, data: { users: [{ _openid: ID.alice, ...ADULT }] } })
  const r = await as(db, ID.alice)({ action: 'listCircles' })
  assert.equal(r.code, 0)
  assert.deepEqual(r.data, { list: [] })
})

test('listCircles：库里的脏数据不会让展示崩溃或泄露（计数为负 / 非数字 → 0，缺字段 → 空串 / null）', async () => {
  const dirty = { _id: 'circle-dirty', slug: 'dirty', status: 'open', sort: 1, memberCount: -5, topicCount: 'x', name: 123, _openid: 'acct-leak-777', secret: 'x' }
  const db = world({ circles: [dirty], memberships: [] })
  const r = await as(db, ID.alice)({ action: 'listCircles' })
  assert.deepEqual(r.data.list[0], { id: 'circle-dirty', slug: 'dirty', name: '', desc: '', cover: null, memberCount: 0, topicCount: 0, joined: false })
  assert.ok(!JSON.stringify(r.data).includes('acct-leak-777'))
})

// ---------- BE-M4-01 getCircle ----------

test('getCircle：成员与非成员都能看到简介和公约；joined 正确；不含成员信息', async () => {
  const db = world()
  const mine = await as(db, ID.alice)({ action: 'getCircle', id: MINDFUL._id })
  assert.equal(mine.code, 0)
  assert.equal(mine.data.circle.joined, true)
  assert.deepEqual(mine.data.circle.rules, ['说具体：做法、时长、当时的感受，少下结论。', '不评判他人的练习方式。'])
  assert.deepEqual(Object.keys(mine.data.circle).sort(), [...LIST_KEYS, 'rules'].sort())
  assertNoLeak(mine.data)
  const other = await as(db, ID.bob)({ action: 'getCircle', id: LIFESTYLE._id })
  assert.equal(other.code, 0)
  assert.equal(other.data.circle.joined, false)
  assert.equal(other.data.circle.name, '正念生活')
  assert.deepEqual(other.data.circle.rules, LIFESTYLE.rules)
})

test('getCircle：不存在 / 已关闭 40401；id 缺失或格式错 / 夹带参数 40001；未确认 18+ 40303；无身份 40101', async () => {
  const db = world()
  const me = as(db, ID.alice)
  assert.equal((await me({ action: 'getCircle', id: 'circle-nope' })).code, 40401)
  assert.equal((await me({ action: 'getCircle', id: CLOSED._id })).code, 40401)
  assert.equal((await me({ action: 'getCircle' })).code, 40001)
  assert.equal((await me({ action: 'getCircle', id: 'a b/c' })).code, 40001)
  assert.equal((await me({ action: 'getCircle', id: MINDFUL._id, extra: 1 })).code, 40001)
  assert.equal((await as(db, ID.kid)({ action: 'getCircle', id: MINDFUL._id })).code, 40303)
  assert.equal((await as(db, null)({ action: 'getCircle', id: MINDFUL._id })).code, 40101)
})

test('getCircle：公约兜底——非数组 → 空；只留非空字符串；最多 5 条', async () => {
  const many = circleDoc({ slug: 'many', rules: ['1', '2', '3', '4', '5', '6', '7'] })
  const messy = circleDoc({ slug: 'messy', rules: ['  ', 42, null, '有效的一条', { a: 1 }] })
  const none = circleDoc({ slug: 'none', rules: 'not-an-array' })
  const db = world({ circles: [many, messy, none], memberships: [] })
  const get = async (c) => (await as(db, ID.alice)({ action: 'getCircle', id: c._id })).data.circle.rules
  assert.deepEqual(await get(many), ['1', '2', '3', '4', '5'])
  assert.deepEqual(await get(messy), ['有效的一条'])
  assert.deepEqual(await get(none), [])
})

// ---------- 成员关系读取（话题校验、邀请签发共用） ----------

test('myCircleIds / isMember：只看自己的成员关系；去重；无关系或集合不存在 → 空 / false', async () => {
  const db = world()
  assert.deepEqual((await myCircleIds(db, ID.alice)).sort(), [MINDFUL._id, TRADITION._id].sort())
  assert.deepEqual(await myCircleIds(db, ID.bob), [MINDFUL._id])
  assert.deepEqual(await myCircleIds(db, ID.kid), [])
  assert.deepEqual(await myCircleIds(db, null), [])
  assert.equal(await isMember(db, ID.alice, TRADITION._id), true)
  assert.equal(await isMember(db, ID.bob, TRADITION._id), false)
  assert.equal(await isMember(db, ID.alice, null), false)
  const bare = createFakeDb({ strictCollections: true })
  assert.deepEqual(await myCircleIds(bare, ID.alice), [])
  assert.equal(await isMember(bare, ID.alice, 'x'), false)
})

test('话题接口不受影响：M4 前的 listTopics 仍可调用（成员校验在 BE-M4-03 接入）', async () => {
  const db = world()
  const r = await as(db, ID.alice)({ action: 'listTopics' })
  assert.equal(r.code, 0)
})
