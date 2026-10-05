'use strict'
/**
 * 邀请码（BE-M4-02，PRD G2 / G3）。契约见 docs/api/community.md「圈子与邀请码（M4）」，决策见 docs/prd/m4-plan.md。
 *
 * - 名额在 users.inviteQuota：字段缺失 = 未初始化，首次使用时用「字段不存在」条件写入初始值（幂等，不覆盖已有值）；
 *   扣减用 `inviteQuota >= 1` 条件 + inc(-1)，updated 为 0 即名额不足，并发下不会扣成负数。
 * - 签发：只有该圈成员能签发；先扣名额再写码，写码失败把名额退回。
 * - 过期退名额：过期未使用的码退回 1 个名额；`refunded` 用条件更新「抢占」，保证每个码只退一次
 *   （先标记后加额，极端崩溃时宁可少退一个，也不会多退）；官方码不占名额也不退。listInvites / createInvite 时触发。
 * - 兑换：规范化 → 码无效 / 已用 / 过期 / 圈子已关闭统一 40401 → 已是成员 40901（不消耗码）→ 条件标记已用 → 写成员关系。
 *   每次兑换尝试（含失败）计 1 次日额度，防猜码；输入格式错误（40001）不计。
 */
const {
  validate, notFound, conflict, tooMany, forbidden, guardWrite, isDuplicateKeyError, withCollection, INVITE_RULES, normalizeInviteCode, generateInviteCode,
} = require('./_shared')
const { findById, findRows, requireReader } = require('./common')
const { isMember, presentCircle } = require('./circles')

const CIRCLES = 'circles'
const MEMBERSHIPS = 'memberships'
const INVITES = 'invites'
const USERS = 'users'
const DAY_MS = 24 * 3600 * 1000
/** 生成码撞唯一索引的重试次数（32^8 ≈ 1e12，实际几乎不会发生） */
const CODE_ATTEMPTS = 5
/** 一次最多回收的过期码（再多的下次再退） */
const REFUND_BATCH = 50
const INVALID_MSG = '邀请码无效、已被使用或已过期'

const quotaOf = (v) => (typeof v === 'number' && v > 0 ? Math.floor(v) : 0)

/** 名额懒初始化（字段缺失才写，幂等）；返回当前剩余名额 */
async function readQuota(db, accountId) {
  await db.collection(USERS).where({ _openid: accountId, inviteQuota: db.command.exists(false) }).update({ inviteQuota: INVITE_RULES.initialQuota })
  const rows = await findRows(db.collection(USERS).where({ _openid: accountId }).limit(1))
  return quotaOf(rows[0] && rows[0].inviteQuota)
}

/** 原子扣 1 个名额；名额不足返回 false */
async function takeQuota(db, accountId) {
  const _ = db.command
  const res = await db.collection(USERS).where({ _openid: accountId, inviteQuota: _.gte(1) }).update({ inviteQuota: _.inc(-1) })
  return !!res && res.updated === 1
}

async function giveBackQuota(db, accountId) {
  await db.collection(USERS).where({ _openid: accountId }).update({ inviteQuota: db.command.inc(1) })
}

/** 过期未用且未退过的非官方码退名额（幂等）；返回退回个数 */
async function refundExpired(db, accountId, now) {
  const _ = db.command
  const rows = await findRows(
    db.collection(INVITES).where({ _openid: accountId, official: false, usedBy: null, refunded: false, expiresAt: _.lte(now) }).limit(REFUND_BATCH),
  )
  let refunded = 0
  for (const inv of rows) {
    const claim = await db.collection(INVITES).where({ code: inv.code, usedBy: null, refunded: false }).update({ refunded: true })
    if (claim && claim.updated === 1) {
      await giveBackQuota(db, accountId)
      refunded += 1
    }
  }
  return refunded
}

const statusOf = (inv, now) => (inv.usedBy ? 'used' : typeof inv.expiresAt === 'number' && inv.expiresAt <= now ? 'expired' : 'active')

/** 邀请码对象：只给签发人本人；不含兑换人 / 官方标记 / 退额度标记 */
function presentInvite(inv, circle, now) {
  return {
    code: inv.code,
    circle: { id: inv.circleId, name: circle && typeof circle.name === 'string' ? circle.name : '' },
    status: statusOf(inv, now),
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    usedAt: typeof inv.usedAt === 'number' ? inv.usedAt : null,
  }
}

/** community.listInvites：我的名额与我签发的码（新的在前） */
async function listInvites(params, ctx) {
  validate(params, {})
  const me = await requireReader(ctx)
  const now = ctx.now()
  await readQuota(ctx.db, me) // 先初始化名额：退名额是 inc，不能落在缺失字段上
  await refundExpired(ctx.db, me, now)
  const quota = await readQuota(ctx.db, me)
  const rows = await findRows(ctx.db.collection(INVITES).where({ _openid: me }).orderBy('createdAt', 'desc').limit(INVITE_RULES.listMax))
  const circles = new Map()
  for (const id of new Set(rows.map((r) => r.circleId))) circles.set(id, await findById(ctx.db, CIRCLES, id))
  return { quota, ttlDays: INVITE_RULES.ttlDays, list: rows.map((r) => presentInvite(r, circles.get(r.circleId), now)) }
}

/** community.createInvite：成员签发一次性邀请码（扣 1 个名额，7 天有效） */
async function createInvite(params, ctx) {
  const { circleId } = validate(params, { circleId: { type: 'id' } })
  const g = await guardWrite(ctx, 'createInvite')
  const { db } = ctx
  const now = ctx.now()
  const circle = await findById(db, CIRCLES, circleId)
  // 圈子不存在 / 已关闭 / 我不是成员：同一个提示，不泄露圈子是否存在
  if (!circle || circle.status !== 'open' || !(await isMember(db, g.accountId, circleId))) throw forbidden('加入圈子后才能邀请')
  await readQuota(db, g.accountId) // 先初始化名额：退名额是 inc，不能落在缺失字段上
  await refundExpired(db, g.accountId, now)
  if (!(await takeQuota(db, g.accountId))) throw tooMany('邀请名额已用完')
  let doc = null
  try {
    for (let i = 0; i < CODE_ATTEMPTS && !doc; i++) {
      const candidate = {
        code: generateInviteCode(ctx), circleId, _openid: g.accountId, official: false, createdAt: now, expiresAt: now + INVITE_RULES.ttlDays * DAY_MS,
        usedBy: null, usedAt: null, refunded: false,
      }
      try {
        await withCollection(db, INVITES, () => db.collection(INVITES).add(candidate))
        doc = candidate
      } catch (e) {
        if (!isDuplicateKeyError(e)) throw e
      }
    }
    if (!doc) throw new Error('邀请码生成失败：多次撞码')
  } catch (e) {
    await giveBackQuota(db, g.accountId).catch((err) => ctx.logger && ctx.logger.error && ctx.logger.error('退回邀请名额失败', err))
    throw e
  }
  await g.commit()
  return { invite: presentInvite(doc, circle, now), quota: await readQuota(db, g.accountId) }
}

/** 还原被抢占的码（写成员关系失败时） */
async function releaseCode(ctx, code, accountId) {
  try {
    await ctx.db.collection(INVITES).where({ code, usedBy: accountId }).update({ usedBy: null, usedAt: null })
  } catch (err) {
    if (ctx.logger && ctx.logger.error) ctx.logger.error('还原邀请码失败', code, err)
  }
}

/** community.redeemInvite：一次性邀请码入圈 */
async function redeemInvite(params, ctx) {
  const { code: raw } = validate(params, { code: { type: 'string', maxLen: 100 } })
  const code = normalizeInviteCode(raw)
  const g = await guardWrite(ctx, 'redeemInvite', { allowMuted: true })
  await g.commit() // 含失败的每次尝试都计数（防猜码）
  const { db } = ctx
  const now = ctx.now()
  const me = g.accountId
  const inv = (await findRows(db.collection(INVITES).where({ code }).limit(1)))[0]
  if (!inv || inv.usedBy || typeof inv.expiresAt !== 'number' || inv.expiresAt <= now) throw notFound(INVALID_MSG)
  const circle = await findById(db, CIRCLES, inv.circleId)
  if (!circle || circle.status !== 'open') throw notFound(INVALID_MSG)
  if (await isMember(db, me, circle._id)) throw conflict('你已在这个圈子里')
  const claim = await db.collection(INVITES).where({ code, usedBy: null, expiresAt: db.command.gt(now) }).update({ usedBy: me, usedAt: now })
  if (!claim || claim.updated !== 1) throw notFound(INVALID_MSG)
  try {
    await withCollection(db, MEMBERSHIPS, () =>
      db.collection(MEMBERSHIPS).add({ circleId: circle._id, _openid: me, joinedAt: now, invitedBy: inv._openid || null, inviteCode: code, role: 'member' }))
  } catch (e) {
    await releaseCode(ctx, code, me)
    if (isDuplicateKeyError(e)) throw conflict('你已在这个圈子里')
    throw e
  }
  // 成员数只是展示用近似值：失败不影响入圈（运维脚本 recount 可校正）
  await db.collection(CIRCLES).doc(circle._id).update({ memberCount: db.command.inc(1) }).catch((err) => ctx.logger && ctx.logger.error && ctx.logger.error('更新成员数失败', err))
  return { circle: presentCircle({ ...circle, memberCount: (circle.memberCount || 0) + 1 }, true), joined: true }
}

module.exports = { listInvites, createInvite, redeemInvite, normalizeInviteCode, readQuota, refundExpired }
