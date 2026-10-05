'use strict'
/**
 * community 各模块共用的读取辅助（话题 / 圈子 / 邀请）：集合不存在时当作空，读内容要求已确认 18+。
 * 从 topics.js 抽出，避免 topics ↔ circles 互相引用。
 */
const { unauthorized, AppError, CODES, requireOpenid, isCollectionMissingError } = require('./_shared')

async function findById(db, collection, id) {
  try {
    const res = await db.collection(collection).doc(id).get()
    return (res && res.data && res.data[0]) || null
  } catch (e) {
    if (isCollectionMissingError(e)) return null
    throw e
  }
}

async function findRows(query) {
  try {
    const res = await query.get()
    return (res && res.data) || []
  } catch (e) {
    if (isCollectionMissingError(e)) return []
    throw e
  }
}

async function countRows(query) {
  try {
    const res = await query.count()
    return (res && res.total) || 0
  } catch (e) {
    if (isCollectionMissingError(e)) return 0
    throw e
  }
}

/** 读内容要求已确认 18+（PRD C5）；返回当前账号 id */
async function requireReader(ctx) {
  const me = requireOpenid(ctx.identity)
  const rows = await findRows(ctx.db.collection('users').where({ _openid: me }).limit(1))
  if (!rows[0]) throw unauthorized('未获取到用户信息，请重新登录')
  if (typeof rows[0].adultConfirmedAt !== 'number') throw new AppError(CODES.ADULT_REQUIRED)
  return me
}

module.exports = { findById, findRows, countRows, requireReader }
