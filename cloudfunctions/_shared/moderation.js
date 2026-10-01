'use strict'
/**
 * 内容机审（BE-M2-01，PRD S1）：自建词库（./wordlist.js）+ 微信 msgSecCheck v2，取更严的结论。
 *   const r = await checkText(ctx, { scene: 'forum', texts: [title, body] })
 *   r.verdict === 'reject' → 调用方抛 40001「内容不符合社区公约」，不落库、不扣额度
 *   r.verdict === 'review' → 落库但 status = 'pending'（不对他人展示），进人工复核队列
 *   r.verdict === 'pass'   → 正常
 * - msgSecCheck 需要用户的小程序 openid（ctx.identity.raw.openId，或 input.openid）与 ctx.mp（_shared/wxmp.js）；
 *   App 用户没有 openid 时只用词库（mvp-plan 风险表：App 端后续接腾讯云内容安全）。
 * - 微信接口失败不阻断发布，但结论至少为 review（宁可慢不可乱）。
 * - ctx.moderation.checkText 可注入替身（单测 / 替换实现）。
 * - logModeration 写 mod_logs（机审 / 人工处理日志，expireAt = 6 个月后，备监管查询；不记原文）。
 */
const { withCollection } = require('./db')
const { scanText, verdictOf, stricter } = require('./wordlist')

/** 机审场景：资料 / 评论 / 论坛 / 社交日志（msgSecCheck v2 的 scene 1–4） */
const SCENES = Object.freeze({ profile: 1, comment: 2, forum: 3, log: 4 })
const VERDICTS = Object.freeze(['pass', 'review', 'reject'])
/** msgSecCheck 单次 content 上限 2500 字 */
const MSG_SEC_MAX = 2500
const MOD_LOG_COLLECTION = 'mod_logs'
const MOD_LOG_TTL_MS = 183 * 24 * 3600 * 1000

function chunks(text, size) {
  const chars = Array.from(text)
  const out = []
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''))
  return out
}

/**
 * @param {{ moderation?: { checkText: Function }, mp?: any, identity?: any }} ctx
 * @param {{ scene: keyof typeof SCENES, texts: Array<string | null | undefined>, openid?: string | null }} input
 * @returns {Promise<{ verdict: 'pass' | 'review' | 'reject', hits: Array<{ category: string, word: string }>, labels: Array<string | number> }>}
 */
async function checkText(ctx, input) {
  if (!input || !Object.prototype.hasOwnProperty.call(SCENES, input.scene)) throw new Error(`checkText: 未知 scene ${input && input.scene}`)
  const texts = (input.texts || []).filter((t) => typeof t === 'string' && t.trim() !== '')
  if (!texts.length) return { verdict: 'pass', hits: [], labels: [] }
  if (ctx && ctx.moderation && typeof ctx.moderation.checkText === 'function') {
    const r = await ctx.moderation.checkText({ scene: input.scene, texts })
    if (!r || !VERDICTS.includes(r.verdict)) throw new Error('checkText: 机审实现返回了未知结论')
    return { hits: [], labels: [], ...r }
  }
  const hits = texts.flatMap((t) => scanText(t))
  let verdict = verdictOf(hits)
  const labels = []
  const openid = input.openid !== undefined ? input.openid : ctx && ctx.identity && ctx.identity.raw && ctx.identity.raw.openId
  if (verdict !== 'reject' && ctx && ctx.mp && typeof ctx.mp.msgSecCheck === 'function' && openid) {
    try {
      for (const part of chunks(texts.join('\n'), MSG_SEC_MAX)) {
        const r = await ctx.mp.msgSecCheck(part, { scene: SCENES[input.scene], openid })
        if (r.label != null && r.label !== 100) labels.push(r.label)
        verdict = stricter(verdict, r.suggest === 'risky' ? 'reject' : r.suggest === 'review' ? 'review' : 'pass')
        if (verdict === 'reject') break
      }
    } catch (e) {
      labels.push('msgsec_error')
      verdict = stricter(verdict, 'review')
    }
  }
  return { verdict, hits: hits.map(({ category, word }) => ({ category, word })), labels }
}

/**
 * 写机审 / 人工处理日志（不记原文）。entry：{ kind: 'machine' | 'manual', scene?, verdict?, categories?, labels?, action?, targetType?, targetId?,
 * contentType?, actor?（处理人 accountId，机审为 'system'）, subject?（被处理用户 accountId）, days?, note? }
 */
async function logModeration(db, entry, now) {
  const doc = { ...entry, createdAt: now, expireAt: new Date(now + MOD_LOG_TTL_MS) }
  await withCollection(db, MOD_LOG_COLLECTION, () => db.collection(MOD_LOG_COLLECTION).add(doc))
}

module.exports = { checkText, logModeration, MODERATION_SCENES: SCENES, MODERATION_VERDICTS: VERDICTS, MOD_LOG_COLLECTION }
