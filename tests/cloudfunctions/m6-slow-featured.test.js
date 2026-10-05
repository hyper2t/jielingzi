'use strict'
/**
 * BE-M6-02：慢话题 `slowUntil`（m6-plan D11）与精华 `featured`（D12）。
 * 覆盖：`createTopic` 的 `slow` 入参与落库字段、冷静期的时间边界（差 1ms 不可回 / 到点可回）、
 * 被拒的回复不扣当日额度也不发机审、作者自己同样受限、已有回复不受影响、旧话题缺字段的兜底、
 * `listTopics` 的 `featured` 筛选（只含 ok、不越圈）、`moderation.markFeatured` 的权限 / 幂等 / mod_logs。
 * 用例编号已登记在 docs/test/cases/M6.md（M6-A06 / M6-A07；队列快照的 featured 属 M6-A18），三端与真机项见同文件第 2 节。
 */
const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const S = require('../../cloudfunctions/_shared')
const community = require('../../cloudfunctions/community/service')
const moderation = require('../../cloudfunctions/moderation/service')
const { RATE_COLLECTION } = require('../../cloudfunctions/_shared/guard')
const { TOPIC_RULES, cnDate } = require('../../cloudfunctions/_shared/config')
const { createFakeDb } = require('./fakeDb')
const { CIRCLE_UNIQUE, circleDoc, memberDoc } = require('./circleFixtures')

beforeEach(() => {
  S.restoreOwnedCollections()
  clock.t = NOW // 时钟是模块级的：逐例复位，否则上一例推进的时间会串到边界断言里
  screenCalls = 0
})

const NOW = Date.UTC(2026, 9, 3, 4, 0, 0)
const DAY = 24 * 3600 * 1000
const HOUR = 3600 * 1000
const silent = { info() {}, error() {} }
const ID = {
  alice: 'acct-slow-alice', bob: 'acct-slow-bob', dan: 'acct-slow-dan', mod: 'acct-slow-mod', admin: 'acct-slow-admin',
}
const MINDFUL = circleDoc({ slug: 'slow-mindful', name: '静观练习', sort: 1 })
const TRADITION = circleDoc({ slug: 'slow-tradition', name: '传统养生', sort: 2 })
const TITLE = '如何面对练习中的枯燥期'
const BODY = '今天站桩二十分钟，感觉呼吸慢慢沉下来，身体也松开了很多，想听听大家是怎么熬过这一段。'.repeat(2)
const REPLY = '我那段是靠把坐香缩短到十分钟熬过来的，先把次数稳住再谈时长。'
const SLOW_MSG = '这条话题还没开放回复'
const SLOW_MS = TOPIC_RULES.slowHours * HOUR

/** 固定时钟：一次调用里 ctx.now() 恒定，时间边界才算得准（自增时钟会把边界推偏 1ms） */
const clock = { t: NOW }
let screenCalls = 0
const spy = { checkText: async () => { screenCalls += 1; return { verdict: 'pass', hits: [], labels: [] } } }

/** alice / bob 同时在两个圈子；dan 只在传统养生（用来证明「精华不解除成员校验」）；mod / admin 不入圈 */
function world (extra = {}) {
  const topic = (id, o = {}) => ({
    _id: id, _openid: ID.bob, circleId: MINDFUL._id, anon: false, title: `话题 ${id}`, body: BODY, tags: [],
    images: [], status: 'ok', featured: false, slowUntil: null, replyCount: 0, reportCount: 0,
    createdAt: NOW - 2 * DAY, lastReplyAt: NOW - 2 * DAY, ...o,
  })
  return createFakeDb({
    unique: { profiles: ['_openid', 'anonAlias'], ...CIRCLE_UNIQUE },
    data: {
      users: [
        { _openid: ID.alice, adultConfirmedAt: 1, phoneVerified: true },
        { _openid: ID.bob, adultConfirmedAt: 1, phoneVerified: true },
        { _openid: ID.dan, adultConfirmedAt: 1, phoneVerified: true },
        { _openid: ID.mod, adultConfirmedAt: 1, phoneVerified: true, role: 'mod' },
        { _openid: ID.admin, adultConfirmedAt: 1, phoneVerified: true, role: 'admin' },
      ],
      circles: [MINDFUL, TRADITION],
      memberships: [
        memberDoc(MINDFUL._id, ID.alice), memberDoc(MINDFUL._id, ID.bob),
        memberDoc(TRADITION._id, ID.alice), memberDoc(TRADITION._id, ID.bob), memberDoc(TRADITION._id, ID.dan),
      ],
      profiles: [
        { _openid: ID.alice, nickname: '甲', anonAlias: '甲的花名' },
        { _openid: ID.bob, nickname: '乙', anonAlias: '乙的花名' },
        { _openid: ID.dan, nickname: '丁', anonAlias: '丁的花名' },
      ],
      topics: [
        topic('t-plain'),
        topic('t-slow', { _openid: ID.alice }),
        topic('t-feat', { featured: true }),
        topic('t-feat-pending', { featured: true, status: 'pending', _openid: ID.alice }),
        topic('t-feat-tradition', { circleId: TRADITION._id, featured: true, _openid: ID.dan }),
      ],
      replies: [
        { _id: 'r-old', _openid: ID.bob, topicId: 't-slow', circleId: MINDFUL._id, body: '我之前也卡在这段', status: 'ok', short: false, anon: false, createdAt: NOW - DAY },
      ],
      ...extra,
    },
  })
}

function call (db, fn, action, p = {}, who = ID.alice) {
  const main = S.createMain({
    actions: fn === 'community' ? community.actions : moderation.actions,
    logger: silent,
    createContext: async () => ({ db, identity: { openid: who }, now: () => clock.t, logger: silent, moderation: spy }),
  })
  return main({ action, ...p })
}
const comm = (db, action, p = {}, who = ID.alice) => call(db, 'community', action, p, who)
const create = (db, p = {}, who = ID.alice) => comm(db, 'createTopic', { title: TITLE, body: BODY, ...p }, who)
const topicOf = (db, id) => db.store.topics.find((t) => t._id === id)
const docOf = (db, r) => topicOf(db, r.data.topic.id)
/** 当日已用额度（按调用时的时钟归日，与 guard 同一算法） */
function used (db, accountId, action) {
  const id = `${accountId}:${action}:${cnDate(clock.t)}`
  return (db.store[RATE_COLLECTION] || []).filter((r) => r._id === id).reduce((s, r) => s + (Number(r.count) || 0), 0)
}
const logs = (db) => (db.store.mod_logs || []).filter((l) => l.kind === 'featured')

/* ---------------- createTopic：slow 入参 ---------------- */

test('createTopic：slow=true 落库 slowUntil = createdAt + 24h，返回体与库里一致（D11）', async () => {
  const db = world()
  const r = await create(db, { slow: true, circleId: MINDFUL._id })
  assert.equal(r.code, 0)
  assert.equal(r.data.topic.slowUntil, NOW + SLOW_MS, '返回体带开放时刻')
  const doc = docOf(db, r)
  assert.equal(doc.slowUntil, doc.createdAt + SLOW_MS, 'slowUntil 以 createdAt 为起点')
  assert.equal(doc.featured, false, '发帖不自带精华')
})

test('createTopic：不传 slow 或 slow=false 都不设冷静期；旧话题没有该字段时返回 null', async () => {
  const db = world()
  for (const p of [{}, { slow: false }]) {
    const r = await create(db, { ...p, circleId: MINDFUL._id })
    assert.equal(r.code, 0, JSON.stringify(p))
    assert.equal(r.data.topic.slowUntil, null)
    assert.equal(docOf(db, r).slowUntil, null)
  }
  delete topicOf(db, 't-plain').slowUntil // 模拟 M6 之前入库的旧文档
  const g = await comm(db, 'getTopic', { id: 't-plain' })
  assert.equal(g.code, 0)
  assert.equal(g.data.topic.slowUntil, null, '缺字段兜成 null，前端据此不显示冷静期')
})

test('createTopic：slow 只接受布尔；未知字段照旧拒绝（防夹带写库）', async () => {
  const db = world()
  const bad = await create(db, { slow: 'yes', circleId: MINDFUL._id })
  assert.equal(bad.code, 40001)
  assert.match(bad.msg, /slow/)
  const before = db.store.topics.length
  const unknown = await create(db, { slowUntil: NOW + DAY, circleId: MINDFUL._id })
  assert.equal(unknown.code, 40001)
  assert.equal(db.store.topics.length, before, '两次非法入参都不落库')
})

/* ---------------- createReply：冷静期边界 ---------------- */

test('createReply：冷静期内（差 1ms）40901，不落库、不扣额度、不发机审', async () => {
  const db = world()
  const r0 = await create(db, { slow: true, circleId: MINDFUL._id })
  const t = docOf(db, r0)
  clock.t = t.slowUntil - 1
  screenCalls = 0
  const before = db.store.replies.length
  const r = await comm(db, 'createReply', { topicId: t._id, body: REPLY }, ID.bob)
  assert.equal(r.code, 40901)
  assert.equal(r.msg, SLOW_MSG)
  assert.equal(db.store.replies.length, before, '被拒的回复不落库')
  assert.equal(used(db, ID.bob, 'createReply'), 0, 'g.commit() 未执行 → 不扣当日额度')
  assert.equal(screenCalls, 0, '被拒的回复不该走机审')
})

test('createReply：到点即可回复（slowUntil 当刻不算「未到」），并扣一次额度', async () => {
  const db = world()
  const r0 = await create(db, { slow: true, circleId: MINDFUL._id })
  const t = docOf(db, r0)
  clock.t = t.slowUntil
  const r = await comm(db, 'createReply', { topicId: t._id, body: REPLY }, ID.bob)
  assert.equal(r.code, 0, r.msg)
  assert.equal(used(db, ID.bob, 'createReply'), 1)
  assert.equal(topicOf(db, t._id).replyCount, 1, '回复数照常累加')
})

test('createReply：作者自己也要等冷静期（开放回复是给别人的，不是给自己续写的通道）', async () => {
  const db = world()
  const r0 = await create(db, { slow: true, circleId: MINDFUL._id })
  const t = docOf(db, r0)
  clock.t = t.slowUntil - 1000
  const r = await comm(db, 'createReply', { topicId: t._id, body: REPLY }, ID.alice)
  assert.equal(r.code, 40901)
  assert.equal(used(db, ID.alice, 'createReply'), 0)
})

test('冷静期只挡新回复：已有回复照常读，话题详情也照常看', async () => {
  const db = world()
  const slow = topicOf(db, 't-slow')
  slow.slowUntil = NOW + SLOW_MS
  const list = await comm(db, 'listReplies', { topicId: 't-slow' }, ID.bob)
  assert.equal(list.code, 0)
  assert.equal(list.data.list.length, 1)
  assert.equal(list.data.list[0].body, '我之前也卡在这段')
  const g = await comm(db, 'getTopic', { id: 't-slow' }, ID.bob)
  assert.equal(g.code, 0)
  assert.equal(g.data.topic.slowUntil, NOW + SLOW_MS, '详情页靠 slowUntil 自己算剩余时间')
  const r = await comm(db, 'createReply', { topicId: 't-slow', body: REPLY }, ID.bob)
  assert.equal(r.code, 40901)
})

test('createReply：越权（非成员）仍是 40401，不因冷静期改动错误码优先级', async () => {
  const db = world()
  const slow = topicOf(db, 't-slow')
  slow.slowUntil = NOW + SLOW_MS
  const r = await comm(db, 'createReply', { topicId: 't-slow', body: REPLY }, ID.dan)
  assert.equal(r.code, 40401)
})

/* ---------------- listTopics：featured 筛选 ---------------- */

test('listTopics：featured=true 只返回精华，且只含 status=ok', async () => {
  const db = world()
  const r = await comm(db, 'listTopics', { featured: true }, ID.bob)
  assert.equal(r.code, 0)
  const ids = r.data.list.map((t) => t.id).sort()
  assert.deepEqual(ids, ['t-feat', 't-feat-tradition'], 'pending 的精华（t-feat-pending）不出现')
  assert.ok(r.data.list.every((t) => t.featured === true))
  const all = await comm(db, 'listTopics', {}, ID.bob)
  assert.ok(all.data.list.some((t) => t.id === 't-plain'), '不传 featured 时不过滤')
})

test('listTopics：精华不解除圈子成员校验（D12，否则会变成越权通道）', async () => {
  const db = world()
  const dan = await comm(db, 'listTopics', { featured: true }, ID.dan)
  assert.deepEqual(dan.data.list.map((t) => t.id), ['t-feat-tradition'], '只看到自己圈子里的精华')
  const byCircle = await comm(db, 'listTopics', { featured: true, circleId: MINDFUL._id }, ID.bob)
  assert.deepEqual(byCircle.data.list.map((t) => t.id), ['t-feat'])
  const mod = await comm(db, 'listTopics', { featured: true }, ID.mod)
  assert.equal(mod.data.list.length, 0, '审核员没有读圈内内容的特权')
  const notMember = await comm(db, 'listTopics', { featured: true, circleId: MINDFUL._id }, ID.dan)
  assert.equal(notMember.code, 40301)
})

test('listTopics：featured 只接受布尔，且不改变分页字段', async () => {
  const db = world()
  const bad = await comm(db, 'listTopics', { featured: 'yes' }, ID.bob)
  assert.equal(bad.code, 40001)
  const r = await comm(db, 'listTopics', { featured: false, page: 1, size: 1 }, ID.bob)
  assert.equal(r.code, 0)
  assert.deepEqual({ page: r.data.page, size: r.data.size, total: r.data.total }, { page: 1, size: 1, total: 4 })
})

/* ---------------- moderation.markFeatured ---------------- */

test('markFeatured：mod 标精华 → 改 topics.featured 并写 mod_logs（kind=featured），返回 changed=true', async () => {
  const db = world()
  const r = await call(db, 'moderation', 'markFeatured', { topicId: 't-plain', featured: true }, ID.mod)
  assert.deepEqual(r.data, { ok: true, featured: true, changed: true })
  assert.equal(topicOf(db, 't-plain').featured, true)
  assert.equal(topicOf(db, 't-plain').status, 'ok', '标精华不动 status（D12：不改变可见性判定）')
  const l = logs(db)
  assert.equal(l.length, 1)
  assert.match(l[0].action, /feature/)
  assert.equal(l[0].targetType, 'topic')
  assert.equal(l[0].targetId, 't-plain')
  assert.equal(l[0].actor, ID.mod)
  assert.equal(l[0].subject, ID.bob, '被标记者记在日志里，不下发')
  assert.ok(!JSON.stringify(r).includes(ID.bob), '返回体不含任何身份标识')
})

test('markFeatured：二次调用幂等——数据不变、changed=false，但仍留一条审计', async () => {
  const db = world()
  await call(db, 'moderation', 'markFeatured', { topicId: 't-plain', featured: true }, ID.mod)
  const r = await call(db, 'moderation', 'markFeatured', { topicId: 't-plain', featured: true }, ID.mod)
  assert.deepEqual(r.data, { ok: true, featured: true, changed: false })
  assert.equal(topicOf(db, 't-plain').featured, true)
  assert.equal(logs(db).length, 2, '人工操作每次都留痕，便于追溯')
})

test('markFeatured：可以取消精华（即便话题已被下架，也要允许撤销标记）', async () => {
  const db = world()
  topicOf(db, 't-feat').status = 'removed'
  const on = await call(db, 'moderation', 'markFeatured', { topicId: 't-feat', featured: false }, ID.mod)
  assert.deepEqual(on.data, { ok: true, featured: false, changed: true })
  assert.equal(topicOf(db, 't-feat').featured, false)
  const off = await call(db, 'moderation', 'markFeatured', { topicId: 't-feat', featured: false }, ID.admin)
  assert.equal(off.data.changed, false)
})

test('markFeatured：只有正常显示的话题能标为精华（pending / folded / removed 一律 40001）', async () => {
  const db = world()
  for (const [id, status] of [['t-feat-pending', 'pending'], ['t-plain', 'folded'], ['t-slow', 'removed']]) {
    topicOf(db, id).status = status
    const r = await call(db, 'moderation', 'markFeatured', { topicId: id, featured: true }, ID.mod)
    assert.equal(r.code, 40001, `${id} ${status}`)
    assert.equal(topicOf(db, id).featured, id === 't-feat-pending', '被拒时不写库')
  }
  assert.equal(logs(db).length, 0, '校验不过不写 mod_logs')
})

test('markFeatured：非 mod / admin → 40301 且不改数据；话题不存在 → 40401', async () => {
  const db = world()
  const denied = await call(db, 'moderation', 'markFeatured', { topicId: 't-plain', featured: true }, ID.alice)
  assert.equal(denied.code, 40301)
  assert.equal(topicOf(db, 't-plain').featured, false)
  const gone = await call(db, 'moderation', 'markFeatured', { topicId: 'no-such-topic', featured: true }, ID.mod)
  assert.equal(gone.code, 40401)
  assert.match(gone.msg, /话题不存在/)
})

test('markFeatured：参数校验——topicId 要合法 id、featured 必填且是布尔', async () => {
  const db = world()
  for (const p of [{ topicId: 't-plain' }, { topicId: 't-plain', featured: 'yes' }, { topicId: '不合法 id!', featured: true }, { topicId: 't-plain', featured: true, note: 'x'.repeat(201) }]) {
    const r = await call(db, 'moderation', 'markFeatured', p, ID.mod)
    assert.equal(r.code, 40001, JSON.stringify(p))
  }
  assert.equal(logs(db).length, 0)
})
test('moderation.queue：目标快照带 featured，审核页据此显示「标为精华 / 取消精华」（QA-M6-02 的入口）', async () => {
  const db = world({
    reports: [{ _id: 'q-feat', _openid: ID.alice, targetType: 'topic', targetId: 't-plain', contentType: 'topic', reason: 'other', note: '', state: 'open', createdAt: NOW - HOUR }],
  })
  const before = await call(db, 'moderation', 'queue', { page: 1, size: 20 }, ID.mod)
  assert.equal(before.code, 0)
  const rowOf = (r) => r.data.list.find((x) => x.targetId === 't-plain')
  assert.equal(rowOf(before).target.featured, false, '未标精华 → 前端显示「标为精华」')
  const marked = await call(db, 'moderation', 'markFeatured', { topicId: 't-plain', featured: true }, ID.mod)
  assert.deepEqual(marked.data, { ok: true, featured: true, changed: true })
  const after = await call(db, 'moderation', 'queue', { page: 1, size: 20 }, ID.mod)
  assert.equal(rowOf(after).target.featured, true, '标完再看队列：按钮要翻成「取消精华」')
  assert.ok(after.data.list.every((x) => x.target === null || typeof x.target.featured === 'boolean'), 'target 里 featured 恒为布尔，前端不用防 undefined')
  assert.equal('authorUid' in rowOf(after).target, false, '多带一个展示字段不能顺手漏出作者标识')
})
