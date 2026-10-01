/**
 * 运维脚本公共件（M4）：读 .env、连接云数据库、按 --account / --phone / --latest 定位账号。
 * 风格同 scripts/ops/set-role.mjs：需要 .env 的 TARO_APP_CLOUD_ENV_ID（或 cloudbaserc.json）、CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveEnvId } from './env-id.mjs'
import { maskId, resolveAccountId } from '../ops/set-role.mjs'
const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const { createPhoneHasher } = require('../../cloudfunctions/_shared/phone.js')
export { maskId }
export function loadEnv () {
  const out = {}
  const f = join(ROOT, '.env')
  if (existsSync(f)) {
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
  return { ...out, ...process.env }
}
export const first = (res) => (res && res.data && res.data[0]) || null
export function openDb (env = loadEnv()) {
  if (!env.CLOUDBASE_SECRET_ID || !env.CLOUDBASE_SECRET_KEY) throw new Error('.env 缺少 CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY')
  const rc = JSON.parse(readFileSync(join(ROOT, 'cloudbaserc.json'), 'utf8'))
  const tcb = require('@cloudbase/node-sdk')
  return tcb.init({ env: resolveEnvId(rc.envId, env), secretId: env.CLOUDBASE_SECRET_ID, secretKey: env.CLOUDBASE_SECRET_KEY }).database()
}
/** 定位账号：--account 直接给；--phone 查 phone:<hash> 别名；--latest 取最近活跃的账号 */
export async function resolveTarget (db, opts, env = loadEnv()) {
  let accountId
  if (opts.latest) {
    const u = first(await db.collection('users').orderBy('lastActiveAt', 'desc').limit(1).get())
    if (!u) throw new Error('云端还没有用户：请先在小程序 / App 里「同意并开始」（会自动建号）后再试')
    accountId = u._openid
    console.log(`最近活跃：${maskId(accountId)}（平台 ${u.lastLoginPlatform || '未知'}）`)
  } else {
    accountId = await resolveAccountId(opts, {
      hasher: createPhoneHasher(env),
      getLink: async (id) => first(await db.collection('account_links').doc(id).get())
    })
  }
  return accountId
}
/** 命令行入口的统一收尾 */
export function runMain (importMeta, name, main) {
  if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(importMeta.url)) {
    main().catch((e) => {
      console.error(`[${name}] 失败：`, e.message || e)
      process.exit(1)
    })
  }
}
