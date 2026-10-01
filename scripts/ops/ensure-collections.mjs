/**
 * 保证全部集合存在（BE-L01 / OPS-M0-02）：清单见 cloudfunctions/_shared/collections.js。
 * 云端实测：集合不会因 add 自动创建（DATABASE_COLLECTION_NOT_EXIST），云函数里虽有自愈（首次写入时 createCollection），
 * 新环境仍建议先跑一次本脚本，再用 scripts/ops/security-rules.mjs --apply 下发 {read:false, write:false} 规则。
 *
 *   node scripts/ops/ensure-collections.mjs            # 创建缺失的集合（幂等）
 *   node scripts/ops/ensure-collections.mjs --check    # 只检查，不创建
 *
 * 需要 .env 的 TARO_APP_CLOUD_ENV_ID、CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY；走 HTTPS_PROXY（如有）。
 * 索引仍需在控制台手动创建（云开发平台 → 数据库 → <集合> → 索引管理），清单见 docs/ops/collections.md。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
/** 全部集合（cloudfunctions/_shared/collections.js 登记表） */
export const { COLLECTION_NAMES } = require('../../cloudfunctions/_shared/collections.js')

function loadEnv() {
  const out = {}
  const f = join(ROOT, '.env')
  if (existsSync(f)) {
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
  return { ...out, ...process.env }
}

async function main() {
  const check = process.argv.includes('--check')
  const env = loadEnv()
  if (!env.TARO_APP_CLOUD_ENV_ID || !env.CLOUDBASE_SECRET_ID || !env.CLOUDBASE_SECRET_KEY) throw new Error('.env 缺少 TARO_APP_CLOUD_ENV_ID / CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY')
  const tcb = require('@cloudbase/node-sdk')
  const proxy = env.HTTPS_PROXY || env.https_proxy
  const app = tcb.init({ env: env.TARO_APP_CLOUD_ENV_ID, secretId: env.CLOUDBASE_SECRET_ID, secretKey: env.CLOUDBASE_SECRET_KEY, ...(proxy ? { proxy } : {}) })
  const db = app.database()
  const out = {}
  for (const name of COLLECTION_NAMES) {
    try {
      await db.collection(name).where({ _id: '__probe__' }).count()
      out[name] = 'exists'
    } catch (e) {
      if (!/COLLECTION_NOT_EXIST|Table not exist/i.test(`${e.code} ${e.message}`)) throw e
      if (check) {
        out[name] = 'missing'
        continue
      }
      await db.createCollection(name)
      out[name] = 'created'
    }
  }
  console.log(JSON.stringify(out))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('[ensure-collections] 失败：', e.message || e)
    process.exit(1)
  })
}
