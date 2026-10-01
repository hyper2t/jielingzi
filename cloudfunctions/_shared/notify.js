'use strict'
/**
 * 站内消息（BE-M2-04，N1 前置）：notifications 集合，_openid = 接收人 accountId（owned：合并改归属、注销删除）。
 * PRD 原则「通知只与我直接相关、不推送营销与热点」：type 只有 reply / moderation / prompt；
 * text 是平台写的固定说明，**不包含被处理内容的原文**（避免二次传播违规内容）。消息列表与未读数在 M6（FE-M6-03）。
 */
const { withCollection } = require('./db')

const NOTIFY_COLLECTION = 'notifications'
const NOTIFY_TYPES = Object.freeze(['reply', 'moderation', 'prompt'])

/** @returns {Promise<boolean>} 没有接收人（如作者已注销）时不写，返回 false */
async function notify(db, { uid, type, refType = null, refId = null, text, now }) {
  if (!uid) return false
  if (!NOTIFY_TYPES.includes(type)) throw new Error(`notify: 未知 type ${type}`)
  const doc = { _openid: uid, type, refType, refId, text, read: false, createdAt: now }
  await withCollection(db, NOTIFY_COLLECTION, () => db.collection(NOTIFY_COLLECTION).add(doc))
  return true
}

module.exports = { notify, NOTIFY_COLLECTION, NOTIFY_TYPES }
