'use strict'
/**
 * 测试用「演示业务」：starter 的 owned.js / settings.js 登记表为空，这里登记两类典型业务集合与几项设置，
 * 用来覆盖账号合并 / 注销 / 设置补齐的全部分支。真实业务落地后可直接改用真实登记项。
 *   favorites：{ _openid, itemId, createdAt }          合并按 itemId 去重，保留主账号那条
 *   records：  { _openid, itemId, tag, updatedAt }     合并按 itemId 取 updatedAt 较新的一条
 *   设置：fontScale（normal/large/xlarge）、theme（light/dark）、dailyGoal（20/30/45，默认 30）
 *
 * 注意：user 函数运行时用的是同步到 cloudfunctions/user/_shared 的副本（独立模块实例），两份都要登记。
 */
const path = require('node:path')

const SHARED_PATHS = [
  path.resolve(__dirname, '../../cloudfunctions/_shared'),
  path.resolve(__dirname, '../../cloudfunctions/user/_shared'),
]

const DEMO_SETTINGS_SCHEMA = {
  fontScale: { type: 'enum', values: ['normal', 'large', 'xlarge'], optional: true },
  theme: { type: 'enum', values: ['light', 'dark'], optional: true },
  dailyGoal: { type: 'enum', values: [20, 30, 45], optional: true },
}
const DEMO_DEFAULT_SETTINGS = { dailyGoal: 30 }
const DEMO_UNIQUE = { favorites: [['_openid', 'itemId']], records: [['_openid', 'itemId']] }

function registerDemoBusiness() {
  for (const p of SHARED_PATHS) {
    let S
    try {
      S = require(p)
    } catch (e) {
      continue // 副本未同步（未跑 scripts/sync-shared.mjs）时跳过；npm run test:functions 会先同步
    }
    S.resetOwnedCollections()
    S.registerOwnedCollection({ name: 'favorites', key: 'itemId', keep: 'primary' })
    S.registerOwnedCollection({ name: 'records', key: 'itemId', keep: 'newer' })
    for (const k of Object.keys(S.SETTINGS_SCHEMA)) delete S.SETTINGS_SCHEMA[k]
    Object.assign(S.SETTINGS_SCHEMA, DEMO_SETTINGS_SCHEMA)
    for (const k of Object.keys(S.DEFAULT_SETTINGS)) delete S.DEFAULT_SETTINGS[k]
    Object.assign(S.DEFAULT_SETTINGS, DEMO_DEFAULT_SETTINGS)
  }
}

/** 恢复默认登记（collections.js 的结灵子业务集合；设置项为空），测真实行为时用 */
function resetDemoBusiness() {
  for (const p of SHARED_PATHS) {
    let S
    try {
      S = require(p)
    } catch (e) {
      continue
    }
    S.restoreOwnedCollections()
    for (const k of Object.keys(S.SETTINGS_SCHEMA)) delete S.SETTINGS_SCHEMA[k]
    for (const k of Object.keys(S.DEFAULT_SETTINGS)) delete S.DEFAULT_SETTINGS[k]
  }
}

/** 业务云函数的身份解析（与 user 函数同一账号层；autoCreate 与普通业务动作一致） */
async function accountOf(db, info) {
  const S = require(SHARED_PATHS[0])
  const { identity } = await S.resolveCaller({ auth: { getUserInfo: () => info }, context: {}, db, event: { action: 'demo' } })
  return identity.openid
}

async function addFavorite(db, info, itemId, createdAt = 1) {
  const owner = await accountOf(db, info)
  await db.collection('favorites').add({ _openid: owner, itemId, createdAt })
}

async function saveRecord(db, info, itemId, tag, updatedAt) {
  const owner = await accountOf(db, info)
  const found = (db.store.records || []).find((r) => r._openid === owner && r.itemId === itemId)
  if (found) {
    found.tag = tag
    found.updatedAt = updatedAt
  } else {
    await db.collection('records').add({ _openid: owner, itemId, tag, updatedAt })
  }
}

async function favoriteIds(db, info) {
  const owner = await accountOf(db, info)
  return (db.store.favorites || []).filter((f) => f._openid === owner).map((f) => f.itemId).sort()
}

module.exports = {
  registerDemoBusiness, resetDemoBusiness, accountOf, addFavorite, saveRecord, favoriteIds,
  DEMO_SETTINGS_SCHEMA, DEMO_DEFAULT_SETTINGS, DEMO_UNIQUE,
}
