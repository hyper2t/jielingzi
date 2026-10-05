'use strict'
/**
 * 微信开放平台「移动应用」授权码换取 openid / unionid（docs/mvp/prompts/rn-login.md §5.2）。
 * 只调 sns/oauth2/access_token，不调 sns/userinfo（决策 L8：不采集昵称头像）；不保存微信 access_token。
 * 环境变量 WX_APP_ID / WX_APP_SECRET 由 cloudbaserc.json 的 envVariables 从 .env 注入；没配置时返回 null，
 * 对应动作返回 50201「微信登录暂不可用」。
 */
const { upstream } = require('./_shared')

const TIMEOUT_MS = 5000

/** cloudbaserc 模板变量没被替换（.env 缺该键）时值形如 "{{env.WX_APP_ID}}"，一律当未配置 */
function cleanEnv(v) {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s || s.startsWith('{{')) return null
  return s
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof fetch} [fetchImpl]
 * @returns {{ appId: string, exchangeCode: (code: string) => Promise<{ openid: string, unionid: string | null }> } | null}
 */
function createWechatClient(env, fetchImpl = globalThis.fetch) {
  const appId = cleanEnv(env.WX_APP_ID)
  const secret = cleanEnv(env.WX_APP_SECRET)
  if (!appId || !secret || typeof fetchImpl !== 'function') return null
  return {
    appId,
    async exchangeCode(code) {
      const url =
        'https://api.weixin.qq.com/sns/oauth2/access_token' +
        `?appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}` +
        `&code=${encodeURIComponent(code)}&grant_type=authorization_code`
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null
      let body
      try {
        const res = await fetchImpl(url, { method: 'GET', signal: controller ? controller.signal : undefined })
        body = await res.json()
      } catch (e) {
        throw upstream('微信接口请求失败，请稍后再试')
      } finally {
        if (timer) clearTimeout(timer)
      }
      if (!body || typeof body !== 'object') throw upstream('微信接口响应异常')
      if (body.errcode) throw upstream(`微信登录失败（${body.errcode}）`)
      if (typeof body.openid !== 'string' || !body.openid) throw upstream('微信未返回 openid')
      return { openid: body.openid, unionid: typeof body.unionid === 'string' && body.unionid ? body.unionid : null }
    },
  }
}

module.exports = { createWechatClient, cleanEnv }
