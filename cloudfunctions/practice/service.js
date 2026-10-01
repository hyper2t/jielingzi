'use strict'
/**
 * practice 云函数业务逻辑：打卡 / 每日一题（M5、M6 填充）。契约见 docs/api/practice.md。
 * 写类动作一律先调用 guardWrite(ctx, '<action>')，成功落库后 commit()（见 _shared/guard.js）。
 * ctx：{ identity, db, now, logger }
 */

/** 不要求身份的动作（入口据此不因副作用建号） */
const IDENTITY_FREE_ACTIONS = ['ping']

const actions = {
  /** 健康检查：部署 / 安全规则验证用，不读写数据库 */
  async ping(_params, ctx) {
    return { fn: 'practice', at: ctx.now() }
  },
  // TODO(M*)：按 docs/prd/mvp-plan.md 的任务编号逐个添加
}

module.exports = { actions, IDENTITY_FREE_ACTIONS }
