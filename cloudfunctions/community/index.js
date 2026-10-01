'use strict'
/** community 云函数：ping / 练习档案 getProfile · updateProfile（M1）/ 圈子 / 邀请 / 话题 / 回复（M3、M4）（契约见 docs/api/community.md、docs/api/profile.md） */
const { createMain, getApp, resolveCaller } = require('./_shared')
const { actions, IDENTITY_FREE_ACTIONS } = require('./service')

exports.main = createMain({
  actions,
  createContext: async (event, context) => {
    const app = getApp()
    const db = app.database()
    const { identity } = await resolveCaller({ auth: app.auth(), context, db, event, identityFree: IDENTITY_FREE_ACTIONS })
    return { identity, db, now: () => Date.now(), logger: console }
  },
})
