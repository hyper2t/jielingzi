'use strict'
/**
 * M0 基建：集合登记表、owned 新策略（single / sum / detach）、统一写入链路 guardWrite / guardRole、
 * 三个新云函数（community / moderation / practice）入口 ping。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const S = require('../../cloudfunctions/_shared')
const { createFakeDb } = require('./fakeDb')

const DAY = 24 * 3600 * 1000
const NOW = Date.UTC(2026, 9, 1, 4, 0, 0) // 北京时间 2026-10-01 12:00

// ---------- 集合登记表 ----------

test('集合登记表：名称唯一；owned 默认登记与 collections.js 一致；规则全部私有', () => {
  const names = S.COLLECTION_NAMES
  assert.equal(new Set(names).size, names.length)
  for (const n of ['users', 'account_links', 'account_merges', 'profiles', 'circles', 'memberships', 'invites', 'topics', 'replies', 'reports', 'mod_logs', 'checkins', 'daily_prompts', 'prompt_answers', 'notifications', 'rate_limits']) {
    assert.ok(names.includes(n), n)
  }
  S.restoreOwnedCollections()
  assert.deepEqual(S.OWNED_COLLECTIONS.map((c) => c.name), S.ownedDefs().map((c) => c.name))
  // 账号层集合不得登记为 owned（由 account.js 单独处理）
  for (const n of ['users', 'account_links', 'account_merges']) assert.ok(!S.OWNED_COLLECTIONS.some((c) => c.name === n))
  // 内容类注销时保留并解除归属
  const detach = S.OWNED_COLLECTIONS.filter((c) => c.onDelete === 'detach').map((c) => c.name).sort()
  assert.deepEqual(detach, ['prompt_answers', 'replies', 'reports', 'topics'])
  for (const r of Object.values(S.collectionRules())) assert.deepEqual(r, { read: false, write: false })
})

test('registerOwnedCollection 校验 keep / sumFields / onDelete', () => {
  assert.throws(() => S.registerOwnedCollection({ name: 'x', keep: 'bad' }), /keep/)
  assert.throws(() => S.registerOwnedCollection({ name: 'x', keep: 'sum' }), /sumFields/)
  assert.throws(() => S.registerOwnedCollection({ name: 'x', onDelete: 'archive' }), /onDelete/)
  S.restoreOwnedCollections()
})

test('每个云函数目录都在 cloudbaserc.json 注册，且有 index.js / service.js / package.json', () => {
  const root = path.resolve(__dirname, '../../cloudfunctions')
  const rc = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../cloudbaserc.json'), 'utf8'))
  const registered = rc.functions.map((f) => f.name).sort()
  const dirs = fs.readdirSync(root).filter((d) => !d.startsWith('_') && fs.statSync(path.join(root, d)).isDirectory()).sort()
  assert.deepEqual(registered, dirs)
  for (const d of dirs) for (const f of ['index.js', 'package.json']) assert.ok(fs.existsSync(path.join(root, d, f)), `${d}/${f}`)
  for (const f of rc.functions) assert.equal(f.runtime, 'Nodejs20.19')
})

// ---------- owned 新策略 ----------

function accountWorld() {
  const db = createFakeDb({
    data: {
      users: [{ _openid: 'P', settings: {} }, { _openid: 'Q', settings: {} }],
      profiles: [{ _openid: 'P', nickname: '主' }, { _openid: 'Q', nickname: '副' }],
      checkins: [
        { _openid: 'P', dayKey: '2026-10-01:meditation', minutes: 20 },
        { _openid: 'Q', dayKey: '2026-10-01:meditation', minutes: 15 },
        { _openid: 'Q', dayKey: '2026-10-02:taichi', minutes: 30 },
      ],
      memberships: [{ _openid: 'P', circleId: 'c1' }, { _openid: 'Q', circleId: 'c1' }, { _openid: 'Q', circleId: 'c2' }],
      topics: [{ _openid: 'Q', title: '副账号的话题' }],
    },
  })
  return { db, repo: S.createAccountRepo(db) }
}
const silent = { info() {}, error() {} }

test('mergeAccounts：profiles 每账号一条保留主账号；checkins 同日累加；memberships 按圈子去重；话题改归属', async () => {
  S.restoreOwnedCollections()
  const { db, repo } = accountWorld()
  const r = await S.mergeAccounts(repo, { secondary: 'Q', primary: 'P', now: NOW, logger: silent })
  assert.equal(r.merged, true)
  assert.deepEqual(db.store.profiles.map((p) => [p._openid, p.nickname]), [['P', '主']])
  const ck = db.store.checkins.map((c) => [c._openid, c.dayKey, c.minutes]).sort()
  assert.deepEqual(ck, [['P', '2026-10-01:meditation', 35], ['P', '2026-10-02:taichi', 30]])
  assert.deepEqual(db.store.memberships.map((m) => [m._openid, m.circleId]).sort(), [['P', 'c1'], ['P', 'c2']])
  assert.equal(db.store.topics[0]._openid, 'P')
  // 可重入
  const again = await S.mergeAccounts(repo, { secondary: 'Q', primary: 'P', now: NOW, logger: silent })
  assert.equal(again.merged, true)
  assert.equal(db.store.checkins.find((c) => c.dayKey === '2026-10-01:meditation').minutes, 35)
})

test('deleteAccountData：话题 / 回复保留但解除归属（authorDeleted），档案与打卡删除；集合不存在也不失败', async () => {
  S.restoreOwnedCollections()
  const db = createFakeDb({
    strictCollections: true,
    data: {
      users: [{ _openid: 'D' }],
      account_links: [{ _id: 'mp:D', accountId: 'D' }],
      profiles: [{ _openid: 'D', nickname: '我' }],
      topics: [{ _openid: 'D', title: 't' }, { _openid: 'X', title: '别人的' }],
      replies: [{ _openid: 'D', body: 'r' }],
    },
  })
  const removed = await S.deleteAccountData(S.createAccountRepo(db), { accountId: 'D', logger: silent })
  assert.equal(removed.profiles, 1)
  assert.equal(removed.topics, 1)
  assert.equal(removed.replies, 1)
  assert.equal(removed.checkins, 0) // 集合不存在
  assert.equal(removed.user, 1)
  assert.deepEqual(db.store.profiles, [])
  assert.deepEqual(db.store.topics.map((t) => [t._openid, t.authorDeleted === true, t.title]), [[null, true, 't'], ['X', false, '别人的']])
  assert.deepEqual(db.store.replies.map((t) => [t._openid, t.authorDeleted]), [[null, true]])
})

// ---------- guardWrite / guardRole ----------

function guardCtx(user, { now = NOW, data = {} } = {}) {
  const db = createFakeDb({ data: { users: user ? [{ _openid: 'U', ...user }] : [], ...data } })
  return { db, identity: { openid: user === undefined ? null : 'U' }, now: () => now }
}
const OK_USER = { adultConfirmedAt: 1, phoneVerified: true }
const codeOf = async (p) => {
  try {
    await p
    return 0
  } catch (e) {
    return e.code
  }
}

test('guardWrite 拒绝分支：未登录 / 无用户 / 封禁 / 未确认 18+ / 未实名 / 禁言', async () => {
  assert.equal(await codeOf(S.guardWrite(guardCtx(undefined), 'createTopic')), 40101)
  assert.equal(await codeOf(S.guardWrite(guardCtx(null), 'createTopic')), 40101)
  assert.equal(await codeOf(S.guardWrite(guardCtx({ ...OK_USER, bannedUntil: NOW + DAY }), 'createTopic')), 40304)
  assert.equal(await codeOf(S.guardWrite(guardCtx({ phoneVerified: true }), 'createTopic')), 40303)
  assert.equal(await codeOf(S.guardWrite(guardCtx({ adultConfirmedAt: 1 }), 'createTopic')), 40302)
  assert.equal(await codeOf(S.guardWrite(guardCtx({ ...OK_USER, mutedUntil: NOW + DAY }), 'createTopic')), 40305)
  // 封禁 / 禁言已过期 → 放行
  assert.equal(await codeOf(S.guardWrite(guardCtx({ ...OK_USER, bannedUntil: NOW - 1, mutedUntil: NOW - 1 }), 'createTopic')), 0)
  // 选项：举报不要求实名、禁言可用
  assert.equal(await codeOf(S.guardWrite(guardCtx({ adultConfirmedAt: 1, mutedUntil: NOW + DAY }), 'report', { requirePhone: false, allowMuted: true })), 0)
  // 封禁优先于其它检查（未实名的封禁用户也提示封禁）
  assert.equal(await codeOf(S.guardWrite(guardCtx({ bannedUntil: NOW + DAY }), 'createTopic')), 40304)
})

test('guardWrite 当日额度：commit 后才计数；超出 42901；按北京时间切日；集合不存在自动创建', async () => {
  const ctx = guardCtx(OK_USER)
  const limit = S.DAILY_LIMITS.createTopic
  assert.equal(limit, 2)
  // 未 commit（如被机审拒绝）不扣额度
  for (let i = 0; i < 3; i++) await S.guardWrite(ctx, 'createTopic')
  assert.equal((ctx.db.store.rate_limits || []).length, 0)
  const g1 = await S.guardWrite(ctx, 'createTopic')
  assert.equal(g1.remaining, 1)
  await g1.commit()
  await g1.commit() // 重复 commit 只计一次
  const g2 = await S.guardWrite(ctx, 'createTopic')
  assert.equal(g2.remaining, 0)
  await g2.commit()
  assert.equal(ctx.db.store.rate_limits[0]._id, 'U:createTopic:2026-10-01')
  assert.equal(ctx.db.store.rate_limits[0].count, 2)
  const e = await S.guardWrite(ctx, 'createTopic').catch((x) => x)
  assert.equal(e.code, 42901)
  assert.match(e.message, /每天 2 次/)
  // 其它动作独立计数
  assert.equal(await codeOf(S.guardWrite(ctx, 'createReply')), 0)
  // 北京时间次日 00:00（UTC 16:00）重置
  const next = { ...ctx, now: () => Date.UTC(2026, 9, 1, 16, 0, 0) }
  assert.equal(await codeOf(S.guardWrite(next, 'createTopic')), 0)
  // 北京时间当日 23:59（UTC 15:59）仍是同一天
  const late = { ...ctx, now: () => Date.UTC(2026, 9, 1, 15, 59, 0) }
  assert.equal(await codeOf(S.guardWrite(late, 'createTopic')), 42901)
})

test('guardWrite：limit 选项覆盖；未配置额度的动作不计数', async () => {
  const ctx = guardCtx(OK_USER)
  const g = await S.guardWrite(ctx, 'someAction')
  assert.equal(g.remaining, null)
  await g.commit()
  assert.equal((ctx.db.store.rate_limits || []).length, 0)
  const g1 = await S.guardWrite(ctx, 'createTopic', { limit: 1 })
  await g1.commit()
  assert.equal(await codeOf(S.guardWrite(ctx, 'createTopic', { limit: 1 })), 42901)
  assert.equal(await codeOf(S.guardWrite(ctx, 'createTopic', { limit: null })), 0)
})

test('guardRole：仅 mod / admin；可指定角色', async () => {
  assert.equal(await codeOf(S.guardRole(guardCtx({ role: 'user' }))), 40301)
  assert.equal(await codeOf(S.guardRole(guardCtx({}))), 40301)
  assert.equal(await codeOf(S.guardRole(guardCtx({ role: 'mod' }))), 0)
  assert.equal(await codeOf(S.guardRole(guardCtx({ role: 'mod' }), ['admin'])), 40301)
  assert.equal(await codeOf(S.guardRole(guardCtx(undefined))), 40101)
})

test('config：练习方式 id 唯一且措辞不含禁用词；cnDate 按 UTC+8', () => {
  assert.equal(new Set(S.PRACTICE_IDS).size, S.PRACTICE_IDS.length)
  for (const p of S.PRACTICES) assert.doesNotMatch(p.label, /修行|法门|同修|加持|开示|师父/)
  assert.equal(S.cnDate(Date.UTC(2026, 8, 30, 16, 0, 0)), '2026-10-01')
  assert.equal(S.cnDate(Date.UTC(2026, 8, 30, 15, 59, 59)), '2026-09-30')
})

// ---------- 新云函数入口 ----------

test('community / moderation / practice 入口：ping 免身份且不建号；未知 action 40001', async () => {
  const db = createFakeDb()
  const fakeSdk = {
    SYMBOL_CURRENT_ENV: Symbol('current'),
    init: () => ({ auth: () => ({ getUserInfo: () => ({ openId: 'oPing' }) }), database: () => db }),
  }
  const origLoad = Module._load
  Module._load = function (request, ...rest) {
    if (request === '@cloudbase/node-sdk') return fakeSdk
    return origLoad.call(this, request, ...rest)
  }
  try {
    for (const fn of ['community', 'moderation', 'practice']) {
      const { main } = require(`../../cloudfunctions/${fn}/index.js`)
      const r = await main({ action: 'ping' }, {})
      assert.equal(r.code, 0, fn)
      assert.equal(r.data.fn, fn)
      assert.equal((await main({ action: 'nope' }, {})).code, 40001)
    }
    assert.deepEqual(db.store.users || [], [])
  } finally {
    Module._load = origLoad
  }
})
