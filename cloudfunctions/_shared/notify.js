'use strict'
/**
 * 站内消息（BE-M2-04，N1 前置）：notifications 集合，_openid = 接收人 accountId（owned：合并改归属、注销删除）。
 * PRD 原则「通知只与我直接相关、不推送营销与热点」：type 只有 reply / moderation / prompt；
 * text 是平台写的固定说明，**不包含被处理内容的原文**（避免二次传播违规内容）。消息列表与未读数在 M6（FE-M6-03）。
 */
const { withCollection } = require('./db')

const NOTIFY_COLLECTION = 'notifications'
const NOTIFY_TYPES = Object.freeze(['reply', 'moderation', 'prompt'])

/**
 * @param {boolean} [dedupe] true = 同 (uid, type, refId) 只保留一条（已存在则不写、返回 false）。
 *   默认关闭：moderation 的既有语义要保持——同一目标被二次处理（如再违规再下架）时还要再通知一次。
 * @returns {Promise<boolean>} 没有接收人（如作者已注销）或去重命中时不写，返回 false
 */
async function notify(db, { uid, type, refType = null, refId = null, text, now, dedupe = false }) {
  if (!uid) return false
  if (!NOTIFY_TYPES.includes(type)) throw new Error(`notify: 未知 type ${type}`)
  const doc = { _openid: uid, type, refType, refId, text, read: false, createdAt: now }
  // 去重必须同时给出 refId：没有它就无从判断「同一条」，退回逐条写（refId 为空的场景本来也不需要去重）
  return withCollection(db, NOTIFY_COLLECTION, async () => {
    const col = db.collection(NOTIFY_COLLECTION)
    if (dedupe && refId) {
      // 走 idx_owner_read_time 的 _openid 前缀：一个人最多几十条消息，先查后写比加一条唯一索引划算
      const hit = await col.where({ _openid: uid, type, refId }).limit(1).get()
      if (hit && hit.data && hit.data.length) return false
    }
    await col.add(doc)
    return true
  })
}

module.exports = { notify, NOTIFY_COLLECTION, NOTIFY_TYPES }
