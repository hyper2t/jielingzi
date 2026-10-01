/**
 * 设置审核员 / 管理员（BE-M2-05，PRD S3「审核后台（管理员白名单）」）：users.role 只能由本脚本修改，前端没有任何入口。
 *
 *   node scripts/ops/set-role.mjs --list                                    # 列出现有 mod / admin（只读）
 *   node scripts/ops/set-role.mjs --account <accountId> --role mod           # 预览（默认不写）
 *   node scripts/ops/set-role.mjs --phone 13800138000 --role mod --apply      # 按已验证手机号定位并写入
 *   node scripts/ops/set-role.mjs --account <accountId> --role user --apply   # 撤销
 *   node scripts/ops/set-role.mjs --latest --role admin [--apply]              # 最近活跃的账号（第一个管理员：先在小程序 / App 同意协议建号）
 *
 * --phone 用与云函数 user 相同的 HMAC 哈希定位 phone:<hash> 别名，需要 .env 的 PHONE_HASH_SECRET；不打印手机号。
 * 需要 .env：TARO_APP_CLOUD_ENV_ID、CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY。写入前打印旧值，便于回滚。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveEnvId } from '../lib/env-id.mjs'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const { ROLES } = require('../../cloudfunctions/_shared/config.js')
const { createPhoneHasher } = require('../../cloudfunctions/_shared/phone.js')

export function parseArgs (argv) {
  const opts = { list: false, account: null, phone: null, latest: false, role: null, apply: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--list') opts.list = true
    else if (a === '--apply') opts.apply = true
    else if (a === '--latest') opts.latest = true
    else if (a === '--account') opts.account = argv[++i] || null
    else if (a === '--phone') opts.phone = argv[++i] || null
    else if (a === '--role') opts.role = argv[++i] || null
    else throw new Error(`未知参数：${a}`)
  }
  if (opts.list) return opts
  if ([opts.account, opts.phone, opts.latest].filter(Boolean).length !== 1) throw new Error('需要且只能指定 --account、--phone、--latest 之一')
  if (!ROLES.includes(opts.role)) throw new Error(`--role 只能是 ${ROLES.join(' / ')}`)
  if (opts.phone && !/^1\d{10}$/.test(opts.phone.replace(/\D/g, ''))) throw new Error('--phone 需为 11 位大陆手机号')
  return opts
}

/** accountId：直接给定，或按手机号哈希查 phone:<hash> 别名 */
export async function resolveAccountId ({ account, phone }, { hasher, getLink }) {
  if (account) return account
  if (!hasher) throw new Error('按手机号定位需要 .env 的 PHONE_HASH_SECRET（与云函数 user 相同）')
  const link = await getLink(`phone:${hasher(phone)}`)
  if (!link || !link.accountId) throw new Error('该手机号没有绑定任何账号（需先在小程序 / App 完成手机号验证）')
  return link.accountId
}

export function planRole (user, role) {
  if (!user) throw new Error('账号不存在（users 中没有该 accountId）')
  const from = ROLES.includes(user.role) ? user.role : 'user'
  return { from, to: role, changed: from !== role }
}

function loadEnv () {
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

const first = (res) => (res && res.data && res.data[0]) || null
/** 账号标识只显示首尾 */
export const maskId = (s) => (typeof s === 'string' && s.length > 10 ? `${s.slice(0, 6)}…${s.slice(-4)}` : String(s))

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  const env = loadEnv()
  if (!env.CLOUDBASE_SECRET_ID || !env.CLOUDBASE_SECRET_KEY) throw new Error('.env 缺少 CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY')
  const rc = JSON.parse(readFileSync(join(ROOT, 'cloudbaserc.json'), 'utf8'))
  const tcb = require('@cloudbase/node-sdk')
  const db = tcb.init({ env: resolveEnvId(rc.envId, env), secretId: env.CLOUDBASE_SECRET_ID, secretKey: env.CLOUDBASE_SECRET_KEY }).database()
  if (opts.list) {
    const res = await db.collection('users').where({ role: db.command.in(['mod', 'admin']) }).limit(100).get()
    for (const u of res.data || []) console.log(`${u.role}\t${u._openid}`)
    console.log(`共 ${(res.data || []).length} 个`)
    return
  }
  let accountId
  let user
  if (opts.latest) {
    user = first(await db.collection('users').orderBy('lastActiveAt', 'desc').limit(1).get())
    if (!user) throw new Error('云端还没有用户：请先在小程序 / App 里「同意并开始」（会自动建号）后再试')
    accountId = user._openid
    const at = user.lastActiveAt ? new Date(user.lastActiveAt + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '未知'
    console.log(`最近活跃：${maskId(accountId)}（平台 ${user.lastLoginPlatform || '未知'}，北京时间 ${at}）`)
  } else {
    accountId = await resolveAccountId(opts, {
      hasher: createPhoneHasher(env),
      getLink: async (id) => first(await db.collection('account_links').doc(id).get())
    })
    user = first(await db.collection('users').where({ _openid: accountId }).limit(1).get())
  }
  const plan = planRole(user, opts.role)
  console.log(`账号 ${maskId(accountId)}：${plan.from} → ${plan.to}${plan.changed ? '' : '（无变化）'}`)
  if (!plan.changed) return
  if (!opts.apply) {
    console.log('预览模式：加 --apply 写入')
    return
  }
  await db.collection('users').doc(user._id).update({ role: opts.role, roleUpdatedAt: Date.now() })
  console.log('已写入')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('[set-role] 失败：', e.message || e)
    process.exit(1)
  })
}
