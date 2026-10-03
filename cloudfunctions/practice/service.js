'use strict'
/**
 * practice 云函数业务逻辑：M5 打卡；M6 每日一题后续补齐。契约见 docs/api/practice.md。
 * 写类动作一律先调用 guardWrite(ctx, '<action>')，成功落库后 commit()（见 _shared/guard.js）。
 * ctx：{ identity, db, now, logger }
 */

const { guardWrite } = require('./_shared/guard')
const { badParam } = require('./_shared/errors')
const { isDuplicateKeyError, withCollection } = require('./_shared/db')

/** 不要求身份的动作（入口据此不因副作用建号） */
const IDENTITY_FREE_ACTIONS = ['ping']

const PRACTICE_IDS = new Set([
  'meditation', 'mindfulness', 'vipassana', 'taichi', 'zhanzhuang', 'qigong',
  'yoga', 'breathing', 'calligraphy', 'tea', 'reading', 'other'
])
const MAX_SESSION_MINUTES = 180
const MONTH_PAGE_SIZE = 100

function noUnknown (input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badParam('参数格式不正确')
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key))
  if (unknown.length) throw badParam(`不支持的参数：${unknown.join(',')}`)
}

function isDateKey (value) {
  if (typeof value !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return false
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  return year >= 2000 && year <= 2100 && new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value
}

function validateCheckin (input) {
  noUnknown(input, ['sessionId', 'date', 'practice', 'minutes'])
  if (typeof input.sessionId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(input.sessionId)) throw badParam('sessionId 格式不正确')
  if (!isDateKey(input.date)) throw badParam('date 必须是有效的 YYYY-MM-DD 日期')
  if (typeof input.practice !== 'string' || !PRACTICE_IDS.has(input.practice)) throw badParam('practice 不在支持范围内')
  if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > MAX_SESSION_MINUTES) throw badParam(`minutes 必须为 1–${MAX_SESSION_MINUTES} 的整数`)
  return { sessionId: input.sessionId, date: input.date, practice: input.practice, minutes: input.minutes }
}

function validateMonth (input) {
  noUnknown(input, ['month'])
  if (typeof input.month !== 'string' || !/^(\d{4})-(0[1-9]|1[0-2])$/.test(input.month)) throw badParam('month 必须是 YYYY-MM 格式')
  const year = Number(input.month.slice(0, 4))
  if (year < 2000 || year > 2100) throw badParam('month 超出支持范围')
  return input.month
}

async function findDay (db, accountId, dayKey) {
  const res = await withCollection(db, 'checkins', () => db.collection('checkins')
    .where({ _openid: accountId, dayKey }).limit(1).get())
  return (res && res.data && res.data[0]) || null
}

function resultFor (doc, duplicate) {
  return {
    checkin: {
      date: doc.date,
      practice: doc.practice,
      minutes: Number(doc.minutes) || 0,
      duplicate
    }
  }
}

async function addToDay (ctx, accountId, dayKey, input, doc) {
  const sessionIds = Array.isArray(doc.sessionIds) ? doc.sessionIds : []
  if (sessionIds.includes(input.sessionId)) return resultFor(doc, true)

  // 条件更新 + $push：并发重试相同 sessionId 时只有一次能增加分钟数。
  const update = await withCollection(ctx.db, 'checkins', () => ctx.db.collection('checkins')
    .where({
      _openid: accountId,
      dayKey,
      sessionIds: ctx.db.command.nin([input.sessionId])
    })
    .update({
      minutes: ctx.db.command.inc(input.minutes),
      sessionIds: ctx.db.command.push(input.sessionId),
      updatedAt: ctx.now()
    }))

  const latest = await findDay(ctx.db, accountId, dayKey)
  if (latest && Array.isArray(latest.sessionIds) && latest.sessionIds.includes(input.sessionId)) {
    return resultFor(latest, !(update && update.updated))
  }
  throw new Error('打卡记录并发更新后未找到 sessionId')
}

async function checkin (params, ctx) {
  const input = validateCheckin(params)
  // 私人练习记录不要求绑定手机号，也不受社区禁言影响；仍要求登录、18+ 且账号未封禁。
  const gate = await guardWrite(ctx, 'checkin', { requirePhone: false, allowMuted: true, limit: 0 })
  const accountId = gate.accountId
  const dayKey = `${input.date}:${input.practice}`
  const existing = await findDay(ctx.db, accountId, dayKey)
  if (existing) return addToDay(ctx, accountId, dayKey, input, existing)

  const now = ctx.now()
  const doc = {
    _openid: accountId,
    dayKey,
    monthKey: input.date.slice(0, 7),
    date: input.date,
    practice: input.practice,
    minutes: input.minutes,
    sessionIds: [input.sessionId],
    createdAt: now,
    updatedAt: now
  }
  try {
    await withCollection(ctx.db, 'checkins', () => ctx.db.collection('checkins').add(doc))
    await gate.commit()
    return resultFor(doc, false)
  } catch (e) {
    if (!isDuplicateKeyError(e)) throw e
    // 唯一索引處理「首次並發建立同一天記錄」；重讀後沿用原子累加路徑。
    const latest = await findDay(ctx.db, accountId, dayKey)
    if (!latest) throw e
    const result = await addToDay(ctx, accountId, dayKey, input, latest)
    await gate.commit()
    return result
  }
}

async function listCheckins (params, ctx) {
  const month = validateMonth(params)
  const { accountId } = await guardWrite(ctx, 'listCheckins', { requirePhone: false, allowMuted: true, limit: 0 })
  const docs = []
  for (let skip = 0; ; skip += MONTH_PAGE_SIZE) {
    const res = await withCollection(ctx.db, 'checkins', () => ctx.db.collection('checkins')
      .where({ _openid: accountId, monthKey: month })
      .orderBy('date', 'asc').skip(skip).limit(MONTH_PAGE_SIZE).get())
    const page = (res && res.data) || []
    docs.push(...page)
    if (page.length < MONTH_PAGE_SIZE) break
  }

  const byDate = new Map()
  for (const doc of docs) {
    if (!isDateKey(doc.date) || doc.monthKey !== month || !PRACTICE_IDS.has(doc.practice)) continue
    const minutes = Number.isInteger(doc.minutes) && doc.minutes > 0 ? doc.minutes : 0
    if (!minutes) continue
    let day = byDate.get(doc.date)
    if (!day) {
      day = { date: doc.date, minutes: 0, practices: {} }
      byDate.set(doc.date, day)
    }
    day.minutes += minutes
    day.practices[doc.practice] = (day.practices[doc.practice] || 0) + minutes
  }
  const list = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date))
  return { month, list, totalMinutes: list.reduce((sum, day) => sum + day.minutes, 0) }
}

const actions = {
  /** 健康检查：部署 / 安全规则验证用，不读写数据库 */
  async ping(_params, ctx) {
    return { fn: 'practice', at: ctx.now() }
  },
  /** BE-M5-01：每日按练习方式累加；同一 sessionId 的重试不重复计时 */
  checkin,
  /** BE-M5-01：仅返回当前账号指定月份的汇总 */
  listCheckins
}

module.exports = { actions, IDENTITY_FREE_ACTIONS, PRACTICE_IDS }
