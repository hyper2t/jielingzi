'use strict'
/**
 * 练习档案（BE-M1-04，PRD P1 / P2 / §8 profiles）。契约见 docs/api/profile.md。
 *
 * - 每个账号一条（_openid = accountId）；合并保留主账号、注销删除——由 _shared/collections.js 的 owned 登记驱动（BE-M1-05）。
 * - 只返回本人档案；任何返回值都不含 _openid / _id（匿名脱敏，PRD §8.3）。
 * - anonAlias：首次写档案时生成，全站唯一（profiles.anonAlias 唯一索引 + 写前查重 + 冲突重试），之后不变。
 * - 写入链路：guardWrite(ctx, 'updateProfile', { requirePhone: false })——登录、未封禁、已确认 18+、未禁言、每日 20 次；
 *   档案不是「发布」，不要求实名（首次进入流程里「完善档案」在绑定手机号之前，PRD §7.6）。
 *   昵称 / 目标 / 介绍过机审钩子（_shared/moderation.js，M2 前恒放行）；被拒绝时不写库、不扣额度。
 * - 字数按 Unicode 码点计（emoji、生僻字算 1 个），与前端 src/features/profile/rules.ts 一致。
 */
const {
  badParam, validate, requireOpenid, guardWrite, checkText, AppError, CODES,
  TEXT_RULES, PRACTICE_IDS, PROFILE_RULES, AVATAR_PRESETS, RESERVED_NICKNAME_WORDS,
  isDuplicateKeyError, isCollectionMissingError, withCollection, logModeration, startImageCheck,
} = require('./_shared')
const { generateAlias } = require('./alias')

const COLLECTION = 'profiles'
const MAX_ALIAS_ATTEMPTS = 10
const UPDATE_KEYS = ['nickname', 'avatar', 'practices', 'years', 'goal', 'bio']
/** 控制字符、零宽字符、双向控制符（可用来伪装昵称）——一律拒绝 */
const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/
const AVATAR_RE = /^preset:([a-z0-9-]{1,32})$/

const textLength = (s) => Array.from(s).length

/** 单行文本：折叠空白、去首尾空格；拒绝不可见字符；按码点计字数 */
function cleanLine(key, label, value, { min = 0, max }) {
  if (typeof value !== 'string') throw badParam(`${label}格式错误`)
  if (INVISIBLE_RE.test(value.replace(/[\t\r\n]/g, ' '))) throw badParam(`${label}含有不支持的字符`)
  const v = value.replace(/\s+/g, ' ').trim()
  const n = textLength(v)
  if (min > 0 && n < min) throw badParam(`${label}至少 ${min} 个字`)
  if (n > max) throw badParam(`${label}最多 ${max} 个字`)
  return v
}

function cleanNickname(value) {
  const v = cleanLine('nickname', '昵称', value, TEXT_RULES.nickname)
  if (RESERVED_NICKNAME_WORDS.some((w) => v.includes(w))) throw badParam('昵称不可使用该名称')
  return v
}

function cleanAvatar(value) {
  if (value === null) return null
  const m = typeof value === 'string' ? AVATAR_RE.exec(value) : null
  if (!m || !AVATAR_PRESETS.includes(m[1])) throw badParam('请选择预置头像（自定义头像请用上传，审核通过后生效）')
  return value
}

function cleanPractices(value) {
  if (!Array.isArray(value)) throw badParam('练习方式格式错误')
  const out = []
  for (const id of value) {
    if (typeof id !== 'string' || !PRACTICE_IDS.includes(id)) throw badParam('练习方式只能从列表中选择')
    if (!out.includes(id)) out.push(id)
  }
  if (out.length > PROFILE_RULES.practicesMax) throw badParam(`练习方式最多选 ${PROFILE_RULES.practicesMax} 项`)
  return out
}

function cleanYears(value) {
  if (value === null) return null
  const { min, max } = PROFILE_RULES.years
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw badParam(`练习年限需为 ${min}–${max} 的整数`)
  return value
}

/** 只接受声明过的字段（防止夹带字段写库）；至少修改一项 */
function parseUpdate(params) {
  const src = params && typeof params === 'object' && !Array.isArray(params) ? params : {}
  const unknown = Object.keys(src).filter((k) => !UPDATE_KEYS.includes(k))
  if (unknown.length) throw badParam(`不支持的参数：${unknown.join(',')}`)
  const out = {}
  if (src.nickname !== undefined) out.nickname = cleanNickname(src.nickname)
  if (src.avatar !== undefined) out.avatar = cleanAvatar(src.avatar)
  if (src.practices !== undefined) out.practices = cleanPractices(src.practices)
  if (src.years !== undefined) out.years = cleanYears(src.years)
  if (src.goal !== undefined) out.goal = cleanLine('goal', '当前目标', src.goal, TEXT_RULES.goal)
  if (src.bio !== undefined) out.bio = cleanLine('bio', '一句话介绍', src.bio, TEXT_RULES.bio)
  if (!Object.keys(out).length) throw badParam('至少需要修改一项')
  return out
}

/** 返回给前端的档案（不含 _openid / _id） */
function present(doc) {
  return {
    nickname: typeof doc.nickname === 'string' ? doc.nickname : '',
    avatar: typeof doc.avatar === 'string' ? doc.avatar : null,
    /** 自己上传、还在审核中的头像（只有本人看得到，BE-M2-02） */
    avatarPending: typeof doc.avatarPending === 'string' ? doc.avatarPending : null,
    practices: Array.isArray(doc.practices) ? doc.practices : [],
    years: typeof doc.years === 'number' ? doc.years : null,
    goal: typeof doc.goal === 'string' ? doc.goal : '',
    bio: typeof doc.bio === 'string' ? doc.bio : '',
    anonAlias: typeof doc.anonAlias === 'string' ? doc.anonAlias : null,
    badges: Array.isArray(doc.badges) ? doc.badges : [],
    updatedAt: typeof doc.updatedAt === 'number' ? doc.updatedAt : null,
  }
}

/** 集合还没建时读当作空（云端集合不会因读写自动创建） */
async function readOne(db, where) {
  try {
    const res = await db.collection(COLLECTION).where(where).limit(1).get()
    return (res && res.data && res.data[0]) || null
  } catch (e) {
    if (isCollectionMissingError(e)) return null
    throw e
  }
}

const findProfile = (db, accountId) => readOne(db, { _openid: accountId })

/** 生成未被占用的匿名代号（写入时仍可能并发冲突，由唯一索引兜底重试） */
async function freshAlias(db, random, startAttempt) {
  for (let attempt = startAttempt; attempt < MAX_ALIAS_ATTEMPTS; attempt++) {
    const alias = generateAlias(random, attempt)
    if (!(await readOne(db, { anonAlias: alias }))) return { alias, attempt }
  }
  throw new AppError(CODES.SERVER, '生成匿名代号失败，请重试')
}

/**
 * 档案不存在则建（带唯一 anonAlias，initial 一并写入）；已存在则补齐缺失的 anonAlias。M3 发帖前也用它保证匿名代号存在。
 * @returns {Promise<{ doc: any, created: boolean }>}
 */
async function ensureProfile(ctx, accountId, now, initial = {}) {
  const db = ctx.db
  const random = typeof ctx.random === 'function' ? ctx.random : Math.random
  const existing = await findProfile(db, accountId)
  if (existing && existing.anonAlias) return { doc: existing, created: false }
  let attempt = 0
  while (attempt < MAX_ALIAS_ATTEMPTS) {
    const picked = await freshAlias(db, random, attempt)
    attempt = picked.attempt + 1
    try {
      if (existing) {
        await db.collection(COLLECTION).doc(existing._id).update({ anonAlias: picked.alias, updatedAt: now })
        return { doc: { ...existing, anonAlias: picked.alias, updatedAt: now }, created: false }
      }
      const doc = { _openid: accountId, anonAlias: picked.alias, badges: [], ...initial, createdAt: now, updatedAt: now }
      const res = await withCollection(db, COLLECTION, () => db.collection(COLLECTION).add(doc))
      return { doc: { ...doc, _id: res && (res.id || res._id) }, created: true }
    } catch (e) {
      if (!isDuplicateKeyError(e)) throw e
      // 唯一索引冲突：本账号并发首次写入（_openid）→ 用已建好的那条；否则 anonAlias 被抢占 → 换一个重试
      const again = await findProfile(db, accountId)
      if (again && again.anonAlias) return { doc: again, created: false }
    }
  }
  throw new AppError(CODES.SERVER, '生成匿名代号失败，请重试')
}

/** community.getProfile：本人档案；还没有档案时 profile 为 null（首次 updateProfile 时建档并分配匿名代号） */
async function getProfile(params, ctx) {
  validate(params, {})
  const accountId = requireOpenid(ctx.identity)
  const doc = await findProfile(ctx.db, accountId)
  return { profile: doc ? present(doc) : null }
}

/** community.updateProfile：部分更新（只传要改的字段）；返回完整档案 */
async function updateProfile(params, ctx) {
  const input = parseUpdate(params)
  const g = await guardWrite(ctx, 'updateProfile', { requirePhone: false })
  const verdict = await checkText(ctx, { scene: 'profile', texts: [input.nickname, input.goal, input.bio] })
  const now = ctx.now()
  if (verdict.verdict !== 'pass') {
    await logModeration(ctx.db, { kind: 'machine', scene: 'profile', verdict: verdict.verdict, categories: [...new Set(verdict.hits.map((h) => h.category))], labels: verdict.labels, actor: 'system', subject: g.accountId }, now)
  }
  if (verdict.verdict === 'reject') throw badParam('内容不符合社区公约，请修改后再保存')
  // review：档案只对本人可见（M3 起作者信息对他人展示前再按 pending 处理），这里只留痕待人工复核
  const { doc, created } = await ensureProfile(ctx, g.accountId, now, input)
  const patch = { ...input }
  // 改选预置 / 默认头像：作废审核中的上传（删文件）
  if (input.avatar !== undefined && doc.avatarPending) {
    patch.avatarPending = null
    if (ctx.storage) await ctx.storage.deleteFiles([doc.avatarPending]).catch(() => {})
  }
  if (!created) await ctx.db.collection(COLLECTION).doc(doc._id).update({ ...patch, updatedAt: now })
  await g.commit()
  return { profile: present({ ...doc, ...patch, updatedAt: now }) }
}

/**
 * community.setAvatar（BE-M2-02 + FE-M1-03 自定义头像）：客户端已把图片传到 uploads/avatar/ 下，这里登记并发起机审。
 * 审核通过前头像只记在 avatarPending（只有本人看得到）；通过后由 mediacheck 回调 / 人工复核写入 avatar。
 * 写入链路同 updateProfile（18+、未封禁、未禁言，不要求实名），每日上传 10 次。
 */
async function setAvatar(params, ctx) {
  const { fileID } = validate(params, { fileID: { type: 'string', minLen: 10, maxLen: 512 } })
  const g = await guardWrite(ctx, 'uploadImage', { requirePhone: false })
  const media = await startImageCheck(ctx, { fileID, purpose: 'avatar', accountId: g.accountId })
  const now = ctx.now()
  const { doc, created } = await ensureProfile(ctx, g.accountId, now, { avatarPending: fileID })
  if (!created) {
    if (doc.avatarPending && doc.avatarPending !== fileID && ctx.storage) await ctx.storage.deleteFiles([doc.avatarPending]).catch(() => {})
    await ctx.db.collection(COLLECTION).doc(doc._id).update({ avatarPending: fileID, updatedAt: now })
  }
  await g.commit()
  return { profile: present({ ...doc, avatarPending: fileID, updatedAt: now }), status: media.status }
}

module.exports = { getProfile, updateProfile, setAvatar, ensureProfile, parseUpdate, present, textLength, cleanLine, INVISIBLE_RE, PROFILE_COLLECTION: COLLECTION }
