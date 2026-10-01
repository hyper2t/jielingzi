'use strict'
/**
 * 调用方「原始身份」解析（账号层见 ./account.js：原始身份 → account_links → accountId）。
 * - 小程序（wx.cloud.callFunction）：openId 由平台注入；小程序绑定开放平台后 WX_UNIONID 也会注入到调用上下文。
 * - App 微信登录（自定义登录票据）：签票时 customUserId = accountId。身份认证 v2 实测：这类会话的 uid 就是 customUserId，
 *   而 TCB_CUSTOM_USER_ID 不再注入（getUserInfo().customUserId 为空、LOGINTYPE 见 raw.loginType），因此表现为 source='web'，
 *   由账号层用 acc:<uid> 链接识别（见 ./account.js resolveAccount）。
 * - App 手机号登录 / H5：只有 CloudBase uid。
 * 不信任 event 中任何客户端可控的身份字段（如 event.userInfo / event.openid）。
 *
 * 注意 Publishable Key（客户端公钥）本身也是一张 JWT：sub 固定为 'anon'、scope 'anonymous'。云函数安全规则的
 * "auth != null" 会放行它，此时 getUserInfo().uid 拿到的是字面量 'anon'——它不代表任何用户（所有拿到公钥的人共用），
 * 身份类接口必须当作「没有身份」拒绝，否则收藏 / 进度会写进一个人人可写的公共桶（BE-RN-04 实测）。
 */
const { unauthorized } = require('./errors')

const PUBLISHABLE_KEY_UID = 'anon'

/**
 * @param {{ getUserInfo: () => { openId?: string, uid?: string, customUserId?: string, appId?: string, isAnonymous?: boolean } }} auth
 * @param {any} [context] 云函数入口的 context（用于读取小程序 UNIONID）
 * @returns {{ openid: string | null, source: 'weapp' | 'custom' | 'web' | null, appId: string | null, raw: RawIdentity }}
 *   openid：原始身份键（账号层会把它替换成 accountId）；raw：各平台原始字段，供 user.login 等建立别名用
 */
function resolveIdentity(auth, context) {
  let info = {}
  try {
    info = (auth && auth.getUserInfo && auth.getUserInfo()) || {}
  } catch (e) {
    info = {}
  }
  const openId = nonEmpty(info.openId)
  const uidRaw = nonEmpty(info.uid)
  const uid = uidRaw === PUBLISHABLE_KEY_UID ? null : uidRaw
  const customUserId = nonEmpty(info.customUserId)
  const ctxEnv = readContextEnv(context)
  const raw = {
    openId,
    uid,
    customUserId,
    appId: nonEmpty(info.appId),
    unionId: nonEmpty(process.env.WX_UNIONID) || nonEmpty(ctxEnv.WX_UNIONID),
    /** 平台注入的登录方式（如 ANONYMOUS / CUSTOM / PHONE / WECHAT-PUBLIC…），仅作辅助判断，不作为身份 */
    loginType: nonEmpty(process.env.LOGINTYPE) || nonEmpty(ctxEnv.LOGINTYPE),
    isAnonymous: info.isAnonymous === true,
    publishableKey: uidRaw === PUBLISHABLE_KEY_UID,
  }
  if (openId) return { openid: openId, source: 'weapp', appId: raw.appId, raw }
  if (customUserId) return { openid: customUserId, source: 'custom', appId: null, raw }
  if (uid) return { openid: uid, source: 'web', appId: null, raw }
  return { openid: null, source: null, appId: null, raw }
}

/** 云函数 context.environment（JSON 字符串）里由平台注入的字段：WX_UNIONID（小程序绑定开放平台后）、LOGINTYPE 等 */
function readContextEnv(context) {
  try {
    let env = context && context.environment
    if (typeof env === 'string') env = JSON.parse(env)
    if (env && typeof env === 'object') return env
    return context && typeof context === 'object' ? context : {}
  } catch (e) {
    return {}
  }
}

/** 小程序绑定微信开放平台后，调用上下文里会带 WX_UNIONID（process.env 或 context.environment） */
function readUnionId(context) {
  return nonEmpty(process.env.WX_UNIONID) || nonEmpty(readContextEnv(context).WX_UNIONID)
}

/** 拿不到身份时抛 40101 */
function requireOpenid(identity) {
  if (!identity || !identity.openid) throw unauthorized('未获取到用户身份')
  return identity.openid
}

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

module.exports = { resolveIdentity, requireOpenid, readUnionId, readContextEnv, PUBLISHABLE_KEY_UID }
