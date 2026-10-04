'use strict'
/**
 * 微信**小程序**服务端接口客户端（user：手机号快速验证 BE-M1-01；community / moderation：msgSecCheck 文本内容安全 BE-M2-01；mediaCheckAsync 见 BE-M2-02）。
 *
 * - 凭证：小程序 AppID / AppSecret（环境变量 WX_MP_APP_ID / WX_MP_APP_SECRET，经 cloudbaserc.json envVariables 注入）。
 *   注意与 WX_APP_ID / WX_APP_SECRET（微信开放平台「移动应用」，App 微信登录用）不是同一套。
 * - access_token：POST /cgi-bin/stable_token（稳定版，普通模式下重复获取返回同一个 token，平台提前 5 分钟换新）；
 *   进程内缓存到过期前 5 分钟；业务接口返回 40001 / 42001（token 失效）时强制刷新一次后重试。
 * - 手机号：POST /wxa/business/getuserphonenumber { code, openid }——code 来自小程序 <button open-type="getPhoneNumber">，
 *   一次性、5 分钟有效；传 openid 让微信校验 code 与调用者是否同一用户（防止拿别人的 code 冒绑）。
 * 没配置凭证时 createMpClient 返回 null，对应动作返回 50201「暂不可用」，其它动作不受影响。
 * 只记录 errcode，不记录手机号 / code / token。
 */
const { upstream, badParam } = require('./errors')
const { normalizePhone } = require('./phone')

const API = 'https://api.weixin.qq.com'
const TIMEOUT_MS = 5000
const EARLY_REFRESH_MS = 5 * 60 * 1000
/** access_token 失效 / 过期 */
const TOKEN_ERRCODES = [40001, 40014, 42001]
/** 手机号 code 无效（已使用 / 过期 / 不属于该用户） */
const PHONE_CODE_ERRCODES = [40029, 40163, 41008]
/** 订阅消息：用户未订阅 / 已取消 / 本次额度用完 —— 正常业务结果，不该重试 */
const SUBSCRIBE_NO_QUOTA_ERRCODES = [43101]
/** 订阅消息：模板 ID 不属于本小程序，或参数不符合模板要求 —— 配置问题 */
const SUBSCRIBE_BAD_TEMPLATE_ERRCODES = [40037, 47003]


function cleanEnv(v) {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s || s.startsWith('{{')) return null
  return s
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ fetchImpl?: typeof fetch, now?: () => number }} [opts]
 * @returns {null | { appId: string, getAccessToken: (force?: boolean) => Promise<string>, getPhoneNumber: (code: string, openid?: string | null) => Promise<string>, postJson: (path: string, body: any) => Promise<any> }}
 */
function createMpClient(env, opts = {}) {
  const appId = cleanEnv(env && env.WX_MP_APP_ID)
  const secret = cleanEnv(env && env.WX_MP_APP_SECRET)
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  const now = opts.now || (() => Date.now())
  if (!appId || !secret || typeof fetchImpl !== 'function') return null

  let cached = null // { token, expiresAt }
  let inflight = null

  async function request(url, body) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      })
      const data = await res.json()
      if (!data || typeof data !== 'object') throw new Error('bad body')
      return data
    } catch (e) {
      throw upstream('微信接口请求失败，请稍后再试')
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function fetchToken(force) {
    const body = { grant_type: 'client_credential', appid: appId, secret }
    if (force) body.force_refresh = true
    const data = await request(`${API}/cgi-bin/stable_token`, body)
    if (data.errcode || typeof data.access_token !== 'string' || !data.access_token) {
      throw upstream(`微信接口凭证获取失败（${data.errcode || 'no token'}）`)
    }
    const ttl = (Number(data.expires_in) || 7200) * 1000
    cached = { token: data.access_token, expiresAt: now() + Math.max(ttl - EARLY_REFRESH_MS, 60 * 1000) }
    return cached.token
  }

  async function getAccessToken(force = false) {
    if (!force && cached && cached.expiresAt > now()) return cached.token
    if (!force && inflight) return inflight
    const p = fetchToken(force)
    if (!force) {
      inflight = p
      p.then(() => { inflight = null }, () => { inflight = null })
    }
    return p
  }

  /** 调业务接口：token 失效时强制刷新一次重试 */
  async function postJson(path, body) {
    let data = await request(`${API}${path}?access_token=${encodeURIComponent(await getAccessToken())}`, body)
    if (TOKEN_ERRCODES.includes(data.errcode)) {
      data = await request(`${API}${path}?access_token=${encodeURIComponent(await getAccessToken(true))}`, body)
    }
    return data
  }

  /** @returns {Promise<string>} 规范化手机号（"+8613800138000"） */
  async function getPhoneNumber(code, openid) {
    const body = { code }
    if (openid) body.openid = openid
    const data = await postJson('/wxa/business/getuserphonenumber', body)
    if (PHONE_CODE_ERRCODES.includes(data.errcode)) throw badParam('手机号验证已失效，请重新获取')
    if (data.errcode) throw upstream(`手机号验证失败（${data.errcode}）`)
    const info = data.phone_info || {}
    const phone = normalizePhone(info.purePhoneNumber || info.phoneNumber, info.purePhoneNumber ? info.countryCode : null)
    if (!phone) throw upstream('微信未返回手机号')
    return phone
  }

  /**
   * 文本内容安全 v2（BE-M2-01）：POST /wxa/msg_sec_check { content, version: 2, scene, openid }。
   * 返回 { suggest: 'pass' | 'review' | 'risky', label, traceId }；openid 须是近 2 小时访问过小程序的用户。
   */
  async function msgSecCheck(content, { scene, openid }) {
    const data = await postJson('/wxa/msg_sec_check', { content, version: 2, scene, openid })
    if (data.errcode) throw upstream(`内容安全接口失败（${data.errcode}）`)
    const r = data.result || {}
    return { suggest: ['pass', 'review', 'risky'].includes(r.suggest) ? r.suggest : 'review', label: r.label != null ? r.label : null, traceId: data.trace_id || null }
  }

  /**
   * 图片异步内容安全 v2（BE-M2-02）：POST /wxa/media_check_async { media_url, media_type: 2, version: 2, scene, openid }。
   * 返回 { traceId }；结论由「消息推送」事件 wxa_media_check 推给 mediacheck 云函数。
   */
  async function mediaCheckAsync(mediaUrl, { scene, openid }) {
    const data = await postJson('/wxa/media_check_async', { media_url: mediaUrl, media_type: 2, version: 2, scene, openid })
    if (data.errcode) throw upstream(`图片安全接口失败（${data.errcode}）`)
    if (typeof data.trace_id !== 'string' || !data.trace_id) throw upstream('图片安全接口未返回 trace_id')
    return { traceId: data.trace_id }
  }

  /**
   * 一次性订阅消息发送（D14 / ★D17 的订阅通道底层件）：POST /cgi-bin/message/subscribe/send。
   * 只回结论、不抛业务错：微信侧 errcode 一律映射成 outcome，由调用方决定要不要扣额度 / 记日志；
   * 只有传输层失败（postJson 里的 upstream）才外抛，交回「提醒可以晚发」的既有口径吞掉。
   * - 'no-quota'：43101 = 用户没订阅 / 已取消 / 本次额度用完，属正常结果，重试没有意义；
   * - 'bad-template'：模板 ID 与小程序不匹配或参数不合模板要求（40037 / 47003），是配置问题，要能报警但不该影响站内提醒；
   * - 'failed'：其它 errcode（频控、系统繁忙等），本次不发，额度按调用方语义保留；
   * - data 的每一项按微信要求包成 { value }，非字符串统一转字符串、null / undefined 退化成空串。
   */
  async function subscribeMessageSend({ toUser, templateId, page = '', data = {}, miniprogramState = 'formal', lang = 'zh_CN' } = {}) {
    const toUserTrimmed = typeof toUser === 'string' ? toUser.trim() : ''
    const tpl = typeof templateId === 'string' ? templateId.trim() : ''
    if (!toUserTrimmed || !tpl) throw badParam('订阅消息缺少收件人或模板 ID')
    const body = { touser: toUserTrimmed, template_id: tpl, lang }
    if (page) body.page = page
    if (miniprogramState) body.miniprogram_state = miniprogramState
    const fields = {}
    for (const [key, value] of Object.entries(data || {})) {
      fields[key] = { value: typeof value === 'string' ? value : String(value == null ? '' : value) }
    }
    body.data = fields
    const res = await postJson('/cgi-bin/message/subscribe/send', body)
    const errcode = Number(res.errcode) || 0
    if (!errcode) return { outcome: 'sent', errcode: 0 }
    const errmsg = typeof res.errmsg === 'string' ? res.errmsg.slice(0, 64) : undefined
    if (SUBSCRIBE_NO_QUOTA_ERRCODES.includes(errcode)) return { outcome: 'no-quota', errcode }
    if (SUBSCRIBE_BAD_TEMPLATE_ERRCODES.includes(errcode)) return { outcome: 'bad-template', errcode, errmsg }
    return { outcome: 'failed', errcode, errmsg }
  }

  return { appId, getAccessToken, getPhoneNumber, msgSecCheck, mediaCheckAsync, postJson, subscribeMessageSend }
}

module.exports = { createMpClient, MP_TOKEN_ERRCODES: TOKEN_ERRCODES, MP_PHONE_CODE_ERRCODES: PHONE_CODE_ERRCODES, MP_SUBSCRIBE_NO_QUOTA_ERRCODES: SUBSCRIBE_NO_QUOTA_ERRCODES, MP_SUBSCRIBE_BAD_TEMPLATE_ERRCODES: SUBSCRIBE_BAD_TEMPLATE_ERRCODES }
