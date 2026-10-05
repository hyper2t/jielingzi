'use strict'
/**
 * 业务集合登记表（账号合并 / 注销的唯一依据）。
 *
 * 约定：所有「属于某个用户」的业务集合都用 `_openid` 字段承载 accountId（见 account.js 头注释）。
 * 新增这类集合时**必须**在 ./collections.js 登记 owned，否则：
 *   - 两个账号合并（绑定微信 / 手机号 / Apple 触发）时，被并入账号的数据会成为孤儿；
 *   - 注销账号（user.deleteAccount）时数据不会被删除（违反《个人信息保护法》与 App Store 5.1.1(v)）。
 *
 * 每项（字段含义见 ./collections.js 头注释）：
 *   name      集合名
 *   key       可选。合并去重键；single=true 表示每个账号只有一条
 *   keep      可选。'primary'（默认）| 'newer' | 'sum'（累加 sumFields）
 *   onDelete  可选。'remove'（默认）| 'detach'（保留内容、解除归属）
 *
 * 默认值来自 ./collections.js 的 owned 字段（新增集合请在那里登记，不要直接改这里）。
 * users / account_links / account_merges 由 account.js 单独处理。
 */
const { ownedDefs } = require('./collections')

const KEEP = ['primary', 'newer', 'sum']
const ON_DELETE = ['remove', 'detach']

function checkDef(def) {
  if (!def || typeof def.name !== 'string' || !def.name) throw new Error('registerOwnedCollection: name 必填')
  if (def.keep && !KEEP.includes(def.keep)) throw new Error(`registerOwnedCollection: keep 只能是 ${KEEP.join(' / ')}`)
  if (def.keep === 'sum' && !(Array.isArray(def.sumFields) && def.sumFields.length)) throw new Error('registerOwnedCollection: keep=sum 需要 sumFields')
  if (def.onDelete && !ON_DELETE.includes(def.onDelete)) throw new Error(`registerOwnedCollection: onDelete 只能是 ${ON_DELETE.join(' / ')}`)
  return { ...def }
}

const OWNED_COLLECTIONS = ownedDefs().map(checkDef)

/** 测试 / 业务模块初始化时登记（重复登记同名集合会覆盖） */
function registerOwnedCollection(def) {
  const d = checkDef(def)
  const i = OWNED_COLLECTIONS.findIndex((c) => c.name === d.name)
  if (i >= 0) OWNED_COLLECTIONS.splice(i, 1, d)
  else OWNED_COLLECTIONS.push(d)
}

/** 测试用：清空登记表 */
function resetOwnedCollections() {
  OWNED_COLLECTIONS.splice(0, OWNED_COLLECTIONS.length)
}

/** 测试用：恢复为 collections.js 的默认登记 */
function restoreOwnedCollections() {
  resetOwnedCollections()
  OWNED_COLLECTIONS.push(...ownedDefs().map(checkDef))
}

module.exports = { OWNED_COLLECTIONS, registerOwnedCollection, resetOwnedCollections, restoreOwnedCollections }
