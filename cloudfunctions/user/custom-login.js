'use strict'
/**
 * CloudBase 自定义登录票据（docs/mvp/prompts/rn-login.md §5.2）。
 * 私钥来自控制台「身份认证 → 登录方式 → 自定义登录」，通过环境变量注入（cloudbaserc.json envVariables ← .env）：
 *   TCB_CUSTOM_LOGIN_JSON    下载的私钥 JSON（原文或 base64）；也接受只含 PEM 私钥（原文或 base64），
 *   TCB_CUSTOM_LOGIN_KEY_ID  当 TCB_CUSTOM_LOGIN_JSON 只是 PEM 时必填（控制台显示的私钥 ID）
 * 票据格式由 node-sdk 生成：`${private_key_id}/@@/${RS256 JWT}`；客户端用
 *   POST /auth/v1/signin/with/provider { provider_id: 'custom', provider_token: ticket } 换会话。
 */
const { cleanEnv } = require('./wechat')

/** 登录态有效期：与 CloudBase 自身的 30 天保持一致；access_token 每小时刷新 */
const TICKET_REFRESH_MS = 60 * 60 * 1000
const TICKET_EXPIRE_MS = 30 * 24 * 60 * 60 * 1000

function tryJson(text) {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? v : null
  } catch (e) {
    return null
  }
}

function tryBase64(text) {
  try {
    return Buffer.from(text, 'base64').toString('utf8')
  } catch (e) {
    return ''
  }
}

/** 从 JSON 文件里手抄出来的 PEM 常带字面量 \\n（两个字符）而不是换行，统一还原；顺带去掉首尾空白 */
function normalizePem(pem) {
  return String(pem).replace(/\\n/g, '\n').replace(/\r\n?/g, '\n').trim()
}

/**
 * 解析私钥配置。
 * @returns {{ private_key_id: string, private_key: string, env_id?: string } | null}
 */
function loadCredentials(env) {
  const raw = cleanEnv(env.TCB_CUSTOM_LOGIN_JSON)
  if (!raw) return null
  const keyId = cleanEnv(env.TCB_CUSTOM_LOGIN_KEY_ID)
  const candidates = [raw, tryBase64(raw)]
  for (const text of candidates) {
    const obj = tryJson(text)
    if (obj && typeof obj.private_key === 'string') {
      const id = typeof obj.private_key_id === 'string' && obj.private_key_id ? obj.private_key_id : keyId
      if (!id) return null
      return { private_key_id: id, private_key: normalizePem(obj.private_key), env_id: typeof obj.env_id === 'string' ? obj.env_id : undefined }
    }
  }
  for (const text of candidates) {
    if (text.includes('-----BEGIN') && keyId) return { private_key_id: keyId, private_key: normalizePem(text) }
  }
  return null
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ init: (opts: any) => any, SYMBOL_CURRENT_ENV: symbol } | null} [sdk] @cloudbase/node-sdk（单测可注入假的）
 * @returns {{ createTicket: (accountId: string, now?: number) => string } | null}
 */
function createTicketIssuer(env, sdk) {
  const creds = loadCredentials(env)
  if (!creds) return null
  let app = null
  return {
    createTicket(accountId, now = Date.now()) {
      if (!app) {
        // eslint-disable-next-line global-require
        const tcb = sdk || require('@cloudbase/node-sdk')
        const envId = creds.env_id || cleanEnv(env.TCB_ENV) || cleanEnv(env.SCF_NAMESPACE)
        app = tcb.init({ env: envId || tcb.SYMBOL_CURRENT_ENV, credentials: { ...creds, env_id: envId } })
      }
      return app.auth().createTicket(accountId, { refresh: TICKET_REFRESH_MS, expire: now + TICKET_EXPIRE_MS })
    },
  }
}

module.exports = { loadCredentials, normalizePem, createTicketIssuer, TICKET_REFRESH_MS, TICKET_EXPIRE_MS }
