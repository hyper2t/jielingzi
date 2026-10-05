'use strict'
/**
 * 账号层（docs/mvp/prompts/rn-login.md §4）：把各平台的原始身份映射到唯一的 accountId。
 *
 * - users 与所有业务集合的 `_openid` 字段承载 accountId，字段名不改；业务集合须在 owned.js 登记（合并 / 注销依据）。
 * - 集合 account_links：_id 即别名（"<kind>:<value>"），指向 accountId。别名种类：
 *     acc:<customUserId>   自定义登录票据的 customUserId → accountId（建号时写自指 acc:<accountId>；accountId 不满足
 *                          customUserId 规则时另写 acc:<c+sha1 前 31 位>，见 ensureCustomId；合并后重定向到主账号）
 *     mp:<小程序 openid>    小程序身份（现网老用户在下一次调用时补链接，零迁移）
 *     unionid:<unionid>    微信开放平台 unionid（App 微信登录 / 绑定微信 / 小程序绑定开放平台后的登录）
 *     wxapp:<移动应用 openid> 仅记录
 *     cbuid:<CloudBase uid> 手机号登录用户（via='phone'）；微信自定义登录用户的 CloudBase uid（via='custom'）
 *     apple:<Apple sub>    通过 Apple 登录（iOS，user.appleLogin / bindApple）
 *     phone:<hash>         已验证手机号的 HMAC 哈希（_shared/phone.js；小程序 bindPhoneWeapp / App linkPhoneSession 写入，见 linkPhone）
 *     pending:<token>      wechatAppLogin 签发的一次性关联令牌（5 分钟）
 * - accountId 取值：小程序首登 = 小程序 openid；App 微信首登 = unionid；App 手机号首登 = CloudBase uid；Apple 首登 = 'ap_' + sha1(sub) 前 24 位。
 * - 同一人出现两个账号时按 mergeAccounts 合并（owned.js 登记的业务集合按策略改归属、users 字段补齐、别名重定向、写 account_merges）。
 */
const { createHash } = require('node:crypto')
const { unauthorized, badParam, conflict } = require('./errors')
const { isDuplicateKeyError, isNotExistError, isCollectionMissingError, withCollection } = require('./db')
const { resolveIdentity } = require('./identity')
const { OWNED_COLLECTIONS } = require('./owned')
const { DEFAULT_SETTINGS, mergeableSettingKeys } = require('./settings')

const LINK_COLLECTION = 'account_links'
const MERGE_COLLECTION = 'account_merges'
const PENDING_TTL_MS = 5 * 60 * 1000
/** 单账号合并 / 删除时每个集合最多处理的文档数 */
const OWNED_LIMIT = 500
/** accountId 的通用约束（平台 openid / unionid / CloudBase uid 都满足）：1–64 位，无空白与引号 */
const ACCOUNT_ID_RE = /^[A-Za-z0-9_\-#@(){}[\]:.,<>+~]{1,64}$/
/** 自定义登录 customUserId 规则（4–32 位）：只有要签票据的账号（微信首登 = unionid，28 位）需要满足 */
const CUSTOM_ID_RE = /^[A-Za-z0-9_\-#@(){}[\]:.,<>+~]{4,32}$/

/**
 * 合并账号时 users 字段的规则（BE-M1-05）：
 *   FILL：主账号没有时从被并入方补齐（实名、18+、协议版本、邀请名额）
 *   MAX：处罚截止时间取较晚者——不能借合并账号规避封禁 / 禁言
 *   role：取较高者（能触发合并的人已经证明同时控制两个账号）
 */
const USER_FILL_FIELDS = ['phoneVerified', 'phoneHash', 'phoneVerifiedAt', 'adultConfirmedAt', 'consentVersion', 'inviteQuota']
const USER_MAX_FIELDS = ['bannedUntil', 'mutedUntil']
const ROLE_RANK = { user: 0, mod: 1, admin: 2 }
/** 能区分「不同的人」的别名种类：两个账号在同一种类上各有不同取值 → 不是同一个人 */
const PERSONAL_KINDS = ['mp', 'unionid', 'apple']

const isUnset = (v) => v === undefined || v === null || v === false

function mergeUserFields(pu, su) {
  const patch = {}
  for (const k of USER_FILL_FIELDS) if (isUnset(pu[k]) && !isUnset(su[k])) patch[k] = su[k]
  for (const k of USER_MAX_FIELDS) {
    if (typeof su[k] === 'number' && !(typeof pu[k] === 'number' && pu[k] >= su[k])) patch[k] = su[k]
  }
  if ((ROLE_RANK[su.role] || 0) > (ROLE_RANK[pu.role] || 0)) patch.role = su.role
  return patch
}

function newUserDoc(accountId, now) {
  return { _openid: accountId, createdAt: now, lastActiveAt: now, settings: { ...DEFAULT_SETTINGS } }
}

const linkId = (kind, value) => `${kind}:${value}`

function assertAccountId(id) {
  if (typeof id !== 'string' || !ACCOUNT_ID_RE.test(id)) throw badParam('账号标识格式错误')
  return id
}

/** 签自定义登录票据前检查 customUserId 规则 */
function assertCustomId(id) {
  if (typeof id !== 'string' || !CUSTOM_ID_RE.test(id)) throw badParam('账号标识不满足自定义登录规则')
  return id
}

/** 给账号一个满足自定义登录规则的 customUserId：accountId 本身合规就用它，否则用 'c' + sha1 前 31 位并写 acc: 别名 */
async function ensureCustomId(repo, { accountId, now }) {
  assertAccountId(accountId)
  if (CUSTOM_ID_RE.test(accountId)) return accountId
  const customId = 'c' + createHash('sha1').update(accountId).digest('hex').slice(0, 31)
  await repo.addLink({ _id: linkId('acc', customId), accountId, kind: 'acc', createdAt: now })
  return customId
}

function first(res) {
  return (res && res.data && res.data[0]) || null
}

function deletedCount(res) {
  return (res && (res.deleted || (res.stats && res.stats.removed))) || 0
}

function updatedCount(res) {
  return (res && (res.updated || (res.stats && res.stats.updated))) || 0
}

// ---------- 仓储 ----------

/** @param {any} db @cloudbase/node-sdk 的 database()（单测用 tests/cloudfunctions/fakeDb.js） */
function createAccountRepo(db) {
  const links = () => db.collection(LINK_COLLECTION)
  const users = () => db.collection('users')
  const col = (name) => db.collection(name)
  /** 账号层自己的集合可能还没建（云端集合不会因 add 自动创建）：读当作空，写则建集合后重试 */
  const readLinks = async (fn) => {
    try {
      return await fn()
    } catch (e) {
      if (isCollectionMissingError(e)) return null
      throw e
    }
  }
  return {
    async getLink(id) {
      try {
        return first(await readLinks(() => links().doc(id).get()))
      } catch (e) {
        if (isNotExistError(e)) return null
        throw e
      }
    },
    /** @returns {Promise<boolean>} true=新建；false=该别名已存在（调用方按需读取 getLink 判断指向） */
    async addLink(doc) {
      try {
        await withCollection(db, LINK_COLLECTION, () => links().add(doc))
        return true
      } catch (e) {
        if (isDuplicateKeyError(e)) return false
        throw e
      }
    },
    async listLinks(accountId) {
      const res = await readLinks(() => links().where({ accountId }).limit(100).get())
      return (res && res.data) || []
    },
    async retargetLinks(from, to) {
      return updatedCount(await readLinks(() => links().where({ accountId: from }).update({ accountId: to })))
    },
    async removeLink(id) {
      try {
        await readLinks(() => links().doc(id).remove())
      } catch (e) {
        if (!isNotExistError(e)) throw e
      }
    },
    async removeLinks(accountId) {
      return deletedCount(await readLinks(() => links().where({ accountId }).remove()))
    },
    async addMerge(doc) {
      await withCollection(db, MERGE_COLLECTION, () => col(MERGE_COLLECTION).add(doc))
    },

    async findUser(accountId) {
      return first(await users().where({ _openid: accountId }).limit(1).get())
    },
    /** @returns {Promise<boolean>} true=新建；false=已存在（users._openid 唯一索引） */
    async createUser(doc) {
      try {
        await users().add(doc)
        return true
      } catch (e) {
        if (isDuplicateKeyError(e)) return false
        throw e
      }
    },
    async updateUser(id, patch) {
      await users().doc(id).update(patch)
    },
    async removeUser(accountId) {
      return deletedCount(await users().where({ _openid: accountId }).remove())
    },

    /** 业务集合可能还没建：读当作空、删 / 解除归属当作 0 条（注销不能因集合缺失失败） */
    async listOwned(name, accountId, limit = OWNED_LIMIT) {
      const res = await readLinks(() => col(name).where({ _openid: accountId }).limit(limit).get())
      return (res && res.data) || []
    },
    async updateDoc(name, id, patch) {
      await col(name).doc(id).update(patch)
    },
    async setOwner(name, id, accountId) {
      await col(name).doc(id).update({ _openid: accountId })
    },
    async removeDoc(name, id) {
      await col(name).doc(id).remove()
    },
    async removeOwned(name, accountId) {
      if (!accountId) throw new Error('removeOwned 缺少 accountId')
      return deletedCount(await readLinks(() => col(name).where({ _openid: accountId }).remove()))
    },
    /** 注销时保留内容、解除归属：_openid 置为 null，authorDeleted=true（展示为"已注销用户"） */
    async detachOwned(name, accountId) {
      if (!accountId) throw new Error('detachOwned 缺少 accountId')
      return updatedCount(await readLinks(() => col(name).where({ _openid: accountId }).update({ _openid: null, authorDeleted: true })))
    },
  }
}

// ---------- 账号解析 ----------

/**
 * 原始身份 → accountId。
 * @param {{ source: string | null, raw: any }} identity resolveIdentity 的结果
 * @param {{ autoCreate?: boolean, now?: number }} [opts] autoCreate=false 时找不到链接返回 null（user.login 带 linkToken 的场景）
 * @returns {Promise<{ accountId: string | null, isNew: boolean, linkKey: string | null }>}
 */
async function resolveAccount(identity, repo, opts = {}) {
  const autoCreate = opts.autoCreate !== false
  const now = typeof opts.now === 'number' ? opts.now : Date.now()
  const raw = (identity && identity.raw) || {}
  let key = null
  let alias = null
  let accountId = null
  if (identity && identity.source === 'weapp') {
    key = linkId('mp', raw.openId)
    alias = { kind: 'mp', value: raw.openId }
    accountId = raw.openId
  } else if (identity && identity.source === 'custom') {
    key = linkId('acc', raw.customUserId)
  } else if (identity && identity.source === 'web') {
    key = linkId('cbuid', raw.uid)
    alias = { kind: 'cbuid', value: raw.uid, via: raw.isAnonymous ? 'anonymous' : 'phone' }
    accountId = raw.uid
  } else {
    return { accountId: null, isNew: false, linkKey: null }
  }

  const link = await repo.getLink(key)
  if (link) return { accountId: link.accountId, isNew: false, linkKey: key }
  // 自定义登录票据只由 wechatAppLogin 签发，签发前一定写过 acc: 链接；找不到说明账号已注销
  if (!alias) throw unauthorized('账号不存在，请重新登录')
  if (identity.source === 'web' && !raw.isAnonymous) {
    // 身份认证 v2 实测（docs/mvp/plans/rn-login-spike.md）：自定义登录会话的 uid 就是签票时的 customUserId，
    // TCB_CUSTOM_USER_ID 不注入。签票前一定写过 acc:<customUserId>，据此识别并补 cbuid 链接（via=custom）
    const acc = await repo.getLink(linkId('acc', raw.uid))
    if (acc) {
      await repo.addLink({ _id: key, accountId: acc.accountId, kind: 'cbuid', via: 'custom', createdAt: now })
      return { accountId: acc.accountId, isNew: false, linkKey: key }
    }
    // v1 形态的上下文会给 LOGINTYPE=CUSTOM；v2 的 HTTP API 会话一律是 'OAuth'（实测），所以已注销账号的旧会话在 v2 下会退化为按 uid 建号
    if (raw.loginType === 'CUSTOM') throw unauthorized('账号不存在，请重新登录')
  }
  if (!autoCreate) return { accountId: null, isNew: false, linkKey: key }
  const created = await createAccount(repo, { accountId, now, aliases: [alias] })
  return { accountId: created.accountId, isNew: created.isNew, linkKey: key }
}

/**
 * 建号：users 文档（已存在则复用，即老用户零迁移）+ acc: 自指链接 + 别名链接。
 * 并发下别名被别的请求先写入且指向不同账号时，以先写入者为准。
 */
async function createAccount(repo, { accountId, now, aliases = [] }) {
  assertAccountId(accountId)
  const isNew = await repo.createUser(newUserDoc(accountId, now))
  await repo.addLink({ _id: linkId('acc', accountId), accountId, kind: 'acc', createdAt: now })
  for (const a of aliases) {
    const doc = { _id: linkId(a.kind, a.value), accountId, kind: a.kind, createdAt: now }
    if (a.via) doc.via = a.via
    const ok = await repo.addLink(doc)
    if (!ok) {
      const existing = await repo.getLink(doc._id)
      if (existing && existing.accountId !== accountId) return { accountId: existing.accountId, isNew: false }
    }
  }
  return { accountId, isNew }
}

/**
 * 给账号增加一个别名；别名已指向其他账号时，把那个账号并入当前账号。
 * @returns {Promise<{ merged: boolean, accountId: string }>}
 */
async function linkAlias(repo, { kind, value, via, accountId, now, logger }) {
  const id = linkId(kind, value)
  const doc = { _id: id, accountId, kind, createdAt: now }
  if (via) doc.via = via
  const created = await repo.addLink(doc)
  if (created) return { merged: false, accountId }
  const existing = await repo.getLink(id)
  if (!existing || existing.accountId === accountId) return { merged: false, accountId }
  await mergeAccounts(repo, { secondary: existing.accountId, primary: accountId, now, logger, reason: kind })
  return { merged: true, accountId }
}

// ---------- 合并 / 删除 ----------

/** 按 owned.js 的策略把 secondary 名下某集合的文档并到 primary；返回改归属的条数 */
async function mergeOwned(repo, def, { secondary, primary }) {
  let moved = 0
  const mine = await repo.listOwned(def.name, secondary)
  if (!def.key && !def.single) {
    for (const d of mine) {
      await repo.setOwner(def.name, d._id, primary)
      moved++
    }
    return moved
  }
  const keep = def.keep || 'primary'
  const keyOf = def.single ? () => '__single__' : (d) => d[def.key]
  const theirs = new Map((await repo.listOwned(def.name, primary)).map((d) => [keyOf(d), d]))
  for (const d of mine) {
    const cur = theirs.get(keyOf(d))
    if (!cur) {
      await repo.setOwner(def.name, d._id, primary)
      theirs.set(keyOf(d), { ...d, _openid: primary })
      moved++
    } else if (keep === 'newer' && (d.updatedAt || 0) > (cur.updatedAt || 0)) {
      await repo.removeDoc(def.name, cur._id)
      await repo.setOwner(def.name, d._id, primary)
      theirs.set(keyOf(d), { ...d, _openid: primary })
      moved++
    } else if (keep === 'sum') {
      const patch = {}
      for (const f of def.sumFields) patch[f] = (Number(cur[f]) || 0) + (Number(d[f]) || 0)
      await repo.updateDoc(def.name, cur._id, patch)
      Object.assign(cur, patch)
      await repo.removeDoc(def.name, d._id)
    } else {
      await repo.removeDoc(def.name, d._id)
    }
  }
  return moved
}

/**
 * 把 secondary 并入 primary（docs/api/user.md「账号合并」）。可重入：中途失败重跑得到同样结果。
 * 日志只记条数，不记任何账号标识。
 * @param {{ owned?: Array<{ name: string, key?: string, keep?: 'primary' | 'newer' }> }} p owned 默认取 owned.js 登记表
 */
async function mergeAccounts(repo, { secondary, primary, now, logger = console, reason = 'manual', owned = OWNED_COLLECTIONS }) {
  if (!secondary || !primary || secondary === primary) return { merged: false, counts: null }
  const counts = { links: 0 }

  // 1. 业务集合：按登记表策略改归属
  for (const def of owned) counts[def.name] = await mergeOwned(repo, def, { secondary, primary })

  // 2. users：保留主账号文档，缺失的设置 / 同意时间用被并入方补齐
  const pu = await repo.findUser(primary)
  const su = await repo.findUser(secondary)
  if (pu) {
    const patch = { lastActiveAt: now, mergedFrom: [...(Array.isArray(pu.mergedFrom) ? pu.mergedFrom : []), secondary] }
    if (su) {
      for (const k of mergeableSettingKeys()) {
        const has = pu.settings && pu.settings[k] !== undefined
        if (!has && su.settings && su.settings[k] !== undefined) patch[`settings.${k}`] = su.settings[k]
      }
      if (typeof pu.guardianConsentAt !== 'number' && typeof su.guardianConsentAt === 'number') patch.guardianConsentAt = su.guardianConsentAt
      Object.assign(patch, mergeUserFields(pu, su))
    }
    await repo.updateUser(pu._id, patch)
  } else if (su) {
    // eslint-disable-next-line no-unused-vars
    const { _id, ...rest } = su
    await repo.createUser({ ...rest, _openid: primary, lastActiveAt: now, mergedFrom: [...(Array.isArray(su.mergedFrom) ? su.mergedFrom : []), secondary] })
  }
  if (su) await repo.removeUser(secondary)

  // 3. 别名全部改指主账号（含 acc:<secondary>，已签发给它的自定义登录会话仍能解析到主账号）
  counts.links = await repo.retargetLinks(secondary, primary)

  // 4. 审计
  await repo.addMerge({ primary, secondary, reason, counts, at: now })
  logger.info(`[merge] reason=${reason} ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  return { merged: true, counts }
}

/** 注销：owned.js 登记的业务数据按 onDelete 删除或解除归属 + 删 users + 全部别名。返回各项删除条数（{ user, links, <集合名>... }）。 */
async function deleteAccountData(repo, { accountId, logger = console, owned = OWNED_COLLECTIONS }) {
  if (!accountId) throw unauthorized('未获取到用户身份')
  const removed = {}
  for (const def of owned) {
    removed[def.name] = def.onDelete === 'detach' ? await repo.detachOwned(def.name, accountId) : await repo.removeOwned(def.name, accountId)
  }
  removed.user = await repo.removeUser(accountId)
  removed.links = await repo.removeLinks(accountId)
  logger.info(`[deleteAccount] removed ${Object.entries(removed).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  return removed
}

// ---------- 手机号别名（BE-M1-01 / BE-M1-02） ----------

/** 两个账号是否属于不同的人：同一种个人身份（小程序 openid / unionid / Apple sub）各有取值且没有交集；返回冲突的种类 */
function identityConflict(mine, theirs) {
  for (const kind of PERSONAL_KINDS) {
    const a = new Set(mine.filter((l) => l.kind === kind).map((l) => l._id))
    const b = theirs.filter((l) => l.kind === kind).map((l) => l._id)
    if (a.size && b.length && !b.some((id) => a.has(id))) return kind
  }
  return null
}

/**
 * 给账号挂已验证手机号的别名 phone:<hash>：
 * - 别名不存在 → 新建；已指向本账号 → 幂等；
 * - 已指向另一个账号：两个账号若有同种类但取值不同的个人身份（两个不同的微信 / 小程序用户 / Apple ID，可能是号码二次放号）→ 40901，
 *   否则视为同一个人（如先用 App 手机号登录、后在小程序绑定同一号码）→ 用已有合并逻辑把对方并入当前账号；
 * - previousHash：换绑新号码时，删除仍指向本账号的旧别名（号码释放）。
 * 不接触手机号明文。
 * @returns {Promise<{ merged: boolean }>}
 */
async function linkPhone(repo, { accountId, hash, previousHash = null, now, logger = console }) {
  if (!accountId || typeof hash !== 'string' || !hash) throw new Error('linkPhone 缺少 accountId / hash')
  const id = linkId('phone', hash)
  let existing = await repo.getLink(id)
  if (!existing) {
    const created = await repo.addLink({ _id: id, accountId, kind: 'phone', createdAt: now })
    if (!created) existing = await repo.getLink(id)
  }
  let merged = false
  if (existing && existing.accountId !== accountId) {
    const [mine, theirs] = await Promise.all([repo.listLinks(accountId), repo.listLinks(existing.accountId)])
    if (identityConflict(mine, theirs)) throw conflict('该手机号已绑定其他账号')
    await mergeAccounts(repo, { secondary: existing.accountId, primary: accountId, now, logger, reason: 'phone' })
    merged = true
  }
  if (previousHash && previousHash !== hash) {
    const old = await repo.getLink(linkId('phone', previousHash))
    if (old && old.accountId === accountId) await repo.removeLink(old._id)
  }
  return { merged }
}

// ---------- 一次性关联令牌（wechatAppLogin → user.login） ----------

async function createPending(repo, { accountId, token, now }) {
  const ok = await repo.addLink({ _id: linkId('pending', token), accountId, kind: 'pending', createdAt: now, expiresAt: now + PENDING_TTL_MS })
  if (!ok) throw new Error('pending token collision')
}

/** 消费令牌（无论是否过期都删除）；返回 accountId 或 null */
async function consumePending(repo, { token, now }) {
  const id = linkId('pending', token)
  const link = await repo.getLink(id)
  if (!link || link.kind !== 'pending') return null
  await repo.removeLink(id)
  if (typeof link.expiresAt === 'number' && link.expiresAt < now) return null
  return link.accountId || null
}

/** 账号与安全展示用：从别名推导已绑定的登录方式（phone：App 手机号登录 / 绑定，或小程序已验证手机号） */
function identitiesFromLinks(links) {
  const list = Array.isArray(links) ? links : []
  return {
    mp: list.some((l) => l.kind === 'mp'),
    wechat: list.some((l) => l.kind === 'unionid' || l.kind === 'wxapp' || l.kind === 'mp'),
    phone: list.some((l) => (l.kind === 'cbuid' && l.via === 'phone') || l.kind === 'phone'),
    apple: list.some((l) => l.kind === 'apple'),
  }
}

/**
 * 入口 wiring 用：原始身份 + 账号解析一步到位。
 * @param {{ auth: any, context?: any, db: any, event?: any, now?: number }} p
 * @returns {Promise<{ identity: any, accountRepo: any }>} identity.openid 已是 accountId（无身份为 null）
 */
/**
 * 云函数入口用：原始身份 → 账号。
 * @param {{ auth: any, context: any, db: any, event: any, now?: number, identityFree?: string[] }} p
 *   identityFree：不要求身份的动作（whoami / ping / wechatAppLogin…），这类调用不因副作用建号，只解析已有账号
 */
async function resolveCaller({ auth, context, db, event, now, identityFree = [] }) {
  const identity = resolveIdentity(auth, context)
  const accountRepo = createAccountRepo(db)
  const action = event && event.action
  // user.login 带 linkToken 时不自动建号：让 login 先用令牌把当前 CloudBase uid 关联到微信账号
  const linking = action === 'login' && !!event && typeof event.linkToken === 'string'
  const autoCreate = !linking && !identityFree.includes(action)
  const account = await resolveAccount(identity, accountRepo, { autoCreate, now })
  return { identity: { ...identity, openid: account.accountId, accountIsNew: account.isNew }, accountRepo }
}

module.exports = {
  LINK_COLLECTION,
  MERGE_COLLECTION,
  PENDING_TTL_MS,
  ACCOUNT_ID_RE,
  CUSTOM_ID_RE,
  newUserDoc,
  linkId,
  assertAccountId,
  assertCustomId,
  ensureCustomId,
  createAccountRepo,
  resolveAccount,
  resolveCaller,
  createAccount,
  linkAlias,
  mergeAccounts,
  mergeUserFields,
  identityConflict,
  linkPhone,
  deleteAccountData,
  createPending,
  consumePending,
  identitiesFromLinks,
}
