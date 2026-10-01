'use strict'
/**
 * CloudBase 身份认证 HTTP API 的最小客户端（仅 user.linkPhoneSession 用）：
 * 用「另一份会话」（或自己的手机号会话）的 access_token 调 GET /auth/v1/user/me，验证它确实是本环境签发的有效登录态，
 * 取回 sub（uid）与 phone_number（手机号会话才有，用于 phone: 别名的哈希）。
 */
const { cleanEnv } = require('./wechat')

const TIMEOUT_MS = 5000

/**
 * @param {NodeJS.ProcessEnv} env 需要 TCB_ENV（云函数运行时注入）或 SCF_NAMESPACE
 * @param {typeof fetch} [fetchImpl]
 * @returns {{ userMe: (accessToken: string) => Promise<{ sub: string, phone: string | null } | null> } | null}
 */
function createAuthApi(env, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') return null
  return {
    async userMe(accessToken) {
      const envId = cleanEnv(env.TCB_ENV) || cleanEnv(env.SCF_NAMESPACE)
      if (!envId || typeof accessToken !== 'string' || !accessToken) return null
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null
      try {
        const res = await fetchImpl(`https://${envId}.api.tcloudbasegateway.com/auth/v1/user/me`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: controller ? controller.signal : undefined,
        })
        if (res.status !== 200) return null
        const body = await res.json()
        if (!body || typeof body.sub !== 'string' || !body.sub) return null
        // 手机号会话带 phone_number（"+86 13800138000"）：只交给调用方算哈希，不落库、不记日志
        return { sub: body.sub, phone: typeof body.phone_number === 'string' && body.phone_number ? body.phone_number : null }
      } catch (e) {
        return null
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
  }
}

module.exports = { createAuthApi }
