/**
 * 数据模型（字段以 docs/api/*.md 为准）。时间一律毫秒时间戳。
 * starter 只包含账号相关模型；业务模型（如条目、记录）落地时在这里补充，并同步 services/cloud.types.ts 的 CollectionMap / FunctionMap。
 */

/**
 * 用户设置（users.settings）。starter 为空；新增设置项时与云函数 cloudfunctions/_shared/settings.js 的 SETTINGS_SCHEMA 保持一致，
 * 例如 `{ fontScale?: 'normal' | 'large' }`。
 */
export type UserSettings = Record<string, unknown>

/** users 集合文档（_openid 承载 accountId，见 cloudfunctions/_shared/account.js） */
export interface User {
  _id: string
  _openid: string
  createdAt: number
  lastActiveAt: number
  lastLoginAt?: number
  lastLoginPlatform?: 'weapp' | 'app'
  settings: UserSettings
  /** 用户同意用户协议 / 隐私政策的服务端时间（字段名沿用 starter）；未同意为 undefined */
  guardianConsentAt?: number
  consentVersion?: string
  /** 已实名（绑定过手机号）；手机号只存 HMAC 哈希，前端拿不到 */
  phoneVerified?: boolean
  /** 18+ 确认的服务端时间 */
  adultConfirmedAt?: number
  role?: 'user' | 'mod' | 'admin'
  bannedUntil?: number
  mutedUntil?: number
}

export type ConsentState = 'unknown' | 'agreed' | 'declined'

/**
 * 18+ 确认（本机，PRD A3 / C5）：unknown 未确认；confirmed 已确认（云端以 users.adultConfirmedAt 为准）；
 * declined 选择了退出——只能浏览公开内容，可随时从「我的」或发布入口重新确认（FE-M1-01）。
 */
export type AdultState = 'unknown' | 'confirmed' | 'declined'

/** 账号状态（user.login / whoami / confirmAdult / bindPhoneWeapp 返回，docs/api/user.md）。不含任何标识与手机号 */
export interface AccountStatus {
  phoneVerified: boolean
  adult: boolean
  role: 'user' | 'mod' | 'admin'
  /** 封禁截止（未封禁或已过期为 null） */
  bannedUntil: number | null
  /** 禁言截止（未禁言或已过期为 null） */
  mutedUntil: number | null
}

/** 练习档案（community.getProfile / updateProfile，docs/api/profile.md）。只有本人能读，不含任何账号标识 */
export interface Profile {
  nickname: string
  /** 'preset:<id>'（预置头像）、'cloud://…'（审核通过的上传头像）或 null（默认头像） */
  avatar: string | null
  /** 自己上传、还在审核中的头像（只有本人看得到；通过后变成 avatar，BE-M2-02） */
  avatarPending?: string | null
  /** 练习方式 id（constants/community.ts PRACTICES） */
  practices: string[]
  years: number | null
  goal: string
  bio: string
  /** 匿名代号：首次保存档案时分配，之后不变；匿名发布时显示「匿名·<代号>」 */
  anonAlias: string | null
  badges: string[]
  updatedAt: number | null
}

/** updateProfile 入参：只传要修改的字段；avatar / years 传 null 表示清除 */
export type ProfilePatch = Partial<Pick<Profile, 'nickname' | 'avatar' | 'practices' | 'years' | 'goal' | 'bio'>>

/**
 * 内容作者的展示信息（PRD §8.3 匿名脱敏：接口只返回 author: { name, avatar, badges, isSelf }，永远不含 authorUid）。
 * M3 话题 / 回复接口按此返回；匿名时 name 为匿名代号、avatar 为空。
 */
export interface AuthorView {
  name: string
  avatar?: string | null
  badges?: string[]
  isSelf?: boolean
  anon?: boolean
  /** 作者已注销：显示「已注销用户」 */
  deleted?: boolean
  practices?: string[]
  years?: number | null
}

/** 举报目标（M2，docs/api/moderation.md）：举报用户时传他发布的内容（contentType + targetId），不暴露任何 uid */
export interface ReportTarget {
  targetType: 'topic' | 'reply' | 'user'
  targetId: string
  contentType?: 'topic' | 'reply'
}

/** 审核队列条目（moderation.queue）：按目标聚合；target 为内容快照，不含任何作者标识 */
export interface ModQueueItem extends Required<Pick<ReportTarget, 'targetType' | 'targetId'>> {
  contentType: 'topic' | 'reply'
  count: number
  reasons: Record<string, number>
  notes: string[]
  latestAt: number
  target: { status: 'ok' | 'pending' | 'folded' | 'removed', excerpt: string, anon: boolean, authorDeleted: boolean } | null
}

export type ModDecision = 'dismiss' | 'remove' | 'restore' | 'mute' | 'ban'

/** 图片人工复核条目（moderation.mediaQueue，BE-M2-02）：url 为 1 小时临时预览链接，不含上传者标识 */
export interface MediaQueueItem {
  mediaId: string
  purpose: string
  purposeLabel: string
  status: 'pending' | 'review'
  provider: 'wx' | 'manual'
  label: string | number | null
  createdAt: number
  url: string | null
}

/** 话题状态（docs/api/community.md M3）：pending = 机审待复核（只有作者看得到）；folded = 被举报自动折叠 */
export type TopicStatus = 'pending' | 'ok' | 'folded' | 'removed'

/** 话题流条目（community.listTopics）：只有摘要，不含正文；author 已按匿名脱敏 */
export interface TopicSummary {
  id: string
  title: string
  excerpt: string
  tags: string[]
  anon: boolean
  author: AuthorView
  replyCount: number
  createdAt: number
  lastReplyAt: number
  featured: boolean
  /** M3 恒为 []，话题配图随统一原生选图一起做 */
  images: string[]
  folded: boolean
  pending: boolean
}

/** 话题详情（community.getTopic / createTopic）：用 body 代替 excerpt；折叠时 body 为 null */
export interface TopicDetail extends Omit<TopicSummary, 'excerpt'> {
  body: string | null
}

/** 回复里的引用：被引用的回复折叠 / 删除 / 待审时 unavailable，authorName 与 excerpt 为 null */
export interface ReplyQuote {
  id: string
  unavailable: boolean
  authorName: string | null
  anon: boolean
  excerpt: string | null
}

/** 回复（community.listReplies / createReply）：短回复（< 30 字）默认折叠；折叠的回复 body 为 null */
export interface Reply {
  id: string
  topicId: string
  body: string | null
  short: boolean
  anon: boolean
  author: AuthorView
  quote: ReplyQuote | null
  createdAt: number
  folded: boolean
  pending: boolean
}

export interface TopicInput {
  title: string
  body: string
  anon?: boolean
  tags?: string[]
}

export interface ReplyInput {
  topicId: string
  body: string
  anon?: boolean
  quoteId?: string
}
