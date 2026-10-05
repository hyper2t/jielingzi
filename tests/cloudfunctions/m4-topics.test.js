'use strict'
/**
 * M4 话题的圈子成员校验（BE-M4-03）：发帖选圈子、话题流聚合 / 过滤、详情 / 回复 / 举报的越权拒绝（40401 / 40301）、
 * 旧话题（无圈子）不可见、审核员无读圈内内容的特权、删除自己的内容不要求成员。用例索引 docs/test/cases/M4.md。
 */
const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const S = require('../../cloudfunctions/_shared')
const community = require('../../cloudfunctions/community/service')
const moderation = require('../../cloudfunctions/moderation/service')
const { createFakeDb } = require('./fakeDb')
const { CIRCLE_UNIQUE, circleDoc, memberDoc, inviteDoc } = require('./circleFixtures')

beforeEach(() => S.restoreOwnedCollections())
const NOW = Date.UTC(2026, 9, 1, 4, 0, 0)
const silent = { info() {}, error() {} }
let tick = NOW
const ID = { alice: 'acct-alice-001', bob: 'acct-bob-002', carol: 'acct-carol-004', dan: 'acct-dan-005', mod: 'acct-mod-007' }
const ok = { adultConfirmedAt: 1, phoneVerified: true }
const MINDFUL = circleDoc({ slug: 'mindful', name: '静观练习', sort: 1, topicCount: 5 })
const TRADITION = circleDoc({ slug: 'tradition', name: '传统养生', sort: 2 })
const CLOSED = circleDoc({ slug: 'old', name: '已关闭的圈子', sort: 3, status: 'closed' })
const BODY = '今天站桩二十分钟，感觉呼吸慢慢沉下来，身体也松开了很多，心里安静了。'.repeat(2)
const NOT_FOUND = '话题不存在或已删除'
let seq = 0

/** alice：静观 + 传统 + 已关闭圈子；bob：静观；dan：传统；carol / mod：没加入任何圈子 */
function world(extra = {}) {
  const topic = (id, circleId, o = {}) => ({ _id: id, _openid: ID.bob, circleId, anon: false, title: `话题标题 ${id}`, body: BODY, tags: [], status: 'ok', replyCount: 0, reportCount: 0, createdAt: NOW + ++seq, lastReplyAt: NOW + seq, ...o })
  const legacy = topic('legacy-missing', null)
  delete legacy.circleId
  return createFakeDb({
    unique: { profiles: ['_openid', 'anonAlias'], ...CIRCLE_UNIQUE },
    data: {
      users: [ID.alice, ID.bob, ID.carol, ID.dan].map((_openid) => ({ _openid, ...ok })).concat([{ _openid: ID.mod, ...ok, role: 'mod' }]),
      circles: [MINDFUL, TRADITION, CLOSED],
      memberships: [
        memberDoc(MINDFUL._id, ID.alice), memberDoc(TRADITION._id, ID.alice), memberDoc(CLOSED._id, ID.alice),
        memberDoc(MINDFUL._id, ID.bob), memberDoc(TRADITION._id, ID.dan),
      ],
      topics: [
        topic('m1', MINDFUL._id), topic('m2', MINDFUL._id), topic('t1', TRADITION._id, { _openid: ID.dan }), topic('c1', CLOSED._id),
        topic('legacy-null', null), legacy, topic('pending-m', MINDFUL._id, { status: 'pending', _openid: ID.alice }),
      ],
      replies: [{ _id: 'r-m1', _openid: ID.bob, topicId: 'm1', circleId: MINDFUL._id, body: '我也有同感', status: 'ok', short: true, anon: false, createdAt: NOW + 1000 }],
      ...extra,
    },
  })
}
const as = (db, accountId) =>
  S.createMain({ actions: community.actions, logger: silent, createContext: async () => ({ db, identity: accountId === null ? {} : { openid: accountId }, now: () => ++tick, logger: silent }) })
const modAs = (db, accountId) =>
  S.createMain({ actions: moderation.actions, logger: silent, createContext: async () => ({ db, identity: { openid: accountId }, now: () => ++tick, logger: silent }) })
const create = (me, p = {}) => me({ action: 'createTopic', title: '如何面对练习中的枯燥期', body: BODY, ...p })
const circleDocOf = (db, id) => db.store.circles.find((c) => c._id === id)
const noLeak = (data) => {
  const s = JSON.stringify(data)
  for (const f of ['_openid', '"circleId"', 'memberships']) assert.ok(!s.includes(f), `返回体含 ${f}`)
}

// ---------- createTopic ----------
test('createTopic：指定圈子——必须是我加入的开放圈子；返回 circle { id, name }，圈子话题数 +1', async () => {
  const db = world()
  const r = await create(as(db, ID.alice), { circleId: TRADITION._id })
  assert.equal(r.code, 0)
  assert.deepEqual(r.data.topic.circle, { id: TRADITION._id, name: '传统养生' })
  assert.equal(db.store.topics.find((t) => t._id === r.data.topic.id).circleId, TRADITION._id)
  assert.equal(circleDocOf(db, TRADITION._id).topicCount, 1)
  assert.equal(circleDocOf(db, MINDFUL._id).topicCount, 5, '别的圈子不动')
  noLeak(r.data)
})

test('createTopic：不是成员 / 圈子不存在 / 圈子已关闭 → 40301，不落库、不占日额度', async () => {
  const db = world()
  for (const [who, circleId] of [[ID.bob, TRADITION._id], [ID.carol, MINDFUL._id], [ID.alice, 'no-such-circle'], [ID.alice, CLOSED._id]]) {
    const r = await create(as(db, who), { circleId })
    assert.equal(r.code, 40301, `${who} → ${circleId}`)
    assert.equal(r.msg, '加入圈子后才能发帖')
  }
  assert.equal((await create(as(db, ID.alice), { circleId: 12345 })).code, 40001)
  assert.equal((await create(as(db, ID.alice), { circleId: 'bad id!' })).code, 40001)
  assert.equal(db.store.topics.length, 7, '没有新增话题')
  assert.equal((db.store.rate_limits || []).length, 0, '被拒绝不占额度')
})

test('createTopic：不指定圈子——恰好加入 1 个自动归属；加入多个要选（40001）；没加入任何圈子 40301', async () => {
  const db = world()
  const bob = await create(as(db, ID.bob))
  assert.equal(bob.code, 0)
  assert.deepEqual(bob.data.topic.circle, { id: MINDFUL._id, name: '静观练习' })
  assert.equal((await create(as(db, ID.bob), { circleId: null })).code, 0, 'null 视同不传')
  const alice = await create(as(db, ID.alice))
  assert.equal(alice.code, 40001)
  assert.equal(alice.msg, '请选择圈子')
  const carol = await create(as(db, ID.carol))
  assert.equal(carol.code, 40301)
  assert.equal(carol.msg, '加入圈子后才能发帖')
})

test('createTopic：已关闭圈子不计入「我的圈子」——只剩 1 个开放圈子时仍可默认归属', async () => {
  const db = world({ memberships: [memberDoc(MINDFUL._id, ID.alice), memberDoc(CLOSED._id, ID.alice)] })
  const r = await create(as(db, ID.alice))
  assert.equal(r.code, 0)
  assert.equal(r.data.topic.circle.id, MINDFUL._id)
})

// ---------- listTopics ----------
test('listTopics：不传圈子 = 聚合我所有开放圈子；旧话题 / 已关闭圈子 / 别的圈子 / 待复核的都不出现；每条带 circle', async () => {
  const db = world()
  const alice = (await as(db, ID.alice)({ action: 'listTopics' })).data
  assert.deepEqual(alice.list.map((t) => t.title).sort(), ['话题标题 m1', '话题标题 m2', '话题标题 t1'])
  assert.equal(alice.total, 3)
  assert.deepEqual(alice.list.map((t) => [t.title.slice(-2), t.circle.name]).sort(), [['m1', '静观练习'], ['m2', '静观练习'], ['t1', '传统养生']])
  noLeak(alice)
  const bob = (await as(db, ID.bob)({ action: 'listTopics' })).data
  assert.deepEqual(bob.list.map((t) => t.circle.id), [MINDFUL._id, MINDFUL._id])
  assert.equal(bob.total, 2)
  const dan = (await as(db, ID.dan)({ action: 'listTopics' })).data
  assert.deepEqual(dan.list.map((t) => t.title), ['话题标题 t1'])
})

test('listTopics：传圈子只看该圈；不是成员 / 不存在 / 已关闭 → 40301；没有任何圈子 → 空列表（不是错误）；审核员也一样', async () => {
  const db = world()
  const t = (await as(db, ID.alice)({ action: 'listTopics', circleId: TRADITION._id })).data
  assert.deepEqual(t.list.map((x) => x.title), ['话题标题 t1'])
  for (const [who, circleId] of [[ID.bob, TRADITION._id], [ID.carol, MINDFUL._id], [ID.alice, 'nope'], [ID.alice, CLOSED._id], [ID.mod, MINDFUL._id]]) {
    const r = await as(db, who)({ action: 'listTopics', circleId })
    assert.equal(r.code, 40301, `${who} → ${circleId}`)
    assert.equal(r.msg, '加入圈子后才能查看')
  }
  for (const who of [ID.carol, ID.mod]) {
    const r = await as(db, who)({ action: 'listTopics' })
    assert.equal(r.code, 0)
    assert.deepEqual(r.data, { list: [], total: 0, page: 1, size: 20, hasMore: false })
  }
  // 分页仍按聚合后的总数
  const p = (await as(db, ID.alice)({ action: 'listTopics', size: 2 })).data
  assert.deepEqual([p.list.length, p.total, p.hasMore], [2, 3, true])
})

// ---------- getTopic / listReplies / createReply ----------
test('getTopic / listReplies / createReply：不是成员、旧话题、已关闭圈子——一律 40401，与「不存在」同一句话（防遍历 ID）', async () => {
  const db = world()
  const cases = [
    ['非成员（carol）读静观话题', ID.carol, 'm1'],
    ['非成员（bob）读传统话题', ID.bob, 't1'],
    ['审核员无特权', ID.mod, 'm1'],
    ['旧话题（circleId = null）对所有人不可见：bob', ID.bob, 'legacy-null'],
    ['旧话题（无 circleId 字段）：alice', ID.alice, 'legacy-missing'],
    ['作者本人也读不到旧话题', ID.bob, 'legacy-null'],
    ['圈子已关闭（alice 是成员）', ID.alice, 'c1'],
    ['话题不存在', ID.alice, 'nope'],
  ]
  for (const [name, who, id] of cases) {
    const g = await as(db, who)({ action: 'getTopic', id })
    assert.equal(g.code, 40401, `getTopic：${name}`)
    assert.equal(g.msg, NOT_FOUND, name)
    const l = await as(db, who)({ action: 'listReplies', topicId: id })
    assert.equal(l.code, 40401, `listReplies：${name}`)
    const c = await as(db, who)({ action: 'createReply', topicId: id, body: '想说点什么，认真地回复一下。' })
    assert.equal(c.code, 40401, `createReply：${name}`)
  }
  assert.equal(db.store.replies.length, 1, '没有新增回复')
  assert.equal((db.store.rate_limits || []).length, 0, '被拒绝不占额度')
  assert.equal(db.store.topics.find((t) => t._id === 'm1').replyCount, 0)
})

test('成员正常读写：getTopic 带 circle；回复落库带圈子；待复核的话题仍只有作者本人看得到', async () => {
  const db = world()
  const g = await as(db, ID.bob)({ action: 'getTopic', id: 'm1' })
  assert.equal(g.code, 0)
  assert.deepEqual(g.data.topic.circle, { id: MINDFUL._id, name: '静观练习' })
  noLeak(g.data)
  const l = await as(db, ID.alice)({ action: 'listReplies', topicId: 'm1' })
  assert.deepEqual(l.data.list.map((r) => r.id), ['r-m1'])
  const c = await as(db, ID.alice)({ action: 'createReply', topicId: 'm1', body: '谢谢分享，我也在慢慢体会这种感觉。' })
  assert.equal(c.code, 0)
  assert.equal(db.store.replies.find((r) => r._id === c.data.reply.id).circleId, MINDFUL._id)
  assert.equal((await as(db, ID.alice)({ action: 'getTopic', id: 'pending-m' })).code, 0, '作者看自己待复核的')
  assert.equal((await as(db, ID.bob)({ action: 'getTopic', id: 'pending-m' })).code, 40401)
})

// ---------- deleteMine ----------
test('deleteMine：不要求仍是成员——旧话题 / 圈外的作者也能删自己的内容；话题数随之 −1', async () => {
  const db = world({ memberships: [memberDoc(MINDFUL._id, ID.alice)] })
  db.store.topics.push({ _id: 'carol-t', _openid: ID.carol, circleId: TRADITION._id, anon: false, title: '她已不在这个圈子', body: BODY, status: 'ok', createdAt: NOW + 5000 })
  const mine = await as(db, ID.carol)({ action: 'deleteMine', type: 'topic', id: 'carol-t' })
  assert.deepEqual(mine.data, { ok: true, changed: true })
  assert.equal(circleDocOf(db, TRADITION._id).topicCount, 0, '话题数是近似值，已经是 0 就不再往下减')
  const legacy = await as(db, ID.bob)({ action: 'deleteMine', type: 'topic', id: 'legacy-null' })
  assert.deepEqual(legacy.data, { ok: true, changed: true })
  const before = circleDocOf(db, MINDFUL._id).topicCount
  const own = await as(db, ID.bob)({ action: 'deleteMine', type: 'topic', id: 'm1' })
  assert.equal(own.data.changed, true)
  assert.equal(circleDocOf(db, MINDFUL._id).topicCount, before - 1)
  assert.equal((await as(db, ID.carol)({ action: 'deleteMine', type: 'topic', id: 'm2' })).code, 40401, '不是作者仍然 40401')
})

// ---------- moderation ----------
test('report：只有内容所在圈子的成员能举报；旧话题 / 非成员 / 审核员（非成员）一律 40401，且不落库', async () => {
  const db = world()
  const rep = (who, targetId, targetType = 'topic') => modAs(db, who)({ action: 'report', targetType, targetId, reason: 'spam' })
  assert.equal((await rep(ID.carol, 'm1')).code, 40401)
  assert.equal((await rep(ID.bob, 't1')).code, 40401)
  assert.equal((await rep(ID.mod, 'm1')).code, 40401)
  assert.equal((await rep(ID.alice, 'legacy-null')).code, 40401)
  assert.equal((await rep(ID.alice, 'legacy-missing')).code, 40401)
  assert.equal((await rep(ID.carol, 'r-m1', 'reply')).code, 40401)
  assert.equal((db.store.reports || []).length, 0)
  assert.equal((await rep(ID.alice, 'm1')).code, 0)
  assert.equal((await rep(ID.alice, 'r-m1', 'reply')).code, 0)
  assert.equal(db.store.reports.length, 2)
})

test('审核员没有读圈内内容的特权，但仍能处理：队列只给摘要（无正文 / 圈子 / 账号标识），decide remove 生效', async () => {
  const db = world()
  await Promise.all([ID.alice].map((who) => modAs(db, who)({ action: 'report', targetType: 'topic', targetId: 'm1', reason: 'medical', note: '说能治病' })))
  assert.equal((await as(db, ID.mod)({ action: 'getTopic', id: 'm1' })).code, 40401)
  assert.equal((await as(db, ID.mod)({ action: 'listReplies', topicId: 'm1' })).code, 40401)
  const q = await modAs(db, ID.mod)({ action: 'queue' })
  assert.equal(q.code, 0)
  assert.equal(q.data.list.length, 1)
  assert.deepEqual(q.data.list[0].target, { status: 'ok', excerpt: '话题标题 m1', anon: false, authorDeleted: false, featured: false })
  const s = JSON.stringify(q.data)
  for (const bad of ['circle', 'memberships', '_openid', ID.alice, ID.bob, BODY.slice(0, 10)]) assert.ok(!s.includes(bad), `队列不应包含 ${bad}`)
  const d = await modAs(db, ID.mod)({ action: 'decide', targetType: 'topic', targetId: 'm1', decision: 'remove', note: '疗效承诺' })
  assert.equal(d.code, 0)
  assert.equal(db.store.topics.find((t) => t._id === 'm1').status, 'removed')
})

// ---------- 与邀请码联动 ----------
test('邀请码入圈后立即获得读写权：新人兑换前读不到、发不了；兑换后话题流有内容，发帖默认归到该圈', async () => {
  const db = world({ invites: [inviteDoc('FREE2026', MINDFUL._id, null, { now: NOW })] })
  const carol = as(db, ID.carol)
  assert.equal((await carol({ action: 'getTopic', id: 'm1' })).code, 40401)
  assert.equal((await create(carol)).code, 40301)
  assert.deepEqual((await carol({ action: 'listTopics' })).data.list, [])
  const joined = await carol({ action: 'redeemInvite', code: 'free2026' })
  assert.equal(joined.code, 0)
  assert.equal((await carol({ action: 'listTopics' })).data.total, 2)
  assert.equal((await carol({ action: 'getTopic', id: 'm1' })).code, 0)
  const made = await create(carol)
  assert.equal(made.code, 0)
  assert.equal(made.data.topic.circle.id, MINDFUL._id)
  assert.equal((await carol({ action: 'createReply', topicId: 'm1', body: '刚加入这个圈子，先来打个招呼。' })).code, 0)
  assert.equal((await as(db, ID.dan)({ action: 'getTopic', id: 'm1' })).code, 40401, '别的圈子的成员仍然看不到')
})
