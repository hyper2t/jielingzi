'use strict'
/**
 * 数据访问公共件。业务逻辑（service）只依赖 repo 接口，repo 由各函数的 repo.*.js 提供，
 * 以便环境数据库选型（NoSQL / PostgreSQL，见 03-backend §1 BE-01 结论）确定后只替换 repo。
 */

let appCache = null

/** 惰性初始化 @cloudbase/node-sdk（本地单测不会触发） */
function getApp() {
  if (!appCache) {
    // eslint-disable-next-line global-require
    const tcb = require('@cloudbase/node-sdk')
    appCache = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV })
  }
  return appCache
}

const errText = (e) => `${(e && e.code) || ''} ${(e && e.message) || ''}`

/** 唯一索引冲突（并发首次写入）或自定义 _id 已存在（云端：DATABASE_REQUEST_FAILED + "E11000 duplicate key error … index: _id_"） */
function isDuplicateKeyError(e) {
  return /duplicate|E11000|DUPLICATE|already exist/i.test(errText(e))
}

/**
 * 集合不存在（云端实测：集合不会因 add 自动创建，任何读写都抛 DATABASE_COLLECTION_NOT_EXIST
 * "[ResourceNotFound] Db or Table not exist: <name>"）
 */
function isCollectionMissingError(e) {
  return /COLLECTION_NOT_EXIST|Table not exist/i.test(errText(e))
}

/** 文档不存在（node-sdk 3.x 的 doc(id).get 返回 { data: [] }、update 返回 { updated: 0 }，不抛错；此处兼容会抛错的版本） */
function isNotExistError(e) {
  return !isCollectionMissingError(e) && /not exist|NOT_EXIST|DOCUMENT_NOT_FOUND|does not exist/i.test(errText(e))
}

/**
 * 保证集合存在（幂等）：已存在时云端抛 DATABASE_COLLECTION_ALREADY_EXIST，吞掉。
 * 供写入前自愈用；集合规则由 scripts/ops/security-rules.mjs 单独下发（先于集合创建也能生效）。
 */
async function ensureCollection(db, name) {
  if (!db || typeof db.createCollection !== 'function') return false
  try {
    await db.createCollection(name)
    return true
  } catch (e) {
    if (/ALREADY_EXIST|Table exist|already exist/i.test(errText(e))) return false
    throw e
  }
}

/** 执行 fn；若因集合不存在失败，则创建集合后重试一次 */
async function withCollection(db, name, fn) {
  try {
    return await fn()
  } catch (e) {
    if (!isCollectionMissingError(e)) throw e
    await ensureCollection(db, name)
    return fn()
  }
}

function toSkip(page, size) {
  return (page - 1) * size
}

module.exports = { getApp, isDuplicateKeyError, isNotExistError, isCollectionMissingError, ensureCollection, withCollection, toSkip }
