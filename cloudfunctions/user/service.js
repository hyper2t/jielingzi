'use strict'
/**
 * user 云函数业务逻辑（BE-07、BE-26；登录体系 BE-L02～L05，契约见 docs/api/user.md），与数据库实现无关。
 * repo 接口（users 集合）：
 *   findByOpenid(accountId) -> user | null
 *   create(doc) -> _id                    （users._openid 唯一索引冲突时抛 duplicate 错误）
 *   update(_id, patch)                    （patch 键可为点号路径，如 'settings.<key>'）
 * ctx 还需要：
 *   identity      resolveCaller 的结果：openid 已是 accountId（无身份为 null），raw 为平台原始字段，source 为 weapp/custom/web
 *   accountRepo   _shared/account.js 的仓储（account_links / 合并 / 注销）
 *   wechat        { exchangeCode(code) } 或 null（未配置 WX_APP_ID / WX_APP_SECRET）
 *   apple         apple.js createAppleClient 的结果（verifyIdentityToken / revokeByAuthorizationCode）或 null
 *   createTicket  (accountId) => ticket 或 null（未配置自定义登录私钥）
 *   authApi       { userMe(accessToken) } 或 null
 *   randomToken   () => string
 *   mp            _shared/wxmp.js createMpClient 的结果（小程序服务端接口：getPhoneNumber）或 null（未配置 WX_MP_APP_ID / WX_MP_APP_SECRET）
 *   phoneHash     _shared/phone.js createPhoneHasher 的结果 (phone) => 'h1:…' 或 null（未配置 PHONE_HASH_SECRET）
 */
const {
  validate, requireOpenid, isDuplicateKeyError, badParam, unauthorized, upstream, forbidden,
  DEFAULT_SETTINGS, SETTINGS_SCHEMA, newUserDoc, linkId, createAccount, linkAlias, linkPhone, createPending, consumePending, identitiesFromLinks, deleteAccountData, ensureCustomId,
  ROLES, CONSENT_VERSION,
} = require('./_shared')
const { appleAccountId } = require('./apple')

const PLATFORMS = ['weapp', 'app']
/** 不要求身份的动作（入口据此不因副作用建号） */
const IDENTITY_FREE_ACTIONS = ['whoami', 'wechatAppLogin', 'appleLogin']

/** 设置项的唯一定义在 _shared/settings.js（starter 为空） */
const settingsSchema = SETTINGS_SCHEMA

const loginSchema = {
  platform: { type: 'enum', values: PLATFORMS, optional: true },
  /** App 端把本机记录的同意时间上报（首登时用），服务端只在云端还没有同意时间时写入（写服务端时间） */
  consentAt: { type: 'int', min: 1, optional: true },
  consentVersion: { type: 'string', maxLen: 32, optional: true },
  /** wechatAppLogin 返回的一次性关联令牌：把当前 CloudBase uid 关联到微信账号 */
  linkToken: { type: 'string', minLen: 16, maxLen: 128, optional: true },
  /** App 端首次进入时在本机确认 18+ 的时间（登录前完成，登录时上报）；服务端只在云端还没有确认时间时写服务端时间（BE-M1-03） */
  adultConfirmedAt: { type: 'int', min: 1, optional: true },
}

/** 小程序 <button open-type="getPhoneNumber"> 回调里的 code（一次性，5 分钟有效） */
const phoneCodeSchema = {
  code: { type: 'string', minLen: 8, maxLen: 512 },
}

const codeSchema = {
  code: { type: 'string', minLen: 8, maxLen: 512 },
  state: { type: 'string', maxLen: 128, optional: true },
}

/** 通过 Apple 登录：identityToken（JWT）+ 客户端生成的原始 nonce（token 里是其 SHA-256） */
const appleSchema = {
  identityToken: { type: 'string', minLen: 20, maxLen: 4096 },
  nonce: { type: 'string', minLen: 8, maxLen: 256 },
}

function newUser(openid, now) {
  return newUserDoc(openid, now)
}

/** 取当前用户，不存在则创建；返回 { user, isNew } */
async function ensureUser(repo, openid, now) {
  const found = await repo.findByOpenid(openid)
  if (found) return { user: found, isNew: false }
  const doc = newUser(openid, now)
  try {
    const _id = await repo.create(doc)
    return { user: { _id, ...doc }, isNew: true }
  } catch (e) {
    if (!isDuplicateKeyError(e)) throw e
    // 并发首次调用：另一请求已创建
    const again = await repo.findByOpenid(openid)
    if (!again) throw e
    return { user: again, isNew: false }
  }
}

function fullSettings(user, extra) {
  return { ...DEFAULT_SETTINGS, ...((user && user.settings) || {}), ...(extra || {}) }
}

function consentAtOf(user) {
  return user && typeof user.guardianConsentAt === 'number' ? user.guardianConsentAt : null
}

function logger(ctx) {
  return ctx.logger || console
}

/**
 * 账号状态（login / whoami / confirmAdult / bindPhoneWeapp 都返回；前端据此决定 18+ / 实名拦截与处罚提示，BE-M1-03）。
 * 处罚已过期的返回 null；不含任何标识与手机号。
 */
function accountStatus(user, now) {
  const u = user || {}
  const active = (v) => (typeof v === 'number' && v > now ? v : null)
  return {
    phoneVerified: u.phoneVerified === true,
    adult: typeof u.adultConfirmedAt === 'number',
    role: ROLES.includes(u.role) ? u.role : 'user',
    bannedUntil: active(u.bannedUntil),
    mutedUntil: active(u.mutedUntil),
  }
}

// ---------- 登录 ----------

async function login(params, ctx) {
  const input = validate(params, loginSchema)
  const now = ctx.now()
  const raw = (ctx.identity && ctx.identity.raw) || {}
  let accountId = ctx.identity ? ctx.identity.openid : null
  let merged = false

  // 1. App 微信登录：用 linkToken 把当前 CloudBase uid（自定义登录用户）关联到签票时的账号
  if (input.linkToken) {
    if (!raw.uid) throw unauthorized('未获取到用户身份')
    const pendingAccount = await consumePending(ctx.accountRepo, { token: input.linkToken, now })
    if (pendingAccount) {
      const r = await linkAlias(ctx.accountRepo, { kind: 'cbuid', value: raw.uid, via: 'custom', accountId: pendingAccount, now, logger: logger(ctx) })
      merged = r.merged
      accountId = pendingAccount
    } else if (!accountId) {
      throw unauthorized('登录凭证已过期，请重新登录')
    }
  }
  if (!accountId) throw unauthorized('未获取到用户身份')

  // 2. users 文档（账号层建号时已创建；老用户 / 极端并发下兜底）
  const { user, isNew } = await ensureUser(ctx.repo, accountId, now)

  // 3. 小程序绑定开放平台后带 unionid：建立别名；unionid 已属于别的账号（先在 App 用微信登录过）则并入当前账号
  if (ctx.identity.source === 'weapp' && raw.unionId) {
    const r = await linkAlias(ctx.accountRepo, { kind: 'unionid', value: raw.unionId, accountId, now, logger: logger(ctx) })
    merged = merged || r.merged
  }

  // 4. 活跃时间、登录平台、首次上报的同意时间
  const links = await ctx.accountRepo.listLinks(accountId)
  const identities = identitiesFromLinks(links)
  const patch = {
    lastActiveAt: now,
    lastLoginAt: now,
    lastLoginPlatform: input.platform || (ctx.identity.source === 'weapp' ? 'weapp' : 'app'),
  }
  if (input.consentAt && consentAtOf(user) == null) {
    patch.guardianConsentAt = now
    if (input.consentVersion) patch.consentVersion = input.consentVersion
  }
  // 5. App 端登录前在本机确认过 18+：云端还没有确认时间时写服务端时间（BE-M1-03）
  if (input.adultConfirmedAt && typeof user.adultConfirmedAt !== 'number') {
    patch.adultConfirmedAt = now
    if (!user.consentVersion && !patch.consentVersion) patch.consentVersion = input.consentVersion || CONSENT_VERSION
  }
  // 6. 账号带手机号登录方式（App 手机号登录 / 绑定过手机号）即视为实名（BE-M1-02，PRD C4）
  if (identities.phone && user.phoneVerified !== true) {
    patch.phoneVerified = true
    patch.phoneVerifiedAt = now
  }
  await ctx.repo.update(user._id, patch)

  const fresh = (merged ? await ctx.repo.findByOpenid(accountId) : null) || { ...user, ...patch }
  return {
    openid: accountId,
    accountId,
    isNew: isNew || !!(ctx.identity && ctx.identity.accountIsNew),
    identities,
    settings: fullSettings(fresh),
    guardianConsentAt: consentAtOf(fresh),
    merged,
    ...accountStatus(fresh, now),
  }
}

/**
 * 18+ 确认（BE-M1-03，PRD A3 / C5）：首次确认写 adultConfirmedAt（服务端时间，重复确认不改），并记录当时同意的协议版本。
 * 小程序 / H5 在首次进入流程里直接调用；App 端登录前只记本机，登录时随 login.adultConfirmedAt 上报。
 */
async function confirmAdult(params, ctx) {
  const input = validate(params, { consentVersion: { type: 'string', minLen: 1, maxLen: 32, optional: true } })
  const accountId = requireOpenid(ctx.identity)
  const now = ctx.now()
  const { user } = await ensureUser(ctx.repo, accountId, now)
  const patch = { lastActiveAt: now, consentVersion: input.consentVersion || CONSENT_VERSION }
  if (typeof user.adultConfirmedAt !== 'number') patch.adultConfirmedAt = now
  await ctx.repo.update(user._id, patch)
  const fresh = { ...user, ...patch }
  return { adultConfirmedAt: fresh.adultConfirmedAt, consentVersion: fresh.consentVersion, ...accountStatus(fresh, now) }
}

async function consent(params, ctx) {
  validate(params, {})
  const openid = requireOpenid(ctx.identity)
  const now = ctx.now()
  const { user } = await ensureUser(ctx.repo, openid, now)
  await ctx.repo.update(user._id, { guardianConsentAt: now, lastActiveAt: now })
  return { guardianConsentAt: now }
}

async function updateSettings(params, ctx) {
  const input = validate(params, settingsSchema)
  if (Object.keys(input).length === 0) throw badParam('至少需要一个设置项')
  const openid = requireOpenid(ctx.identity)
  const now = ctx.now()
  const { user } = await ensureUser(ctx.repo, openid, now)
  const patch = { lastActiveAt: now }
  for (const [k, v] of Object.entries(input)) patch[`settings.${k}`] = v
  await ctx.repo.update(user._id, patch)
  return { settings: fullSettings(user, input) }
}

/**
 * 不要求身份：返回调用方身份的形态（布尔值 + 平台登录方式枚举，不含任何标识；供联调 / 冒烟确认自定义登录会话在函数里长什么样），
 * 以及账号状态 phoneVerified / adult / role / bannedUntil / mutedUntil（BE-M1-03；没有账号时为默认值，不会因此建号）。
 */
async function whoami(params, ctx) {
  validate(params, {})
  const raw = (ctx.identity && ctx.identity.raw) || {}
  const accountId = ctx.identity && ctx.identity.openid
  const user = accountId ? await ctx.repo.findByOpenid(accountId) : null
  return {
    source: ctx.identity ? ctx.identity.source : null,
    loginType: raw.loginType || null,
    account: !!(ctx.identity && ctx.identity.openid),
    openId: !!raw.openId,
    unionId: !!raw.unionId,
    uid: !!raw.uid,
    customUserId: !!raw.customUserId,
    anonymous: !!raw.isAnonymous,
    publishableKey: !!raw.publishableKey,
    ...accountStatus(user, ctx.now()),
  }
}

// ---------- 微信（App） ----------

async function exchangeWechat(ctx, code) {
  if (!ctx.wechat) throw upstream('微信登录暂不可用')
  const { openid, unionid } = await ctx.wechat.exchangeCode(code)
  if (!unionid) throw upstream('微信未返回 unionid，请确认移动应用已绑定到开放平台')
  return { openid, unionid }
}

/**
 * App 微信登录（Publishable Key 调用，不要求身份）：code → unionid → 账号 → 自定义登录票据 + 一次性关联令牌。
 * 客户端随后 POST /auth/v1/signin/with/provider { provider_id: 'custom', provider_token: ticket }，再 user.login({ linkToken })。
 */
async function wechatAppLogin(params, ctx) {
  const { code } = validate(params, codeSchema)
  if (!ctx.createTicket) throw upstream('微信登录暂不可用（未配置自定义登录）')
  const { openid, unionid } = await exchangeWechat(ctx, code)
  const now = ctx.now()

  let accountId
  let isNew = false
  const existing = await ctx.accountRepo.getLink(linkId('unionid', unionid))
  if (existing) {
    accountId = existing.accountId
  } else {
    const r = await createAccount(ctx.accountRepo, { accountId: unionid, now, aliases: [{ kind: 'unionid', value: unionid }] })
    accountId = r.accountId
    isNew = r.isNew
  }
  await ctx.accountRepo.addLink({ _id: linkId('wxapp', openid), accountId, kind: 'wxapp', createdAt: now })

  const linkToken = ctx.randomToken()
  await createPending(ctx.accountRepo, { accountId, token: linkToken, now })
  const ticket = ctx.createTicket(await ensureCustomId(ctx.accountRepo, { accountId, now }))
  return { ticket, linkToken, isNew, accountId }
}

/** 已登录账号绑定微信；该微信已有账号（如小程序老用户）则并入当前账号 */
async function bindWechat(params, ctx) {
  const { code } = validate(params, codeSchema)
  const accountId = requireOpenid(ctx.identity)
  const { openid, unionid } = await exchangeWechat(ctx, code)
  const now = ctx.now()
  const r = await linkAlias(ctx.accountRepo, { kind: 'unionid', value: unionid, accountId, now, logger: logger(ctx) })
  await ctx.accountRepo.addLink({ _id: linkId('wxapp', openid), accountId, kind: 'wxapp', createdAt: now })
  return { ok: true, merged: r.merged }
}

// ---------- 通过 Apple 登录（iOS，BE-L09） ----------

async function verifyApple(ctx, input) {
  if (!ctx.apple) throw upstream('Apple 登录暂不可用')
  return ctx.apple.verifyIdentityToken(input.identityToken, { nonce: input.nonce })
}

/**
 * App 端 Apple 登录（Publishable Key 调用，不要求身份）：identityToken → sub → 账号（首登 accountId = 'ap_' + sha1(sub) 前 24 位）
 * → 自定义登录票据 + 一次性关联令牌。后续流程与 wechatAppLogin 相同（signin/with/provider → user.login({ linkToken })）。
 */
async function appleLogin(params, ctx) {
  const input = validate(params, appleSchema)
  if (!ctx.createTicket) throw upstream('Apple 登录暂不可用（未配置自定义登录）')
  const { sub } = await verifyApple(ctx, input)
  const now = ctx.now()

  let accountId
  let isNew = false
  const existing = await ctx.accountRepo.getLink(linkId('apple', sub))
  if (existing) {
    accountId = existing.accountId
  } else {
    const r = await createAccount(ctx.accountRepo, { accountId: appleAccountId(sub), now, aliases: [{ kind: 'apple', value: sub }] })
    accountId = r.accountId
    isNew = r.isNew
  }

  const linkToken = ctx.randomToken()
  await createPending(ctx.accountRepo, { accountId, token: linkToken, now })
  const ticket = ctx.createTicket(await ensureCustomId(ctx.accountRepo, { accountId, now }))
  return { ticket, linkToken, isNew, accountId }
}

/** 已登录账号绑定 Apple ID；该 Apple ID 已有账号则并入当前账号 */
async function bindApple(params, ctx) {
  const input = validate(params, appleSchema)
  const accountId = requireOpenid(ctx.identity)
  const { sub } = await verifyApple(ctx, input)
  const r = await linkAlias(ctx.accountRepo, { kind: 'apple', value: sub, accountId, now: ctx.now(), logger: logger(ctx) })
  return { ok: true, merged: r.merged }
}

// ---------- 手机号（App） ----------

/** 手机号 → phone: 别名的哈希；号码格式无法识别时返回 null（不建别名，不影响实名标记） */
function hashOf(ctx, phone) {
  if (!ctx.phoneHash || !phone) return null
  try {
    return ctx.phoneHash(phone)
  } catch (e) {
    logger(ctx).error('[phone] 号码格式无法识别，跳过 phone 别名')
    return null
  }
}

/** 标记实名并记录手机号哈希（不存明文）；返回写入后的用户文档 */
async function markPhoneVerified(ctx, { accountId, user, hash, merged, now }) {
  const base = merged ? (await ctx.repo.findByOpenid(accountId)) || user : user
  const patch = { phoneVerified: true, lastActiveAt: now }
  if (base.phoneVerified !== true || hash) patch.phoneVerifiedAt = now
  if (hash) patch.phoneHash = hash
  await ctx.repo.update(base._id, patch)
  return { ...base, ...patch }
}

/**
 * 已登录账号绑定手机号（App）：客户端先用手机号完成 CloudBase 登录 / 注册拿到另一份会话，把它的 access_token 传来；
 * 服务端向 /auth/v1/user/me 验证后把该 uid 关联到当前账号，并标记实名（BE-M1-02）。
 * 传的是**自己的**手机号会话（手机号登录后调用一次）：只标记实名 + 登记 phone: 别名。
 * /auth/v1/user/me 返回 phone_number 且配置了 PHONE_HASH_SECRET 时登记 phone:<hash> 别名——小程序绑定同一号码时识别为同一人（BE-M1-01）。
 * 手机号明文不落库、不记日志。
 */
async function linkPhoneSession(params, ctx) {
  const { otherAccessToken } = validate(params, { otherAccessToken: { type: 'string', minLen: 16, maxLen: 4096 } })
  const accountId = requireOpenid(ctx.identity)
  if (!ctx.authApi) throw upstream('绑定手机号暂不可用')
  const other = await ctx.authApi.userMe(otherAccessToken)
  if (!other || !other.sub) throw unauthorized('手机号登录态无效，请重新获取验证码')
  const raw = (ctx.identity && ctx.identity.raw) || {}
  const self = other.sub === raw.uid
  // 自己的会话但不是手机号会话（如微信自定义登录）：没有可登记的号码，保持幂等
  if (self && !other.phone) return { ok: true, merged: false }
  const now = ctx.now()
  const { user } = await ensureUser(ctx.repo, accountId, now)
  const hash = hashOf(ctx, other.phone)
  let merged = false
  // 先处理号码别名：与另一个人的账号冲突（40901）时，什么都不写
  if (hash) merged = (await linkPhone(ctx.accountRepo, { accountId, hash, now, logger: logger(ctx) })).merged
  if (!self) {
    const r = await linkAlias(ctx.accountRepo, { kind: 'cbuid', value: other.sub, via: 'phone', accountId, now, logger: logger(ctx) })
    merged = merged || r.merged
  }
  await markPhoneVerified(ctx, { accountId, user, hash: hash && !user.phoneHash ? hash : null, merged, now })
  return { ok: true, merged }
}

/**
 * 小程序手机号快速验证（BE-M1-01，PRD A2 / C4）：<button open-type="getPhoneNumber"> 的 code → 微信换手机号（校验 code 属于当前 openid）
 * → 只存 HMAC 哈希（users.phoneHash + phone:<hash> 别名）并标记实名。
 * 号码已属于另一个账号：同一个人的 App 手机号账号 → 并入当前账号（merged=true）；另一个微信用户的账号 → 40901。
 * 换绑新号码时释放旧号码的别名。code 失效 / 不属于当前用户 → 40001；未配置小程序凭证或哈希密钥 → 50201。
 */
async function bindPhoneWeapp(params, ctx) {
  const { code } = validate(params, phoneCodeSchema)
  const accountId = requireOpenid(ctx.identity)
  if (ctx.identity.source !== 'weapp') throw forbidden('请在微信小程序内绑定手机号')
  if (!ctx.mp || !ctx.phoneHash) throw upstream('手机号验证暂不可用')
  const now = ctx.now()
  const phone = await ctx.mp.getPhoneNumber(code, ctx.identity.raw && ctx.identity.raw.openId)
  const hash = hashOf(ctx, phone)
  if (!hash) throw upstream('暂不支持该手机号')
  const { user } = await ensureUser(ctx.repo, accountId, now)
  const { merged } = await linkPhone(ctx.accountRepo, { accountId, hash, previousHash: user.phoneHash || null, now, logger: logger(ctx) })
  const fresh = await markPhoneVerified(ctx, { accountId, user, hash, merged, now })
  return { ok: true, merged, ...accountStatus(fresh, now) }
}

// ---------- 注销 ----------

async function deleteAccount(params, ctx) {
  const input = validate(params, {
    confirm: { type: 'enum', values: ['DELETE'] },
    /** 绑定过 Apple 的账号：客户端注销前重新授权拿到的 authorizationCode，用于撤销 Apple 授权（审核指南 5.1.1(v)） */
    appleAuthorizationCode: { type: 'string', minLen: 8, maxLen: 1024, optional: true },
  })
  const accountId = requireOpenid(ctx.identity)
  const removed = await deleteAccountData(ctx.accountRepo, { accountId, logger: logger(ctx) })
  const out = { ok: true, removed }
  // 数据先删（主流程），撤销尽力而为：失败只记日志，返回 appleRevoked=false 供客户端提示「可在 iPhone 设置里停止使用 Apple 登录」
  if (input.appleAuthorizationCode) {
    out.appleRevoked = ctx.apple ? await ctx.apple.revokeByAuthorizationCode(input.appleAuthorizationCode, logger(ctx)) : null
  }
  return out
}

module.exports = {
  actions: { login, consent, confirmAdult, updateSettings, whoami, wechatAppLogin, bindWechat, appleLogin, bindApple, linkPhoneSession, bindPhoneWeapp, deleteAccount },
  ensureUser,
  accountStatus,
  PLATFORMS,
  IDENTITY_FREE_ACTIONS,
  DEFAULT_SETTINGS,
}
