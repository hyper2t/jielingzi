'use strict'
/**
 * M3 深度话题：BE-M3-01 createTopic / listTopics / getTopic、BE-M3-02 createReply / listReplies（引用展开）、
 * BE-M3-03 每日上限 + deleteMine、BE-M3-04 匿名脱敏（返回体不含 authorUid / _openid），以及机审 review → 审核队列放行。
 * 用例索引见 docs/test/cases/M3.md。
 */
const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const S = require('../../cloudfunctions/_shared')
const community = require('../../cloudfunctions/community/service')
const moderation = require('../../cloudfunctions/moderation/service')
const { createFakeDb } = require('./fakeDb')

beforeEach(() => S.restoreOwnedCollections())

const NOW = Date.UTC(2026, 9, 1, 4, 0, 0) // 北京时间 2026-10-01 12:00
const DAY = 24 * 3600 * 1000
const silent = { info() {}, error() {} }
const ADULT = { adultConfirmedAt: 1 }
let tick = NOW

/** 账号 id 故意取得足够独特，便于在返回体里搜索泄露 */
const ID = { alice: 'acct-alice-001', bob: 'acct-bob-002', cara: 'acct-cara-003', nophone: 'acct-nophone-004', kid: 'acct-kid-005', muted: 'acct-muted-006', mod: 'acct-mod-007' }
const BODY = '今天站桩二十分钟，感觉呼吸慢慢沉下来，身体也松开了很多，心里安静了。'.repeat(2)
const TITLE = '如何面对练习中的枯燥期'

function world() {
  return createFakeDb({
    unique: { profiles: ['_openid', 'anonAlias'] },
    data: {
      users: [
        { _openid: ID.alice, ...ADULT, phoneVerified: true },
        { _openid: ID.bob, ...ADULT, phoneVerified: true },
        { _openid: ID.cara, ...ADULT, phoneVerified: true },
        { _openid: ID.nophone, ...ADULT },
        { _openid: ID.kid, phoneVerified: true },
        { _openid: ID.muted, ...ADULT, phoneVerified: true, mutedUntil: NOW + 30 * DAY },
        { _openid: ID.mod, ...ADULT, phoneVerified: true, role: 'mod' },
      ],
      profiles: [
        { _openid: ID.alice, nickname: '林然', avatar: 'preset:leaf', anonAlias: '竹影', badges: ['senior'], practices: ['taichi', 'zhanzhuang'], years: 3 },
        { _openid: ID.bob, nickname: '阿青', avatar: 'preset:moon', anonAlias: '松风', badges: [] },
      ],
    },
  })
}
const as = (db, accountId) =>
  S.createMain({ actions: community.actions, logger: silent, createContext: async () => ({ db, identity: { openid: accountId }, now: () => ++tick, logger: silent }) })
const modAs = (db, accountId) =>
  S.createMain({ actions: moderation.actions, logger: silent, createContext: async () => ({ db, identity: { openid: accountId }, now: () => ++tick, logger: silent }) })

const topicOf = async (me, p = {}) => me({ action: 'createTopic', title: TITLE, body: BODY, ...p })
const replyOf = async (me, topicId, p = {}) => me({ action: 'createReply', topicId, body: '谢谢分享，我也在慢慢体会这种感觉。', ...p })

/** 返回体里不得出现内部字段名与任何账号 id（BE-M3-04：抓包检查） */
function assertNoLeak(data, extra = []) {
  const s = JSON.stringify(data)
  for (const f of ['_openid', '_id', 'authorUid', 'targetUid', 'openid', 'accountId', 'reportCount', 'removedBy']) assert.ok(!s.includes(`"${f}"`), `返回体含内部字段 ${f}`)
  for (const id of [...Object.values(ID), ...extra]) assert.ok(!s.includes(id), `返回体含账号标识 ${id}`)
}

// ---------- BE-M3-01 createTopic ----------

test('createTopic 校验：标题 5–40、正文有效字数 ≥ 50（空白不算）、标签 ≤ 3、匿名须为布尔，夹带字段一律 40001', async () => {
  const a = as(world(), ID.alice)
  const code = async (p) => (await topicOf(a, p)).code
  assert.equal(await code({ title: '短标题' }), 40001)
  assert.equal(await code({ title: '一二三四五'.repeat(9) }), 40001, '标题超过 40 字')
  assert.equal(await code({ title: undefined }), 40001)
  assert.equal(await code({ body: '太短了' }), 40001)
  assert.equal(await code({ body: `${'字'.repeat(30)}${' \n\t '.repeat(40)}` }), 40001, '空白凑字数不算')
  assert.equal(await code({ body: '字'.repeat(10001) }), 40001)
  assert.equal(await code({ tags: ['一', '二', '三', '四'] }), 40001)
  assert.equal(await code({ tags: [123] }), 40001)
  assert.equal(await code({ tags: ['这个标签实在是太长了超过十二个字'] }), 40001)
  assert.equal(await code({ tags: 'x' }), 40001)
  assert.equal(await code({ anon: 'yes' }), 40001)
  for (const extra of [{ status: 'ok' }, { images: [] }, { _openid: 'x' }, { featured: true }, { replyCount: 99 }]) assert.equal(await code(extra), 40001, `夹带 ${Object.keys(extra)}`)
  assert.equal(await code({ circleId: 'c1' }), 40001, '圈子 M4 才开放')
  assert.equal((await topicOf(a, { body: '字'.repeat(50) })).code, 0, '恰好 50 字')
  assert.equal((await topicOf(a, { body: `${'字'.repeat(49)}   ` })).code, 40001)
})

test('createTopic：落库字段、清洗（换行 / 标签去重去 #）、实名返回昵称与头像，返回体无内部字段', async () => {
  const db = world()
  const r = await topicOf(as(db, ID.alice), { title: '  如何  面对练习中的枯燥期 ', body: `${BODY}\r\n\r\n\r\n\r\n第二段   \n`, tags: ['#站桩', '站桩', ' 枯燥期 '] })
  assert.equal(r.code, 0)
  assert.equal(r.data.status, 'ok')
  const t = r.data.topic
  assert.equal(t.title, '如何 面对练习中的枯燥期')
  assert.equal(t.body, `${BODY}\n\n第二段`)
  assert.deepEqual(t.tags, ['站桩', '枯燥期'])
  assert.deepEqual(t.author, { name: '林然', avatar: 'preset:leaf', badges: ['senior'], practices: ['taichi', 'zhanzhuang'], years: 3, isSelf: true, anon: false, deleted: false })
  assert.equal(t.anon, false)
  assert.deepEqual(t.images, [])
  assertNoLeak(r.data)
  const saved = db.store.topics[0]
  assert.equal(saved._openid, ID.alice, '作者存在 _openid（注销时 detach）')
  assert.deepEqual([saved.status, saved.circleId, saved.replyCount, saved.reportCount, saved.featured], ['ok', null, 0, 0, false])
  assert.equal(saved.createdAt, saved.lastReplyAt)
})

test('createTopic：没有档案的人发帖会建档并分配匿名代号；实名发帖时昵称缺省回退为代号', async () => {
  const db = world()
  const r = await topicOf(as(db, ID.cara))
  assert.equal(r.code, 0)
  const p = db.store.profiles.find((x) => x._openid === ID.cara)
  assert.ok(p && p.anonAlias)
  assert.equal(r.data.topic.author.name, p.anonAlias)
})

test('写入链路：未实名 40302 / 未确认 18+ 40303 / 禁言 40305；读也要求 18+', async () => {
  const db = world()
  assert.equal((await topicOf(as(db, ID.nophone))).code, 40302)
  assert.equal((await topicOf(as(db, ID.kid))).code, 40303)
  assert.equal((await topicOf(as(db, ID.muted))).code, 40305)
  assert.equal((await as(db, ID.kid)({ action: 'listTopics' })).code, 40303)
  assert.equal((await as(db, ID.kid)({ action: 'getTopic', id: 'x1' })).code, 40303)
  assert.equal((await as(db, ID.kid)({ action: 'listReplies', topicId: 'x1' })).code, 40303)
  assert.equal(db.store.topics, undefined, '被拒绝的都没有落库')
})

// ---------- BE-M3-03 每日上限 ----------

test('T4 每日上限：话题第 3 条被拒 42901；被机审拒绝的不占额度；次日（北京时间）恢复', async () => {
  const db = world()
  const b = as(db, ID.bob)
  const bad = await topicOf(b, { body: `${BODY} 加我微信 abc12345` })
  assert.equal(bad.code, 40001)
  assert.match(bad.msg, /社区公约/)
  assert.equal(db.store.topics, undefined, '机审拒绝不落库')
  assert.equal((await topicOf(b)).code, 0)
  assert.equal((await topicOf(b)).code, 0)
  const third = await topicOf(b)
  assert.equal(third.code, 42901)
  assert.match(third.msg, /每天 2 次/)
  assert.equal(db.store.topics.length, 2)
  // 次日恢复：同一个 db 换成第二天的时钟
  const nextDay = S.createMain({ actions: community.actions, logger: silent, createContext: async () => ({ db, identity: { openid: ID.bob }, now: () => tick + DAY, logger: silent }) })
  assert.equal((await topicOf(nextDay)).code, 0)
})

test('T4 每日上限：回复第 21 条被拒 42901', async () => {
  const db = world()
  const t = (await topicOf(as(db, ID.alice))).data.topic
  const c = as(db, ID.cara)
  for (let i = 0; i < 20; i++) assert.equal((await replyOf(c, t.id)).code, 0, `第 ${i + 1} 条`)
  assert.equal((await replyOf(c, t.id)).code, 42901)
  assert.equal(db.store.replies.length, 20)
  assert.equal(db.store.topics[0].replyCount, 20)
})

// ---------- BE-M3-01 listTopics / getTopic ----------

test('listTopics：只含 ok、新的在前、分页 + hasMore、只给摘要；返回体不含内部字段', async () => {
  const db = world()
  const a = as(db, ID.alice)
  const made = []
  for (const i of [1, 2]) made.push((await topicOf(a, { title: `第${i}个话题标题`, body: `${BODY}${'。'.repeat(i)}` })).data.topic.id)
  const b = as(db, ID.bob)
  made.push((await topicOf(b, { title: '第3个话题标题', anon: true })).data.topic.id)
  db.store.topics.push({ _id: 'old1', _openid: ID.bob, anon: false, title: '早先的话题标题', body: BODY, status: 'ok', createdAt: 1, replyCount: 0 })
  db.store.topics.push({ _id: 'rm1', _openid: ID.bob, anon: false, title: '已下架的话题', body: BODY, status: 'removed', createdAt: tick + 5 })
  db.store.topics.push({ _id: 'pd1', _openid: ID.bob, anon: false, title: '待复核的话题', body: BODY, status: 'pending', createdAt: tick + 6 })

  const p1 = (await as(db, ID.cara)({ action: 'listTopics', size: 2 })).data
  assert.equal(p1.total, 4)
  assert.deepEqual(p1.list.map((x) => x.title), ['第3个话题标题', '第2个话题标题'])
  assert.equal(p1.hasMore, true)
  const p2 = (await as(db, ID.cara)({ action: 'listTopics', size: 2, page: 2 })).data
  assert.deepEqual(p2.list.map((x) => x.title), ['第1个话题标题', '早先的话题标题'])
  assert.equal(p2.hasMore, false)
  assert.equal((await as(db, ID.cara)({ action: 'listTopics', page: 9 })).data.list.length, 0)
  assert.ok(p1.list.every((x) => !('body' in x) && typeof x.excerpt === 'string'))
  assert.equal(p1.list[1].excerpt.length <= 81, true)
  assertNoLeak(p1)
  assert.equal((await as(db, ID.cara)({ action: 'listTopics', circleId: 'c1' })).code, 40001)
  assert.equal((await as(db, ID.cara)({ action: 'listTopics', size: 51 })).code, 40001)
  assert.equal((await as(world(), ID.cara)({ action: 'listTopics' })).data.total, 0, '没有 topics 集合也不报错')
})

test('getTopic：返回正文；不存在 / 已下架 40401；待复核只有作者本人看得到；折叠的保留位置但不给正文', async () => {
  const db = world()
  const t = (await topicOf(as(db, ID.alice))).data.topic
  const got = (await as(db, ID.bob)({ action: 'getTopic', id: t.id })).data.topic
  assert.equal(got.body, BODY)
  assert.equal(got.author.isSelf, false)
  assert.equal((await as(db, ID.alice)({ action: 'getTopic', id: t.id })).data.topic.author.isSelf, true)
  assert.equal((await as(db, ID.bob)({ action: 'getTopic', id: 'nope' })).code, 40401)
  assert.equal((await as(db, ID.bob)({ action: 'getTopic' })).code, 40001)
  assert.equal((await as(db, ID.bob)({ action: 'getTopic', id: t.id, extra: 1 })).code, 40001)

  db.store.topics[0].status = 'pending'
  assert.equal((await as(db, ID.bob)({ action: 'getTopic', id: t.id })).code, 40401)
  const mine = (await as(db, ID.alice)({ action: 'getTopic', id: t.id })).data.topic
  assert.deepEqual([mine.pending, mine.body], [true, BODY])
  db.store.topics[0].status = 'folded'
  const folded = (await as(db, ID.bob)({ action: 'getTopic', id: t.id })).data.topic
  assert.deepEqual([folded.folded, folded.body], [true, null])
  db.store.topics[0].status = 'removed'
  assert.equal((await as(db, ID.alice)({ action: 'getTopic', id: t.id })).code, 40401)
})

// ---------- BE-M3-04 匿名脱敏 ----------

test('匿名脱敏：匿名话题 / 回复 / 引用都只给代号，无头像、无徽章、无任何账号标识；本人看自己 isSelf = true；注销显示「已注销用户」', async () => {
  const db = world()
  const a = as(db, ID.alice)
  const b = as(db, ID.bob)
  const c = as(db, ID.cara)
  const t = (await topicOf(a, { anon: true })).data.topic
  const ra = (await replyOf(a, t.id, { anon: true, body: '这是我（匿名）的补充说明，写得稍微长一些以便区分。' })).data.reply
  const rb = (await replyOf(b, t.id, { quoteId: ra.id, body: '引用了上面的匿名回复。' })).data.reply
  assert.deepEqual(ra.author, { name: '竹影', avatar: null, badges: [], practices: [], years: null, isSelf: true, anon: true, deleted: false })

  const seenByC = [(await c({ action: 'getTopic', id: t.id })).data, (await c({ action: 'listReplies', topicId: t.id })).data, (await c({ action: 'listTopics' })).data]
  for (const data of seenByC) {
    assertNoLeak(data)
    const s = JSON.stringify(data)
    for (const secret of ['林然', 'preset:leaf', 'senior', 'taichi', 'zhanzhuang']) assert.ok(!s.includes(secret), `匿名内容泄露了 ${secret}`)
  }
  const replies = seenByC[1].list
  assert.deepEqual(replies[0].author, { name: '竹影', avatar: null, badges: [], practices: [], years: null, isSelf: false, anon: true, deleted: false })
  assert.deepEqual(replies[1].author, { name: '阿青', avatar: 'preset:moon', badges: [], practices: [], years: null, isSelf: false, anon: false, deleted: false }, '实名回复给昵称与头像')
  assert.deepEqual(replies[1].quote, { id: ra.id, unavailable: false, authorName: '竹影', anon: true, excerpt: '这是我（匿名）的补充说明，写得稍微长一些以便区分。' })
  assert.equal(rb.quote.authorName, '竹影')

  assert.equal((await a({ action: 'listReplies', topicId: t.id })).data.list[0].author.isSelf, true)
  // 作者注销：detach
  await db.collection('topics').where({ _openid: ID.alice }).update({ _openid: null, authorDeleted: true })
  await db.collection('replies').where({ _openid: ID.alice }).update({ _openid: null, authorDeleted: true })
  const after = (await c({ action: 'listReplies', topicId: t.id })).data.list
  assert.deepEqual(after[0].author, { name: '已注销用户', avatar: null, badges: [], practices: [], years: null, isSelf: false, anon: false, deleted: true })
  assert.equal(after[1].quote.authorName, '已注销用户')
  assert.equal((await c({ action: 'getTopic', id: t.id })).data.topic.author.name, '已注销用户')
})

// ---------- BE-M3-02 回复 ----------

test('createReply：不存在 / 非 ok 的话题 40401；< 30 字标记 short（空白不算）；更新 replyCount 与 lastReplyAt', async () => {
  const db = world()
  const t = (await topicOf(as(db, ID.alice))).data.topic
  const b = as(db, ID.bob)
  assert.equal((await replyOf(b, 'nope')).code, 40401)
  assert.equal((await replyOf(b, t.id, { body: '' })).code, 40001)
  assert.equal((await replyOf(b, t.id, { body: '   \n ' })).code, 40001)
  assert.equal((await replyOf(b, t.id, { body: '字'.repeat(5001) })).code, 40001)
  assert.equal((await replyOf(b, t.id, { anon: 1 })).code, 40001)
  assert.equal((await replyOf(b, t.id, { status: 'ok' })).code, 40001)
  assert.equal((await b({ action: 'createReply', body: '缺少话题' })).code, 40001)

  const short = (await replyOf(b, t.id, { body: '好文，收藏。' + ' '.repeat(40) })).data.reply
  assert.equal(short.short, true)
  const long = (await replyOf(b, t.id, { body: '字'.repeat(30) })).data.reply
  assert.equal(long.short, false)
  assert.equal((await replyOf(b, t.id, { body: '字'.repeat(29) })).data.reply.short, true)
  const topic = db.store.topics[0]
  assert.equal(topic.replyCount, 3)
  assert.ok(topic.lastReplyAt > topic.createdAt)
  db.store.topics[0].status = 'folded'
  assert.equal((await replyOf(b, t.id)).code, 40401, '折叠 / 待审 / 下架的话题不能回复')
})

test('引用回复：只能引用同一话题里正常的回复；列表里展开引用，被折叠 / 删除的只告知不可用', async () => {
  const db = world()
  const a = as(db, ID.alice)
  const b = as(db, ID.bob)
  const t1 = (await topicOf(a)).data.topic
  const t2 = (await topicOf(a, { title: '另一个话题的标题' })).data.topic
  const r1 = (await replyOf(a, t1.id, { body: '第一条回复的内容，用来被引用。' })).data.reply
  const other = (await replyOf(a, t2.id)).data.reply
  assert.equal((await replyOf(b, t1.id, { quoteId: other.id })).code, 40001, '不能引用别的话题的回复')
  assert.equal((await replyOf(b, t1.id, { quoteId: 'nope' })).code, 40001)
  const r2 = (await replyOf(b, t1.id, { quoteId: r1.id })).data.reply
  assert.deepEqual(r2.quote, { id: r1.id, unavailable: false, authorName: '林然', anon: false, excerpt: '第一条回复的内容，用来被引用。' })

  const list = (await b({ action: 'listReplies', topicId: t1.id })).data
  assert.deepEqual(list.list.map((x) => x.id), [r1.id, r2.id])
  assert.equal(list.list[0].quote, null)
  assert.equal(list.list[1].quote.excerpt, '第一条回复的内容，用来被引用。')

  db.store.replies.find((x) => x._id === r1.id).status = 'folded'
  const folded = (await b({ action: 'listReplies', topicId: t1.id })).data.list
  assert.deepEqual([folded[0].folded, folded[0].body], [true, null])
  assert.deepEqual(folded[1].quote, { id: r1.id, unavailable: true, authorName: null, anon: false, excerpt: null })
  assert.equal((await replyOf(b, t1.id, { quoteId: r1.id })).code, 40001, '折叠的回复不能再被引用')
})

test('listReplies：按时间正序、分页；待复核的回复只有作者本人看得到；话题不可见时 40401', async () => {
  const db = world()
  const t = (await topicOf(as(db, ID.alice))).data.topic
  const b = as(db, ID.bob)
  const c = as(db, ID.cara)
  const ids = []
  for (let i = 1; i <= 5; i++) ids.push((await replyOf(i % 2 ? b : c, t.id, { body: `第${i}条回复` })).data.reply.id)
  const p1 = (await b({ action: 'listReplies', topicId: t.id, size: 2 })).data
  assert.deepEqual(p1.list.map((x) => x.id), ids.slice(0, 2))
  assert.deepEqual([p1.total, p1.hasMore], [5, true])
  assert.deepEqual((await b({ action: 'listReplies', topicId: t.id, size: 2, page: 3 })).data.list.map((x) => x.id), ids.slice(4))
  assert.equal((await b({ action: 'listReplies', topicId: t.id, size: 51 })).code, 40001)

  db.store.replies.find((x) => x._id === ids[0]).status = 'pending' // bob 的
  assert.equal((await c({ action: 'listReplies', topicId: t.id })).data.list.length, 4)
  const mine = (await b({ action: 'listReplies', topicId: t.id })).data.list
  assert.equal(mine.length, 5)
  assert.equal(mine[0].pending, true)

  assert.equal((await b({ action: 'listReplies', topicId: 'nope' })).code, 40401)
  db.store.topics[0].status = 'removed'
  assert.equal((await b({ action: 'listReplies', topicId: t.id })).code, 40401)
})

// ---------- 机审：review → 审核队列放行 ----------

test('机审 review：落库为 pending、对他人不可见、占额度、进审核队列；审核员放行后可见；下架会通知作者', async () => {
  const db = world()
  const a = as(db, ID.alice)
  const mod = modAs(db, ID.mod)
  const r = await topicOf(a, { body: `${BODY} 想皈依的朋友找我` })
  assert.equal(r.code, 0)
  assert.deepEqual([r.data.status, r.data.topic.pending], ['pending', true])
  const id = r.data.topic.id
  assert.equal((await as(db, ID.bob)({ action: 'listTopics' })).data.total, 0)
  assert.equal((await as(db, ID.bob)({ action: 'getTopic', id })).code, 40401)
  assert.equal((await a({ action: 'getTopic', id })).code, 0)
  assert.equal(db.store.mod_logs.filter((l) => l.kind === 'machine' && l.verdict === 'review').length, 1)

  const q = (await mod({ action: 'queue' })).data
  assert.equal(q.total, 1)
  assert.deepEqual([q.list[0].targetType, q.list[0].targetId, q.list[0].count, q.list[0].reasons, q.list[0].notes], ['topic', id, 1, { other: 1 }, ['机审待复核']])
  assert.equal(q.list[0].target.status, 'pending')
  assertNoLeak(q)

  const dec = await mod({ action: 'decide', targetType: 'topic', targetId: id, decision: 'restore' })
  assert.deepEqual([dec.code, dec.data.status, dec.data.resolved], [0, 'ok', 1])
  assert.equal((await as(db, ID.bob)({ action: 'listTopics' })).data.total, 1)
  assert.equal((await mod({ action: 'queue' })).data.total, 0)
  assert.equal(db.store.notifications, undefined, '系统待复核没有真实举报人，不发通知')

  // dismiss 同样是放行；remove 下架并通知作者
  const t2 = (await topicOf(a, { body: `${BODY} 想皈依的朋友找我` })).data.topic.id
  assert.equal((await mod({ action: 'decide', targetType: 'topic', targetId: t2, decision: 'dismiss' })).data.status, 'ok')
  const t3 = (await topicOf(as(db, ID.bob), { body: `${BODY} 想皈依的朋友找我` })).data.topic.id
  assert.equal((await mod({ action: 'decide', targetType: 'topic', targetId: t3, decision: 'remove' })).data.status, 'removed')
  assert.deepEqual(db.store.notifications.map((n) => [n._openid, n.type]), [[ID.bob, 'moderation']])
  assert.equal((await as(db, ID.cara)({ action: 'getTopic', id: t3 })).code, 40401)
})

test('机审 review 的回复：pending、不计入 replyCount、进队列；放行后对他人可见', async () => {
  const db = world()
  const t = (await topicOf(as(db, ID.alice))).data.topic
  const b = as(db, ID.bob)
  const r = await replyOf(b, t.id, { body: '想皈依的朋友找我，我可以介绍。' })
  assert.deepEqual([r.code, r.data.status, r.data.reply.pending], [0, 'pending', true])
  assert.equal(db.store.topics[0].replyCount, 0)
  assert.equal((await as(db, ID.cara)({ action: 'listReplies', topicId: t.id })).data.list.length, 0)
  const q = (await modAs(db, ID.mod)({ action: 'queue' })).data
  assert.deepEqual([q.total, q.list[0].targetType, q.list[0].contentType], [1, 'reply', 'reply'])
  await modAs(db, ID.mod)({ action: 'decide', targetType: 'reply', targetId: r.data.reply.id, decision: 'restore' })
  assert.equal((await as(db, ID.cara)({ action: 'listReplies', topicId: t.id })).data.list.length, 1)
})

test('机审 reject 的回复：40001、不落库、不扣额度', async () => {
  const db = world()
  const t = (await topicOf(as(db, ID.alice))).data.topic
  const b = as(db, ID.bob)
  assert.equal((await replyOf(b, t.id, { body: '加我微信 abc12345 详聊' })).code, 40001)
  assert.equal(db.store.replies, undefined)
  assert.equal(db.store.rate_limits.filter((x) => x._id.includes(':createReply:')).length, 0)
})

// ---------- BE-M3-03 删除自己的内容 ----------

test('deleteMine：只能删自己的（别人的 / 不存在一律 40401）；回复删除后 replyCount 减 1；重复删除幂等；禁言中也能删', async () => {
  const db = world()
  const a = as(db, ID.alice)
  const b = as(db, ID.bob)
  const t = (await topicOf(a)).data.topic
  const r = (await replyOf(b, t.id)).data.reply
  assert.equal((await b({ action: 'deleteMine', type: 'topic', id: t.id })).code, 40401)
  assert.equal((await a({ action: 'deleteMine', type: 'reply', id: r.id })).code, 40401)
  assert.equal((await a({ action: 'deleteMine', type: 'topic', id: 'nope' })).code, 40401)
  assert.equal((await a({ action: 'deleteMine', type: 'post', id: t.id })).code, 40001)
  assert.equal(db.store.topics[0].status, 'ok')

  assert.equal((await b({ action: 'deleteMine', type: 'reply', id: r.id })).data.changed, true)
  assert.equal((await b({ action: 'deleteMine', type: 'reply', id: r.id })).data.changed, false)
  assert.equal(db.store.topics[0].replyCount, 0, '只减一次')
  assert.equal((await a({ action: 'listReplies', topicId: t.id })).data.list.length, 0)

  db.store.users.find((u) => u._openid === ID.alice).mutedUntil = tick + DAY
  const del = await a({ action: 'deleteMine', type: 'topic', id: t.id })
  assert.deepEqual([del.code, del.data.changed], [0, true])
  assert.equal((await a({ action: 'getTopic', id: t.id })).code, 40401)
  assert.equal((await b({ action: 'listTopics' })).data.total, 0)
  assert.equal(db.store.topics[0].removedBy, 'author')
})

test('作者自己删除的内容审核员不能恢复；待复核的内容被作者删除后，队列里的系统待复核随之关闭', async () => {
  const db = world()
  const a = as(db, ID.alice)
  const mod = modAs(db, ID.mod)
  const t1 = (await topicOf(a)).data.topic.id
  await a({ action: 'deleteMine', type: 'topic', id: t1 })
  const restore = await mod({ action: 'decide', targetType: 'topic', targetId: t1, decision: 'restore' })
  assert.equal(restore.code, 40001)
  assert.match(restore.msg, /自行删除/)
  assert.equal(db.store.topics.find((x) => x._id === t1).status, 'removed')

  const t2 = (await topicOf(a, { body: `${BODY} 想皈依的朋友找我` })).data.topic.id
  assert.equal((await mod({ action: 'queue' })).data.total, 1)
  await a({ action: 'deleteMine', type: 'topic', id: t2 })
  assert.equal((await mod({ action: 'queue' })).data.total, 0)
})

test('举报折叠联动：回复被 3 人举报自动折叠后，保留位置但不给正文', async () => {
  const db = world()
  const t = (await topicOf(as(db, ID.alice))).data.topic
  const r = (await replyOf(as(db, ID.alice), t.id)).data.reply
  const reporters = [ID.bob, ID.cara, ID.nophone]
  for (const who of reporters) assert.equal((await modAs(db, who)({ action: 'report', targetType: 'reply', targetId: r.id, reason: 'spam' })).code, 0)
  assert.equal(db.store.replies[0].status, 'folded')
  const list = (await as(db, ID.bob)({ action: 'listReplies', topicId: t.id })).data.list
  assert.deepEqual([list[0].folded, list[0].body], [true, null])
})

test('集合登记：topics 话题流索引（status + createdAt）；topics / replies 注销时 detach', () => {
  const topics = S.COLLECTIONS.find((c) => c.name === 'topics')
  assert.ok(topics.indexes.some((i) => i.name === 'idx_status_time' && JSON.stringify(i.keys) === '[["status",1],["createdAt",-1]]'))
  assert.equal(topics.owned.onDelete, 'detach')
  assert.equal(S.COLLECTIONS.find((c) => c.name === 'replies').owned.onDelete, 'detach')
  assert.deepEqual(S.TOPIC_RULES, { tagsMax: 3, tag: { min: 1, max: 12 }, excerptLen: 80 })
})
