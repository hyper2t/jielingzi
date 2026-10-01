'use strict'
/**
 * community 云函数业务逻辑：练习档案 / 圈子 / 邀请 / 话题 / 回复（M1、M3、M4 填充）。契约见 docs/api/community.md。
 * 写类动作一律先调用 guardWrite(ctx, '<action>')，成功落库后 commit()（见 _shared/guard.js）。
 * ctx：{ identity, db, now, logger, envId, storage（_shared/media.js createStorage）, mp?, random?（匿名代号生成，单测注入）, moderation?（机审替身） }
 */

const { getProfile, updateProfile, setAvatar } = require('./profile')
const { createTopic, listTopics, getTopic, createReply, listReplies, deleteMine } = require('./topics')

/** 不要求身份的动作（入口据此不因副作用建号） */
const IDENTITY_FREE_ACTIONS = ['ping']

const actions = {
  /** 健康检查：部署 / 安全规则验证用，不读写数据库 */
  async ping(_params, ctx) {
    return { fn: 'community', at: ctx.now() }
  },
  /** M1 练习档案（BE-M1-04，docs/api/profile.md） */
  getProfile,
  updateProfile,
  /** BE-M2-02：上传头像登记并机审 */
  setAvatar,
  /** M3 深度话题（BE-M3-01 ~ 04，docs/api/community.md） */
  createTopic,
  listTopics,
  getTopic,
  createReply,
  listReplies,
  deleteMine,
  // TODO(M4)：圈子 / 邀请，按 docs/prd/mvp-plan.md 的任务编号逐个添加
}

module.exports = { actions, IDENTITY_FREE_ACTIONS }
