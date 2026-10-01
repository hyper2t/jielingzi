'use strict'
/** moderation 云函数：机审 / 举报 / 审核队列 / 处罚（M2 填充）（契约见 docs/api/moderation.md） */
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
