'use strict'
/** user 云函数：login / consent / confirmAdult / updateSettings / whoami / wechatAppLogin / bindWechat / appleLogin / bindApple / linkPhoneSession / bindPhoneWeapp / deleteAccount（契约见 docs/api/user.md） */
const { randomBytes } = require('node:crypto')
const { createMain, getApp, resolveCaller, createMpClient, createPhoneHasher, createStorage } = require('./_shared')
const { actions, IDENTITY_FREE_ACTIONS } = require('./service')
const { createUserRepo } = require('./repo.nosql')
const { createWechatClient } = require('./wechat')
const { createAppleClient } = require('./apple')
const { createTicketIssuer } = require('./custom-login')
const { createAuthApi } = require('./auth-api')

// 进程级只初始化一次；环境变量缺失时为 null，对应动作返回 50201（其它动作不受影响）
const wechat = createWechatClient(process.env)
const apple = createAppleClient(process.env)
const issuer = createTicketIssuer(process.env)
const authApi = createAuthApi(process.env)
const mp = createMpClient(process.env)
const phoneHash = createPhoneHasher(process.env)

exports.main = createMain({
  actions,
  createContext: async (event, context) => {
    const app = getApp()
    const db = app.database()
    const { identity, accountRepo } = await resolveCaller({ auth: app.auth(), context, db, event, identityFree: IDENTITY_FREE_ACTIONS })
    return {
      identity,
      accountRepo,
      repo: createUserRepo(db),
      now: () => Date.now(),
      logger: console,
      wechat,
      apple,
      createTicket: issuer ? (accountId) => issuer.createTicket(accountId) : null,
      authApi,
      mp,
      phoneHash,
      storage: createStorage(app),
      randomToken: () => randomBytes(24).toString('base64url'),
    }
  },
})
