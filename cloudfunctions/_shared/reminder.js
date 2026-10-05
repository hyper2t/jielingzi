'use strict'
/**
 * 每日一题的站内提醒（BE-M6-03，规则见 docs/prd/m6-plan.md D13 / D15）。
 *
 * 调用方式：practice 的定时触发器（cloudbaserc.json 的 `functions[].triggers`，每天 08:00）把 event
 * 交给 createTimerEntry；识别为定时事件时不进入 action 分发，直接跑一批提醒。
 *
 * 三条硬约束：
 * - 当日没有 status='ok' 的题目 → 整批跳过，一条通知都不写（运营补题后第二天自然生效）。
 * - 按 (uid, 'prompt', promptId) 去重（notify 的 dedupe）：一道题对同一个人只提醒一次，
 *   所以触发器重跑、扩容导致的重复唤起都只会多扫一遍，不会重复打扰。
 * - 只写站内 notifications，**不读任何环境变量**：订阅消息通道按 D17 后补，practice 在
 *   cloudbaserc.json 里也没有 envVariables，因此「模板 ID 缺键」在本模块里根本没有对应代码，不可能抛错。
 *
 * 定时事件本身不是安全边界（`{ Type: 'timer' }` 也能被调用方构造出来，虽然 App 侧的封装永远带 action），
 * 所以这里不接收业务入参、不返回业务数据，最坏结果只是「今天的提醒提前发一次」，且被去重挡住不会发第二遍。
 */
const { notify } = require('./notify')
const { withCollection } = require('./db')
const { cnDate } = require('./config')

const PROMPTS_COLLECTION = 'daily_prompts'
const USERS_COLLECTION = 'users'
/** 通知正文：固定说明，不含题目原文、昵称等任何他人信息 */
const REMINDER_TEXT = '今天的每日一题已经准备好，可以写下你的回答'
/** 订阅消息的落地页：点通知直接进当日作答页 */
const SUBSCRIBE_PAGE = 'pkg-practice/pages/prompt/index'
/**
 * 订阅消息的 data —— key 必须与小程序后台的模板字段严格一致，模板请按这两项创建：
 * thing1 = 固定提醒语（微信对 thing 类型限 20 字，超了会 47003）、date2 = 当天日期（YYYY-MM-DD）。
 */
const SUBSCRIBE_THING = '今日的每日一题已备好'
const SUBSCRIBE_DATE = 'date2'
/** users 扫描分页与上限：超限只记日志（truncated），不静默丢掉后面的账号 */
const SCAN_PAGE = 100
const SCAN_MAX = 2000

/** 只认平台定时事件的形状；带 action 的一律按普通调用走 action 分发 */
function isTimerEvent(event) {
  return !!event && typeof event === 'object' && event.Type === 'timer' && typeof event.action !== 'string'
}

/** 当日题目：与 practice.todayPrompt 同一条查询口径（只认 status='ok'） */
async function findTodayPrompt(db, date) {
  const res = await withCollection(db, PROMPTS_COLLECTION, () =>
    db.collection(PROMPTS_COLLECTION).where({ date, status: 'ok' }).limit(1).get())
  const row = (res && res.data && res.data[0]) || null
  return row && row._id ? row : null
}

/**
 * 可接收提醒的账号：已确认年满 18 周岁、且不在封禁期内——与 guardWrite 的门禁一致
 * （收到提醒却打不开页面只是打扰）；禁言只限制发言，不影响被动收消息。
 */
function eligible(user, now) {
  if (!user || !user._openid) return false
  if (typeof user.adultConfirmedAt !== 'number') return false
  if (typeof user.bannedUntil === 'number' && user.bannedUntil > now) return false
  return true
}

/** 按 _id 升序翻页扫描 users（返回去重后的 accountId 列表） */
async function scanUsers(db, now) {
    const seen = new Set()
    const uids = []
    const accounts = []
  let scanned = 0
  let truncated = false
  for (let skip = 0; ; skip += SCAN_PAGE) {
    const res = await withCollection(db, USERS_COLLECTION, () =>
      db.collection(USERS_COLLECTION).orderBy('_id', 'asc').skip(skip).limit(SCAN_PAGE).get())
    const rows = (res && res.data) || []
    scanned += rows.length
        for (const u of rows) {
          if (!eligible(u, now) || seen.has(u._openid)) continue
          seen.add(u._openid)
          uids.push(u._openid)
          accounts.push({
            uid: u._openid,
            mpOpenid: typeof u.mpOpenid === 'string' ? u.mpOpenid : '',
            quota: Number.isFinite(u.promptSubscribeQuota) ? Math.max(u.promptSubscribeQuota, 0) : 0,
          })
        }
    if (rows.length < SCAN_PAGE) break
    if (skip + SCAN_PAGE >= SCAN_MAX) {
      truncated = true
      break
    }
  }
  return { uids, accounts, scanned, truncated }
}

/**
 * 额度记账（发送成功 -1 / 43101 清零）：只按 _openid 定位自己那行。
 * 失败故意不外抛——额度顶多偏大一格，下轮重复发一次也会先被 notify 的去重挡住站内消息。
 */
async function spendQuota(db, uid, quota, now) {
  try {
    await withCollection(db, USERS_COLLECTION, () =>
      db.collection(USERS_COLLECTION).where({ _openid: uid }).update({ promptSubscribeQuota: quota, promptSubscribeAt: now }))
  } catch (e) { /* 记账失败不影响提醒本身 */ }
}

/**
 * 订阅消息外发（D09b）。三条前提全满足才发：调用方注入了 mp 客户端、给了模板 ID、账号有 mpOpenid 且额度 > 0。
 * 少任何一条都只是「不发」，站内提醒照常——与 `user` 函数「没配凭证时 mp 为 null」同款做法；
 * 本模块因此仍然不读任何环境变量（env 读取留在 practice/index.js 的注入处，见 m6-notify 的既有用例）。
 */
async function sendSubscriptionReminders(ctx, { accounts, date }) {
  const templateId = typeof ctx.promptTemplateId === 'string' ? ctx.promptTemplateId.trim() : ''
  const out = { attempted: 0, sent: 0, noQuota: 0, failed: 0, skipped: 0, reason: '' }
  if (!ctx.mp || !templateId) return null // 通道未启用：不返回全零计数，免得调用方把「没配」读成「配了但没人可发」
  for (const acc of accounts) {
    if (!acc.mpOpenid || acc.quota <= 0) {
      out.skipped += 1
      continue
    }
    out.attempted += 1
    let res = null
    try {
      res = await ctx.mp.subscribeMessageSend({
        toUser: acc.mpOpenid,
        templateId,
        page: SUBSCRIBE_PAGE,
        data: { thing1: SUBSCRIBE_THING, [SUBSCRIBE_DATE]: date },
      })
    } catch (e) {
      out.failed += 1
      continue
    }
    if (res && res.outcome === 'sent') {
      out.sent += 1
      await spendQuota(ctx.db, acc.uid, Math.max(acc.quota - 1, 0), ctx.now())
    } else if (res && res.outcome === 'no-quota') {
      out.noQuota += 1
      await spendQuota(ctx.db, acc.uid, 0, ctx.now())
    } else if (res && res.outcome === 'bad-template') {
      out.failed += 1
      out.reason = 'bad-template'
      break // 模板失配是配置问题：继续跑只会让每个账号都撞一遍同样的错
    } else {
      out.failed += 1
    }
  }
  return out
}

/**
 * 跑一批每日提醒。
 * @param {{ db: any, now: () => number, logger?: { info?: Function, error?: Function } }} ctx
 * @returns {Promise<{ date: string, promptId: string | null, sent: number, deduped: number, scanned: number, truncated: boolean }>}
 *   sent = 本次新写入的通知条数，deduped = 因去重跳过的账号数
 */
async function runPromptReminder(ctx) {
  const now = ctx.now()
  const date = cnDate(now)
  const prompt = await findTodayPrompt(ctx.db, date)
  if (!prompt) return { date, promptId: null, sent: 0, deduped: 0, scanned: 0, truncated: false, subscribe: null }

  const { uids, accounts, scanned, truncated } = await scanUsers(ctx.db, now)
  let sent = 0
  let deduped = 0
  for (const uid of uids) {
    const wrote = await notify(ctx.db, {
      uid, type: 'prompt', refType: 'daily_prompt', refId: prompt._id, text: REMINDER_TEXT, now, dedupe: true,
    })
    if (wrote) sent += 1
    else deduped += 1
  }
    const subscribe = await sendSubscriptionReminders(ctx, { accounts, date })
    const summary = { date, promptId: prompt._id, sent, deduped, scanned, truncated, subscribe }
  if (ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info(`[promptReminder] ${JSON.stringify(summary)}`)
  return summary
}

/**
 * 定时事件入口。永不抛错：抛错会让平台按调用失败重试，而「提醒没发出去」不需要重试（明天还会跑，
 * 且去重保证不会重复），所以异常只记日志，返回值按定时触发器约定回 'success'。
 * @param {{ run: (ctx: any) => Promise<any>, createContext: (event: any, context: any) => Promise<any>, logger?: any }} opts
 */
function createTimerEntry({ run, createContext, logger = console }) {
  return async function timerMain(event, context) {
    try {
      await run(await createContext(event, context))
    } catch (e) {
      if (logger && typeof logger.error === 'function') logger.error('[promptReminder] failed', e && e.stack ? e.stack : e)
    }
    return 'success'
  }
}

module.exports = { runPromptReminder, createTimerEntry, isTimerEvent, eligible, REMINDER_TEXT, REMINDER_REF_TYPE: 'daily_prompt', sendSubscriptionReminders, SUBSCRIBE_PAGE, SUBSCRIBE_THING }
