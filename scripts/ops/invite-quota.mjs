/**
 * 邀请名额运维（OPS-M4-01，PRD G3「按活跃与贡献增发」先手动）。**默认只预览，加 --apply 才写库**。
 *
 *   node scripts/ops/invite-quota.mjs --report [--month 2026-10]                         # 只读：本月有效回复榜 + 名额 + 已签发 / 已用 / 过期未退的码数
 *   node scripts/ops/invite-quota.mjs (--account <id> | --phone <号> | --latest) --add 2 [--apply]   # 补发名额；写入前打印旧值便于回滚
 *
 * 「有效回复」= 状态 ok、不少于 30 字（short = false）的回复。账号标识只显示首尾。
 */
import { createRequire } from 'node:module'
import { first, maskId, openDb, resolveTarget, runMain } from '../lib/ops-db.mjs'
const require = createRequire(import.meta.url)
const { INVITE_RULES } = require('../../cloudfunctions/_shared/config.js')
const { isCollectionMissingError } = require('../../cloudfunctions/_shared/db.js')
const CN_OFFSET = 8 * 3600e3
const PAGE = 1000
const MAX_PAGES = 20

export function parseArgs (argv) {
  const opts = { report: false, month: null, account: null, phone: null, latest: false, add: null, apply: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--report') opts.report = true
    else if (a === '--apply') opts.apply = true
    else if (a === '--latest') opts.latest = true
    else if (a === '--month') opts.month = argv[++i] || null
    else if (a === '--account') opts.account = argv[++i] || null
    else if (a === '--phone') opts.phone = argv[++i] || null
    else if (a === '--add') {
      const v = argv[++i]
      if (!/^\d+$/.test(String(v)) || Number(v) < 1 || Number(v) > 20) throw new Error('--add 需为 1–20 的整数')
      opts.add = Number(v)
    } else throw new Error(`未知参数：${a}`)
  }
  if (opts.report === (opts.add !== null)) throw new Error('需要且只能指定 --report 或 --add N 之一')
  if (opts.report) {
    if (opts.month !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(opts.month)) throw new Error('--month 格式为 YYYY-MM')
    return opts
  }
  if ([opts.account, opts.phone, opts.latest].filter(Boolean).length !== 1) throw new Error('需要且只能指定 --account、--phone、--latest 之一')
  if (opts.phone && !/^1\d{10}$/.test(opts.phone.replace(/\D/g, ''))) throw new Error('--phone 需为 11 位大陆手机号')
  return opts
}

/** 北京时间 YYYY-MM 的 [起, 止) 毫秒区间；不传取当前月 */
export function monthRange (month, now = Date.now()) {
  let y, m
  if (month) [y, m] = month.split('-').map(Number)
  else {
    const d = new Date(now + CN_OFFSET)
    y = d.getUTCFullYear()
    m = d.getUTCMonth() + 1
  }
  return { month: `${y}-${String(m).padStart(2, '0')}`, from: Date.UTC(y, m - 1, 1) - CN_OFFSET, to: Date.UTC(y, m, 1) - CN_OFFSET }
}

/** 名额写入计划：未初始化的按初始名额起算（与云函数懒初始化一致） */
export function planQuota (user, add) {
  if (!user) throw new Error('账号不存在（users 中没有该 accountId）')
  const initialized = typeof user.inviteQuota === 'number'
  const from = initialized ? user.inviteQuota : INVITE_RULES.initialQuota
  return { initialized, from, to: from + add }
}

async function scan (db, name, where) {
  const out = []
  for (let page = 0; page < MAX_PAGES; page++) {
    let res
    try {
      res = await db.collection(name).where(where).skip(page * PAGE).limit(PAGE).get()
    } catch (e) {
      if (isCollectionMissingError(e)) return out
      throw e
    }
    const data = (res && res.data) || []
    out.push(...data)
    if (data.length < PAGE) break
  }
  return out
}

export async function buildReport (db, { month = null, now = Date.now() } = {}) {
  const range = monthRange(month, now)
  const _ = db.command
  const replies = await scan(db, 'replies', { status: 'ok', short: false, createdAt: _.gte(range.from) })
  const perAccount = new Map()
  for (const r of replies) {
    if (!r._openid || r.createdAt >= range.to || r.createdAt < range.from) continue
    perAccount.set(r._openid, (perAccount.get(r._openid) || 0) + 1)
  }
  const users = new Map((await scan(db, 'users', { inviteQuota: _.exists(true) })).map((u) => [u._openid, u.inviteQuota]))
  const invites = new Map()
  for (const i of await scan(db, 'invites', { official: false })) {
    const s = invites.get(i._openid) || { issued: 0, used: 0, expiredUnrefunded: 0 }
    s.issued += 1
    if (i.usedBy) s.used += 1
    else if (typeof i.expiresAt === 'number' && i.expiresAt <= now && !i.refunded) s.expiredUnrefunded += 1
    invites.set(i._openid, s)
  }
  const ids = new Set([...perAccount.keys(), ...users.keys(), ...invites.keys()])
  const rowsOut = [...ids].map((id) => ({
    account: id, replies: perAccount.get(id) || 0, quota: users.has(id) ? users.get(id) : null, ...(invites.get(id) || { issued: 0, used: 0, expiredUnrefunded: 0 }),
  }))
  rowsOut.sort((a, b) => b.replies - a.replies || b.used - a.used)
  return { month: range.month, rows: rowsOut }
}

export async function addQuota (db, accountId, add, { apply = false } = {}) {
  const user = first(await db.collection('users').where({ _openid: accountId }).limit(1).get())
  const plan = planQuota(user, add)
  if (apply) {
    const _ = db.command
    if (plan.initialized) await db.collection('users').doc(user._id).update({ inviteQuota: _.inc(add) })
    else {
      const r = await db.collection('users').where({ _id: user._id, inviteQuota: _.exists(false) }).update({ inviteQuota: plan.to })
      // 刚好被云函数懒初始化抢先：改用累加
      if (!r || r.updated !== 1) await db.collection('users').doc(user._id).update({ inviteQuota: _.inc(add) })
    }
  }
  return plan
}

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  const db = openDb()
  if (opts.report) {
    const r = await buildReport(db, opts)
    console.log(`北京时间 ${r.month}：有效回复（ok、≥ 30 字）/ 现有名额 / 已签发 / 已用 / 过期未退`)
    for (const x of r.rows.slice(0, 50)) console.log(`${maskId(x.account)}\t回复 ${x.replies}\t名额 ${x.quota === null ? '未初始化' : x.quota}\t签发 ${x.issued}\t已用 ${x.used}\t过期未退 ${x.expiredUnrefunded}`)
    console.log(`共 ${r.rows.length} 个账号${r.rows.length > 50 ? '（仅显示前 50）' : ''}`)
    return
  }
  const accountId = await resolveTarget(db, opts)
  const plan = await addQuota(db, accountId, opts.add, opts)
  console.log(`账号 ${maskId(accountId)}：名额 ${plan.initialized ? plan.from : `${plan.from}（未初始化，按初始值计）`} → ${plan.to}${opts.apply ? '（已写入）' : ''}`)
  if (!opts.apply) console.log('预览模式：加 --apply 写入')
}
runMain(import.meta, 'invite-quota', main)
