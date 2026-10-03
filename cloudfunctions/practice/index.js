'use strict'
/**
 * practice 云函数：打卡 / 每日一题（M5、M6 填充）+ 每日一题站内提醒（BE-M6-03）。
 * 契约见 docs/api/practice.md；定时触发器配置在 cloudbaserc.json 的 functions[].triggers。
 */
const { createMain, getApp, resolveCaller } = require('./_shared')
const { createTimerEntry, isTimerEvent, runPromptReminder } = require('./_shared/reminder')
const { actions, IDENTITY_FREE_ACTIONS } = require('./service')

const main = createMain({
  actions,
  createContext: async (event, context) => {
    const app = getApp()
    const db = app.database()
    const { identity } = await resolveCaller({ auth: app.auth(), context, db, event, identityFree: IDENTITY_FREE_ACTIONS })
    return { identity, db, now: () => Date.now(), logger: console }
  },
})
/**
 * 定时事件不进入 action 分发（无身份、无业务入参，只跑当天这批提醒）；其余调用照旧走 actions。
 * 提醒失败不抛给平台（见 createTimerEntry），避免平台按失败重试导致重复唤起。
 */
const timerMain = createTimerEntry({
  run: runPromptReminder,
  createContext: async () => ({ db: getApp().database(), now: () => Date.now(), logger: console }),
})

exports.main = async (event, context) => (isTimerEvent(event) ? timerMain(event, context) : main(event, context))
