'use strict'
/**
 * 统一写入链路（BE-M0-02，PRD §9 安全）：所有 UGC / 社区写接口在执行业务前调用。
 *
 *   const g = await guardWrite(ctx, 'createTopic')   // 登录 → 未封禁 → 18+ → 实名 → 未禁言 → 当日额度
 *   // … 机审（M2）、落库 …
 *   await g.commit()                                 // 成功后才计入当日额度（被机审拒绝不扣额度）
 *
 * ctx 需要：identity（resolveCaller 结果）、db（node-sdk database）、now()。
 * 选项：
 *   requirePhone  默认 true（发布类）；举报等非发布动作可传 false
 *   allowMuted    默认 false；举报、删除自己的内容可传 true
 *   limit         覆盖 DAILY_LIMITS[action]；传 0 / null 表示不限
 * 错误码：40101 未登录 / 40304 封禁 / 40303 未确认 18+ / 40302 未绑手机 / 40305 禁言 / 42901 超出当日额度。
 */
const { CODES, AppError, unauthorized, tooMany } = require('./errors')
const { requireOpenid } = require('./identity')
const { withCollection, isDuplicateKeyError, isCollectionMissingError } = require('./db')
const { DAILY_LIMITS, cnDate } = require('./config')

const RATE_COLLECTION = 'rate_limits'
const DAY_MS = 24 * 3600 * 1000

async function findUser(db, accountId) {
  const res = await db.collection('users').where({ _openid: accountId }).limit(1).get()
  return (res && res.data && res.data[0]) || null
}

/** 当前计数（集合不存在当作 0） */
async function readCount(db, id) {
  try {
    const res = await db.collection(RATE_COLLECTION).doc(id).get()
    const doc = res && res.data && res.data[0]
    return (doc && doc.count) || 0
  } catch (e) {
    if (isCollectionMissingError(e)) return 0
    throw e
  }
}

/** 计数 +1（首次写入用 add，已存在则原子自增） */
async function increment(db, id, now) {
  const col = () => db.collection(RATE_COLLECTION)
  try {
    await withCollection(db, RATE_COLLECTION, () => col().add({ _id: id, count: 1, createdAt: now, expireAt: new Date(now + 2 * DAY_MS) }))
  } catch (e) {
    if (!isDuplicateKeyError(e)) throw e
    await col().doc(id).update({ count: db.command.inc(1) })
  }
}

/**
 * @param {{ identity: any, db: any, now: () => number }} ctx
 * @param {string} action
 * @param {{ requirePhone?: boolean, allowMuted?: boolean, limit?: number | null }} [opts]
 * @returns {Promise<{ user: any, accountId: string, remaining: number | null, commit: () => Promise<void> }>}
 */
async function guardWrite(ctx, action, opts = {}) {
  const { requirePhone = true, allowMuted = false } = opts
  const accountId = requireOpenid(ctx.identity)
  const now = ctx.now()
  const user = await findUser(ctx.db, accountId)
  if (!user) throw unauthorized('未获取到用户信息，请重新登录')
  if (typeof user.bannedUntil === 'number' && user.bannedUntil > now) throw new AppError(CODES.BANNED)
  if (typeof user.adultConfirmedAt !== 'number') throw new AppError(CODES.ADULT_REQUIRED)
  if (requirePhone && user.phoneVerified !== true) throw new AppError(CODES.PHONE_REQUIRED)
  if (!allowMuted && typeof user.mutedUntil === 'number' && user.mutedUntil > now) throw new AppError(CODES.MUTED)

  const limit = 'limit' in opts ? opts.limit : DAILY_LIMITS[action]
  if (!limit) return { user, accountId, remaining: null, commit: async () => {} }

  const id = `${accountId}:${action}:${cnDate(now)}`
  const used = await readCount(ctx.db, id)
  if (used >= limit) throw tooMany(`今日额度已用完（每天 ${limit} 次），明天再来`)
  let committed = false
  return {
    user,
    accountId,
    remaining: limit - used - 1,
    commit: async () => {
      if (committed) return
      committed = true
      await increment(ctx.db, id, now)
    },
  }
}

/** 管理类动作：要求 role ∈ roles（默认 mod / admin） */
async function guardRole(ctx, roles = ['mod', 'admin']) {
  const accountId = requireOpenid(ctx.identity)
  const user = await findUser(ctx.db, accountId)
  if (!user || !roles.includes(user.role)) throw new AppError(CODES.FORBIDDEN)
  return { user, accountId }
}

module.exports = { guardWrite, guardRole, RATE_COLLECTION }
