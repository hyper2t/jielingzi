'use strict'
/**
 * 手机号规范化与哈希（PRD §8 users.phoneHash：加盐哈希，只用于唯一性校验，不存明文）。
 *
 * - 规范化：统一成 E.164 形态 "+8613800138000"。来源：小程序 getuserphonenumber 的 countryCode + purePhoneNumber；
 *   CloudBase 身份认证 /auth/v1/user/me 的 phone_number（"+86 13800138000"）。
 * - 哈希：HMAC-SHA256(PHONE_HASH_SECRET, 规范化号码) 取前 32 位十六进制（128 bit），带版本前缀 "h1:"。
 *   密钥只在云函数环境变量里；**一旦启用不可更换**（否则已存的哈希与 phone: 别名全部失效）。
 * - 别名：account_links 里 `phone:<hash>` 指向 accountId（见 account.js linkPhone），小程序与 App 的同一手机号据此识别为同一人。
 */
const { createHmac } = require('node:crypto')

const HASH_VERSION = 'h1'

/** @returns {string | null} "+<国家码><号码>"；无法识别时 null */
function normalizePhone(input, countryCode) {
  if (typeof input !== 'string' && typeof input !== 'number') return null
  const raw = String(input).trim()
  if (!raw) return null
  const digits = raw.replace(/[^\d]/g, '')
  if (!digits) return null
  if (raw.startsWith('+')) return digits.length >= 6 && digits.length <= 15 ? `+${digits}` : null
  const cc = countryCode != null && String(countryCode).replace(/[^\d]/g, '')
  if (cc) return digits.length >= 4 && cc.length + digits.length <= 15 ? `+${cc}${digits}` : null
  // 无国家码：只接受大陆 11 位手机号
  if (/^1\d{10}$/.test(digits)) return `+86${digits}`
  if (/^861\d{10}$/.test(digits)) return `+${digits}`
  return null
}

/** cloudbaserc 模板变量没被替换时值形如 "{{env.X}}"，一律当未配置 */
function cleanSecret(v) {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s || s.startsWith('{{')) return null
  return s
}

/**
 * @param {NodeJS.ProcessEnv} env 需要 PHONE_HASH_SECRET（≥ 16 位）
 * @returns {((phone: string) => string) | null} 未配置时 null（绑定手机号返回 50201；App 端照常标记实名，只是不建 phone: 别名）
 */
function createPhoneHasher(env) {
  const secret = cleanSecret(env && env.PHONE_HASH_SECRET)
  if (!secret || secret.length < 16) return null
  return function phoneHash(phone) {
    const normalized = normalizePhone(phone)
    if (!normalized) throw new Error('phoneHash: 手机号格式无法识别')
    return `${HASH_VERSION}:${createHmac('sha256', secret).update(normalized).digest('hex').slice(0, 32)}`
  }
}

module.exports = { normalizePhone, createPhoneHasher, PHONE_HASH_VERSION: HASH_VERSION }
