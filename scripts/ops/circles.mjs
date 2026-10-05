/**
 * 官方圈子运维（OPS-M4-01，docs/prd/m4-plan.md §8）。**默认只预览，加 --apply 才写库**；所有写入都幂等（可重复执行）。
 *
 *   node scripts/ops/circles.mjs seed [--apply]                                        # 按 circles.seed.json 按 slug upsert 官方圈子
 *   node scripts/ops/circles.mjs grant --circle mindful (--account <id> | --phone <号> | --latest) [--apply]   # 直接让某人入圈（第一批成员）
 *   node scripts/ops/circles.mjs issue --circle mindful --count 5 [--ttl-days 7] [--apply]                   # 签发官方邀请码（不占名额；只在终端显示一次）
 *   node scripts/ops/circles.mjs audit                                                  # 只读：旧话题数、各圈子计数偏差、名额异常、邀请码概况
 *   node scripts/ops/circles.mjs migrate-topics --to mindful [--apply]                  # 把没有圈子的旧话题与回复归到某圈子
 *   node scripts/ops/circles.mjs recount [--apply]                                      # 按明细重算 memberCount / topicCount
 *
 * 需要 .env：CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY（--phone 另需 PHONE_HASH_SECRET）。账号标识只显示首尾，不打印手机号。
 * 上线顺序见 docs/prd/m4-plan.md §11：audit → seed → 部署 → grant / issue。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { first, maskId, openDb, resolveTarget, runMain } from '../lib/ops-db.mjs'
const require = createRequire(import.meta.url)
const { CIRCLE_RULES, INVITE_RULES } = require('../../cloudfunctions/_shared/config.js')
const { isCollectionMissingError, isDuplicateKeyError } = require('../../cloudfunctions/_shared/db.js')
const { generateInviteCode } = require('../../cloudfunctions/_shared/invite-code.js')
const HERE = dirname(fileURLToPath(import.meta.url))
const DAY = 24 * 3600 * 1000
const COMMANDS = ['seed', 'grant', 'issue', 'audit', 'migrate-topics', 'recount']
const SLUG_RE = /^[a-z][a-z0-9-]{1,31}$/
const len = (s) => Array.from(String(s)).length

export function parseArgs (argv) {
  const [cmd, ...rest] = argv
  if (!COMMANDS.includes(cmd)) throw new Error(`用法：circles.mjs <${COMMANDS.join(' | ')}> [参数]`)
  const opts = { cmd, circle: null, account: null, phone: null, latest: false, count: null, ttlDays: INVITE_RULES.ttlDays, to: null, apply: false }
  const intArg = (name, v) => {
    if (!/^\d+$/.test(String(v))) throw new Error(`${name} 需为正整数`)
    return Number(v)
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--apply') opts.apply = true
    else if (a === '--latest') opts.latest = true
    else if (a === '--circle') opts.circle = rest[++i] || null
    else if (a === '--account') opts.account = rest[++i] || null
    else if (a === '--phone') opts.phone = rest[++i] || null
    else if (a === '--count') opts.count = intArg('--count', rest[++i])
    else if (a === '--ttl-days') opts.ttlDays = intArg('--ttl-days', rest[++i])
    else if (a === '--to') opts.to = rest[++i] || null
    else throw new Error(`未知参数：${a}`)
  }
  if (cmd === 'grant') {
    if (!opts.circle) throw new Error('grant 需要 --circle <slug>')
    if ([opts.account, opts.phone, opts.latest].filter(Boolean).length !== 1) throw new Error('需要且只能指定 --account、--phone、--latest 之一')
    if (opts.phone && !/^1\d{10}$/.test(opts.phone.replace(/\D/g, ''))) throw new Error('--phone 需为 11 位大陆手机号')
  }
  if (cmd === 'issue') {
    if (!opts.circle) throw new Error('issue 需要 --circle <slug>')
    if (!opts.count || opts.count > 100) throw new Error('--count 需为 1–100')
    if (opts.ttlDays < 1 || opts.ttlDays > 30) throw new Error('--ttl-days 需为 1–30')
  }
  if (cmd === 'migrate-topics' && !opts.to) throw new Error('migrate-topics 需要 --to <slug>')
  return opts
}

// ---------- 读取辅助（集合不存在当作空） ----------
async function rows (query) {
  try {
    return ((await query.get()) || {}).data || []
  } catch (e) {
    if (isCollectionMissingError(e)) return []
    throw e
  }
}
async function total (query) {
  try {
    return ((await query.count()) || {}).total || 0
  } catch (e) {
    if (isCollectionMissingError(e)) return 0
    throw e
  }
}
async function addDoc (db, name, doc) {
  try {
    return await db.collection(name).add(doc)
  } catch (e) {
    if (!isCollectionMissingError(e)) throw e
    await db.createCollection(name)
    return db.collection(name).add(doc)
  }
}
export async function findCircle (db, slug) {
  const c = first({ data: await rows(db.collection('circles').where({ slug }).limit(1)) })
  if (!c) throw new Error(`圈子 ${slug} 不存在（先执行 circles.mjs seed --apply）`)
  return c
}

// ---------- seed ----------
export function loadSeed (file = join(HERE, 'circles.seed.json')) {
  return validateSeed(JSON.parse(readFileSync(file, 'utf8')).circles)
}
/** 种子校验：slug 格式 / 唯一，名称、简介、公约长度与条数（与 CIRCLE_RULES 一致），cover 只能是 circle:<slug> */
export function validateSeed (list) {
  if (!Array.isArray(list) || !list.length) throw new Error('种子里没有圈子')
  const seen = new Set()
  for (const c of list) {
    const at = `圈子 ${c && c.slug}`
    if (!c || !SLUG_RE.test(c.slug)) throw new Error(`${at}：slug 需为小写字母开头的 2–32 位（小写字母 / 数字 / -）`)
    if (seen.has(c.slug)) throw new Error(`${at}：slug 重复`)
    seen.add(c.slug)
    if (typeof c.name !== 'string' || !c.name.trim() || len(c.name) > CIRCLE_RULES.nameMax) throw new Error(`${at}：name 需为 1–${CIRCLE_RULES.nameMax} 字`)
    if (typeof c.desc !== 'string' || !c.desc.trim() || len(c.desc) > CIRCLE_RULES.descMax) throw new Error(`${at}：desc 需为 1–${CIRCLE_RULES.descMax} 字`)
    if (!Array.isArray(c.rules) || c.rules.length > CIRCLE_RULES.rulesMax) throw new Error(`${at}：rules 最多 ${CIRCLE_RULES.rulesMax} 条`)
    for (const r of c.rules) if (typeof r !== 'string' || !r.trim() || len(r) > CIRCLE_RULES.ruleMax) throw new Error(`${at}：每条公约需为 1–${CIRCLE_RULES.ruleMax} 字`)
    if (!Number.isInteger(c.sort)) throw new Error(`${at}：sort 需为整数`)
    if (c.cover !== null && c.cover !== `circle:${c.slug}`) throw new Error(`${at}：cover 只能是 null 或 circle:${c.slug}`)
  }
  return list
}
const SEED_FIELDS = ['name', 'desc', 'cover', 'rules', 'sort']
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
export async function seedCircles (db, list, { apply = false, now = Date.now() } = {}) {
  const plan = []
  for (const c of list) {
    const cur = first({ data: await rows(db.collection('circles').where({ slug: c.slug }).limit(1)) })
    if (!cur) {
      plan.push({ slug: c.slug, action: 'create', fields: SEED_FIELDS })
      if (apply) await addDoc(db, 'circles', { slug: c.slug, ...Object.fromEntries(SEED_FIELDS.map((f) => [f, c[f]])), status: 'open', memberCount: 0, topicCount: 0, createdAt: now })
      continue
    }
    const fields = SEED_FIELDS.filter((f) => !same(cur[f], c[f]))
    plan.push({ slug: c.slug, action: fields.length ? 'update' : 'same', fields })
    if (apply && fields.length) await db.collection('circles').doc(cur._id).update({ ...Object.fromEntries(fields.map((f) => [f, c[f]])), updatedAt: now })
  }
  return plan
}

// ---------- grant ----------
export async function grantMember (db, { circle: slug, accountId }, { apply = false, now = Date.now() } = {}) {
  const circle = await findCircle(db, slug)
  if (circle.status !== 'open') throw new Error(`圈子 ${slug} 已关闭`)
  const user = first({ data: await rows(db.collection('users').where({ _openid: accountId }).limit(1)) })
  if (!user) throw new Error('账号不存在（users 中没有该 accountId）')
  const exists = await total(db.collection('memberships').where({ circleId: circle._id, _openid: accountId }))
  if (exists) return { status: 'already', circle: slug }
  if (apply) {
    try {
      await addDoc(db, 'memberships', { circleId: circle._id, _openid: accountId, joinedAt: now, invitedBy: null, inviteCode: null, role: 'member' })
    } catch (e) {
      if (isDuplicateKeyError(e)) return { status: 'already', circle: slug }
      throw e
    }
    await db.collection('circles').doc(circle._id).update({ memberCount: db.command.inc(1) })
  }
  return { status: 'joined', circle: slug }
}

// ---------- issue ----------
/** 签发官方邀请码（owner = null，不占任何人名额）；预览只报数量，不生成 */
export async function issueCodes (db, { circle: slug, count, ttlDays }, { apply = false, now = Date.now(), random } = {}) {
  const circle = await findCircle(db, slug)
  if (circle.status !== 'open') throw new Error(`圈子 ${slug} 已关闭`)
  if (!apply) return { circle: slug, count, codes: [] }
  const codes = []
  for (let attempts = 0; codes.length < count; attempts++) {
    if (attempts > count + 20) throw new Error('邀请码生成失败：多次撞码')
    const code = generateInviteCode(random ? { random } : {})
    try {
      await addDoc(db, 'invites', { code, circleId: circle._id, _openid: null, official: true, createdAt: now, expiresAt: now + ttlDays * DAY, usedBy: null, usedAt: null, refunded: false })
      codes.push(code)
    } catch (e) {
      if (!isDuplicateKeyError(e)) throw e
    }
  }
  return { circle: slug, count, codes }
}
export const formatCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`

// ---------- audit / recount / migrate ----------
async function actualCounts (db, circle) {
  return {
    members: await total(db.collection('memberships').where({ circleId: circle._id })),
    topics: await total(db.collection('topics').where({ circleId: circle._id, status: 'ok' })),
  }
}
export async function auditCircles (db, { now = Date.now() } = {}) {
  const _ = db.command
  const circles = []
  for (const c of await rows(db.collection('circles').orderBy('sort', 'asc').limit(50))) {
    const actual = await actualCounts(db, c)
    circles.push({
      slug: c.slug, status: c.status,
      memberCount: c.memberCount || 0, members: actual.members,
      topicCount: c.topicCount || 0, topics: actual.topics,
      drift: (c.memberCount || 0) !== actual.members || (c.topicCount || 0) !== actual.topics,
    })
  }
  const quota = []
  for (const u of await rows(db.collection('users').where({ inviteQuota: _.exists(true) }).limit(1000))) {
    const v = u.inviteQuota
    if (!Number.isInteger(v) || v < 0) quota.push({ account: maskId(u._openid), value: v })
  }
  const invites = { active: 0, used: 0, expired: 0, officialActive: 0 }
  for (const i of await rows(db.collection('invites').limit(1000))) {
    if (i.usedBy) invites.used += 1
    else if (typeof i.expiresAt === 'number' && i.expiresAt <= now) invites.expired += 1
    else {
      invites.active += 1
      if (i.official) invites.officialActive += 1
    }
  }
  return {
    legacy: { topics: await total(db.collection('topics').where({ circleId: null })), replies: await total(db.collection('replies').where({ circleId: null })) },
    circles, quotaAnomalies: quota, invites,
  }
}
export async function recountCircles (db, { apply = false } = {}) {
  const out = []
  for (const c of await rows(db.collection('circles').limit(50))) {
    const a = await actualCounts(db, c)
    const row = { slug: c.slug, memberCount: [c.memberCount || 0, a.members], topicCount: [c.topicCount || 0, a.topics] }
    row.changed = row.memberCount[0] !== row.memberCount[1] || row.topicCount[0] !== row.topicCount[1]
    out.push(row)
    if (apply && row.changed) await db.collection('circles').doc(c._id).update({ memberCount: a.members, topicCount: a.topics })
  }
  return out
}
/** 把 circleId 为空的话题与回复归到指定圈子（D11）；循环更新直到没有剩余 */
export async function migrateTopics (db, { to }, { apply = false } = {}) {
  const circle = await findCircle(db, to)
  const plan = { to, topics: await total(db.collection('topics').where({ circleId: null })), replies: await total(db.collection('replies').where({ circleId: null })) }
  if (!apply) return plan
  for (const name of ['topics', 'replies']) {
    for (let round = 0; round < 100; round++) {
      const r = await db.collection(name).where({ circleId: null }).update({ circleId: circle._id })
      if (!r || !r.updated) break
    }
  }
  return plan
}

// ---------- 命令行 ----------
async function main () {
  const opts = parseArgs(process.argv.slice(2))
  const db = openDb()
  const note = (changed) => { if (changed && !opts.apply) console.log('预览模式：加 --apply 写入') }
  if (opts.cmd === 'seed') {
    const plan = await seedCircles(db, loadSeed(), opts)
    for (const p of plan) console.log(`${p.slug}\t${p.action}${p.fields.length && p.action === 'update' ? `（${p.fields.join(', ')}）` : ''}`)
    note(plan.some((p) => p.action !== 'same'))
  } else if (opts.cmd === 'grant') {
    const accountId = await resolveTarget(db, opts)
    const r = await grantMember(db, { circle: opts.circle, accountId }, opts)
    console.log(`账号 ${maskId(accountId)} → ${opts.circle}：${r.status === 'already' ? '已是成员（无变化）' : opts.apply ? '已加入' : '将加入'}`)
    note(r.status === 'joined')
  } else if (opts.cmd === 'issue') {
    const r = await issueCodes(db, opts, opts)
    if (!opts.apply) console.log(`将签发 ${r.count} 个官方码（${opts.circle}，${opts.ttlDays} 天有效）`)
    else {
      console.log(`已签发 ${r.codes.length} 个官方码（${opts.circle}，${opts.ttlDays} 天有效）。**下面的清单只显示这一次**：`)
      for (const c of r.codes) console.log(formatCode(c))
    }
    note(true)
  } else if (opts.cmd === 'audit') {
    const r = await auditCircles(db)
    console.log(`旧话题（无圈子）：${r.legacy.topics}，旧回复：${r.legacy.replies}${r.legacy.topics ? '  → 需要 migrate-topics，否则它们对所有人不可见' : ''}`)
    for (const c of r.circles) console.log(`${c.slug}\t${c.status}\t成员 ${c.memberCount}/${c.members}\t话题 ${c.topicCount}/${c.topics}${c.drift ? '\t← 计数有偏差，可 recount' : ''}`)
    console.log(`名额异常：${r.quotaAnomalies.length ? r.quotaAnomalies.map((q) => `${q.account}=${q.value}`).join(', ') : '无'}`)
    console.log(`邀请码：有效 ${r.invites.active}（官方 ${r.invites.officialActive}）、已用 ${r.invites.used}、过期 ${r.invites.expired}`)
    console.log('（计数列：库里记录值/按明细统计值）')
  } else if (opts.cmd === 'migrate-topics') {
    const r = await migrateTopics(db, opts, opts)
    console.log(`归入 ${r.to}：话题 ${r.topics}、回复 ${r.replies}${opts.apply ? '（已写入；建议随后执行 recount --apply）' : ''}`)
    note(r.topics + r.replies > 0)
  } else if (opts.cmd === 'recount') {
    const r = await recountCircles(db, opts)
    for (const c of r) console.log(`${c.slug}\t成员 ${c.memberCount[0]} → ${c.memberCount[1]}\t话题 ${c.topicCount[0]} → ${c.topicCount[1]}${c.changed ? '' : '（无变化）'}`)
    note(r.some((c) => c.changed))
  }
}
runMain(import.meta, 'circles', main)
