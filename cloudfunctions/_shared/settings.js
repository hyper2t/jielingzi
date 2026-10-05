'use strict'
/**
 * 用户设置（users.settings）的唯一定义：user.updateSettings 的参数校验、新用户默认值、账号合并时的补齐规则都读这里。
 * starter 阶段为空：updateSettings 会以 40001「至少需要一个设置项 / 不支持的参数」拒绝所有入参。
 *
 * 新增设置项示例（validate.js 规则写法）：
 *   SETTINGS_SCHEMA.fontScale = { type: 'enum', values: ['normal', 'large'], optional: true }
 *   DEFAULT_SETTINGS.fontScale = 'normal'
 * 同步修改：前端 src/types/models.ts 的 UserSettings、docs/api/user.md。
 */
const SETTINGS_SCHEMA = {}

/** 新用户默认值（newUserDoc 会浅拷贝；不要在运行时修改） */
const DEFAULT_SETTINGS = {}

/** 合并账号时从被并入方补齐的设置键（主账号没有该键时才补） */
function mergeableSettingKeys() {
  return Object.keys(SETTINGS_SCHEMA)
}

module.exports = { SETTINGS_SCHEMA, DEFAULT_SETTINGS, mergeableSettingKeys }
