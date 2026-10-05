/**
 * 本地脚本用的自定义登录票据签发（与 cloudfunctions/user/custom-login.js 同一套解析规则，这里不依赖 _shared，可直接 import）。
 * 私钥来源（任选其一，值可为原文或 base64）：
 *   CLOUDBASE_CUSTOM_LOGIN_JSON / TCB_CUSTOM_LOGIN_JSON      控制台下载的私钥 JSON（含 private_key_id、private_key、env_id）
 *   …_JSON 只含 PEM 时另需 CLOUDBASE_CUSTOM_LOGIN_KEY_ID / TCB_CUSTOM_LOGIN_KEY_ID（控制台显示的私钥 ID）
 * 票据由 @cloudbase/node-sdk（根目录依赖）生成，格式 `${private_key_id}/@@/${RS256 JWT}`。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function clean(v) {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return !s || s.startsWith('{{') ? null : s
}

function tryJson(text) {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

function tryBase64(text) {
  try {
    return Buffer.from(text, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

/** 手抄的 PEM 常带字面量 \\n；统一还原为换行 */
export function normalizePem(pem) {
  return String(pem).replace(/\\n/g, '\n').replace(/\r\n?/g, '\n').trim()
}

/** @returns {{ private_key_id: string, private_key: string, env_id?: string } | null} 以及缺什么的提示 */
export function loadCustomLoginCredentials(env) {
  const raw = clean(env.CLOUDBASE_CUSTOM_LOGIN_JSON) || clean(env.TCB_CUSTOM_LOGIN_JSON)
  const keyId = clean(env.CLOUDBASE_CUSTOM_LOGIN_KEY_ID) || clean(env.TCB_CUSTOM_LOGIN_KEY_ID)
  if (!raw) return { credentials: null, reason: '.env 缺少 CLOUDBASE_CUSTOM_LOGIN_JSON（控制台 → 身份认证 → 登录方式 → 自定义登录 → 下载私钥）' }
  const candidates = [raw, tryBase64(raw)]
  for (const text of candidates) {
    const obj = tryJson(text)
    if (obj && typeof obj.private_key === 'string') {
      const id = typeof obj.private_key_id === 'string' && obj.private_key_id ? obj.private_key_id : keyId
      if (!id) return { credentials: null, reason: '私钥 JSON 缺少 private_key_id，请在 .env 增加 CLOUDBASE_CUSTOM_LOGIN_KEY_ID' }
      return { credentials: { private_key_id: id, private_key: normalizePem(obj.private_key), env_id: typeof obj.env_id === 'string' ? obj.env_id : undefined }, reason: null }
    }
  }
  for (const text of candidates) {
    if (text.includes('-----BEGIN')) {
      if (keyId) return { credentials: { private_key_id: keyId, private_key: normalizePem(text) }, reason: null }
      return { credentials: null, reason: 'CLOUDBASE_CUSTOM_LOGIN_JSON 只是 PEM 私钥：请在 .env 增加 CLOUDBASE_CUSTOM_LOGIN_KEY_ID=<控制台显示的私钥 ID>，或改放下载的完整 JSON 的 base64' }
    }
  }
  return { credentials: null, reason: 'CLOUDBASE_CUSTOM_LOGIN_JSON 既不是 JSON 也不是 PEM（原文或 base64）' }
}

/**
 * @param {{ envId: string, credentials: { private_key_id: string, private_key: string }, proxy?: string }} opts
 * @returns {(customUserId: string, options?: { refresh?: number, expire?: number }) => string}
 */
export function createTicketSigner({ envId, credentials, proxy }) {
  const tcb = require('@cloudbase/node-sdk')
  const app = tcb.init({ env: envId, credentials: { ...credentials, env_id: envId }, ...(proxy ? { proxy } : {}) })
  return (customUserId, options = {}) => app.auth().createTicket(customUserId, options)
}
