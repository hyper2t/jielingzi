'use strict'
/**
 * 云函数入口封装：action 分发 + 统一返回 + 异常兜底。
 *
 *   exports.main = createMain({
 *     actions: { login: (params, ctx) => ... },
 *     createContext: () => ({ repo, identity, now }),   // 每次调用构造
 *   })
 *
 * 入参约定（与前端 cloud.weapp.ts / cloud.h5.ts 一致）：event = { action, ...params }
 */
const { CODES, ok, fail } = require('./errors')

/** 用鸭子类型判断，避免 _shared 被复制多份时 instanceof 失效 */
const isAppError = (e) => !!e && e.name === 'AppError' && typeof e.code === 'number'

/** 平台或 SDK 注入、不属于业务参数的字段 */
const RESERVED_KEYS = ['action', 'userInfo', 'tcbContext']

function splitEvent(event) {
  const src = event && typeof event === 'object' ? event : {}
  const params = {}
  for (const [k, v] of Object.entries(src)) if (!RESERVED_KEYS.includes(k)) params[k] = v
  return { action: src.action, params }
}

/**
 * @param {{ actions: Record<string, (params: any, ctx: any) => Promise<any>>, createContext: (event: any, context: any) => any, logger?: Pick<Console, 'error'> }} opts
 */
function createMain({ actions, createContext, logger = console }) {
  return async function main(event, context) {
    const { action, params } = splitEvent(event)
    if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(actions, action)) {
      return fail(CODES.BAD_PARAM, `未知的 action：${typeof action === 'string' ? action : ''}`)
    }
    try {
      const ctx = await createContext(event, context)
      const data = await actions[action](params, ctx)
      return ok(data === undefined ? null : data)
    } catch (e) {
      if (isAppError(e)) return fail(e.code, e.message)
      // 不记录入参与身份，避免日志中出现个人信息
      logger.error(`[${action}] unexpected error`, e && e.stack ? e.stack : e)
      return fail(CODES.SERVER)
    }
  }
}

module.exports = { createMain, splitEvent, isAppError }
