/**
 * CloudBase 统一接入接口（FE-05）
 * 业务层（services/me.ts 及后续业务 service）只依赖这里的 `CloudClient`，不感知平台：
 * - 小程序：cloud.weapp.ts（wx.cloud，OPENID 免登录）
 * - H5：cloud.h5.ts（@cloudbase/js-sdk 匿名登录）
 * - RN：cloud.rn.ts（CloudBase HTTP API：公开读用 Publishable Key；身份类调用用登录后的会话，见 `CloudAuth`）
 * 云函数入参 / 出参以 docs/api/*.md 为准（starter：docs/api/user.md）。
 */
import type { AccountStatus, CheckinMonth, Circle, CircleDetail, Invite, InviteList, MarkReadResult, MediaQueueItem, ModDecision, ModQueueItem, NotificationPage, PracticeCheckinInput, PracticeCheckinResult, Profile, ProfilePatch, PromptAnswer, PromptAnswerInput, PromptAnswerPage, PromptToday, Reply, ReplyInput, ReportTarget, TopicDetail, TopicInput, TopicSummary, User, UserSettings } from '@/types/models'

/** 客户端可直读的集合（安全规则见 docs/api/README.md「安全规则」）；业务集合落地时在这里补充 */
export interface CollectionMap {
  users: User
}
export type CollectionName = keyof CollectionMap

/** 公开内容集合（查询自动补 status: 'online'，与安全规则子集一致）；starter 无公开集合 */
export const PUBLIC_COLLECTIONS: CollectionName[] = []
/** 私有集合查询必须带 _openid（由各端实现自动注入） */
export const PRIVATE_COLLECTIONS: CollectionName[] = ['users']

export type Where<T> = Partial<{ [K in keyof T]: T[K] }> & Record<string, unknown>

export interface QueryOptions<T> {
  where?: Where<T>
  orderBy?: Array<[keyof T & string, 'asc' | 'desc']>
  /** 从 1 开始 */
  page?: number
  /** 默认 20，最大 100 */
  size?: number
  /** projection，如 { settings: false } */
  field?: Partial<Record<keyof T & string, boolean>>
}

export interface PageResult<T> {
  list: T[]
  page: number
  size: number
  hasMore: boolean
}

/** 云函数分页出参（带 total；与 PageResult 的区别：这是服务端分页，不是集合查询） */
export interface PagedList<T> {
  list: T[]
  total: number
  page: number
  size: number
  hasMore: boolean
}

export interface CloudDb {
  query<C extends CollectionName>(collection: C, opts?: QueryOptions<CollectionMap[C]>): Promise<PageResult<CollectionMap[C]>>
  get<C extends CollectionName>(collection: C, id: string): Promise<CollectionMap[C] | null>
}

/** 登录方式（App 端；小程序 / H5 由平台提供身份，没有这个概念） */
export type AuthMethod = 'phone' | 'wechat' | 'apple'

/** 账号已关联的登录方式（docs/api/user.md login 出参 identities） */
export interface AccountIdentities { mp: boolean, wechat: boolean, phone: boolean, apple?: boolean }

export interface LoginInput {
  platform?: 'weapp' | 'app'
  /** App 端本机记录的同意时间（毫秒） */
  consentAt?: number
  consentVersion?: string
  /** wechatAppLogin 返回的一次性关联令牌（兜底，5 分钟有效） */
  linkToken?: string
  /** App 端登录前在本机确认 18+ 的时间（毫秒）；云端没有确认时间时写服务端时间 */
  adultConfirmedAt?: number
}

/** login 结果里带账号状态（BE-M1-03） */
export interface LoginResult extends AccountStatus {
  /** 与 accountId 相同（兼容旧字段） */
  openid: string
  accountId?: string
  isNew: boolean
  identities?: AccountIdentities
  merged?: boolean
  settings?: UserSettings
  guardianConsentAt?: number | null
}

/** 云函数 action 映射：[入参, 出参] */
export interface FunctionMap {
  user: {
    /**
     * 登录 / 刷新账号（docs/api/user.md）。settings / guardianConsentAt：云端已保存的设置与同意时间，换机 / 重装后前端据此恢复（services/me.ts login）。
     * App 端把本机记录的同意时间随 consentAt 上报（云端只在没有同意时间时写入服务端时间）；identities 为该账号已关联的登录方式；
     * merged 为 true 表示本次登录触发了账号合并（前端应失效收藏 / 进度缓存）。
     */
    login: [LoginInput, LoginResult]
    /** 小程序 / H5：同意协议动作写 guardianConsentAt；App 端同意只记本机，登录时随 login.consentAt 上报（services/me.ts consent） */
    consent: [void, { guardianConsentAt: number }]
    /** 18+ 确认（FE-M1-01 / BE-M1-03）：首次写服务端时间，重复确认不改；记录协议版本 */
    confirmAdult: [{ consentVersion?: string }, { adultConfirmedAt: number, consentVersion: string } & AccountStatus]
    /** 设置项由 cloudfunctions/_shared/settings.js 定义（starter 为空，任何入参都返回 40001） */
    updateSettings: [Partial<UserSettings>, { settings: UserSettings }]
    /** 联调用：调用方身份形态（全布尔，不含标识）；不要求身份 */
    whoami: [void, { source: 'weapp' | 'custom' | 'web' | null, loginType: string | null, account: boolean, uid: boolean, customUserId: boolean, anonymous: boolean, publishableKey: boolean } & AccountStatus]
    /** App 微信登录第一跳（Publishable Key 调用）：微信 code → 自定义登录票据；50201 = 未配置 / 微信侧失败 */
    wechatAppLogin: [{ code: string, state?: string }, { ticket: string, linkToken: string, isNew: boolean, accountId: string }]
    /** 已登录账号绑定微信；对方微信已有账号时并入当前账号 */
    bindWechat: [{ code: string, state?: string }, { ok: true, merged: boolean }]
    /** 通过 Apple 登录第一跳（Publishable Key 调用，iOS）：identityToken + 原始 nonce → 自定义登录票据；40101 = 凭证无效 */
    appleLogin: [{ identityToken: string, nonce: string }, { ticket: string, linkToken: string, isNew: boolean, accountId: string }]
    /** 已登录账号绑定 Apple ID；对方已有账号时并入当前账号 */
    bindApple: [{ identityToken: string, nonce: string }, { ok: true, merged: boolean }]
    /** 已登录账号绑定手机号：传入手机号会话的 access_token（客户端先用手机号另取一份会话）；手机号登录后用自己的会话调一次以登记号码 */
    linkPhoneSession: [{ otherAccessToken: string }, { ok: true, merged: boolean }]
    /** 小程序手机号快速验证（FE-M1-02 / BE-M1-01）：getPhoneNumber 的 code；号码属于同一人的 App 账号时合并（merged），属于他人时 40901 */
    bindPhoneWeapp: [{ code: string }, { ok: true, merged: boolean } & AccountStatus]
    /** 注销：删除账号全部数据与别名；带 appleAuthorizationCode 时顺带撤销 Apple 授权（appleRevoked） */
    deleteAccount: [{ confirm: 'DELETE', appleAuthorizationCode?: string }, { ok: true, removed: { user: number, links: number } & Record<string, number>, appleRevoked?: boolean | null }]
  }
  /** 社区（docs/api/community.md）：M1 练习档案（docs/api/profile.md）；M3 / M4 话题、圈子、邀请 */
  community: {
    /** 本人档案；还没有档案时为 null */
    getProfile: [void, { profile: Profile | null }]
    /** 部分更新（只传要改的字段）；首次保存时建档并分配匿名代号。需已确认 18+（40303），不要求实名 */
    updateProfile: [ProfilePatch, { profile: Profile }]
    /** 上传头像后登记并机审（BE-M2-02）：pending = 等微信机审回调；review = 人工复核（App 用户等）。通过前只记 avatarPending */
    setAvatar: [{ fileID: string }, { profile: Profile, status: 'pending' | 'review' }]
    /** 官方圈子列表（M4）：仅 open 圈子，非成员也可看简介与公约；joined 表示当前账号是否已加入 */
    listCircles: [void, { list: Circle[] }]
    /** 官方圈子详情（M4）：不存在 / 已关闭为 40401 */
    getCircle: [{ id: string }, { circle: CircleDetail }]
    /** 我的邀请码与剩余名额（M4）；会懒初始化名额并回收过期码额度 */
    listInvites: [void, InviteList]
    /** 为我所属的圈子签发邀请码，扣 1 个名额（M4） */
    createInvite: [{ circleId: string }, { invite: Invite, quota: number }]
    /** 兑换一次性邀请码并加入其绑定的圈子（M4） */
    redeemInvite: [{ code: string }, { circle: Circle, joined: true }]
    /** 发起话题（M3）：标题 5–40 字、正文有效字数 ≥ 50；status = pending 表示机审待复核（只有本人看得到）；机审拒绝 40001 且不占额度。`slow: true` = 慢话题（M6 D11） */
    createTopic: [TopicInput, { status: 'ok' | 'pending', topic: TopicDetail, remaining: number }]
    /** 话题流：只含 ok，新的在前；条目为摘要，作者已按匿名脱敏。需 18+，不要求实名。M6：`featured: true` 只看精华（D12，不改变可见性判定） */
    listTopics: [{ page?: number, size?: number, circleId?: string, featured?: boolean }, PagedList<TopicSummary>]
    /** 话题详情；不存在 / 已下架 / 别人的待审 40401 */
    getTopic: [{ id: string }, { topic: TopicDetail }]
    /** 回复：有效字数 ≥ 1，< 30 标记 short；quoteId 必须是同一话题里的正常回复。慢话题未到 `slowUntil` → 40901（不扣额度、不发机审） */
    createReply: [ReplyInput, { status: 'ok' | 'pending', reply: Reply, remaining: number }]
    /** 回复列表：时间正序，默认每页 30 */
    listReplies: [{ topicId: string, page?: number, size?: number }, PagedList<Reply>]
    /** 作者删除自己的话题 / 回复（软删除，幂等） */
    deleteMine: [{ type: 'topic' | 'reply', id: string }, { ok: true, changed: boolean }]
  }
  /** 内容安全（docs/api/moderation.md，M2） */
  moderation: {
    /** 举报：需 18+，不要求实名，禁言中也可；同一人对同一目标只计一次（duplicate）；达阈值自动折叠（folded） */
    report: [ReportTarget & { reason: string, note?: string }, { ok: true, duplicate: boolean, folded: boolean }]
    /** 审核队列（仅 mod / admin，否则 40301） */
    queue: [{ state?: 'open' | 'resolved', page?: number, size?: number }, { list: ModQueueItem[], total: number, page: number, size: number, hasMore: boolean }]
    /** 处理（仅 mod / admin）：decision 不叫 action（action 是路由字段）；mute 需 days 1–30，ban 不传 days = 永久 */
    decide: [ReportTarget & { decision: ModDecision, days?: number, note?: string }, { ok: true, resolved: number, status: string | null }]
    /** 图片人工复核队列（仅 mod / admin） */
    mediaQueue: [{ page?: number, size?: number }, { list: MediaQueueItem[], total: number, page: number, size: number, hasMore: boolean }]
    /** 图片复核结论（仅 mod / admin）：pass 生效；reject 删除文件并通知上传者 */
    decideMedia: [{ mediaId: string, decision: 'pass' | 'reject', note?: string }, { ok: true, status: string, changed: boolean }]
    /** 标 / 取消精华（M6 BE-M6-02，仅 mod / admin，否则 40301）：只改 topics.featured，不动 status；标精华要求话题当前为 ok，取消不限；同值调用 changed: false */
    markFeatured: [{ topicId: string, featured: boolean }, { ok: true, featured: boolean, changed: boolean }]
  }
  /** 私人练习记录（docs/api/practice.md，M5）；服务端只按当前身份读写 */
  practice: {
    /** 单次完成记录；同一 sessionId 重试幂等 */
    checkin: [PracticeCheckinInput, { checkin: PracticeCheckinResult }]

    /** 指定月份的个人热力图数据 */
    listCheckins: [{ month: string }, CheckinMonth]
    /** 今日题目（BE-M6-01）：无入参；当日无已发布题目时返回 `{ prompt: null }` */
    todayPrompt: [Record<string, never>, PromptToday]
    /** 作答每日一题：一人一题一次（重复 40901），默认匿名；机审拒绝 40001 且不落库 */
    answerPrompt: [PromptAnswerInput, { answer: PromptAnswer }]
    /** 答案列表：本人未作答 → 40301；他人只返回 status ok，本人那条在 mine 里 */
    listAnswers: [{ promptId: string, page?: number, size?: number }, PromptAnswerPage]
    /** 站内消息（BE-M6-03）：只返回写给自己账号的那份，createdAt 倒序；unread 是未读条数 */
    listNotifications: [{ page?: number, size?: number }, NotificationPage]
    /** 标记已读：ids（1–100）或 all: true；别人的 id 命中 0 条、重复标记幂等 */
    markNotificationsRead: [{ ids?: string[], all?: true }, MarkReadResult]
    /** 订阅授权上报（D09b）：granted=true 才加额度，云端封顶 PROMPT_RULES.subscribeQuotaMax；非小程序端 40301 */
    recordPromptSubscription: [{ granted: boolean }, { quota: number; granted: boolean }]
  }
  // 业务云函数在这里按同样格式声明：<函数名>: { <action>: [入参, 出参] }，并在 cloud.rn.ts 标注公开 / 免身份动作
}
export type FnName = keyof FunctionMap
export type FnAction<N extends FnName> = keyof FunctionMap[N] & string
export type FnInput<N extends FnName, A extends FnAction<N>> = FunctionMap[N][A] extends [infer I, unknown] ? I : never
export type FnOutput<N extends FnName, A extends FnAction<N>> = FunctionMap[N][A] extends [unknown, infer O] ? O : never

/** 云函数统一返回 `{ code, data, msg }` */
export interface FnResponse<T> {
  code: number
  data: T
  msg?: string
}

export const ERROR_CODES = {
  OK: 0,
  BAD_PARAM: 40001,
  UNAUTHORIZED: 40101,
  FORBIDDEN: 40301,
  /** 发布类动作需先绑定手机号（后台实名） */
  PHONE_REQUIRED: 40302,
  /** 需先确认年满 18 周岁 */
  ADULT_REQUIRED: 40303,
  BANNED: 40304,
  MUTED: 40305,
  NOT_FOUND: 40401,
  /** 手机号已绑定其他账号 */
  CONFLICT: 40901,
  TOO_MANY: 42901,
  SERVER: 50000,
  /** 前端自定义：网络/SDK 异常 */
  NETWORK: -1,
  /** 前端自定义：未配置 envId 或端未实现 */
  NOT_READY: -2,
  /** 前端自定义：未同意用户协议 / 隐私政策，云端写入被拦截 */
  CONSENT_REQUIRED: -3,
  /** 前端自定义（App）：需要登录；会话不存在或刷新失败后抛出，页面据此跳登录页 */
  LOGIN_REQUIRED: -4,
  /** 前端自定义（App）：短信验证码不正确或已过期 */
  AUTH_CODE_INVALID: -5,
  /** 前端自定义（App）：身份认证服务要求图形验证码（captcha_required）或短时间内操作过多 */
  AUTH_BUSY: -6,
  /** 前端自定义（App）：微信未安装 / SDK 未接入 / 未配置 AppID / 微信返回失败 */
  WECHAT_UNAVAILABLE: -7,
  /** 前端自定义（App）：用户在微信里取消了授权，或切回 App 后微信没有返回结果 */
  AUTH_CANCELLED: -8,
  /** 前端自定义（App）：用户在微信里拒绝了授权 */
  AUTH_DENIED: -9,
  /** 前端自定义（App / iOS）：非 iOS 13+ / 原生模块缺失 / Apple 授权失败 */
  APPLE_UNAVAILABLE: -10
} as const

export class CloudError extends Error {
  code: number
  constructor (code: number, msg: string) {
    super(msg)
    this.name = 'CloudError'
    this.code = code
  }
}

export interface CloudFn {
  call<N extends FnName, A extends FnAction<N>>(
    name: N, action: A, ...data: FnInput<N, A> extends void ? [] : [FnInput<N, A>]
  ): Promise<FnOutput<N, A>>
}

export interface CloudIdentity {
  /** 小程序为 OPENID；H5 为匿名 uid；App 为 CloudBase 会话 uid（未登录为 null，且不会为取身份而发请求） */
  uid: string | null
  anonymous: boolean
  /** App：登录方式；未登录为 null */
  method?: AuthMethod | null
  /** App：user.login 返回的账号 ID（登录后才有） */
  accountId?: string | null
}

/** App 端会话摘要（不含令牌），供 store / 页面显示 */
export interface SessionInfo {
  uid: string
  method: AuthMethod
  accountId?: string
  /** 毫秒时间戳 */
  expiresAt: number
}

/** 手机号验证码登录三步的中间结果 */
export interface VerificationInfo {
  verificationId: string
  /** 该手机号是否已是 CloudBase 用户（决定 signin 还是 signup） */
  isUser: boolean
  /** 秒 */
  expiresIn: number
}

/**
 * App 端登录（docs/api/user.md「App 登录流程」）。小程序没有该对象（身份由平台提供）。
 * 手机号：sendCode → verifyCode → signIn；微信：user.wechatAppLogin 拿票据 → custom.signIn。
 * 手机号只经过 CloudBase 身份认证服务，本项目的数据库与云函数不接触手机号。
 */
export interface CloudAuth {
  /** 当前会话摘要（只读本地，不发请求） */
  session(): SessionInfo | null
  phone: {
    /** 发送短信验证码；phone 为 11 位大陆手机号（不含 +86） */
    sendCode(phone: string): Promise<VerificationInfo>
    /** 校验验证码，返回 verification_token（10 分钟内有效） */
    verifyCode(verificationId: string, code: string): Promise<string>
    /**
     * 用 verification_token 登录（已注册 signin / 未注册 signup 自动选择）。
     * persist=false 时只返回会话不落盘、不改变当前登录态（设置页「绑定手机号」用另一份会话调 user.linkPhoneSession）
     */
    signIn(input: { phone: string, verificationToken: string, isUser?: boolean }, opts?: { persist?: boolean }): Promise<SessionInfo & { accessToken: string }>
  }
  custom: {
    /** 自定义登录票据（user.wechatAppLogin 返回）换会话 */
    signIn(ticket: string, method?: AuthMethod): Promise<SessionInfo>
  }
  /** 记录 user.login 返回的 accountId（随会话持久化） */
  attachAccount(accountId: string): void
  /** 退出：尽力撤销 refresh_token，无论成败都清本地会话 */
  signOut(): Promise<void>
  /** 注销 CloudBase 用户（DELETE /auth/v1/user/me），失败不抛出；随后清本地会话 */
  deleteCloudUser(): Promise<void>
}

/** 云存储上传（小程序 / H5 / mock 实现；App 暂未实现，见 docs/api/profile.md setAvatar） */
export interface CloudStorage {
  /** 把本地临时文件传到 cloudPath（如 uploads/avatar/202610/xxx.jpg），返回 fileID（cloud://…） */
  upload(localPath: string, cloudPath: string, file?: unknown): Promise<string>
}

export interface CloudClient {
  platform: 'weapp' | 'h5' | 'rn'
  /** 云存储（没有实现的端为 undefined：不显示上传入口） */
  storage?: CloudStorage
  /** 幂等；多次调用返回同一个 Promise */
  init(): Promise<void>
  identity(): Promise<CloudIdentity>
  /** 丢弃本端持有的登录态（App 端会话 / H5 匿名会话；小程序 OPENID 由平台管理，无需实现） */
  signOut?(): Promise<void>
  /** App 端登录能力（RN 与 mock 实现；小程序 / H5 无） */
  auth?: CloudAuth
  db: CloudDb
  fn: CloudFn
}

export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100

export function normalizePage (page?: number, size?: number) {
  const s = Math.min(Math.max(1, size || DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE)
  const p = Math.max(1, page || 1)
  return { page: p, size: s, skip: (p - 1) * s }
}

/** 公开集合自动补 status: 'online'，保证查询条件是安全规则的子集 */
export function withRuleWhere<C extends CollectionName> (collection: C, where: Record<string, unknown> = {}, openid?: string | null) {
  const w: Record<string, unknown> = { ...where }
  if (PUBLIC_COLLECTIONS.includes(collection) && w.status === undefined) w.status = 'online'
  if (PRIVATE_COLLECTIONS.includes(collection)) {
    if (!openid) throw new CloudError(ERROR_CODES.UNAUTHORIZED, '未获取到用户身份')
    w._openid = openid
  }
  return w
}

export function unwrap<T> (res: FnResponse<T> | undefined, name: string, action: string): T {
  if (!res || typeof res.code !== 'number') throw new CloudError(ERROR_CODES.SERVER, `${name}.${action} 返回格式错误`)
  if (res.code !== ERROR_CODES.OK) throw new CloudError(res.code, res.msg || `${name}.${action} 失败`)
  return res.data
}
