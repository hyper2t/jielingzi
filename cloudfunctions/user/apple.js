'use strict'
/**
 * 通过 Apple 登录（BE-L09 / NA-L04）：校验 App 端拿到的 identityToken，得到稳定的 Apple 用户标识 sub。
 *
 * 校验项（Apple「Verifying a user」）：
 *   - JWS 头 alg = RS256，kid 在 https://appleid.apple.com/auth/keys（JWKS，进程内缓存 1 小时，kid 未命中时强制刷新一次）
 *   - 签名、iss = https://appleid.apple.com、aud = 本 App 的 Bundle ID（APPLE_BUNDLE_ID，缺省 com.jielingzi.app）
 *   - exp 未过期（容忍 60 s 时钟偏差）
 *   - nonce：客户端传原始 nonce，token 里是它的 SHA-256 十六进制（@invertase/react-native-apple-authentication 的 nonceEnabled 行为），防重放
 * 最小化采集（决策 L8）：只用 sub，不读 / 不存 email、姓名。
 *
 * 注销时撤销授权（App Store 审核指南 5.1.1(v)）：配置了 APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY（.p8，原文或 base64）时，
 * 用客户端注销前重新授权拿到的 authorizationCode 换 refresh_token 再调 /auth/revoke；未配置则 revoke 为 null（注销本身不受影响）。
 */
const { createHash, createPublicKey, createPrivateKey, sign, verify } = require('node:crypto')
const { cleanEnv } = require('./wechat')
const { unauthorized, upstream } = require('./_shared')

const ISSUER = 'https://appleid.apple.com'
const JWKS_URL = 'https://appleid.apple.com/auth/keys'
const TOKEN_URL = 'https://appleid.apple.com/auth/token'
const REVOKE_URL = 'https://appleid.apple.com/auth/revoke'
const DEFAULT_BUNDLE_ID = 'com.jielingzi.app'
const JWKS_TTL_MS = 60 * 60 * 1000
const CLOCK_SKEW_S = 60
const TIMEOUT_MS = 5000

const b64urlJson = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
const b64url = (buf) => Buffer.from(buf).toString('base64url')
const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

/** Apple 账号的 accountId（docs/mvp/prompts/rn-login.md §4.1）：'ap_' + sha1(sub) 前 24 位，满足自定义登录 customUserId 规则 */
function appleAccountId(sub) {
  return 'ap_' + createHash('sha1').update(String(sub)).digest('hex').slice(0, 24)
}

/** .p8 私钥：原文 PEM / base64 PEM / 字面量 \n 都接受 */
function normalizeP8(raw) {
  const s = cleanEnv(raw)
  if (!s) return null
  const text = s.includes('-----BEGIN') ? s : Buffer.from(s, 'base64').toString('utf8')
  if (!text.includes('-----BEGIN')) return null
  return text.replace(/\\n/g, '\n').replace(/\r\n?/g, '\n').trim()
}

async function fetchJson(fetchImpl, url, init) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null
  try {
    const res = await fetchImpl(url, { ...(init || {}), signal: controller ? controller.signal : undefined })
    let body = null
    try { body = await res.json() } catch (e) { body = null }
    return { status: res.status, body }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ fetchImpl?: typeof fetch, now?: () => number }} [deps]
 */
function createAppleClient(env, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch
  const now = deps.now || (() => Date.now())
  if (typeof fetchImpl !== 'function') return null
  const bundleId = cleanEnv(env.APPLE_BUNDLE_ID) || DEFAULT_BUNDLE_ID
  const teamId = cleanEnv(env.APPLE_TEAM_ID)
  const keyId = cleanEnv(env.APPLE_KEY_ID)
  const privateKey = normalizeP8(env.APPLE_PRIVATE_KEY)
  const canRevoke = !!(teamId && keyId && privateKey)

  let jwks = null
  let jwksAt = 0

  async function loadKeys(force) {
    if (!force && jwks && now() - jwksAt < JWKS_TTL_MS) return jwks
    let r
    try {
      r = await fetchJson(fetchImpl, JWKS_URL, { method: 'GET' })
    } catch (e) {
      throw upstream('Apple 登录服务暂时不可用，请稍后再试')
    }
    if (!r.body || !Array.isArray(r.body.keys)) throw upstream('Apple 登录服务响应异常')
    jwks = r.body.keys
    jwksAt = now()
    return jwks
  }

  /**
   * @param {string} identityToken
   * @param {{ nonce: string }} opts 原始 nonce
   * @returns {Promise<{ sub: string }>}
   */
  async function verifyIdentityToken(identityToken, { nonce }) {
    const invalid = () => unauthorized('Apple 登录凭证无效，请重试')
    const parts = String(identityToken || '').split('.')
    if (parts.length !== 3) throw invalid()
    let header
    let claims
    try {
      header = b64urlJson(parts[0])
      claims = b64urlJson(parts[1])
    } catch (e) {
      throw invalid()
    }
    if (!header || header.alg !== 'RS256' || !header.kid) throw invalid()

    let jwk = (await loadKeys(false)).find((k) => k.kid === header.kid)
    if (!jwk) jwk = (await loadKeys(true)).find((k) => k.kid === header.kid) // Apple 轮换密钥
    if (!jwk) throw invalid()
    let ok = false
    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' })
      ok = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))
    } catch (e) {
      ok = false
    }
    if (!ok) throw invalid()

    const nowS = Math.floor(now() / 1000)
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (claims.iss !== ISSUER || !aud.includes(bundleId)) throw invalid()
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < nowS) throw unauthorized('Apple 登录凭证已过期，请重试')
    if (typeof claims.sub !== 'string' || !claims.sub) throw invalid()
    if (!nonce || typeof claims.nonce !== 'string' || claims.nonce !== sha256Hex(nonce)) throw invalid()
    return { sub: claims.sub }
  }

  /** ES256 client_secret（Apple 要求 5 分钟～6 个月有效期，这里 5 分钟） */
  function clientSecret() {
    const iat = Math.floor(now() / 1000)
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }))
    const payload = b64url(JSON.stringify({ iss: teamId, iat, exp: iat + 300, aud: ISSUER, sub: bundleId }))
    const signature = sign('sha256', Buffer.from(`${header}.${payload}`), { key: createPrivateKey(privateKey), dsaEncoding: 'ieee-p1363' })
    return `${header}.${payload}.${b64url(signature)}`
  }

  /**
   * 注销时撤销 Apple 授权：authorizationCode → refresh_token → revoke。尽力而为，失败返回 false 不抛错。
   * @returns {Promise<boolean|null>} null = 未配置撤销所需密钥
   */
  async function revokeByAuthorizationCode(authorizationCode, logger = console) {
    if (!canRevoke) return null
    try {
      const secret = clientSecret()
      const form = (o) => new URLSearchParams(o).toString()
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
      const t = await fetchJson(fetchImpl, TOKEN_URL, {
        method: 'POST', headers, body: form({ client_id: bundleId, client_secret: secret, code: authorizationCode, grant_type: 'authorization_code' }),
      })
      const token = t.body && (t.body.refresh_token || t.body.access_token)
      if (!token) {
        logger.error(`[apple] token exchange failed status=${t.status} error=${(t.body && t.body.error) || ''}`)
        return false
      }
      const hint = t.body.refresh_token ? 'refresh_token' : 'access_token'
      const r = await fetchJson(fetchImpl, REVOKE_URL, {
        method: 'POST', headers, body: form({ client_id: bundleId, client_secret: secret, token, token_type_hint: hint }),
      })
      if (r.status !== 200) logger.error(`[apple] revoke failed status=${r.status}`)
      return r.status === 200
    } catch (e) {
      logger.error(`[apple] revoke error ${e && e.name}`)
      return false
    }
  }

  return { bundleId, canRevoke, verifyIdentityToken, revokeByAuthorizationCode }
}

module.exports = { createAppleClient, appleAccountId, normalizeP8, sha256Hex, ISSUER, JWKS_URL, TOKEN_URL, REVOKE_URL, DEFAULT_BUNDLE_ID }
