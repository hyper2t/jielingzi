'use strict'
/** user 函数测试夹具：与 cloudfunctions/user/index.js 相同的 wiring（原始身份 → 账号层 → ctx），供 user.test / account.test 复用 */
const { createMain, resolveCaller } = require('../../cloudfunctions/_shared')
const { actions, IDENTITY_FREE_ACTIONS } = require('../../cloudfunctions/user/service')
const { createUserRepo } = require('../../cloudfunctions/user/repo.nosql')
const { createFakeDb } = require('./fakeDb')
const { DEMO_UNIQUE } = require('./demoBusiness')

const UNIQUE = { users: ['_openid'], ...DEMO_UNIQUE }

/**
 * 与 cloudfunctions/user/index.js 相同的 wiring：原始身份（openId / uid / customUserId）→ 账号层 → ctx。
 * identity 传字符串等价于小程序 openId；传对象则按 getUserInfo() 的返回值处理；null 为无身份。
 */
function setup({ openid = 'oA', users = [], data = {}, wechat = null, apple = null, createTicket = null, authApi = null, unionId = null, mp = null, phoneHash = null, unique = {} } = {}) {
  const db = createFakeDb({ data: { users, ...data }, unique: { ...UNIQUE, ...unique } })
  let t = 1000
  let tokenSeq = 0
  const logs = []
  const logger = { info: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) }
  const toInfo = (id) => (id == null ? {} : typeof id === 'string' ? { openId: id } : id)
  const as = (id, opts = {}) =>
    createMain({
      actions,
      logger,
      createContext: async (event) => {
        const ctxEnv = {}
        if (opts.unionId || unionId) ctxEnv.WX_UNIONID = opts.unionId || unionId
        if (opts.loginType) ctxEnv.LOGINTYPE = opts.loginType
        const context = Object.keys(ctxEnv).length ? { environment: JSON.stringify(ctxEnv) } : {}
        const { identity, accountRepo } = await resolveCaller({ auth: { getUserInfo: () => toInfo(id) }, context, db, event, now: t, identityFree: IDENTITY_FREE_ACTIONS })
        return {
          identity,
          accountRepo,
          repo: createUserRepo(db),
          now: () => ++t,
          logger,
          wechat: 'wechat' in opts ? opts.wechat : wechat,
          apple: 'apple' in opts ? opts.apple : apple,
          createTicket: 'createTicket' in opts ? opts.createTicket : createTicket,
          authApi: 'authApi' in opts ? opts.authApi : authApi,
          mp: 'mp' in opts ? opts.mp : mp,
          phoneHash: 'phoneHash' in opts ? opts.phoneHash : phoneHash,
          randomToken: () => `tok-${++tokenSeq}-${'x'.repeat(20)}`,
        }
      },
    })
  return { db, main: as(openid), as, logs }
}

const links = (db) => (db.store.account_links || []).map((l) => `${l._id}>${l.accountId}`).sort()

module.exports = { setup, links, UNIQUE }
