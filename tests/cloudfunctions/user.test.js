'use strict'
const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const S = require('../../cloudfunctions/_shared')
const { setup, links } = require('./userHarness')
const { registerDemoBusiness, resetDemoBusiness } = require('./demoBusiness')

// 设置项用演示登记（fontScale / theme / dailyGoal，默认 dailyGoal=30），见 demoBusiness.js
beforeEach(() => registerDemoBusiness())

test('login：首次创建、重复调用不重复建用户；写 acc:/mp: 别名', async () => {
  const { db, main } = setup()
  const r1 = await main({ action: 'login' })
  assert.deepEqual(r1, {
    code: 0,
    data: {
      openid: 'oA',
      accountId: 'oA',
      isNew: true,
      identities: { mp: true, wechat: true, phone: false, apple: false },
      settings: { dailyGoal: 30 },
      guardianConsentAt: null,
      merged: false,
      // 账号状态（BE-M1-03）：新用户未实名、未确认 18+
      phoneVerified: false,
      adult: false,
      role: 'user',
      bannedUntil: null,
      mutedUntil: null,
    },
    msg: 'ok',
  })
  const r2 = await main({ action: 'login' })
  assert.equal(r2.data.isNew, false)
  assert.equal(r2.data.accountId, 'oA')
  assert.equal(db.store.users.length, 1)
  const u = db.store.users[0]
  assert.equal(u._openid, 'oA')
  assert.deepEqual(u.settings, { dailyGoal: 30 })
  assert.ok(u.lastActiveAt > u.createdAt)
  assert.equal(u.lastLoginPlatform, 'weapp')
  assert.deepEqual(Object.keys(u).sort(), ['_id', '_openid', 'createdAt', 'lastActiveAt', 'lastLoginAt', 'lastLoginPlatform', 'settings'])
  assert.deepEqual(links(db), ['acc:oA>oA', 'mp:oA>oA'])
})

test('login：并发首次调用只建一条（唯一索引兜底）', async () => {
  const { db, main } = setup()
  const rs = await Promise.all([main({ action: 'login' }), main({ action: 'login' }), main({ action: 'login' })])
  assert.ok(rs.every((r) => r.code === 0))
  assert.equal(rs.filter((r) => r.data.isNew).length, 1)
  assert.equal(db.store.users.length, 1)
  assert.deepEqual(links(db), ['acc:oA>oA', 'mp:oA>oA'])
})

test('login：现网老用户（有 users 无 account_links）零迁移：首次调用补别名，isNew=false，数据不变', async () => {
  const { db, main } = setup({ users: [{ _id: 'u0', _openid: 'oA', createdAt: 1, lastActiveAt: 1, settings: { dailyGoal: 20, fontScale: 'large' }, guardianConsentAt: 5 }] })
  const r = await main({ action: 'login' })
  assert.equal(r.data.isNew, false)
  assert.deepEqual(r.data.settings, { dailyGoal: 20, fontScale: 'large' })
  assert.equal(r.data.guardianConsentAt, 5)
  assert.equal(db.store.users.length, 1)
  assert.deepEqual(links(db), ['acc:oA>oA', 'mp:oA>oA'])
})

test('login：下发云端已保存的设置与同意时间（换机 / 重装后前端据此恢复）', async () => {
  const { main } = setup()
  await main({ action: 'updateSettings', fontScale: 'large', dailyGoal: 20 })
  const c = await main({ action: 'consent' })
  const r = await main({ action: 'login' })
  assert.equal(r.code, 0)
  assert.deepEqual(r.data.settings, { dailyGoal: 20, fontScale: 'large' })
  assert.equal(r.data.guardianConsentAt, c.data.guardianConsentAt)
  // 旧记录没有 settings 字段时也要给默认值，不能返回 undefined
  const { main: legacy } = setup({ users: [{ _id: 'u0', _openid: 'oA', createdAt: 1, lastActiveAt: 1 }] })
  const r2 = await legacy({ action: 'login' })
  assert.deepEqual(r2.data.settings, { dailyGoal: 30 })
  assert.equal(r2.data.guardianConsentAt, null)
})

test('login（App）：platform / consentAt 上报——云端没有同意时间时写服务端时间，已有则不覆盖', async () => {
  const { db, as } = setup()
  const phone = as({ uid: 'uid-phone-0001' })
  const r = await phone({ action: 'login', platform: 'app', consentAt: 123, consentVersion: '2026-09' })
  assert.equal(r.code, 0)
  assert.equal(r.data.accountId, 'uid-phone-0001')
  assert.deepEqual(r.data.identities, { mp: false, wechat: false, phone: true, apple: false })
  assert.ok(r.data.guardianConsentAt > 1000, '写的是服务端时间')
  const first = r.data.guardianConsentAt
  const u = db.store.users.find((x) => x._openid === 'uid-phone-0001')
  assert.equal(u.consentVersion, '2026-09')
  assert.equal(u.lastLoginPlatform, 'app')
  const r2 = await phone({ action: 'login', platform: 'app', consentAt: 456 })
  assert.equal(r2.data.guardianConsentAt, first)
  assert.equal((await phone({ action: 'login', platform: 'h5' })).code, 40001)
  assert.equal((await phone({ action: 'login', consentAt: 0 })).code, 40001)
})

test('未登录返回 40101（login / consent / updateSettings / bindWechat / linkPhoneSession / deleteAccount）', async () => {
  const { as } = setup()
  const anon = as(null)
  for (const action of ['login', 'consent']) assert.equal((await anon({ action })).code, 40101)
  assert.equal((await anon({ action: 'updateSettings', theme: 'dark' })).code, 40101)
  assert.equal((await anon({ action: 'bindWechat', code: 'code-0123456789' })).code, 40101)
  assert.equal((await anon({ action: 'linkPhoneSession', otherAccessToken: 'x'.repeat(20) })).code, 40101)
  assert.equal((await anon({ action: 'deleteAccount', confirm: 'DELETE' })).code, 40101)
  // Publishable Key 的 uid 'anon' 同样视为无身份
  const pk = as({ uid: 'anon' })
  assert.equal((await pk({ action: 'login' })).code, 40101)
})

test('客户端夹带身份字段无效，多余参数被拒', async () => {
  const { main } = setup()
  assert.equal((await main({ action: 'login', openid: 'oB' })).code, 40001)
  const r = await main({ action: 'login', userInfo: { openId: 'oB' } })
  assert.equal(r.data.openid, 'oA')
})

test('updateSettings：合法值写入 settings.*，非法值 40001', async () => {
  const { db, main } = setup()
  await main({ action: 'login' })
  const r = await main({ action: 'updateSettings', fontScale: 'large', dailyGoal: 45 })
  assert.equal(r.code, 0)
  assert.deepEqual(r.data.settings, { dailyGoal: 45, fontScale: 'large' })
  await main({ action: 'updateSettings', theme: 'dark' })
  assert.deepEqual(db.store.users[0].settings, { dailyGoal: 45, fontScale: 'large', theme: 'dark' })

  const bad = [
    { fontScale: 'huge' }, { fontScale: '' }, { dailyGoal: 0 }, { dailyGoal: 60 }, { dailyGoal: '30' },
    { dailyGoal: -1 }, { theme: 'blue' }, {}, { guardianConsentAt: 1 }, { settings: {} },
  ]
  for (const p of bad) assert.equal((await main({ action: 'updateSettings', ...p })).code, 40001, JSON.stringify(p))
  assert.deepEqual(db.store.users[0].settings, { dailyGoal: 45, fontScale: 'large', theme: 'dark' })
})

test('updateSettings：用户不存在时先创建', async () => {
  const { db, main } = setup()
  const r = await main({ action: 'updateSettings', fontScale: 'large' })
  assert.deepEqual(r.data.settings, { dailyGoal: 30, fontScale: 'large' })
  assert.equal(db.store.users.length, 1)
})

test('consent：写服务端时间，重复同意覆盖为最新', async () => {
  const { db, main } = setup()
  const r1 = await main({ action: 'consent' })
  assert.equal(r1.code, 0)
  assert.equal(db.store.users[0].guardianConsentAt, r1.data.guardianConsentAt)
  const r2 = await main({ action: 'consent', guardianConsentAt: 1 })
  assert.equal(r2.code, 40001)
  const r3 = await main({ action: 'consent' })
  assert.ok(r3.data.guardianConsentAt > r1.data.guardianConsentAt)
  assert.equal(db.store.users.length, 1)
})

test('A、B 互不影响', async () => {
  const { db, as } = setup()
  await as('oA')({ action: 'updateSettings', fontScale: 'large' })
  await as('oB')({ action: 'updateSettings', fontScale: 'xlarge' })
  const byId = Object.fromEntries(db.store.users.map((u) => [u._openid, u.settings.fontScale]))
  assert.deepEqual(byId, { oA: 'large', oB: 'xlarge' })
})

const NO_STATUS = { phoneVerified: false, adult: false, role: 'user', bannedUntil: null, mutedUntil: null }

test('whoami：不要求身份，只返回布尔形态 + 账号状态（无账号时为默认值）', async () => {
  const { as } = setup()
  assert.deepEqual((await as('oA', { unionId: 'un-1' })({ action: 'whoami' })).data, {
    source: 'weapp', loginType: null, account: false, openId: true, unionId: true, uid: false, customUserId: false, anonymous: false, publishableKey: false, ...NO_STATUS,
  })
  assert.deepEqual((await as(null)({ action: 'whoami' })).data, {
    source: null, loginType: null, account: false, openId: false, unionId: false, uid: false, customUserId: false, anonymous: false, publishableKey: false, ...NO_STATUS,
  })
  // whoami 不会因副作用建号；登录过之后 account 为 true 且带 loginType
  const { db, as: as2 } = setup()
  assert.equal((await as2({ uid: 'uid-0001' }, { loginType: 'PHONE' })({ action: 'whoami' })).data.account, false)
  assert.equal((db.store.users || []).length, 0)
  await as2({ uid: 'uid-0001' })({ action: 'login' })
  // 手机号登录的账号：login 时已标记实名（BE-M1-02）
  assert.deepEqual((await as2({ uid: 'uid-0001' }, { loginType: 'PHONE' })({ action: 'whoami' })).data, {
    source: 'web', loginType: 'PHONE', account: true, openId: false, unionId: false, uid: true, customUserId: false, anonymous: false, publishableKey: false, ...NO_STATUS, phoneVerified: true,
  })
  assert.equal((await as('oA')({ action: 'whoami', x: 1 })).code, 40001)
})

test('默认登记（结灵子业务集合，设置项为空）：新用户 settings 为 {}，updateSettings 拒绝任何入参；注销遍历全部业务集合', async () => {
  resetDemoBusiness()
  const { db, main } = setup()
  const r = await main({ action: 'login' })
  assert.deepEqual(r.data.settings, {})
  assert.deepEqual(db.store.users[0].settings, {})
  assert.equal((await main({ action: 'updateSettings' })).code, 40001)
  assert.equal((await main({ action: 'updateSettings', fontScale: 'large' })).code, 40001)
  const d = await main({ action: 'deleteAccount', confirm: 'DELETE' })
  const zero = Object.fromEntries(S.OWNED_COLLECTIONS.map((c) => [c.name, 0]))
  assert.deepEqual(d.data, { ok: true, removed: { ...zero, user: 1, links: 2 } })
  assert.ok('profiles' in d.data.removed && 'topics' in d.data.removed)
  assert.deepEqual(db.store.users, [])
})
