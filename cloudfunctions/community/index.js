'use strict'
/** community 云函数：ping / 练习档案 getProfile · updateProfile（M1）/ 圈子 / 邀请 / 话题 / 回复（M3、M4）（契约见 docs/api/community.md、docs/api/profile.md） */
const { createMain, getApp, resolveCaller, createMpClient, createStorage } = require('./_shared')
const { actions, IDENTITY_FREE_ACTIONS } = require('./service')

// 小程序服务端接口（msgSecCheck 文本内容安全）；没配 WX_MP_APP_ID / SECRET 时为 null，机审只用词库
const mp = createMpClient(process.env)

exports.main = createMain({
  actions,
  createContext: async (event, context) => {
    const app = getApp()
    const db = app.database()
    const { identity } = await resolveCaller({ auth: app.auth(), context, db, event, identityFree: IDENTITY_FREE_ACTIONS })
    // envId：校验上传图片属于本环境（cloud://<envId>.<bucket>/…）
    const envId = process.env.TCB_ENV || process.env.SCF_NAMESPACE || null
    return { identity, db, now: () => Date.now(), logger: console, mp, envId, storage: createStorage(app) }
  },
})
