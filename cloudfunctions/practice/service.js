'use strict'
/**
 * practice 云函数业务逻辑：M5 打卡；M6 每日一题（今日题目 / 作答 / 答案列表）。契约见 docs/api/practice.md。
 * 写类动作一律先调用 guardWrite(ctx, '<action>')，成功落库后 commit()（见 _shared/guard.js）。
 * ctx：{ identity, db, now, logger }
 *   - 每日一题（BE-M6-01，m6-plan D6–D13）：题目由运营在控制台写入 daily_prompts，云函数侧只读（后台在 M7）；
 *     一人一题一次（重复 40901），答案默认匿名、可切实名；他人答案只在本人已作答后可见；
 *     机审与社区发布链路一致（reject 抛 40001 且不落库、不扣额度；review 落库为 pending）。
 */

const { guardWrite } = require('./_shared/guard')
const { requireOpenid } = require('./_shared/identity')
const { badParam, notFound, forbidden, conflict } = require('./_shared/errors')
const { isDuplicateKeyError, withCollection } = require('./_shared/db')
const { cnDate, PROMPT_RULES } = require('./_shared/config')
const { checkText, logModeration } = require('./_shared/moderation')

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

// ---------- 每日一题（BE-M6-01：今日题目 / 作答 / 答案列表） ----------

/** 题目集合（公开只读，运营录入）与答案集合（owned by promptId，见 _shared/collections.js） */
const DAILY_PROMPTS = 'daily_prompts'
const PROMPT_ANSWERS = 'prompt_answers'
/** 答案列表默认分页大小（上限取 PROMPT_RULES.listMax） */
const ANSWER_PAGE_SIZE = 20
/** profiles 批量查询分片大小（与 community/topics.js 的 IN_CHUNK 同值） */
const IN_CHUNK = 20
/**
 * 机审拦截提示语：与 cloudfunctions/community/topics.js 的同名常量逐字一致（同一套社区公约口径），
 * 由 tests/cloudfunctions/m6-prompt.test.js 锁定文案，改动一处即红。
 */
const REJECT_MSG = '内容不符合社区公约，请修改后再发布'
/**
 * 答案作者展示形态（与 community 的 presentAuthor 同语义，但按最小必要只给名称与形态，
 * 不返回头像 / 徽章 / 练习方式 / 年限，避免被反推身份；m6-plan D9）。
 */
const DELETED_NAME = '已注销用户'
const ANON_NAME = '匿名用户'
const NICK_NAME = '练习者'

function isPositiveInt (value) {
  return Number.isInteger(value) && value > 0
}

/** 今日题目无入参：多传字段按参数错误处理，便于尽早暴露前端拼错 */
function validateToday (input) {
  if (input !== undefined && input !== null) noUnknown(input, [])
  return {}
}

function validateAnswer (input) {
  noUnknown(input, ['promptId', 'text', 'anon'])
  if (typeof input.promptId !== 'string' || !input.promptId) throw badParam('promptId 不能为空')
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  const { min, max } = PROMPT_RULES.answer
  if (text.length < min || text.length > max) throw badParam(`答案需 ${min}–${max} 字`)
  if ('anon' in input && typeof input.anon !== 'boolean') throw badParam('anon 需为布尔值')
  // 默认匿名（PROMPT_RULES.defaultAnon）：只有显式传 false 才按实名处理
  return { promptId: input.promptId, text, anon: input.anon !== false }
}

function validateAnswerList (input) {
  noUnknown(input, ['promptId', 'page', 'size'])
  if (typeof input.promptId !== 'string' || !input.promptId) throw badParam('promptId 不能为空')
  const page = input.page === undefined ? 1 : input.page
  if (!isPositiveInt(page)) throw badParam('page 需为正整数')
  const size = input.size === undefined ? ANSWER_PAGE_SIZE : input.size
  if (!isPositiveInt(size) || size > PROMPT_RULES.listMax) throw badParam(`size 需为 1–${PROMPT_RULES.listMax} 的整数`)
  return { promptId: input.promptId, page: Number(page), size: Number(size) }
}

async function findPromptById (db, id) {
  const res = await withCollection(db, DAILY_PROMPTS, () => db.collection(DAILY_PROMPTS).where({ _id: id }).limit(1).get())
  return (res && res.data && res.data[0]) || null
}

/** 当日题目：只认 status='ok'（closed / pending 不出现在今日入口） */
async function findPromptByDate (db, date) {
  const res = await withCollection(db, DAILY_PROMPTS, () => db.collection(DAILY_PROMPTS).where({ date, status: 'ok' }).limit(1).get())
  return (res && res.data && res.data[0]) || null
}

/** 本人对该题的作答（任意状态：ok / pending / removed 都算「已作答」，m6-plan D10） */
async function findMyAnswer (db, promptId, accountId) {
  if (!promptId || !accountId) return null
  const res = await withCollection(db, PROMPT_ANSWERS, () =>
    db.collection(PROMPT_ANSWERS).where({ promptId, _openid: accountId }).orderBy('createdAt', 'asc').limit(1).get())
  return (res && res.data && res.data[0]) || null
}

/** 该题可见答案数（展示用近似值，与圈子成员数同口径） */
async function countOkAnswers (db, promptId) {
  const res = await withCollection(db, PROMPT_ANSWERS, () =>
    db.collection(PROMPT_ANSWERS).where({ promptId, status: 'ok' }).count())
  const total = res && (res.total != null ? res.total : res.count)
  return Number.isFinite(Number(total)) ? Number(total) : 0
}

/** 答案作者的展示档案（只取展示需要的昵称 / 花名；缺档案时按「无档案」处理，不额外查询） */
async function loadProfiles (db, ids) {
  const map = new Map()
  const uniq = [...new Set(ids.filter(Boolean))]
  for (let i = 0; i < uniq.length; i += IN_CHUNK) {
    const chunk = uniq.slice(i, i + IN_CHUNK)
    const res = await withCollection(db, 'profiles', () =>
      db.collection('profiles').where({ _openid: db.command.in(chunk) }).limit(chunk.length).get())
    for (const p of (res && res.data) || []) map.set(p._openid, p)
  }
  return map
}

function presentAnswer (row, profiles, me) {
  const base = { id: row._id, date: row.date, text: row.text, status: row.status, createdAt: row.createdAt, isSelf: row._openid === me }
  if (row.authorDeleted === true || !row._openid) {
    return { ...base, authorName: DELETED_NAME, anon: false, deleted: true }
  }
  const p = profiles.get(row._openid) || {}
  if (row.anon !== false) return { ...base, authorName: p.anonAlias || ANON_NAME, anon: true, deleted: false }
  return { ...base, authorName: p.nickname || p.anonAlias || NICK_NAME, anon: false, deleted: false }
}

/**
 * 答案机审（m6-plan D13）：场景 comment（与社区回复同口径）。
 * reject → 抛 40001（调用点在扣额度之前，故不落库也不计额度）；review → 落库但 status=pending（仅本人可见）；
 * 两者都写 mod_logs 留痕（不记原文）。
 */
async function screenAnswer (ctx, accountId, text, promptId, now) {
  const r = await checkText(ctx, { scene: 'comment', texts: [text] })
  if (r.verdict === 'pass') return 'ok'
  await logModeration(ctx.db, {
    kind: 'machine',
    scene: 'comment',
    verdict: r.verdict,
    categories: [...new Set((r.hits || []).map((h) => h.category))],
    labels: r.labels || [],
    actor: 'system',
    subject: accountId,
    targetType: 'prompt_answer',
    targetId: promptId
  }, now)
  if (r.verdict === 'reject') throw badParam(REJECT_MSG)
  return 'pending'
}

/**
 * 今日题目：当日没有已发布题目时返回 `{ prompt: null }`（前端据此隐藏入口，不算错误）。
 * 读动作不扣额度（limit=0），但保留登录 / 18+ / 封禁门禁，与 listCheckins 一致。
 */
async function todayPrompt (params, ctx) {
  validateToday(params)
  const { accountId } = await guardWrite(ctx, 'todayPrompt', { requirePhone: false, allowMuted: true, limit: 0 })
  const date = cnDate(ctx.now())
  const prompt = await findPromptByDate(ctx.db, date)
  if (!prompt) return { prompt: null }
  const mine = await findMyAnswer(ctx.db, prompt._id, accountId)
  return {
    prompt: {
      id: prompt._id,
      date: prompt.date,
      text: prompt.text,
      answered: !!mine,
      myStatus: mine ? mine.status : null,
      answerCount: await countOkAnswers(ctx.db, prompt._id)
    }
  }
}

/**
 * 作答每日一题：一人一题一次（重复 40901 且不扣额度）；同日第二题由 DAILY_LIMITS.answerPrompt=1 兜住。
 * 题目不存在或已下架 → 40401；答案落到题目自己的 date 上（补答昨天的题不占用「今天」的语义）。
 */
async function answerPrompt (params, ctx) {
  const input = validateAnswer(params)
  // 前置判断（题目是否存在 / 本人是否已作答）走在 guardWrite 之前：每日一题的额度只有 1 次，
  // 先扣额度再判重复会让重复提交只看到 42901，盖掉真实原因（与 community.redeemInvite 的「先查前置、再走额度」同序）。
  const me = requireOpenid(ctx.identity)
  const prompt = await findPromptById(ctx.db, input.promptId)
  if (!prompt || prompt.status !== 'ok') throw notFound('题目不存在或已结束')
  if (await findMyAnswer(ctx.db, prompt._id, me)) throw conflict('今天已经作答过了')
  const gate = await guardWrite(ctx, 'answerPrompt')
  const now = ctx.now()
  const status = await screenAnswer(ctx, gate.accountId, input.text, prompt._id, now)
  const doc = {
    _openid: gate.accountId,
    promptId: prompt._id,
    date: prompt.date,
    text: input.text,
    anon: input.anon,
    status,
    createdAt: now
  }
  const res = await withCollection(ctx.db, PROMPT_ANSWERS, () => ctx.db.collection(PROMPT_ANSWERS).add(doc))
  await gate.commit()
  return {
    answer: {
      id: (res && (res.id || res._id)) || null,
      date: doc.date,
      text: doc.text,
      anon: doc.anon,
      status: doc.status,
      createdAt: doc.createdAt
    }
  }
}

/**
 * 答案列表（m6-plan D10）：本人未作答 → 40301，且不返回任何他人答案文本；
 * 他人只返回 status=ok（pending / removed 一律不可见），本人那条单独给出（可能仍在复核中）。
 */
async function listAnswers (params, ctx) {
  const input = validateAnswerList(params)
  const { accountId } = await guardWrite(ctx, 'listAnswers', { requirePhone: false, allowMuted: true, limit: 0 })
  const prompt = await findPromptById(ctx.db, input.promptId)
  if (!prompt) throw notFound('题目不存在')
  const mine = await findMyAnswer(ctx.db, prompt._id, accountId)
  if (!mine) throw forbidden('作答后即可查看他人的回答')
  const _ = ctx.db.command
  const res = await withCollection(ctx.db, PROMPT_ANSWERS, () =>
    ctx.db.collection(PROMPT_ANSWERS)
      .where({ promptId: prompt._id, status: 'ok', _openid: _.neq(accountId) })
      .orderBy('createdAt', 'asc')
      .skip((input.page - 1) * input.size)
      .limit(input.size + 1)
      .get())
  const rows = (res && res.data) || []
  const others = rows.slice(0, input.size)
  const profiles = await loadProfiles(ctx.db, [...others.map((r) => r._openid), accountId])
  return {
    promptId: prompt._id,
    date: prompt.date,
    page: input.page,
    size: input.size,
    hasMore: rows.length > input.size,
    list: others.map((r) => presentAnswer(r, profiles, accountId)),
    mine: presentAnswer(mine, profiles, accountId)
  }
}

const actions = {
  /** 健康检查：部署 / 安全规则验证用，不读写数据库 */
  async ping(_params, ctx) {
    return { fn: 'practice', at: ctx.now() }
  },
  /** BE-M5-01：每日按练习方式累加；同一 sessionId 的重试不重复计时 */
  checkin,
  /** BE-M5-01：仅返回当前账号指定月份的汇总 */
  listCheckins,
  /** BE-M6-01：每日一题（今日题目 / 作答 / 答案列表） */
  todayPrompt,
  answerPrompt,
  listAnswers
}

module.exports = { actions, IDENTITY_FREE_ACTIONS, PRACTICE_IDS }
