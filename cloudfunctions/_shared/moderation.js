'use strict'
/**
 * 内容机审钩子（PRD S1）。M1 先留接口、恒放行；M2（BE-M2-01）在这里接入：
 *   - 小程序 msgSecCheck v2（需 openid + scene）/ App 端无 openid 场景的替代方案（见 mvp-plan 风险表）
 *   - 自建词库：措辞禁用词、疗效承诺、站外引流（微信号 / 二维码 / 手机号正则）
 * 调用方式统一：const r = await checkText(ctx, { scene: 'profile', texts: [...] })
 *   r.verdict === 'reject' → 抛 40001「内容不符合社区公约」；'review' → 落库但 status=pending；'pass' → 正常
 * ctx.moderation 可注入替身（单测 / M2 实现），否则用这里的默认实现。
 */

/** 机审场景：资料 / 评论 / 论坛 / 社交日志（与 msgSecCheck v2 的 scene 1–4 对应） */
const SCENES = Object.freeze({ profile: 1, comment: 2, forum: 3, log: 4 })
const VERDICTS = Object.freeze(['pass', 'review', 'reject'])

/**
 * @param {{ moderation?: { checkText: Function } }} ctx
 * @param {{ scene: keyof typeof SCENES, texts: Array<string | null | undefined> }} input
 * @returns {Promise<{ verdict: 'pass' | 'review' | 'reject', reason?: string }>}
 */
async function checkText(ctx, input) {
  if (!input || !Object.prototype.hasOwnProperty.call(SCENES, input.scene)) throw new Error(`checkText: 未知 scene ${input && input.scene}`)
  const texts = (input.texts || []).filter((t) => typeof t === 'string' && t.trim() !== '')
  if (!texts.length) return { verdict: 'pass' }
  if (ctx && ctx.moderation && typeof ctx.moderation.checkText === 'function') {
    const r = await ctx.moderation.checkText({ scene: input.scene, texts })
    if (!r || !VERDICTS.includes(r.verdict)) throw new Error('checkText: 机审实现返回了未知结论')
    return r
  }
  // TODO(M2 BE-M2-01)：msgSecCheck + 词库；在此之前恒放行
  return { verdict: 'pass' }
}

module.exports = { checkText, MODERATION_SCENES: SCENES, MODERATION_VERDICTS: VERDICTS }
