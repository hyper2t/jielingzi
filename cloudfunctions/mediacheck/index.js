'use strict'
/**
 * mediacheck 云函数（BE-M2-02）：接收微信「消息推送」事件 wxa_media_check（图片异步机审结论），
 * 通过 → 生效（头像写入档案）；违规 → 删除文件（自动下架）+ 站内通知 + mod_logs。逻辑见 _shared/media.js。
 * 安全：云函数安全规则 mediacheck = { invoke: false }，客户端（小程序 / H5 / App）一律不能调用，只有平台推送能触发；
 *      另外只认本小程序 appid 与已登记的 trace_id，其余事件忽略。
 * 配置：小程序后台 / 云开发控制台「消息推送」→ 推送到云开发 → 事件 wxa_media_check → 云函数 mediacheck（docs/api/moderation.md）。
 */
const { getApp, createStorage, handleMediaCheckEvent } = require('./_shared')

const clean = (v) => (typeof v === 'string' && v.trim() && !v.trim().startsWith('{{') ? v.trim() : null)

exports.main = async (event) => {
  const app = getApp()
  const ctx = { db: app.database(), now: () => Date.now(), logger: console, appId: clean(process.env.WX_MP_APP_ID), storage: createStorage(app) }
  const r = await handleMediaCheckEvent(ctx, event)
  // 只记结论，不记 openid / 文件地址
  console.log(`[mediacheck] handled=${r.handled}${r.handled ? ` verdict=${r.verdict} status=${r.status} changed=${r.changed}` : ` reason=${r.reason}`}`)
  return 'success'
}
