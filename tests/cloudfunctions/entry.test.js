'use strict'
/** 入口 wiring 测试：用假的 @cloudbase/node-sdk 驱动 cloudfunctions/<fn>/index.js 全链路 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { createFakeDb } = require('./fakeDb')

const db = createFakeDb({ unique: { users: ['_openid'] } })
let userInfo = { openId: 'oEntry', appId: 'wx1' }
let initArgs = null
const fakeSdk = {
  SYMBOL_CURRENT_ENV: Symbol('current'),
  init(opts) {
    initArgs = opts
    return {
      auth: () => ({ getUserInfo: () => userInfo }),
      database: () => db,
    }
  },
}
const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === '@cloudbase/node-sdk') return fakeSdk
  return origLoad.call(this, request, ...rest)
}

const user = require('../../cloudfunctions/user/index.js')

test('user 入口：用平台注入的 openId，env 使用 SYMBOL_CURRENT_ENV，账号层写入 account_links', async () => {
  const r = await user.main({ action: 'login' }, {})
  assert.deepEqual(r, {
    code: 0,
    data: {
      openid: 'oEntry',
      accountId: 'oEntry',
      isNew: true,
      identities: { mp: true, wechat: true, phone: false, apple: false },
      settings: {},
      guardianConsentAt: null,
      merged: false,
      phoneVerified: false, adult: false, role: 'user', bannedUntil: null, mutedUntil: null,
    },
    msg: 'ok',
  })
  assert.equal(initArgs.env, fakeSdk.SYMBOL_CURRENT_ENV)
  assert.equal(db.store.users[0]._openid, 'oEntry')
  assert.deepEqual(db.store.account_links.map((l) => l._id).sort(), ['acc:oEntry', 'mp:oEntry'])
})

test('user 入口：H5 / App 手机号会话用 uid 作为 accountId', async () => {
  userInfo = { uid: 'uid-h5-0001' }
  const r = await user.main({ action: 'consent' }, {})
  assert.equal(r.code, 0)
  assert.ok(db.store.users.some((u) => u._openid === 'uid-h5-0001' && u.guardianConsentAt))
  assert.ok(db.store.account_links.some((l) => l._id === 'cbuid:uid-h5-0001' && l.via === 'phone'))
})

test('user 入口：Publishable Key（uid=anon）只能调 whoami / wechatAppLogin，身份类动作 40101，且不建账号', async () => {
  userInfo = { uid: 'anon' }
  assert.equal((await user.main({ action: 'login' }, {})).code, 40101)
  const who = await user.main({ action: 'whoami' }, {})
  assert.deepEqual(who.data, { source: null, loginType: null, account: false, openId: false, unionId: false, uid: false, customUserId: false, anonymous: false, publishableKey: true, phoneVerified: false, adult: false, role: 'user', bannedUntil: null, mutedUntil: null })
  // 未配置 WX_APP_ID / 自定义登录私钥：50201 而不是 50000
  assert.equal((await user.main({ action: 'wechatAppLogin', code: 'code-0123456789' }, {})).code, 50201)
  assert.ok(!db.store.account_links.some((l) => l._id.includes('anon')))
})

test('user 入口：deleteAccount 只删自己的 users 与别名，日志不含账号标识', async () => {
  userInfo = { openId: 'oDel', appId: 'wx1' }
  assert.equal((await user.main({ action: 'login' }, {})).code, 0)
  const logs = []
  const origInfo = console.info
  console.info = (...a) => logs.push(a.join(' '))
  try {
    const r = await user.main({ action: 'deleteAccount', confirm: 'DELETE' }, {})
    const zero = Object.fromEntries(require('../../cloudfunctions/_shared').OWNED_COLLECTIONS.map((c) => [c.name, 0]))
    assert.deepEqual(r.data, { ok: true, removed: { ...zero, user: 1, links: 2 } })
  } finally {
    console.info = origInfo
  }
  assert.ok(logs.some((l) => l.startsWith('[deleteAccount] removed')) && !logs.some((l) => l.includes('oDel')))
  assert.ok(db.store.users.some((u) => u._openid === 'oEntry'), '其他用户记录不受影响')
  assert.ok(!db.store.account_links.some((l) => l.accountId === 'oDel'))
})
