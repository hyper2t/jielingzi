'use strict'
/**
 * BE-M6-03：站内通知落地（reply / moderation / prompt 三类；规则见 docs/prd/m6-plan.md D13 / D15 / D16）。
 * 覆盖：notify 的去重开关（默认关闭，moderation 既有语义不变）、新回复只提醒话题作者（给自己回复、
 * 复核中的回复、被冷静期挡下的回复都不发）、消息列表的「仅本人 + 倒序分页 + 未读数」、标记已读的越权与幂等、
 * 每日提醒的「当日无题零写入 / 一题只提醒一次 / 门禁过滤 / 翻页扫描」，以及 practice 入口与
 * cloudbaserc.json 触发器的接线（提醒不读任何环境变量，故模板 ID 缺键不可能抛错）。
 * 三端与 QA 清单待 QA-M6-01 登记进 docs/test/cases/M6.md。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const S = require('../../cloudfunctions/_shared')
const community = require('../../cloudfunctions/community/service')
const practice = require('../../cloudfunctions/practice/service')
const { notify, NOTIFY_TYPES } = require('../../cloudfunctions/_shared/notify')
const {
  runPromptReminder, createTimerEntry, isTimerEvent, eligible, REMINDER_TEXT, REMINDER_REF_TYPE,
} = require('../../cloudfunctions/_shared/reminder')
const { cnDate } = require('../../cloudfunctions/_shared/config')
const { createFakeDb } = require('./fakeDb')
const { CIRCLE_UNIQUE, circleDoc, memberDoc } = require('./circleFixtures')

const ROOT = path.resolve(__dirname, '../..')
const NOW = Date.UTC(2026, 9, 3, 4, 0, 0)
const DAY = 24 * 3600 * 1000
const HOUR = 3600 * 1000
const TODAY = cnDate(NOW)
const silent = { info() {}, error() {} }
const ID = {
  alice: 'acct-notify-alice', bob: 'acct-notify-bob', kid: 'acct-notify-kid', muted: 'acct-notify-muted', banned: 'acct-notify-banned',
}
const TITLE = '如何面对练习中的枯燥期'
const BODY = '今天站桩二十分钟，感觉呼吸慢慢沉下来，身体也松开了很多，想听听大家是怎么熬过这一段。'.repeat(2)
const REPLY = '我那段是靠把坐香缩短到十分钟熬过来的，先把次数稳住再谈时长。'
const SLOW_MSG = '这条话题还没开放回复'
const PASS = { checkText: async () => ({ verdict: 'pass', hits: [], labels: [] }) }
const REVIEW = { checkText: async () => ({ verdict: 'review', hits: [{ category: 'diversion', word: '加群' }], labels: [20002] }) }

/* ---------------- 假 SDK：驱动 cloudfunctions/practice/index.js 全链路 ---------------- */
const entryDb = createFakeDb({ data: { users: [], daily_prompts: [], notifications: [] } })
let entryUserInfo = { openId: 'oNotify' }
const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === '@cloudbase/node-sdk') {
    return {
      SYMBOL_CURRENT_ENV: Symbol('current'),
      init: () => ({ auth: () => ({ getUserInfo: () => entryUserInfo }), database: () => entryDb }),
    }
  }
  return origLoad.call(this, request, ...rest)
}
// 假 SDK 要在整个文件生命周期里生效：db.js 的 getApp() 是惰性的，还原 _load 会让它去加载真 SDK
const practiceEntry = require('../../cloudfunctions/practice/index.js') // eslint-disable-line import/first
void origLoad

/* ---------------- 社区：createReply 的通知 ---------------- */
const CIRCLE = circleDoc({ slug: 'notify-circle', name: '静观练习', sort: 1 })
const topicDoc = (id, o = {}) => ({
  _id: id, _openid: ID.bob, circleId: CIRCLE._id, anon: false, title: `话题 ${id}`, body: BODY, tags: [],
  images: [], status: 'ok', featured: false, slowUntil: null, replyCount: 0, reportCount: 0,
  createdAt: NOW - 2 * DAY, lastReplyAt: null, ...o,
})

function cworld(extra = {}) {
  return createFakeDb({
    unique: { profiles: ['_openid', 'anonAlias'], ...CIRCLE_UNIQUE },
    data: {
      users: [
        { _openid: ID.alice, adultConfirmedAt: 1, phoneVerified: true },
        { _openid: ID.bob, adultConfirmedAt: 1, phoneVerified: true },
      ],
      circles: [CIRCLE],
      memberships: [memberDoc(CIRCLE._id, ID.alice), memberDoc(CIRCLE._id, ID.bob)],
      profiles: [
        { _openid: ID.alice, nickname: '甲', anonAlias: '甲的花名' },
        { _openid: ID.bob, nickname: '乙', anonAlias: '乙的花名' },
      ],
      topics: [topicDoc('t-bob'), topicDoc('t-alice', { _openid: ID.alice }), topicDoc('t-slow', { slowUntil: NOW + HOUR })],
      ...extra,
    },
  })
}

function comm(db, action, p = {}, who = ID.alice, moderation = PASS) {
  const main = S.createMain({
    actions: community.actions,
    logger: silent,
    createContext: async () => ({ db, identity: { openid: who }, now: () => NOW, logger: silent, moderation }),
  })
  return main({ action, ...p })
}

/* ---------------- practice：消息列表 / 标记已读 ---------------- */
const noteDoc = (id, who, o = {}) => ({
  _id: id, _openid: who, type: 'reply', refType: 'topic', refId: 't-bob',
  text: '你的话题收到了新回复', read: false, createdAt: NOW, ...o,
})

function pworld(extra = {}) {
  return createFakeDb({
    data: {
      users: [
        { _openid: ID.alice, adultConfirmedAt: 1, phoneVerified: true },
        { _openid: ID.bob, adultConfirmedAt: 1, phoneVerified: true },
        { _openid: ID.kid, phoneVerified: true },
        { _openid: ID.muted, adultConfirmedAt: 1, phoneVerified: true, mutedUntil: NOW + DAY },
        { _openid: ID.banned, adultConfirmedAt: 1, phoneVerified: true, bannedUntil: NOW + DAY },
      ],
      notifications: [],
      ...extra,
    },
  })
}

function pcall(db, action, p = {}, who = ID.alice) {
  const main = S.createMain({
    actions: practice.actions,
    logger: silent,
    createContext: async () => ({ db, identity: { openid: who }, now: () => NOW, logger: silent }),
  })
  return main({ action, ...p })
}

/* ---------------- 每日提醒 ---------------- */
const promptDoc = (o = {}) => ({ _id: 'prompt-1', date: TODAY, text: '本周你想放下的一件小事是什么？', status: 'ok', ...o })

function rworld(users, prompts) {
  return createFakeDb({ data: { users, daily_prompts: prompts } })
}
const rctx = (db, logger = silent) => ({ db, now: () => NOW, logger })
const notesTo = (db, uid) => (db.store.notifications || []).filter((n) => n._openid === uid)
const userRow = (who, o = {}) => ({ _openid: who, adultConfirmedAt: 1, phoneVerified: true, ...o })

/* ================= notify：去重开关 ================= */

test('notify：dedupe 时同 (uid, type, refId) 只写一条，换 refId 再写；不传 dedupe 时逐条写（moderation 语义不变）', async () => {
  const db = createFakeDb({ data: {} })
  const base = { uid: ID.alice, type: 'prompt', refType: REMINDER_REF_TYPE, refId: 'p-1', text: REMINDER_TEXT, now: NOW }
  assert.equal(await notify(db, { ...base, dedupe: true }), true)
  assert.equal(await notify(db, { ...base, dedupe: true }), false, '同一条不重复写')
  assert.equal(db.store.notifications.length, 1)
  assert.equal(await notify(db, { ...base, refId: 'p-2', dedupe: true }), true, '换一道题要再提醒一次')
  assert.equal(await notify(db, { ...base, uid: ID.bob, dedupe: true }), true, '去重是按人算的：同一道题给别的账号照写')
  assert.equal(db.store.notifications.length, 3)
  assert.equal(await notify(db, { uid: ID.bob, type: 'moderation', refType: 'topic', refId: 't-1', text: '内容已下架', now: NOW }), true)
  assert.equal(await notify(db, { uid: ID.bob, type: 'moderation', refType: 'topic', refId: 't-1', text: '内容已下架', now: NOW + 1 }), true,
    '默认不去重：同一目标二次处理仍要再通知')
  assert.equal(db.store.notifications.length, 5, 'alice 两条 + bob 三条')
  assert.deepEqual([...new Set(db.store.notifications.map((n) => n._openid))].sort(), [ID.alice, ID.bob].sort())
})

test('notify：没有接收人不写；dedupe 但没给 refId 时退回逐条写；未知 type 抛错', async () => {
  const db = createFakeDb({ data: {} })
  assert.equal(await notify(db, { uid: '', type: 'reply', refId: 't-1', text: 'x', now: NOW, dedupe: true }), false, '作者已注销（无 _openid）')
  assert.ok(!db.store.notifications, '无接收人时连集合都不该建')
  const noRef = { uid: ID.alice, type: 'reply', text: 'x', now: NOW, dedupe: true }
  assert.equal(await notify(db, noRef), true)
  assert.equal(await notify(db, noRef), true, 'refId 为空时无从判断「同一条」，不去重')
  assert.equal(db.store.notifications.length, 2)
  await assert.rejects(notify(db, { uid: ID.alice, type: 'sms', refId: 't-1', text: 'x', now: NOW }), /未知 type/)
  assert.deepEqual([...NOTIFY_TYPES], ['reply', 'moderation', 'prompt'], '类型清单仍是这三类（D13）')
})

/* ================= community.createReply ================= */

test('createReply：话题作者收到一条 reply 通知，字段与固定文案一致；作者自己那条没有', async () => {
  const db = cworld()
  const r = await comm(db, 'createReply', { topicId: 't-bob', body: REPLY })
  assert.equal(r.code, 0)
  const notes = db.store.notifications || []
  assert.equal(notes.length, 1, '只发给话题作者')
  const n0 = notes[0]
  assert.equal(n0._openid, ID.bob)
  assert.equal(n0.type, 'reply')
  assert.equal(n0.refType, 'topic')
  assert.equal(n0.refId, 't-bob', '带上话题 id，前端才能直接跳过去')
  assert.equal(n0.text, '你的话题收到了新回复')
  assert.equal(n0.read, false)
  assert.equal(n0.createdAt, NOW)
  assert.deepEqual(Object.keys(n0).sort(), ['_id', '_openid', 'createdAt', 'read', 'refId', 'refType', 'text', 'type'], '不塞别的字段')
  assert.ok(!n0.text.includes(REPLY), '通知正文不含回复原文')
  assert.equal(notesTo(db, ID.alice).length, 0)
})

test('createReply：回复自己的话题不发通知', async () => {
  const db = cworld()
  assert.equal((await comm(db, 'createReply', { topicId: 't-alice', body: REPLY }, ID.alice)).code, 0)
  assert.ok(!db.store.notifications || db.store.notifications.length === 0)
})

test('createReply：机审 review 落库为 pending，但不发通知（复核通过后也不补发）', async () => {
  const db = cworld()
  const r = await comm(db, 'createReply', { topicId: 't-bob', body: REPLY }, ID.alice, REVIEW)
  assert.equal(r.code, 0)
  assert.equal(r.data.status, 'pending')
  assert.equal(db.store.replies[0].status, 'pending')
  assert.ok(!db.store.notifications || db.store.notifications.length === 0, '作者看不见这条回复，就不该被提示')
})

test('createReply：被冷静期挡下（40901）时不写通知', async () => {
  const db = cworld()
  const r = await comm(db, 'createReply', { topicId: 't-slow', body: REPLY })
  assert.equal(r.code, 40901)
  assert.equal(r.msg, SLOW_MSG)
  assert.ok(!db.store.notifications, '被拒的回复不留痕')
})

test('createReply：同一条话题的多次回复各发一条（不去重，dedupe 只给每日提醒用）', async () => {
  const db = cworld()
  for (const body of [REPLY, REPLY.replace('十分钟', '二十分钟')]) {
    assert.equal((await comm(db, 'createReply', { topicId: 't-bob', body })).code, 0)
  }
  assert.equal(notesTo(db, ID.bob).length, 2, '两条回复 = 两条通知')
})

/* ================= practice.listNotifications ================= */

test('listNotifications：只返回本人、createdAt 倒序、分页 hasMore 与未读数', async () => {
  const db = pworld({
    notifications: [
      noteDoc('n-1', ID.alice, { createdAt: NOW - 3 * HOUR }),
      noteDoc('n-2', ID.alice, { createdAt: NOW - 2 * HOUR, type: 'prompt', refType: REMINDER_REF_TYPE, refId: 'p-1', text: REMINDER_TEXT }),
      noteDoc('n-3', ID.alice, { createdAt: NOW - HOUR, read: true }),
      noteDoc('n-other', ID.bob, { createdAt: NOW }),
    ],
  })
  const r = await pcall(db, 'listNotifications')
  assert.equal(r.code, 0)
  assert.deepEqual(r.data.list.map((n) => n.id), ['n-3', 'n-2', 'n-1'], '倒序，且不含他人那条')
  assert.equal(r.data.unread, 2, 'read: true 的那条不计入未读')
  assert.equal(r.data.hasMore, false)
  assert.deepEqual(r.data.list[1], {
    id: 'n-2', type: 'prompt', refType: REMINDER_REF_TYPE, refId: 'p-1', text: REMINDER_TEXT, read: false, createdAt: NOW - 2 * HOUR,
  }, '下发字段就这些：不含 _openid')
  assert.ok(!('_openid' in r.data.list[0]))
  const p1 = await pcall(db, 'listNotifications', { page: 1, size: 2 })
  assert.deepEqual(p1.data.list.map((n) => n.id), ['n-3', 'n-2'])
  assert.equal(p1.data.hasMore, true)
  const p2 = await pcall(db, 'listNotifications', { page: 2, size: 2 })
  assert.deepEqual(p2.data.list.map((n) => n.id), ['n-1'])
  assert.equal(p2.data.hasMore, false)
  const p3 = await pcall(db, 'listNotifications', { page: 3, size: 2 })
  assert.deepEqual(p3.data.list, [])
  assert.equal(p3.data.hasMore, false)
})

test('listNotifications：没有任何消息时返回空列表（集合还不存在也不报错）', async () => {
  const db = pworld({ notifications: [] })
  const r = await pcall(db, 'listNotifications')
  assert.deepEqual(r.data, { page: 1, size: 20, hasMore: false, unread: 0, list: [] })
  const db2 = createFakeDb({ data: { users: [userRow(ID.alice)] } })
  const r2 = await pcall(db2, 'listNotifications')
  assert.equal(r2.code, 0)
  assert.deepEqual(r2.data.list, [], 'notifications 集合还没建起来时同样是空列表')
  assert.equal(r2.data.unread, 0)
})

test('listNotifications：分页参数与未知键都按 40001 挡下', async () => {
  const db = pworld()
  for (const p of [{ page: 0 }, { page: -1 }, { page: 1.5 }, { size: 0 }, { size: 51 }, { size: '20' }, { uid: ID.alice }]) {
    assert.equal((await pcall(db, 'listNotifications', p)).code, 40001, JSON.stringify(p))
  }
  assert.equal((await pcall(db, 'listNotifications', { size: 50 })).code, 0, 'size 上限 50 可用')
})

test('listNotifications / markNotificationsRead 的门禁与写动作一致：未登录 40101、未满 18 岁 40303、封禁 40304，禁言仍可读', async () => {
  const db = pworld({ notifications: [noteDoc('n-1', ID.muted)] })
  assert.equal((await pcall(pworld({ users: [] }), 'listNotifications')).code, 40101)
  assert.equal((await pcall(db, 'listNotifications', {}, ID.kid)).code, 40303)
  assert.equal((await pcall(db, 'listNotifications', {}, ID.banned)).code, 40304)
  assert.equal((await pcall(db, 'listNotifications', {}, ID.muted)).code, 0, '禁言只限制发言，不影响收消息')
  assert.equal((await pcall(db, 'markNotificationsRead', { all: true }, ID.kid)).code, 40303)
  assert.equal((await pcall(db, 'markNotificationsRead', { all: true }, ID.banned)).code, 40304)
})

test('listNotifications 不占当日额度（重复调用不受频控）', async () => {
  const db = pworld({ notifications: [noteDoc('n-1', ID.alice)] })
  for (let i = 0; i < 3; i += 1) assert.equal((await pcall(db, 'listNotifications')).code, 0)
  assert.ok(!(db.store.rate_limits || []).some((r) => /listNotifications|markNotificationsRead/.test(r._id)), 'limit=0 不计数')
})

/* ================= practice.markNotificationsRead ================= */

test('markNotificationsRead：按 ids 只标本人未读的，别人的 id 命中 0 条；返回未读数；重复调用幂等', async () => {
  const db = pworld({
    notifications: [
      noteDoc('n-1', ID.alice),
      noteDoc('n-2', ID.alice, { createdAt: NOW + 1 }),
      noteDoc('n-3', ID.alice, { read: true }),
      noteDoc('n-4', ID.bob),
    ],
  })
  const r = await pcall(db, 'markNotificationsRead', { ids: ['n-1', 'n-3', 'n-4'] })
  assert.equal(r.code, 0)
  assert.equal(r.data.updated, 1, '已读的 n-3 与本人的 n-1 里只有 n-1 是新标记；他人的 n-4 不算')
  assert.equal(r.data.unread, 1, '只剩 n-2 未读')
  assert.equal(db.store.notifications.find((n) => n._id === 'n-1').read, true)
  assert.equal(db.store.notifications.find((n) => n._id === 'n-4').read, false, '越权：别人的文档一个字段都不动')
  const again = await pcall(db, 'markNotificationsRead', { ids: ['n-1'] })
  assert.deepEqual(again.data, { updated: 0, unread: 1 }, '幂等')
})

test('markNotificationsRead：all: true 只清本人的未读', async () => {
  const db = pworld({
    notifications: [
      noteDoc('n-1', ID.alice), noteDoc('n-2', ID.alice), noteDoc('n-3', ID.bob), noteDoc('n-4', ID.bob, { read: true }),
    ],
  })
  const r = await pcall(db, 'markNotificationsRead', { all: true })
  assert.deepEqual(r.data, { updated: 2, unread: 0 })
  assert.deepEqual(db.store.notifications.map((n) => `${n._openid === ID.alice ? 'A' : 'B'}:${n.read ? 1 : 0}`).sort(), ['A:1', 'A:1', 'B:0', 'B:1'])
})

test('markNotificationsRead：ids 与 all 至少要给一个，且形状不对就 40001', async () => {
  const db = pworld({ notifications: [noteDoc('n-1', ID.alice)] })
  for (const p of [{}, { ids: [] }, { ids: 'n-1' }, { ids: [''] }, { ids: [1] }, { ids: new Array(101).fill('n-1') }, { all: 'yes' }, { id: 'n-1' }]) {
    const shape = Array.isArray(p.ids) ? `ids×${p.ids.length}` : JSON.stringify(p)
    assert.equal((await pcall(db, 'markNotificationsRead', p)).code, 40001, shape)
  }
  assert.equal(db.store.notifications[0].read, false, '参数不合法时不改任何数据')
  assert.equal((await pcall(db, 'markNotificationsRead', { ids: ['n-1'], all: true })).code, 0, 'all: true 时忽略 ids（不再校验）')
})

test('markNotificationsRead：消息不存在时 updated = 0，不报「不存在」', async () => {
  const db = pworld({ notifications: [noteDoc('n-1', ID.alice)] })
  assert.deepEqual((await pcall(db, 'markNotificationsRead', { ids: ['不存在'] })).data, { updated: 0, unread: 1 })
})

/* ================= 每日提醒（定时触发器） ================= */

test('runPromptReminder：当日没有 ok 题目时整批跳过，一条通知都不写', async () => {
  for (const prompts of [[], [promptDoc({ date: '2026-10-02' })], [promptDoc({ status: 'pending' })], [promptDoc({ status: 'closed' })]]) {
    const db = rworld([userRow(ID.alice)], prompts)
    const r = await runPromptReminder(rctx(db))
    assert.deepEqual({ ...r, promptId: null }, { date: TODAY, promptId: null, sent: 0, deduped: 0, scanned: 0, truncated: false })
    assert.ok(!db.store.notifications, '零写入：连 notifications 集合都不该建')
  }
})

test('runPromptReminder：每个合格账号一条，第二次跑只算去重（一题最多提醒一次）', async () => {
  const db = rworld([userRow(ID.alice), userRow(ID.bob)], [promptDoc()])
  const first = await runPromptReminder(rctx(db))
  assert.deepEqual(first, { date: TODAY, promptId: 'prompt-1', sent: 2, deduped: 0, scanned: 2, truncated: false })
  assert.equal(db.store.notifications.length, 2)
  const one = db.store.notifications[0]
  assert.equal(one.type, 'prompt')
  assert.equal(one.refType, REMINDER_REF_TYPE)
  assert.equal(one.refId, 'prompt-1')
  assert.equal(one.text, REMINDER_TEXT)
  assert.equal(one.read, false)
  assert.ok(!db.store.notifications.some((n) => String(n.text).includes('你想放下的一件小事')), '正文只有固定说明，不含题目原文')
  const second = await runPromptReminder(rctx(db))
  assert.deepEqual(second, { date: TODAY, promptId: 'prompt-1', sent: 0, deduped: 2, scanned: 2, truncated: false })
  assert.equal(db.store.notifications.length, 2, '重跑不重复打扰')
})

test('runPromptReminder：未确认 18 岁与封禁中的账号被跳过，禁言中的照发', async () => {
  const db = rworld(
    [userRow(ID.alice), { _openid: ID.kid, phoneVerified: true }, userRow(ID.muted, { mutedUntil: NOW + DAY }), userRow(ID.banned, { bannedUntil: NOW + DAY })],
    [promptDoc()],
  )
  const r = await runPromptReminder(rctx(db))
  assert.equal(r.sent, 2)
  assert.equal(r.scanned, 4, '扫到 4 个账号，其中 2 个不合格')
  assert.deepEqual(db.store.notifications.map((n) => n._openid).sort(), [ID.alice, ID.muted].sort())
  assert.equal(eligible(null, NOW), false)
  assert.equal(eligible({ _openid: ID.kid }, NOW), false)
  assert.equal(eligible({ _openid: ID.alice, adultConfirmedAt: 1, bannedUntil: NOW - 1 }, NOW), true, '封禁已到期')
})

test('runPromptReminder：users 超过一页也要扫全，且不重不漏', async () => {
  const many = Array.from({ length: 120 }, (_x, i) => userRow(`acct-many-${i}`))
  const db = rworld(many, [promptDoc()])
  const r = await runPromptReminder(rctx(db))
  assert.deepEqual(r, { date: TODAY, promptId: 'prompt-1', sent: 120, deduped: 0, scanned: 120, truncated: false })
  assert.equal(new Set(db.store.notifications.map((n) => n._openid)).size, 120)
})

test('runPromptReminder：没有可用环境变量也不抛错——提醒这段代码压根不读环境（D17 后补外发）', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions/_shared/reminder.js'), 'utf8').replace(/\r\n/g, '\n')
  assert.ok(!/process\.env|WX_MP_|subscribeMessage/.test(src), 'reminder.js 里不该出现环境变量与订阅消息调用')
  const saved = new Map(Object.keys(process.env).filter((k) => /^(WX|TCB|CLOUDBASE|PHONE)_/.test(k)).map((k) => [k, process.env[k]]))
  for (const k of saved.keys()) delete process.env[k]
  try {
    const db = rworld([userRow(ID.alice)], [promptDoc()])
    assert.equal((await runPromptReminder(rctx(db))).sent, 1, '一个变量都没有也照样跑完')
    assert.equal(notesTo(db, ID.alice)[0].type, 'prompt')
  } finally {
    for (const [k, v] of saved) process.env[k] = v
  }
})

test('isTimerEvent：只认平台定时事件的形状，带 action 的一律走 action 分发', () => {
  assert.equal(isTimerEvent({ Type: 'timer', TriggerName: 'dailyPromptReminder', Time: '2026-10-03T00:00:00Z' }), true)
  assert.equal(isTimerEvent({ Type: 'timer', action: 'listNotifications' }), false, '客户端伪造不了「无 action 的 timer」这条路')
  assert.equal(isTimerEvent({ action: 'ping' }), false)
  assert.equal(isTimerEvent({ Type: 'http' }), false)
  for (const bad of [null, undefined, 'timer', 42, []]) assert.equal(isTimerEvent(bad), false)
})

test('createTimerEntry：正常跑一次；提醒失败只记日志，返回值仍是 success（不让平台重试轰炸）', async () => {
  let runs = 0
  const okEntry = createTimerEntry({ run: async () => { runs += 1 }, createContext: async () => ({}), logger: silent })
  assert.equal(await okEntry({ Type: 'timer' }, {}), 'success')
  assert.equal(runs, 1)
  const logs = []
  const boomEntry = createTimerEntry({
    run: async () => { throw new Error('db down') },
    createContext: async () => ({}),
    logger: { error: (...a) => logs.push(a.join(' ')) },
  })
  assert.equal(await boomEntry({ Type: 'timer' }, {}), 'success')
  assert.equal(logs.length, 1)
  assert.ok(logs[0].includes('promptReminder') && logs[0].includes('db down'), '失败要留下痕迹')
  const noCtxEntry = createTimerEntry({ run: async () => ({}), createContext: async () => { throw new Error('no app') }, logger: silent })
  assert.equal(await noCtxEntry({ Type: 'timer' }, {}), 'success', '连 ctx 都建不起来时也不抛')
})

/* ================= 接线 ================= */

test('cloudbaserc.json：practice 注册了一个每日提醒定时触发器，其它函数没有触发器', () => {
  const rc = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloudbaserc.json'), 'utf8'))
  const byName = Object.fromEntries(rc.functions.map((f) => [f.name, f]))
  assert.deepEqual(byName.practice.triggers, [{ name: 'dailyPromptReminder', type: 'timer', config: '0 0 8 * * * *' }])
  assert.ok(!byName.practice.envVariables, 'practice 不配环境变量：提醒只写站内消息')
  assert.ok(byName.practice.timeout >= 60, '整批扫描要跑得完')
  for (const name of ['user', 'community', 'moderation', 'mediacheck']) assert.ok(!byName[name].triggers, `${name} 不该挂触发器`)
})

test('practice 入口：定时事件走提醒，普通调用仍走 action 分发', async () => {
  const today = cnDate(Date.now())
  entryDb.store.users.push(userRow(ID.alice), userRow(ID.bob))
  entryDb.store.daily_prompts.push(promptDoc({ date: today }))
  const r = await practiceEntry.main({ Type: 'timer', TriggerName: 'dailyPromptReminder', Time: `${today}T00:00:00.000Z` }, {})
  assert.equal(r, 'success', '定时事件返回平台约定的字符串，而不是 { code, data }')
  assert.equal(entryDb.store.notifications.length, 2, '两个账号各一条')
  assert.deepEqual([...new Set(entryDb.store.notifications.map((n) => n.refId))], ['prompt-1'])
  assert.deepEqual((await practiceEntry.main({ action: 'ping' }, {})).code, 0, '带 action 时按普通调用处理')
  assert.equal((await practiceEntry.main({ action: 'nope' }, {})).code, 40001)
  assert.equal(entryDb.store.notifications.length, 2, '普通调用不再触发提醒')
})

test('接线：两个新动作已在 practice.actions 上，且没有把提醒暴露成 action', () => {
  assert.deepEqual(Object.keys(practice.actions).sort(),
    ['answerPrompt', 'checkin', 'listAnswers', 'listCheckins', 'listNotifications', 'markNotificationsRead', 'ping', 'todayPrompt'])
  assert.ok(!('promptReminder' in practice.actions) && !('runReminder' in practice.actions), '客户端不该能手动催提醒')
  assert.ok(!practice.IDENTITY_FREE_ACTIONS.includes('listNotifications'), '消息列表要求身份')
  const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions/practice/index.js'), 'utf8')
  for (const token of ['isTimerEvent', 'createTimerEntry', 'runPromptReminder']) {
    assert.ok(src.includes(token), `index.js 应接上 ${token}`)
  }
})
