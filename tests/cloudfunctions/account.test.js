'use strict'
/** 账号层（_shared/account.js）与 user 函数的登录动作：微信 App 登录、linkToken、unionid 合并、绑定、注销 */
const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const S = require('../../cloudfunctions/_shared')
const { setup, links } = require('./userHarness')
const { createFakeDb } = require('./fakeDb')
const { registerDemoBusiness, addFavorite, saveRecord, favoriteIds, DEMO_UNIQUE } = require('./demoBusiness')

// 合并 / 注销分支用演示业务集合覆盖（starter 登记表为空，见 demoBusiness.js）
beforeEach(() => registerDemoBusiness())

const UNION = 'o6_bm-unionid-0000000000001'
/** 假微信：code → { openid, unionid }；'bad-*' 返回 errcode，'nounion-*' 不带 unionid */
const fakeWechat = {
  appId: 'wxtest',
  async exchangeCode(code) {
    if (code.startsWith('bad-')) throw S.upstream('微信登录失败（40029）')
    if (code.startsWith('nounion-')) return { openid: 'oApp-' + code, unionid: null }
    const m = /^code-(\S+?)(?:-u:(\S+))?$/.exec(code)
    return { openid: 'oApp-' + (m ? m[1] : code), unionid: m && m[2] ? m[2] : UNION }
  },
}
const fakeTicket = (accountId) => `kid/@@/ticket-for-${accountId}`


// ---------- wechatAppLogin ----------

test('wechatAppLogin：首登建号（accountId = unionid），写 acc/unionid/wxapp/pending 别名并签票据', async () => {
  const { db, as } = setup({ wechat: fakeWechat, createTicket: fakeTicket })
  const pk = as({ uid: 'anon' })
  const r = await pk({ action: 'wechatAppLogin', code: 'code-dev1' })
  assert.equal(r.code, 0, JSON.stringify(r))
  assert.deepEqual(Object.keys(r.data).sort(), ['accountId', 'isNew', 'linkToken', 'ticket'])
  assert.equal(r.data.accountId, UNION)
  assert.equal(r.data.isNew, true)
  assert.equal(r.data.ticket, `kid/@@/ticket-for-${UNION}`)
  assert.equal(db.store.users.length, 1)
  assert.equal(db.store.users[0]._openid, UNION)
  assert.deepEqual(links(db), [`acc:${UNION}>${UNION}`, `pending:${r.data.linkToken}>${UNION}`, `unionid:${UNION}>${UNION}`, `wxapp:oApp-dev1>${UNION}`])
  // 再次登录（换了手机）：复用账号，不重复建
  const r2 = await pk({ action: 'wechatAppLogin', code: 'code-dev2' })
  assert.equal(r2.data.isNew, false)
  assert.equal(r2.data.accountId, UNION)
  assert.equal(db.store.users.length, 1)
})

test('wechatAppLogin：参数 / 上游错误 → 40001 / 50201，未配置时 50201，且不建账号', async () => {
  const { db, as } = setup({ wechat: fakeWechat, createTicket: fakeTicket })
  const pk = as({ uid: 'anon' })
  assert.equal((await pk({ action: 'wechatAppLogin' })).code, 40001)
  assert.equal((await pk({ action: 'wechatAppLogin', code: 'short' })).code, 40001)
  assert.equal((await pk({ action: 'wechatAppLogin', code: 'code-x', extra: 1 })).code, 40001)
  const bad = await pk({ action: 'wechatAppLogin', code: 'bad-0123456789' })
  assert.equal(bad.code, 50201)
  assert.match(bad.msg, /40029/)
  assert.equal((await pk({ action: 'wechatAppLogin', code: 'nounion-0123456789' })).code, 50201)
  assert.equal(db.store.users.length, 0)
  assert.equal((db.store.account_links || []).length, 0)
  const { as: noWx } = setup({ createTicket: fakeTicket })
  assert.equal((await noWx({ uid: 'anon' })({ action: 'wechatAppLogin', code: 'code-dev1' })).code, 50201)
  const { as: noTicket } = setup({ wechat: fakeWechat })
  assert.equal((await noTicket({ uid: 'anon' })({ action: 'wechatAppLogin', code: 'code-dev1' })).code, 50201)
})

test('login + linkToken（customUserId 不可见的备选路径）：把 CloudBase uid 关联到微信账号，令牌一次性', async () => {
  const { db, as } = setup({ wechat: fakeWechat, createTicket: fakeTicket })
  const { data } = await as({ uid: 'anon' })({ action: 'wechatAppLogin', code: 'code-dev1' })
  const session = as({ uid: 'uid-custom-0001' }) // 票据登录后拿到的 CloudBase uid，看不到 customUserId
  const r = await session({ action: 'login', platform: 'app', linkToken: data.linkToken })
  assert.equal(r.code, 0, JSON.stringify(r))
  assert.equal(r.data.accountId, UNION)
  assert.deepEqual(r.data.identities, { mp: false, wechat: true, phone: false, apple: false })
  assert.ok(db.store.account_links.some((l) => l._id === 'cbuid:uid-custom-0001' && l.accountId === UNION && l.via === 'custom'))
  assert.ok(!db.store.account_links.some((l) => l.kind === 'pending'), 'pending 已消费')
  // 之后不带 token 也解析到同一账号；没有多建 users
  const r2 = await session({ action: 'login', platform: 'app' })
  assert.equal(r2.data.accountId, UNION)
  assert.equal(db.store.users.length, 1)
  // 令牌重放：已消费 → 但 uid 已有链接，仍正常登录
  assert.equal((await session({ action: 'login', linkToken: data.linkToken })).data.accountId, UNION)
  // 新 uid 拿着无效令牌且没有链接 → 40101，且不建号
  assert.equal((await as({ uid: 'uid-custom-0002' })({ action: 'login', linkToken: 'nope-' + 'x'.repeat(20) })).code, 40101)
  assert.equal(db.store.users.length, 1)
})

test('login + linkToken：令牌过期无效（5 分钟）', async () => {
  const { db, as } = setup({ wechat: fakeWechat, createTicket: fakeTicket })
  const { data } = await as({ uid: 'anon' })({ action: 'wechatAppLogin', code: 'code-dev1' })
  const pending = db.store.account_links.find((l) => l.kind === 'pending')
  pending.expiresAt = 0
  assert.equal((await as({ uid: 'uid-custom-0001' })({ action: 'login', linkToken: data.linkToken })).code, 40101)
  assert.ok(!db.store.account_links.some((l) => l.kind === 'pending'), '过期令牌也被删除')
})

test('自定义登录 customUserId 可见：经 acc: 别名解析；账号不存在（已注销）→ 40101', async () => {
  const { as } = setup({ wechat: fakeWechat, createTicket: fakeTicket })
  const { data } = await as({ uid: 'anon' })({ action: 'wechatAppLogin', code: 'code-dev1' })
  const session = as({ uid: 'uid-custom-0001', customUserId: UNION })
  const r = await session({ action: 'login', platform: 'app', linkToken: data.linkToken })
  assert.equal(r.data.accountId, UNION)
  assert.equal((await session({ action: 'login' })).data.accountId, UNION)
  assert.deepEqual((await session({ action: 'whoami' })).data.source, 'custom')
  assert.equal((await as({ uid: 'uid-x-0001', customUserId: 'ghost-account-0001' })({ action: 'login' })).code, 40101)
})

test('身份认证 v2 实测形态：自定义登录会话 uid == customUserId、customUserId 不可见 → 经 acc: 识别，免 linkToken', async () => {
  const { db, as } = setup({ wechat: fakeWechat, createTicket: fakeTicket })
  const { data } = await as({ uid: 'anon' })({ action: 'wechatAppLogin', code: 'code-dev1' })
  // 票据换会话后：uid 就是 customUserId（= accountId = unionid），LOGINTYPE=CUSTOM，getUserInfo().customUserId 为空
  const session = as({ uid: UNION }, { loginType: 'CUSTOM' })
  const who = await session({ action: 'whoami' })
  assert.deepEqual(who.data, { source: 'web', loginType: 'CUSTOM', account: true, openId: false, unionId: false, uid: true, customUserId: false, anonymous: false, publishableKey: false, phoneVerified: false, adult: false, role: 'user', bannedUntil: null, mutedUntil: null })
  assert.deepEqual(db.store.account_links.find((l) => l._id === `cbuid:${UNION}`), { _id: `cbuid:${UNION}`, accountId: UNION, kind: 'cbuid', via: 'custom', createdAt: db.store.account_links.find((l) => l._id === `cbuid:${UNION}`).createdAt })
  assert.equal(db.store.users.length, 1, 'whoami 没有多建账号')
  // 不带 linkToken 也能登录到同一账号；identities 归为微信而不是手机号
  const r = await session({ action: 'login', platform: 'app' })
  assert.equal(r.data.accountId, UNION)
  assert.deepEqual(r.data.identities, { mp: false, wechat: true, phone: false, apple: false })
  // 带 linkToken 亦幂等
  assert.equal((await session({ action: 'login', platform: 'app', linkToken: data.linkToken })).data.accountId, UNION)
  assert.equal(db.store.users.length, 1)
  // 小程序老用户的票据：customUserId = 小程序 openid → uid = openid → acc:<openid> 自指链接识别
  const MP = 'o6_bmjrPTlm6_2sgVt7hMZOPfL2M'
  await as(MP)({ action: 'login' })
  const r2 = await as({ uid: MP }, { loginType: 'CUSTOM' })({ action: 'login', platform: 'app' })
  assert.equal(r2.data.accountId, MP)
  assert.deepEqual(r2.data.identities, { mp: true, wechat: true, phone: false, apple: false })
  // 已注销账号的自定义登录会话：LOGINTYPE=CUSTOM 且无 acc: 链接 → 40101，不会误建手机号账号
  await session({ action: 'deleteAccount', confirm: 'DELETE' })
  assert.equal((await session({ action: 'login', platform: 'app' })).code, 40101)
  assert.ok(!db.store.users.some((u) => u._openid === UNION))
  // 没有 LOGINTYPE 信息时退化为按 uid 建号（手机号路径），不报错
  assert.equal((await as({ uid: 'uid-phone-0001' })({ action: 'login', platform: 'app' })).code, 0)
})

test('免身份动作不建号：whoami / wechatAppLogin / appleLogin', async () => {
  const { db, as } = setup({ wechat: fakeWechat, createTicket: fakeTicket })
  await as({ uid: 'uid-phone-0001' })({ action: 'whoami' })
  await as({ uid: 'uid-phone-0001' })({ action: 'wechatAppLogin', code: 'code-dev1' })
  assert.deepEqual(db.store.users.map((u) => u._openid), [UNION], '只有 wechatAppLogin 建的微信账号，没有 uid-phone-0001')
  assert.equal((await as({ uid: 'uid-phone-0002' })({ action: 'whoami' })).code, 0)
  assert.ok(!db.store.users.some((u) => u._openid === 'uid-phone-0002'))
  assert.ok(!db.store.account_links.some((l) => l._id === 'cbuid:uid-phone-0002'))
})

// ---------- unionid 合并（小程序 ↔ App） ----------

async function seedAppUser(as, db) {
  const { data } = await as({ uid: 'anon' })({ action: 'wechatAppLogin', code: 'code-dev1' })
  const app = as({ uid: 'uid-custom-0001' })
  await app({ action: 'login', platform: 'app', linkToken: data.linkToken })
  const appInfo = { uid: 'uid-custom-0001' }
  await addFavorite(db, appInfo, 'a1')
  await addFavorite(db, appInfo, 'a2')
  await saveRecord(db, appInfo, 'a1', 'e1', 5001)
  await saveRecord(db, appInfo, 'a3', 'e1', 5002)
  await app({ action: 'updateSettings', fontScale: 'large', theme: 'dark' })
  return { app }
}

test('小程序登录带 unionid：unionid 已属于 App 账号 → 并入小程序账号（按 key 去重保留主账号、按 updatedAt 取新、设置补齐、别名重定向、审计）', async () => {
  const { db, as, logs } = setup({ wechat: fakeWechat, createTicket: fakeTicket })
  await seedAppUser(as, db)
  // 小程序老用户 oA：有自己的收藏 a2、记录 a1（更新）与 a2
  const mp = as('oA')
  await mp({ action: 'login' })
  const mpInfo = { openId: 'oA' }
  await addFavorite(db, mpInfo, 'a2')
  await saveRecord(db, mpInfo, 'a1', 'e2', 9001)
  await saveRecord(db, mpInfo, 'a2', 'e1', 9002)
  await mp({ action: 'updateSettings', dailyGoal: 20 })

  // 小程序绑定开放平台后，登录带上了 unionid
  const r = await as('oA', { unionId: UNION })({ action: 'login' })
  assert.equal(r.code, 0, JSON.stringify(r))
  assert.equal(r.data.merged, true)
  assert.equal(r.data.accountId, 'oA')
  assert.deepEqual(r.data.identities, { mp: true, wechat: true, phone: false, apple: false })
  assert.deepEqual(r.data.settings, { dailyGoal: 20, fontScale: 'large', theme: 'dark' }, '主账号没有的设置项用被并入方补齐')

  // favorites（keep primary）：并集 {a1, a2}，全部归 oA
  const favs = db.store.favorites.filter((f) => f._openid === 'oA').map((f) => f.itemId).sort()
  assert.deepEqual(favs, ['a1', 'a2'])
  assert.equal(db.store.favorites.length, 2)
  // records（keep newer）：a1 取较新的（小程序 e2），a2 只有小程序，a3 只有 App → 3 条全归 oA
  const recs = Object.fromEntries(db.store.records.filter((p) => p._openid === 'oA').map((p) => [p.itemId, p.tag]))
  assert.deepEqual(recs, { a1: 'e2', a2: 'e1', a3: 'e1' })
  assert.equal(db.store.records.length, 3)
  // users：只剩 oA，mergedFrom 记录来源
  assert.deepEqual(db.store.users.map((u) => u._openid), ['oA'])
  assert.deepEqual(db.store.users[0].mergedFrom, [UNION])
  // 别名全部指向 oA（含 acc:<unionid>，已签发的自定义登录会话仍可用）
  assert.deepEqual(links(db), [
    `acc:${UNION}>oA`, 'acc:oA>oA', 'cbuid:uid-custom-0001>oA', 'mp:oA>oA', `unionid:${UNION}>oA`, 'wxapp:oApp-dev1>oA',
  ])
  assert.equal(db.store.account_merges.length, 1)
  assert.deepEqual(db.store.account_merges[0].counts, { links: 4, favorites: 1, records: 1 }, 'favorites a1 迁入 1 条（a2 重复丢弃）；records a3 迁入 1 条（a1 主账号更新，丢弃）')
  assert.ok(logs.some((l) => l.startsWith('[merge] reason=unionid')))
  assert.ok(!logs.some((l) => l.includes('oA') || l.includes(UNION)), '日志不含账号标识')

  // App 端此前的会话（uid / customUserId）现在都解析到 oA，看到合并后的收藏
  assert.deepEqual(await favoriteIds(db, { uid: 'uid-custom-0001', customUserId: UNION }), ['a1', 'a2'])
  assert.equal((await as({ uid: 'uid-custom-0001' })({ action: 'login', platform: 'app' })).data.accountId, 'oA')

  // 再次登录：幂等，不再合并
  const again = await as('oA', { unionId: UNION })({ action: 'login' })
  assert.equal(again.data.merged, false)
  assert.equal(db.store.account_merges.length, 1)
})

test('App 微信登录命中小程序老账号的 unionid：直接复用小程序账号，不新建；票据 customUserId = accountId', async () => {
  const MP = 'o6_bmjrPTlm6_2sgVt7hMZOPfL2M'
  const { db, as } = setup({ wechat: fakeWechat, createTicket: fakeTicket })
  await as(MP, { unionId: UNION })({ action: 'login' })
  const r = await as({ uid: 'anon' })({ action: 'wechatAppLogin', code: 'code-dev1' })
  assert.equal(r.data.accountId, MP)
  assert.equal(r.data.isNew, false)
  assert.equal(r.data.ticket, `kid/@@/ticket-for-${MP}`)
  assert.equal(db.store.users.length, 1)
})

test('accountId 不满足 customUserId 规则（如过长的 CloudBase uid）：票据用派生 id，acc: 别名指回账号', async () => {
  const LONG = 'u'.repeat(40)
  const { db, as } = setup({ wechat: fakeWechat, createTicket: fakeTicket })
  const phone = as({ uid: LONG })
  await phone({ action: 'login', platform: 'app' })
  await phone({ action: 'bindWechat', code: 'code-dev1' })
  const r = await as({ uid: 'anon' })({ action: 'wechatAppLogin', code: 'code-dev2' })
  assert.equal(r.data.accountId, LONG)
  const customId = r.data.ticket.replace('kid/@@/ticket-for-', '')
  assert.match(customId, /^c[0-9a-f]{31}$/)
  assert.equal(db.store.account_links.find((l) => l._id === `acc:${customId}`).accountId, LONG)
  // 票据登录后 customUserId 可见 → 解析回该账号
  assert.equal((await as({ uid: 'uid-custom-0001', customUserId: customId })({ action: 'login' })).data.accountId, LONG)
})

// ---------- 绑定 ----------

test('bindWechat：手机号账号绑定微信；该微信已有账号则并入当前账号', async () => {
  const { db, as } = setup({ wechat: fakeWechat, createTicket: fakeTicket })
  const phone = as({ uid: 'uid-phone-0001' })
  await phone({ action: 'login', platform: 'app' })
  // 未配置微信 → 50201
  assert.equal((await as({ uid: 'uid-phone-0001' }, { wechat: null })({ action: 'bindWechat', code: 'code-dev1' })).code, 50201)
  const r1 = await phone({ action: 'bindWechat', code: 'code-dev1' })
  assert.deepEqual(r1.data, { ok: true, merged: false })
  assert.deepEqual((await phone({ action: 'login' })).data.identities, { mp: false, wechat: true, phone: true, apple: false })
  // 幂等
  assert.deepEqual((await phone({ action: 'bindWechat', code: 'code-dev1' })).data, { ok: true, merged: false })

  // 另一个手机号账号绑定一个已有账号（小程序老用户 oB）的微信 → oB 并入当前账号
  await as('oB', { unionId: 'union-of-oB-000000000000' })({ action: 'login' })
  await addFavorite(db, { openId: 'oB' }, 'a1')
  const phone2 = as({ uid: 'uid-phone-0002' })
  await phone2({ action: 'login', platform: 'app' })
  const r2 = await phone2({ action: 'bindWechat', code: 'code-dev9-u:union-of-oB-000000000000' })
  assert.deepEqual(r2.data, { ok: true, merged: true })
  assert.deepEqual(db.store.favorites.map((f) => f._openid), ['uid-phone-0002'])
  assert.ok(db.store.account_links.some((l) => l._id === 'mp:oB' && l.accountId === 'uid-phone-0002'))
  // 小程序端 oB 之后的调用落到合并后的账号
  assert.deepEqual(await favoriteIds(db, { openId: 'oB' }), ['a1'])
})

test('linkPhoneSession：校验另一份会话并关联 uid；无效 40101；自己的会话幂等；对方已有账号则合并', async () => {
  const authApi = { async userMe(token) { return token.startsWith('good-') ? { sub: token.slice(5) } : null } }
  const { db, as } = setup({ wechat: fakeWechat, createTicket: fakeTicket, authApi })
  const { data } = await as({ uid: 'anon' })({ action: 'wechatAppLogin', code: 'code-dev1' })
  const wx = as({ uid: 'uid-custom-0001' })
  await wx({ action: 'login', platform: 'app', linkToken: data.linkToken })
  assert.equal((await wx({ action: 'linkPhoneSession', otherAccessToken: 'bad-token-0123456789' })).code, 40101)
  assert.equal((await wx({ action: 'linkPhoneSession', otherAccessToken: 'short' })).code, 40001)
  assert.deepEqual((await wx({ action: 'linkPhoneSession', otherAccessToken: 'good-uid-custom-0001' })).data, { ok: true, merged: false })
  const r = await wx({ action: 'linkPhoneSession', otherAccessToken: 'good-uid-phone-0009' })
  assert.deepEqual(r.data, { ok: true, merged: false })
  assert.ok(db.store.account_links.some((l) => l._id === 'cbuid:uid-phone-0009' && l.accountId === UNION && l.via === 'phone'))
  assert.deepEqual((await wx({ action: 'login' })).data.identities, { mp: false, wechat: true, phone: true, apple: false })
  // 之后该手机号会话直接解析到微信账号
  assert.equal((await as({ uid: 'uid-phone-0009' })({ action: 'login', platform: 'app' })).data.accountId, UNION)

  // 对方手机号已有自己的账号与数据 → 并入当前账号
  const other = as({ uid: 'uid-phone-0010' })
  await other({ action: 'login', platform: 'app' })
  await addFavorite(db, { uid: 'uid-phone-0010' }, 'a3')
  assert.deepEqual((await wx({ action: 'linkPhoneSession', otherAccessToken: 'good-uid-phone-0010' })).data, { ok: true, merged: true })
  assert.deepEqual(await favoriteIds(db, { uid: 'uid-custom-0001' }), ['a3'])
  assert.ok(!db.store.users.some((u) => u._openid === 'uid-phone-0010'))
  const { as: noApi } = setup({ wechat: fakeWechat, createTicket: fakeTicket })
  await noApi({ uid: 'uid-phone-0001' })({ action: 'login' })
  assert.equal((await noApi({ uid: 'uid-phone-0001' })({ action: 'linkPhoneSession', otherAccessToken: 'good-uid-phone-0009' })).code, 50201)
})

// ---------- 注销 ----------

test('deleteAccount：需 confirm=DELETE；删业务数据、users 与全部别名；之后同一身份再登录是全新账号', async () => {
  const { db, as, logs } = setup({ wechat: fakeWechat, createTicket: fakeTicket })
  await seedAppUser(as, db)
  await as('oB')({ action: 'login' })
  await addFavorite(db, { openId: 'oB' }, 'a1')
  const app = as({ uid: 'uid-custom-0001' })
  assert.equal((await app({ action: 'deleteAccount' })).code, 40001)
  assert.equal((await app({ action: 'deleteAccount', confirm: 'yes' })).code, 40001)
  const r = await app({ action: 'deleteAccount', confirm: 'DELETE' })
  assert.deepEqual(r.data, { ok: true, removed: { favorites: 2, records: 2, user: 1, links: 4 } })
  assert.deepEqual(db.store.users.map((u) => u._openid), ['oB'])
  assert.deepEqual(db.store.favorites.map((f) => f._openid), ['oB'])
  assert.deepEqual(links(db), ['acc:oB>oB', 'mp:oB>oB'])
  assert.ok(logs.some((l) => l.startsWith('[deleteAccount] removed')) && !logs.some((l) => l.includes(UNION)))
  // 已注销的自定义登录会话：40101；同一微信重新登录 → 全新账号
  assert.equal((await as({ uid: 'uid-custom-0001', customUserId: UNION })({ action: 'login' })).code, 40101)
  const again = await as({ uid: 'anon' })({ action: 'wechatAppLogin', code: 'code-dev1' })
  assert.equal(again.data.isNew, true)
  assert.equal(again.data.accountId, UNION)
})

// ---------- 账号层单元 ----------

test('mergeAccounts 可重入：重复执行结果一致；同账号 / 空账号不做事', async () => {
  const db = createFakeDb({ unique: { users: ['_openid'], ...DEMO_UNIQUE } })
  const repo = S.createAccountRepo(db)
  const quiet = { info() {} }
  await S.createAccount(repo, { accountId: 'acc-A', now: 1, aliases: [{ kind: 'mp', value: 'oA' }] })
  await S.createAccount(repo, { accountId: 'acc-B', now: 2, aliases: [{ kind: 'cbuid', value: 'uB', via: 'phone' }] })
  await db.collection('favorites').add({ _openid: 'acc-B', itemId: 'a1', createdAt: 1 })
  await db.collection('records').add({ _openid: 'acc-B', itemId: 'a1', updatedAt: 9 })
  await db.collection('records').add({ _openid: 'acc-A', itemId: 'a1', updatedAt: 3 })
  const r1 = await S.mergeAccounts(repo, { secondary: 'acc-B', primary: 'acc-A', now: 10, logger: quiet, reason: 'test' })
  assert.deepEqual(r1, { merged: true, counts: { links: 2, favorites: 1, records: 1 } })
  assert.deepEqual(db.store.records.map((p) => [p._openid, p.updatedAt]), [['acc-A', 9]])
  const r2 = await S.mergeAccounts(repo, { secondary: 'acc-B', primary: 'acc-A', now: 11, logger: quiet, reason: 'test' })
  assert.deepEqual(r2.counts, { links: 0, favorites: 0, records: 0 })
  assert.deepEqual(db.store.favorites.map((f) => f._openid), ['acc-A'])
  assert.deepEqual(db.store.users.map((u) => u._openid), ['acc-A'])
  assert.deepEqual(db.store.users[0].mergedFrom, ['acc-B', 'acc-B'])
  assert.deepEqual(await S.mergeAccounts(repo, { secondary: 'acc-A', primary: 'acc-A', now: 12, logger: quiet }), { merged: false, counts: null })
})

test('resolveAccount：无身份 → null；autoCreate=false 不建号；别名格式与 identitiesFromLinks', async () => {
  const db = createFakeDb({ unique: { users: ['_openid'] } })
  const repo = S.createAccountRepo(db)
  const id = (info) => S.resolveIdentity({ getUserInfo: () => info })
  assert.deepEqual(await S.resolveAccount(id({}), repo), { accountId: null, isNew: false, linkKey: null })
  assert.deepEqual(await S.resolveAccount(id({ uid: 'uid-0001' }), repo, { autoCreate: false }), { accountId: null, isNew: false, linkKey: 'cbuid:uid-0001' })
  assert.equal(db.store.users, undefined)
  const created = await S.resolveAccount(id({ uid: 'uid-0001', isAnonymous: true }), repo, { now: 7 })
  assert.deepEqual(created, { accountId: 'uid-0001', isNew: true, linkKey: 'cbuid:uid-0001' })
  assert.equal(db.store.account_links.find((l) => l._id === 'cbuid:uid-0001').via, 'anonymous')
  assert.deepEqual(S.identitiesFromLinks(await repo.listLinks('uid-0001')), { mp: false, wechat: false, phone: false, apple: false })
  assert.deepEqual(S.identitiesFromLinks([{ kind: 'cbuid', via: 'phone' }, { kind: 'wxapp' }]), { mp: false, wechat: true, phone: true, apple: false })
  assert.throws(() => S.assertAccountId('has space'), (e) => e.code === 40001)
  assert.throws(() => S.assertCustomId('abc'), (e) => e.code === 40001)
  assert.equal(S.assertCustomId(UNION), UNION)
  assert.equal(S.linkId('mp', 'o1'), 'mp:o1')
})

test('consumePending：不存在 / 非 pending / 过期均为 null，且只能消费一次', async () => {
  const db = createFakeDb()
  const repo = S.createAccountRepo(db)
  await S.createPending(repo, { accountId: 'acc-A', token: 't1', now: 100 })
  await repo.addLink({ _id: 'mp:o1', accountId: 'acc-A', kind: 'mp', createdAt: 1 })
  assert.equal(await S.consumePending(repo, { token: 'nope', now: 100 }), null)
  assert.equal(await S.consumePending(repo, { token: 't1', now: 100 + S.PENDING_TTL_MS + 1 }), null)
  await S.createPending(repo, { accountId: 'acc-A', token: 't2', now: 100 })
  assert.equal(await S.consumePending(repo, { token: 't2', now: 200 }), 'acc-A')
  assert.equal(await S.consumePending(repo, { token: 't2', now: 200 }), null)
  await assert.rejects(S.createPending(repo, { accountId: 'acc-A', token: 't2', now: 300 }).then(() => S.createPending(repo, { accountId: 'acc-A', token: 't2', now: 300 })), /collision/)
})

test('集合不存在时自愈：读当作空，首次写入自动 createCollection（云端集合不会因 add 自动创建）', async () => {
  const db = createFakeDb({ data: { users: [], favorites: [], records: [] }, unique: { users: ['_openid'] }, strictCollections: true })
  const repo = S.createAccountRepo(db)
  assert.equal(await repo.getLink('mp:o1'), null)
  assert.deepEqual(await repo.listLinks('acc-A'), [])
  assert.equal(await repo.removeLinks('acc-A'), 0)
  const r = await S.resolveAccount(S.resolveIdentity({ getUserInfo: () => ({ openId: 'o1' }) }), repo, { now: 1 })
  assert.deepEqual(r, { accountId: 'o1', isNew: true, linkKey: 'mp:o1' })
  assert.deepEqual(db.calls.filter((c) => c.op === 'createCollection').map((c) => c.collection), ['account_links'])
  assert.deepEqual((db.store.account_links || []).map((l) => l._id).sort(), ['acc:o1', 'mp:o1'])
  // 合并审计集合同样自愈
  await S.createAccount(repo, { accountId: 'acc-B', now: 2, aliases: [{ kind: 'cbuid', value: 'uB', via: 'phone' }] })
  const m = await S.mergeAccounts(repo, { secondary: 'acc-B', primary: 'o1', now: 3, logger: { info() {} }, reason: 'test' })
  assert.equal(m.merged, true)
  assert.equal(db.store.account_merges.length, 1)
  assert.equal(S.isCollectionMissingError({ code: 'DATABASE_COLLECTION_NOT_EXIST', message: '[ResourceNotFound] Db or Table not exist: x' }), true)
  assert.equal(S.isNotExistError({ code: 'DATABASE_COLLECTION_NOT_EXIST', message: 'Db or Table not exist: x' }), false)
  assert.equal(S.isDuplicateKeyError({ code: 'DATABASE_REQUEST_FAILED', message: '[FailedOperation.Insert] bulk write error: E11000 duplicate key error collection: t.account_links index: _id_ dup key' }), true)
  // 其它错误不吞
  const bad = { collection: () => ({ doc: () => ({ get: async () => { throw Object.assign(new Error('boom'), { code: 'DATABASE_REQUEST_FAILED' }) } }) }) }
  await assert.rejects(S.createAccountRepo(bad).getLink('x'), /boom/)
})
