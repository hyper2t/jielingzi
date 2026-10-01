'use strict'
/**
 * 官方圈子（BE-M4-01，PRD G1 / G2）。契约见 docs/api/community.md「圈子与邀请码（M4）」，计划见 docs/prd/m4-plan.md。
 *
 * - `circles` 由运维脚本写入（scripts/ops/circles.mjs seed），本模块只读；客户端不能直读直写（安全规则私有）。
 * - listCircles / getCircle：要求已确认 18+（同话题读取）；**非成员也能看到圈子简介与公约**（未入圈引导页要用），
 *   只有 `status = 'open'` 的圈子可见。
 * - 返回体只放白名单字段（不含 `_id` 以外的任何内部字段、成员名单）。`memberCount` / `topicCount` 是展示用近似值。
 * - myCircleIds / isMember：成员关系的唯一读取入口（话题读写的成员校验、邀请签发都用它）。
 */
const { validate, notFound, CIRCLE_RULES } = require('./_shared')
const { findById, findRows, requireReader } = require('./common')

const CIRCLES = 'circles'
const MEMBERSHIPS = 'memberships'
/** 官方圈子数量很少（≤ 10），一个人最多只会有这么多条成员关系；查询窗口取 100 足够 */
const MEMBER_WINDOW = 100
const LIST_WINDOW = 50

const text = (v) => (typeof v === 'string' ? v : '')
const count = (v) => (typeof v === 'number' && v > 0 ? Math.floor(v) : 0)

/** 我加入的圈子 id（去重；没有成员关系 / memberships 集合还不存在 → 空数组） */
async function myCircleIds(db, accountId) {
  if (!accountId) return []
  const rows = await findRows(db.collection(MEMBERSHIPS).where({ _openid: accountId }).limit(MEMBER_WINDOW))
  return [...new Set(rows.map((r) => r.circleId).filter((id) => typeof id === 'string' && id))]
}

/** 我是否是某个圈子的成员 */
async function isMember(db, accountId, circleId) {
  if (!accountId || !circleId) return false
  const rows = await findRows(db.collection(MEMBERSHIPS).where({ circleId, _openid: accountId }).limit(1))
  return rows.length > 0
}

/** 圈子对象（列表项）；getCircle 在此基础上加 rules */
function presentCircle(doc, joined) {
  return {
    id: doc._id,
    slug: text(doc.slug),
    name: text(doc.name),
    desc: text(doc.desc),
    cover: typeof doc.cover === 'string' && doc.cover ? doc.cover : null,
    memberCount: count(doc.memberCount),
    topicCount: count(doc.topicCount),
    joined: joined === true,
  }
}

/** 圈子公约：只取字符串，最多 CIRCLE_RULES.rulesMax 条（种子脚本已校验长度，这里兜底） */
const presentRules = (doc) => (Array.isArray(doc.rules) ? doc.rules.filter((r) => typeof r === 'string' && r.trim()).slice(0, CIRCLE_RULES.rulesMax) : [])

/** community.listCircles：全部开放圈子（按 sort，再按 slug），含「我是否已加入」；不分页 */
async function listCircles(params, ctx) {
  validate(params, {})
  const me = await requireReader(ctx)
  const rows = await findRows(ctx.db.collection(CIRCLES).where({ status: 'open' }).orderBy('sort', 'asc').orderBy('slug', 'asc').limit(LIST_WINDOW))
  const mine = new Set(await myCircleIds(ctx.db, me))
  return { list: rows.map((c) => presentCircle(c, mine.has(c._id))) }
}

/** community.getCircle：圈子详情（含公约）；不存在 / 已关闭 40401 */
async function getCircle(params, ctx) {
  const { id } = validate(params, { id: { type: 'id' } })
  const me = await requireReader(ctx)
  const doc = await findById(ctx.db, CIRCLES, id)
  if (!doc || doc.status !== 'open') throw notFound('圈子不存在或已关闭')
  const joined = await isMember(ctx.db, me, doc._id)
  return { circle: { ...presentCircle(doc, joined), rules: presentRules(doc) } }
}

module.exports = { listCircles, getCircle, myCircleIds, isMember, presentCircle, presentRules }
