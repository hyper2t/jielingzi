'use strict'
/**
 * M1：账号补强（BE-M1-01 小程序手机号 / BE-M1-02 App 实名 / BE-M1-03 18+ 与状态 / BE-M1-05 合并注销）
 * + 练习档案（BE-M1-04 community.getProfile / updateProfile）。用例索引见 docs/test/cases/M1.md。
 */
const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const S = require('../../cloudfunctions/_shared')
const community = require('../../cloudfunctions/community/service')
const { generateAlias, ALIAS_FIRST, ALIAS_SECOND } = require('../../cloudfunctions/community/alias')
const { setup, links } = require('./userHarness')
const { createFakeDb } = require('./fakeDb')

// 用真实登记表（profiles / checkins …），不用 user.test 的演示业务集合
beforeEach(() => S.restoreOwnedCollections())

const DAY = 24 * 3600 * 1000
const NOW = Date.UTC(2026, 9, 1, 4, 0, 0) // 北京时间 2026-10-01 12:00
const silent = { info() {}, error() {} }
const phoneHash = S.createPhoneHasher({ PHONE_HASH_SECRET: 'test-phone-hash-secret-0123456789' })
const PROFILE_UNIQUE = { profiles: ['_openid', 'anonAlias'] }

/** 假小程序服务端：code → 规范化手机号；'expired-*' → 40001（code 失效） */
const MP_PHONES = { 'code-phone-A-0001': '+8613800000001', 'code-phone-A-0002': '+8613800000001', 'code-phone-B-0001': '+8613800000002' }
function fakeMp(map = MP_PHONES) {
  const calls = []
  return {
    calls,
    async getPhoneNumber(code, openid) {
      calls.push({ code, openid })
      if (code.startsWith('expired-')) throw S.badParam('手机号验证已失效，请重新获取')
      if (!map[code]) throw S.upstream('手机号验证失败（-1）')
      return map[code]
    },
  }
}

/** community 函数入口（身份直接给 accountId；与 user 测试共用同一个 db 时可验证合并 / 注销） */
function communityAs(db, accountId, opts = {}) {
  let t = opts.now || NOW
  return S.createMain({
    actions: community.actions,
    logger: silent,
    createContext: async () => ({ db, identity: { openid: accountId }, now: () => ++t, random: opts.random, moderation: opts.moderation, logger: silent }),
  })
}
const communityWorld = (users = [{ _openid: 'U', adultConfirmedAt: 1 }]) => createFakeDb({ data: { users }, unique: PROFILE_UNIQUE })
const codeOf = async (p) => {
  try {
    await p
    return 0
  } catch (e) {
    return e.code
  }
}

// ---------- 手机号工具 / 小程序服务端客户端 ----------

test('normalizePhone / createPhoneHasher：E.164 规范化；同号不同来源同哈希、带版本前缀、不含明文；未配置或密钥过短为 null', () => {
  assert.equal(S.normalizePhone('13800138000'), '+8613800138000')
  assert.equal(S.normalizePhone('+86 13800138000'), '+8613800138000')
  assert.equal(S.normalizePhone('13800138000', '86'), '+8613800138000')
  assert.equal(S.normalizePhone('8613800138000'), '+8613800138000')
  assert.equal(S.normalizePhone('4155552671', '1'), '+14155552671')
  for (const bad of ['12345', '', null, undefined, 'abc']) assert.equal(S.normalizePhone(bad), null)
  const h = phoneHash('+86 13800138000')
  assert.match(h, /^h1:[0-9a-f]{32}$/)
  assert.equal(phoneHash('13800138000'), h)
  assert.notEqual(phoneHash('13800138001'), h)
  assert.ok(!h.includes('13800138000'))
  assert.notEqual(S.createPhoneHasher({ PHONE_HASH_SECRET: 'another-secret-0123456789' })('13800138000'), h)
  assert.equal(S.createPhoneHasher({}), null)
  assert.equal(S.createPhoneHasher({ PHONE_HASH_SECRET: 'short' }), null)
  assert.equal(S.createPhoneHasher({ PHONE_HASH_SECRET: '{{env.PHONE_HASH_SECRET}}' }), null)
  assert.throws(() => phoneHash('abc'), /无法识别/)
})

test('createMpClient：未配置为 null；stable_token 进程内缓存；token 失效强制刷新重试；带 openid；code 失效 40001；繁忙 / 网络错误 50201', async () => {
  assert.equal(S.createMpClient({}), null)
  assert.equal(S.createMpClient({ WX_MP_APP_ID: 'wx1', WX_MP_APP_SECRET: '{{env.WX_MP_APP_SECRET}}' }), null)
  let tokens = 0
  const calls = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    const u = new URL(url)
    calls.push({ path: u.pathname, token: u.searchParams.get('access_token'), body })
    let data
    if (u.pathname === '/cgi-bin/stable_token') {
      tokens++
      data = { access_token: `tk${tokens}`, expires_in: 7200 }
    } else if (body.code === 'expired-code-01') data = { errcode: 40029, errmsg: 'invalid code' }
    else if (body.code === 'busy-code-0001') data = { errcode: -1, errmsg: 'system error' }
    else if (body.code === 'stale-token-01' && u.searchParams.get('access_token') === 'tk1') data = { errcode: 40001, errmsg: 'invalid credential' }
    else data = { errcode: 0, errmsg: 'ok', phone_info: { phoneNumber: '13800138000', purePhoneNumber: '13800138000', countryCode: '86', watermark: {} } }
    return { json: async () => data }
  }
  let now = 1000
  const mp = S.createMpClient({ WX_MP_APP_ID: 'wxmp', WX_MP_APP_SECRET: 'sec' }, { fetchImpl, now: () => now })
  assert.equal(await mp.getPhoneNumber('good-code-0001', 'oOpen'), '+8613800138000')
  assert.equal(await mp.getPhoneNumber('good-code-0002', 'oOpen'), '+8613800138000')
  assert.equal(tokens, 1, 'access_token 缓存复用')
  assert.deepEqual(calls[0], { path: '/cgi-bin/stable_token', token: null, body: { grant_type: 'client_credential', appid: 'wxmp', secret: 'sec' } })
  assert.deepEqual(calls[1], { path: '/wxa/business/getuserphonenumber', token: 'tk1', body: { code: 'good-code-0001', openid: 'oOpen' } })
  // 平台判定 token 失效 → 强制刷新一次后重试
  assert.equal(await mp.getPhoneNumber('stale-token-01', 'oOpen'), '+8613800138000')
  assert.equal(tokens, 2)
  assert.ok(calls.some((c) => c.path === '/cgi-bin/stable_token' && c.body.force_refresh === true))
  await assert.rejects(mp.getPhoneNumber('expired-code-01', 'oOpen'), (e) => e.code === 40001 && /失效/.test(e.message))
  await assert.rejects(mp.getPhoneNumber('busy-code-0001', 'oOpen'), (e) => e.code === 50201)
  // 过期前 5 分钟换新
  now += 7200 * 1000
  await mp.getPhoneNumber('good-code-0003')
  assert.equal(tokens, 3)
  const broken = S.createMpClient({ WX_MP_APP_ID: 'wxmp', WX_MP_APP_SECRET: 'sec' }, { fetchImpl: async () => { throw new Error('ECONNRESET') } })
  await assert.rejects(broken.getPhoneNumber('good-code-0001'), (e) => e.code === 50201)
})

// ---------- BE-M1-01 user.bindPhoneWeapp ----------

test('bindPhoneWeapp 成功：标记实名、只存哈希（库里无明文）、建 phone: 别名、把 openid 交给微信校验 code 归属；重复绑定幂等', async () => {
  const mp = fakeMp()
  const { db, main } = setup({ mp, phoneHash })
  await main({ action: 'login' })
  const r = await main({ action: 'bindPhoneWeapp', code: 'code-phone-A-0001' })
  assert.equal(r.code, 0)
  assert.deepEqual(r.data, { ok: true, merged: false, phoneVerified: true, adult: false, role: 'user', bannedUntil: null, mutedUntil: null })
  assert.deepEqual(mp.calls, [{ code: 'code-phone-A-0001', openid: 'oA' }])
  const u = db.store.users[0]
  assert.equal(u.phoneVerified, true)
  assert.equal(u.phoneHash, phoneHash('13800000001'))
  assert.equal(typeof u.phoneVerifiedAt, 'number')
  assert.ok(links(db).includes(`phone:${u.phoneHash}>oA`))
  assert.ok(!JSON.stringify(db.store).includes('13800000001'), '数据库里没有手机号明文')
  assert.deepEqual((await main({ action: 'login' })).data.identities, { mp: true, wechat: true, phone: true, apple: false })
  assert.equal((await main({ action: 'bindPhoneWeapp', code: 'code-phone-A-0002' })).data.merged, false)
  assert.equal(links(db).filter((l) => l.startsWith('phone:')).length, 1)
})

test('bindPhoneWeapp 失败分支：code 失效 40001 且不写库；参数错误 40001；非小程序 40301；无身份 40101；未配置凭证 / 哈希密钥 50201', async () => {
  const { db, main, as } = setup({ mp: fakeMp(), phoneHash })
  await main({ action: 'login' })
  const before = JSON.stringify(db.store)
  const r = await main({ action: 'bindPhoneWeapp', code: 'expired-code-0001' })
  assert.equal(r.code, 40001)
  assert.match(r.msg, /失效/)
  assert.equal(JSON.stringify(db.store), before, 'code 失效时没有任何写入')
  assert.equal((await main({ action: 'bindPhoneWeapp' })).code, 40001)
  assert.equal((await main({ action: 'bindPhoneWeapp', code: 'short' })).code, 40001)
  assert.equal((await main({ action: 'bindPhoneWeapp', code: 'code-phone-A-0001', phone: '13800000001' })).code, 40001)
  assert.equal((await as({ uid: 'uid-app-0001' })({ action: 'bindPhoneWeapp', code: 'code-phone-A-0001' })).code, 40301)
  assert.equal((await as(null)({ action: 'bindPhoneWeapp', code: 'code-phone-A-0001' })).code, 40101)
  assert.equal((await setup({ phoneHash }).main({ action: 'bindPhoneWeapp', code: 'code-phone-A-0001' })).code, 50201)
  assert.equal((await setup({ mp: fakeMp() }).main({ action: 'bindPhoneWeapp', code: 'code-phone-A-0001' })).code, 50201)
})

test('bindPhoneWeapp：号码已被另一个微信用户绑定 → 40901，不合并、对方不受影响', async () => {
  const { db, as } = setup({ mp: fakeMp(), phoneHash })
  const a = as('oA')
  const b = as('oB')
  await a({ action: 'login' })
  await b({ action: 'login' })
  assert.equal((await a({ action: 'bindPhoneWeapp', code: 'code-phone-A-0001' })).code, 0)
  const r = await b({ action: 'bindPhoneWeapp', code: 'code-phone-A-0002' })
  assert.equal(r.code, 40901)
  assert.match(r.msg, /已绑定其他账号/)
  assert.equal(db.store.users.length, 2)
  assert.notEqual(db.store.users.find((u) => u._openid === 'oB').phoneVerified, true)
  assert.ok(links(db).includes(`phone:${phoneHash('13800000001')}>oA`))
  assert.equal((db.store.account_merges || []).length, 0)
})

test('bindPhoneWeapp：同一号码先在 App 用手机号登录过 → App 账号并入小程序账号（实名、18+、档案、别名都归小程序账号）', async () => {
  const authApi = { async userMe(token) { return token === 'self-token-uid-phone-0001' ? { sub: 'uid-phone-0001', phone: '+86 13800000001' } : null } }
  const { db, as } = setup({ mp: fakeMp(), phoneHash, authApi, unique: PROFILE_UNIQUE })
  const app = as({ uid: 'uid-phone-0001' })
  const login = await app({ action: 'login', platform: 'app', adultConfirmedAt: 5 })
  assert.equal(login.data.phoneVerified, true, 'App 手机号登录即实名（BE-M1-02）')
  assert.equal(login.data.adult, true)
  // App 手机号登录后用自己的会话登记号码（复用 linkPhoneSession）
  assert.deepEqual((await app({ action: 'linkPhoneSession', otherAccessToken: 'self-token-uid-phone-0001' })).data, { ok: true, merged: false })
  assert.ok(links(db).includes(`phone:${phoneHash('13800000001')}>uid-phone-0001`))
  assert.equal((await communityAs(db, 'uid-phone-0001')({ action: 'updateProfile', nickname: 'App 里的我' })).code, 0)

  const mini = as('oMini')
  await mini({ action: 'login' })
  const r = await mini({ action: 'bindPhoneWeapp', code: 'code-phone-A-0001' })
  assert.equal(r.code, 0)
  assert.equal(r.data.merged, true)
  assert.equal(r.data.phoneVerified, true)
  assert.equal(r.data.adult, true, '18+ 从被并入账号补齐')
  assert.ok(!db.store.users.some((u) => u._openid === 'uid-phone-0001'))
  assert.deepEqual(db.store.profiles.map((p) => [p._openid, p.nickname]), [['oMini', 'App 里的我']])
  assert.ok(db.store.account_merges.some((m) => m.reason === 'phone' && m.primary === 'oMini' && m.secondary === 'uid-phone-0001'))
  // 之后 App 手机号会话解析到小程序账号
  assert.equal((await app({ action: 'login', platform: 'app' })).data.accountId, 'oMini')
})

test('bindPhoneWeapp：换绑新号码 → 更新哈希、释放旧号码（别人可以再绑）', async () => {
  const { db, main, as } = setup({ mp: fakeMp(), phoneHash })
  await main({ action: 'login' })
  await main({ action: 'bindPhoneWeapp', code: 'code-phone-A-0001' })
  await main({ action: 'bindPhoneWeapp', code: 'code-phone-B-0001' })
  assert.equal(db.store.users[0].phoneHash, phoneHash('13800000002'))
  assert.deepEqual(links(db).filter((l) => l.startsWith('phone:')), [`phone:${phoneHash('13800000002')}>oA`])
  await as('oB')({ action: 'login' })
  assert.equal((await as('oB')({ action: 'bindPhoneWeapp', code: 'code-phone-A-0002' })).code, 0)
})

// ---------- BE-M1-02 App：手机号登录即实名、补绑手机号复用 linkPhoneSession ----------

test('linkPhoneSession：自己的手机号会话 → 实名 + phone: 别名；号码属于另一个人 → 40901 且不关联会话；未配哈希密钥仍标记实名', async () => {
  const sessions = {
    'tok-self-0000000001': { sub: 'uid-phone-0002', phone: '+86 13800000003' },
    'tok-mine-0000000001': { sub: 'uid-phone-0004', phone: '+86 13800000001' },
  }
  const authApi = { async userMe(t) { return sessions[t] || null } }
  const { db, as } = setup({ mp: fakeMp(), phoneHash, authApi })
  const self = as({ uid: 'uid-phone-0002' })
  await self({ action: 'login', platform: 'app' })
  assert.deepEqual((await self({ action: 'linkPhoneSession', otherAccessToken: 'tok-self-0000000001' })).data, { ok: true, merged: false })
  const u = db.store.users.find((x) => x._openid === 'uid-phone-0002')
  assert.deepEqual([u.phoneVerified, u.phoneHash], [true, phoneHash('13800000003')])

  // 小程序用户 oA 已绑定 13800000001；另一个小程序用户 oB 拿同号的手机号会话来关联 → 40901，cbuid 也不关联
  await as('oA')({ action: 'login' })
  await as('oA')({ action: 'bindPhoneWeapp', code: 'code-phone-A-0001' })
  await as('oB')({ action: 'login' })
  assert.equal((await as('oB')({ action: 'linkPhoneSession', otherAccessToken: 'tok-mine-0000000001' })).code, 40901)
  assert.ok(!links(db).some((l) => l.startsWith('cbuid:uid-phone-0004')))

  // 未配置 PHONE_HASH_SECRET：照常关联会话、标记实名，只是不建 phone: 别名
  const { db: db2, as: as2 } = setup({ authApi })
  const wx = as2({ uid: 'uid-wx-0001' })
  await wx({ action: 'login', platform: 'app' })
  assert.deepEqual((await wx({ action: 'linkPhoneSession', otherAccessToken: 'tok-self-0000000001' })).data, { ok: true, merged: false })
  assert.equal(db2.store.users.find((x) => x._openid === 'uid-wx-0001').phoneVerified, true)
  assert.ok(!links(db2).some((l) => l.startsWith('phone:')))
})

test('login（App）：上报本机 18+ 确认 → 云端没有时写服务端时间与协议版本，已有不覆盖；手机号账号标记实名，小程序账号不会', async () => {
  const { db, as } = setup()
  const app = as({ uid: 'uid-phone-0100' })
  const r1 = await app({ action: 'login', platform: 'app', consentAt: 1, adultConfirmedAt: 2 })
  assert.deepEqual([r1.data.adult, r1.data.phoneVerified], [true, true])
  const u = () => db.store.users.find((x) => x._openid === 'uid-phone-0100')
  assert.ok(u().adultConfirmedAt > 1000, '写服务端时间')
  assert.equal(u().consentVersion, S.CONSENT_VERSION)
  const t = u().adultConfirmedAt
  await app({ action: 'login', platform: 'app', adultConfirmedAt: 99 })
  assert.equal(u().adultConfirmedAt, t)
  assert.equal((await app({ action: 'login', adultConfirmedAt: 0 })).code, 40001)
  const { main } = setup()
  assert.equal((await main({ action: 'login' })).data.phoneVerified, false)
})

// ---------- BE-M1-03 confirmAdult / whoami 状态 ----------

test('confirmAdult：首次写服务端时间与协议版本，重复确认不改时间；之后 guardWrite 不再拦 40303（发布类仍要实名）', async () => {
  const { db, main, as } = setup()
  await main({ action: 'login' })
  const r1 = await main({ action: 'confirmAdult' })
  assert.equal(r1.code, 0)
  assert.equal(r1.data.adult, true)
  assert.equal(r1.data.consentVersion, S.CONSENT_VERSION)
  const t1 = r1.data.adultConfirmedAt
  assert.equal(typeof t1, 'number')
  const r2 = await main({ action: 'confirmAdult', consentVersion: 'v0.2' })
  assert.deepEqual([r2.data.adultConfirmedAt, r2.data.consentVersion], [t1, 'v0.2'])
  assert.equal(db.store.users[0].adultConfirmedAt, t1)
  assert.equal((await main({ action: 'confirmAdult', adultConfirmedAt: 1 })).code, 40001)
  assert.equal((await as(null)({ action: 'confirmAdult' })).code, 40101)
  const ctx = { db, identity: { openid: 'oA' }, now: () => NOW }
  assert.equal(await codeOf(S.guardWrite(ctx, 'createTopic')), 40302)
  assert.equal(await codeOf(S.guardWrite(ctx, 'updateProfile', { requirePhone: false })), 0)
})

test('whoami / login 返回账号状态：处罚未到期才返回截止时间；非法角色按 user', async () => {
  const FUTURE = 10 ** 13
  const { as } = setup({
    users: [
      { _id: 'u1', _openid: 'oA', adultConfirmedAt: 1, phoneVerified: true, role: 'mod', bannedUntil: FUTURE, mutedUntil: 5 },
      { _id: 'u2', _openid: 'oB', role: 'root' },
    ],
  })
  const l = (await as('oA')({ action: 'login' })).data
  assert.deepEqual([l.phoneVerified, l.adult, l.role, l.bannedUntil, l.mutedUntil], [true, true, 'mod', FUTURE, null])
  const w = (await as('oA')({ action: 'whoami' })).data
  assert.deepEqual([w.account, w.phoneVerified, w.adult, w.role, w.bannedUntil, w.mutedUntil], [true, true, true, 'mod', FUTURE, null])
  await as('oB')({ action: 'login' })
  assert.equal((await as('oB')({ action: 'whoami' })).data.role, 'user')
})

// ---------- BE-M1-05 合并 / 注销（users 字段与 profiles） ----------

test('mergeAccounts：users 的实名 / 18+ / 协议版本从被并入方补齐；处罚取较晚（不能借合并规避）；角色取较高', async () => {
  const db = createFakeDb({
    data: {
      users: [
        { _openid: 'P', settings: {}, role: 'user', mutedUntil: 100 },
        { _openid: 'Q', settings: {}, phoneVerified: true, phoneHash: 'h1:abc', phoneVerifiedAt: 3, adultConfirmedAt: 7, consentVersion: 'v0.1', role: 'mod', bannedUntil: 500, mutedUntil: 50 },
      ],
    },
  })
  await S.mergeAccounts(S.createAccountRepo(db), { secondary: 'Q', primary: 'P', now: NOW, logger: silent })
  const p = db.store.users.find((u) => u._openid === 'P')
  assert.deepEqual(
    [p.phoneVerified, p.phoneHash, p.phoneVerifiedAt, p.adultConfirmedAt, p.consentVersion, p.role, p.bannedUntil, p.mutedUntil],
    [true, 'h1:abc', 3, 7, 'v0.1', 'mod', 500, 100],
  )
  assert.deepEqual(S.mergeUserFields({ phoneVerified: true, role: 'admin', bannedUntil: 9 }, { phoneVerified: true, role: 'mod', bannedUntil: 3 }), {})
})

test('identityConflict：只有同一种个人身份（小程序 openid / unionid / Apple）取值不同才算两个人', () => {
  const L = (...ids) => ids.map((id) => ({ _id: id, kind: id.split(':')[0] }))
  assert.equal(S.identityConflict(L('mp:a', 'acc:a'), L('mp:b', 'acc:b')), 'mp')
  assert.equal(S.identityConflict(L('unionid:u1', 'acc:x'), L('unionid:u2')), 'unionid')
  assert.equal(S.identityConflict(L('apple:1'), L('apple:2', 'cbuid:z')), 'apple')
  assert.equal(S.identityConflict(L('mp:a'), L('unionid:u2', 'cbuid:x')), null, '小程序未绑开放平台时无法比较，视为同一人')
  assert.equal(S.identityConflict(L('mp:a'), L('cbuid:x', 'acc:x')), null)
  assert.equal(S.identityConflict(L('unionid:u', 'mp:a'), L('unionid:u')), null)
})

test('注销 / 合并处理 profiles（BE-M1-05）：注销删除档案；两边都有档案时合并保留主账号那条', async () => {
  const { db, main } = setup({ unique: PROFILE_UNIQUE })
  await main({ action: 'login' })
  await main({ action: 'confirmAdult' })
  assert.equal((await communityAs(db, 'oA')({ action: 'updateProfile', nickname: '要注销的我' })).code, 0)
  assert.equal(db.store.profiles.length, 1)
  const d = await main({ action: 'deleteAccount', confirm: 'DELETE' })
  assert.equal(d.data.removed.profiles, 1)
  assert.deepEqual(db.store.profiles, [])

  const db2 = communityWorld([{ _openid: 'P', adultConfirmedAt: 1, settings: {} }, { _openid: 'Q', adultConfirmedAt: 1, settings: {} }])
  await communityAs(db2, 'P')({ action: 'updateProfile', nickname: '主账号' })
  await communityAs(db2, 'Q')({ action: 'updateProfile', nickname: '副账号' })
  await S.mergeAccounts(S.createAccountRepo(db2), { secondary: 'Q', primary: 'P', now: NOW, logger: silent })
  assert.deepEqual(db2.store.profiles.map((p) => [p._openid, p.nickname]), [['P', '主账号']])
})

// ---------- BE-M1-04 community.getProfile / updateProfile ----------

test('getProfile / updateProfile：首次保存建档并分配匿名代号；部分更新；只返回本人档案且不含任何标识', async () => {
  const db = communityWorld()
  const me = communityAs(db, 'U')
  assert.deepEqual((await me({ action: 'getProfile' })).data, { profile: null })
  const r = await me({ action: 'updateProfile', nickname: '  林 然  ', practices: ['mindfulness', 'taichi', 'mindfulness'], years: 3, goal: '每天 20 分钟', bio: '在呼吸里找回自己', avatar: 'preset:leaf' })
  assert.equal(r.code, 0, r.msg)
  const p = r.data.profile
  assert.deepEqual([p.nickname, p.practices, p.years, p.goal, p.bio, p.avatar], ['林 然', ['mindfulness', 'taichi'], 3, '每天 20 分钟', '在呼吸里找回自己', 'preset:leaf'])
  assert.match(p.anonAlias, /^[\u4e00-\u9fa5]{2}$/)
  assert.deepEqual(Object.keys(p).sort(), ['anonAlias', 'avatar', 'badges', 'bio', 'goal', 'nickname', 'practices', 'updatedAt', 'years'])
  assert.deepEqual(db.store.profiles.map((x) => x._openid), ['U'])
  const r2 = await me({ action: 'updateProfile', bio: '' })
  assert.deepEqual([r2.data.profile.bio, r2.data.profile.nickname, r2.data.profile.anonAlias], ['', '林 然', p.anonAlias])
  const g = await me({ action: 'getProfile' })
  assert.deepEqual(g.data.profile, r2.data.profile)
  assert.ok(!JSON.stringify(g.data).includes('"U"'), '不返回 accountId')
  const r3 = await me({ action: 'updateProfile', avatar: null, years: null })
  assert.deepEqual([r3.data.profile.avatar, r3.data.profile.years], [null, null])
  assert.equal(db.store.profiles.length, 1)
  assert.equal((await me({ action: 'getProfile', uid: 'X' })).code, 40001)
  assert.equal((await me({ action: 'updateProfile' })).code, 40001)
  assert.equal((await me({ action: 'updateProfile', _openid: 'X', nickname: '张三' })).code, 40001)
})

test('updateProfile 字段校验（与前端 src/features/profile/rules.ts 一致）：昵称 2–16 字按码点计、保留词、不可见字符；介绍 ≤ 80；目标 ≤ 40；练习方式预置且 ≤ 5；年限 0–80 整数；头像仅预置', async () => {
  const db = communityWorld()
  const me = communityAs(db, 'U')
  const code = async (p) => (await me({ action: 'updateProfile', ...p })).code
  assert.equal(await code({ nickname: '林' }), 40001)
  assert.equal(await code({ nickname: '一二三四五六七八九十一二三四五六七' }), 40001)
  assert.equal(await code({ nickname: '一二三四五六七八九十一二三四五六' }), 0)
  assert.equal(await code({ nickname: '🌿🌿' }), 0)
  assert.equal(await code({ nickname: '🌿' }), 40001)
  assert.equal(await code({ nickname: '结灵子官方' }), 40001)
  assert.equal(await code({ nickname: '管理员小王' }), 40001)
  assert.equal(await code({ nickname: 'ab\u200bcd' }), 40001)
  assert.equal(await code({ nickname: 123 }), 40001)
  assert.equal(await code({ bio: 'x'.repeat(81) }), 40001)
  assert.equal(await code({ bio: '字'.repeat(80) }), 0)
  assert.equal(await code({ goal: 'x'.repeat(41) }), 40001)
  assert.equal(await code({ practices: ['meditation', 'buddhism'] }), 40001)
  assert.equal(await code({ practices: 'meditation' }), 40001)
  assert.equal(await code({ practices: ['meditation', 'mindfulness', 'vipassana', 'taichi', 'zhanzhuang', 'yoga'] }), 40001)
  assert.equal(await code({ practices: [] }), 0)
  for (const years of [-1, 81, 1.5, '3']) assert.equal(await code({ years }), 40001, String(years))
  assert.equal(await code({ years: 0 }), 0)
  assert.equal(await code({ avatar: 'cloud://env-1/a.png' }), 40001)
  assert.equal(await code({ avatar: 'preset:nope' }), 40001)
  for (const id of S.AVATAR_PRESETS) assert.equal(await code({ avatar: `preset:${id}` }), 0, id)
})

test('updateProfile 写入链路：需登录与 18+、不要求实名；封禁 / 禁言拦截；机审拒绝不写库不扣额度；每日 20 次', async () => {
  const FUTURE = NOW + DAY
  const db = communityWorld([
    { _openid: 'U', adultConfirmedAt: 1 },
    { _openid: 'Kid' },
    { _openid: 'Ban', adultConfirmedAt: 1, bannedUntil: FUTURE },
    { _openid: 'Mute', adultConfirmedAt: 1, mutedUntil: FUTURE },
  ])
  assert.equal((await communityAs(db, null)({ action: 'updateProfile', nickname: '张三' })).code, 40101)
  assert.equal((await communityAs(db, null)({ action: 'getProfile' })).code, 40101)
  assert.equal((await communityAs(db, 'Kid')({ action: 'updateProfile', nickname: '张三' })).code, 40303)
  assert.equal((await communityAs(db, 'Ban')({ action: 'updateProfile', nickname: '张三' })).code, 40304)
  assert.equal((await communityAs(db, 'Mute')({ action: 'updateProfile', nickname: '张三' })).code, 40305)
  const rejecting = communityAs(db, 'U', { moderation: { async checkText() { return { verdict: 'reject' } } } })
  const rj = await rejecting({ action: 'updateProfile', nickname: '张三' })
  assert.equal(rj.code, 40001)
  assert.match(rj.msg, /社区公约/)
  assert.equal((db.store.profiles || []).length, 0)
  assert.equal((db.store.rate_limits || []).length, 0)
  const me = communityAs(db, 'U')
  for (let i = 0; i < S.DAILY_LIMITS.updateProfile; i++) assert.equal((await me({ action: 'updateProfile', years: i })).code, 0, `第 ${i + 1} 次`)
  const over = await me({ action: 'updateProfile', years: 1 })
  assert.equal(over.code, 42901)
  assert.equal(db.store.rate_limits[0].count, S.DAILY_LIMITS.updateProfile)
})

test('匿名代号：全站唯一（被占用换一个，连续碰撞后加数字）；并发首次写入也不重复；用尽时 50000 且不建档', async () => {
  const users = ['A', 'B', 'C', 'D', 'E', 'F'].map((id) => ({ _openid: id, adultConfirmedAt: 1 }))
  const db = communityWorld(users)
  const fixed = () => 0 // 永远抽到第一个组合「竹影」
  const save = (id) => communityAs(db, id, { random: fixed })({ action: 'updateProfile', years: 1 })
  assert.equal((await save('A')).data.profile.anonAlias, '竹影')
  assert.equal((await save('B')).data.profile.anonAlias, '竹影10')
  assert.equal((await save('C')).data.profile.anonAlias, '竹影100')
  const d = await save('D')
  assert.equal(d.code, 50000)
  assert.ok(!db.store.profiles.some((p) => p._openid === 'D'))
  // 并发：两人同时首次保存，靠唯一索引兜底重试
  const db2 = communityWorld(users)
  let n = 0
  const cycling = () => [0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5][n++ % 8]
  const rs = await Promise.all(['E', 'F'].map((id) => communityAs(db2, id, { random: cycling })({ action: 'updateProfile', years: 2 })))
  assert.ok(rs.every((r) => r.code === 0), JSON.stringify(rs))
  assert.notEqual(rs[0].data.profile.anonAlias, rs[1].data.profile.anonAlias)
})

test('匿名代号词表：自然意象，不含措辞禁用词与宗教 / 玄学字眼；格式随尝试次数变化', () => {
  for (const w of [...ALIAS_FIRST, ...ALIAS_SECOND]) assert.doesNotMatch(w, /修|法|禅|佛|道|仙|灵|神|圣|僧|寺|庙|经|咒|符|魂|鬼|功/)
  assert.equal(new Set(ALIAS_FIRST).size, ALIAS_FIRST.length)
  assert.equal(new Set(ALIAS_SECOND).size, ALIAS_SECOND.length)
  assert.equal(generateAlias(() => 0.999999, 0).length, 2)
  assert.match(generateAlias(() => 0.5, 5), /^[\u4e00-\u9fa5]{2}\d{2}$/)
  assert.match(generateAlias(() => 0.5, 9), /^[\u4e00-\u9fa5]{2}\d{3}$/)
})

test('checkText（M2 机审钩子）：未知场景报错；空文本放行；可注入实现；实现返回未知结论报错', async () => {
  await assert.rejects(S.checkText({}, { scene: 'nope', texts: ['x'] }), /scene/)
  assert.deepEqual(await S.checkText({}, { scene: 'profile', texts: ['', null, '  '] }), { verdict: 'pass' })
  assert.deepEqual(await S.checkText({}, { scene: 'forum', texts: ['正常内容'] }), { verdict: 'pass' })
  const seen = []
  const ctx = { moderation: { async checkText(i) { seen.push(i); return { verdict: 'review' } } } }
  assert.deepEqual(await S.checkText(ctx, { scene: 'profile', texts: ['a', ''] }), { verdict: 'review' })
  assert.deepEqual(seen, [{ scene: 'profile', texts: ['a'] }])
  await assert.rejects(S.checkText({ moderation: { async checkText() { return { verdict: 'maybe' } } } }, { scene: 'profile', texts: ['a'] }), /未知结论/)
})

test('cloudbaserc / .env.example：user 注入小程序凭证与手机号哈希密钥；moderation 用小程序凭证而不是 App 的 WX_APP_ID（M0-15）', () => {
  const rc = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../cloudbaserc.json'), 'utf8'))
  const fn = (n) => rc.functions.find((f) => f.name === n)
  for (const k of ['WX_MP_APP_ID', 'WX_MP_APP_SECRET', 'PHONE_HASH_SECRET']) assert.equal(fn('user').envVariables[k], `{{env.${k}}}`)
  assert.deepEqual(Object.keys(fn('moderation').envVariables).sort(), ['WX_MP_APP_ID', 'WX_MP_APP_SECRET'])
  assert.match(fn('user').description, /bindPhoneWeapp/)
  assert.match(fn('user').description, /confirmAdult/)
  const example = fs.readFileSync(path.resolve(__dirname, '../../.env.example'), 'utf8')
  for (const k of ['WX_MP_APP_ID', 'WX_MP_APP_SECRET', 'PHONE_HASH_SECRET']) assert.match(example, new RegExp(`^${k}=`, 'm'))
})
