'use strict'
/**
 * 统一返回结构与错误码（03-backend §4）。
 * 所有云函数返回 { code, data, msg }；code=0 为成功。
 */

const CODES = Object.freeze({
  OK: 0,
  BAD_PARAM: 40001,
  UNAUTHORIZED: 40101,
  FORBIDDEN: 40301,
  /** 发布类动作需先绑定手机号（后台实名，PRD C4） */
  PHONE_REQUIRED: 40302,
  /** 需先确认年满 18 周岁（PRD C5） */
  ADULT_REQUIRED: 40303,
  /** 账号已封禁 */
  BANNED: 40304,
  /** 账号禁言中 */
  MUTED: 40305,
  NOT_FOUND: 40401,
  /** 账号别名冲突且未启用自动合并（预留，见 docs/mvp/prompts/rn-login.md §4.4） */
  CONFLICT: 40901,
  TOO_MANY: 42901,
  SERVER: 50000,
  /** 上游（微信开放平台 / CloudBase 认证接口）返回失败 */
  UPSTREAM: 50201,
})

const DEFAULT_MSG = Object.freeze({
  [CODES.OK]: 'ok',
  [CODES.BAD_PARAM]: '参数错误',
  [CODES.UNAUTHORIZED]: '未登录',
  [CODES.FORBIDDEN]: '无权限',
  [CODES.PHONE_REQUIRED]: '请先绑定手机号',
  [CODES.ADULT_REQUIRED]: '请先确认年满 18 周岁',
  [CODES.BANNED]: '账号已被封禁',
  [CODES.MUTED]: '账号禁言中',
  [CODES.NOT_FOUND]: '不存在',
  [CODES.CONFLICT]: '账号冲突',
  [CODES.TOO_MANY]: '请求过于频繁',
  [CODES.SERVER]: '服务异常',
  [CODES.UPSTREAM]: '第三方服务异常',
})

class AppError extends Error {
  /**
   * @param {number} code 业务错误码（CODES 之一）
   * @param {string} [msg] 可展示给前端的说明，不得包含个人信息
   */
  constructor(code, msg) {
    super(msg || DEFAULT_MSG[code] || '未知错误')
    this.name = 'AppError'
    this.code = code
  }
}

const ok = (data = null) => ({ code: CODES.OK, data, msg: 'ok' })
const fail = (code, msg) => ({ code, data: null, msg: msg || DEFAULT_MSG[code] || '未知错误' })

const badParam = (msg) => new AppError(CODES.BAD_PARAM, msg)
const notFound = (msg) => new AppError(CODES.NOT_FOUND, msg)
const unauthorized = (msg) => new AppError(CODES.UNAUTHORIZED, msg)
const forbidden = (msg) => new AppError(CODES.FORBIDDEN, msg)
const conflict = (msg) => new AppError(CODES.CONFLICT, msg)
const upstream = (msg) => new AppError(CODES.UPSTREAM, msg)
const tooMany = (msg) => new AppError(CODES.TOO_MANY, msg)

module.exports = { CODES, AppError, ok, fail, badParam, notFound, unauthorized, forbidden, conflict, upstream, tooMany }
