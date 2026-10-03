/**
 * 数据模型（字段以 docs/api/*.md 为准）。时间一律毫秒时间戳。
 * starter 只包含账号相关模型；业务模型（如条目、记录）落地时在这里补充，并同步 services/cloud.types.ts 的 CollectionMap / FunctionMap。
 */

import type { PracticeId } from '@/constants/community'

/**
 * 用户设置（users.settings）。starter 为空；新增设置项时与云函数 cloudfunctions/_shared/settings.js 的 SETTINGS_SCHEMA 保持一致，
 * 例如 `{ fontScale?: 'normal' | 'large' }`。
 */
export type UserSettings = Record<string, unknown>

/** 一次完成的私人练习；sessionId 是重试时复用的幂等键。 */
export interface PracticeCheckinInput {
  sessionId: string
  /** 设备本地日期 YYYY-MM-DD；跨零点按计时结束日期 */
  date: string
  practice: PracticeId
  minutes: number
}

export interface PracticeCheckinResult {
  date: string
  practice: PracticeId
  /** 当日该练习方式累计分钟数 */
  minutes: number
  duplicate: boolean
}

/** practice.listCheckins 按日汇总，仅包含当前账号自己的记录。 */
export interface DailyCheckin {
  date: string
  minutes: number
  practices: Partial<Record<PracticeId, number>>
}

export interface CheckinMonth {
  month: string
  list: DailyCheckin[]
  totalMinutes: number
}

/**
 * 每日一题（PRD W3，docs/api/practice.md「每日一题」）。题目由运营写入 `daily_prompts`、云函数只读；
 * 答案落 `prompt_answers`：一人一题一次，默认匿名（m6-plan D6 / D9）。
 */
export type PromptAnswerStatus = 'ok' | 'pending' | 'removed'

export interface DailyPrompt {
  id: string
  /** 北京时间日期 YYYY-MM-DD */
  date: string
  text: string
}

/** practice.todayPrompt 的返回体：当日没有已发布题目时 prompt 为 null（不是错误）。 */
export interface PromptToday {
  prompt: (DailyPrompt & {
    /** 本人是否已作答（任意状态都算，是「能否看他人回答」的开关） */
    answered: boolean
    /** 本人那条的状态；未作答为 null */
    myStatus: PromptAnswerStatus | null
    /** 该题的回答数（近似值，含本人那条） */
    answerCount: number
  }) | null
}

export interface PromptAnswerInput {
  promptId: string
  text: string
  /** 缺省即匿名（PROMPT_RULES.defaultAnon），显式 false 才实名 */
  anon?: boolean
}

/** 服务端返回的答案（不回传 _openid） */
export interface PromptAnswer {
  id: string
  date: string
  text: string
  anon: boolean
  status: PromptAnswerStatus
  createdAt: number
}

/** 列表条目：作者只给展示名与形态（匿名 → 花名、实名 → 昵称、注销 → 「已注销用户」） */
export interface PromptAnswerItem extends PromptAnswer {
  authorName: string
  isSelf: boolean
  deleted: boolean
}

export interface PromptAnswerPage {
  promptId: string
  date: string
  page: number
  size: number
  hasMore: boolean
  /** 他人的可见答案（status ok，不含本人） */
  list: PromptAnswerItem[]
  /** 本人那条（可能是 pending）；仅在已作答时有值 */
  mine: PromptAnswerItem | null
}

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

/** 官方圈子列表对象（community.listCircles）；计数仅用于展示 */
export interface Circle {
  id: string
  slug: string
  name: string
  desc: string
  cover: string | null
  memberCount: number
  topicCount: number
  joined: boolean
}

/** 官方圈子详情（community.getCircle）：列表字段 + 圈子公约 */
export interface CircleDetail extends Circle {
  rules: string[]
}

export type CircleRef = Pick<Circle, 'id' | 'name'>

export type InviteStatus = 'active' | 'used' | 'expired'

/** 只返回给签发人的邀请码；不含兑换人或任何账号标识 */
export interface Invite {
  code: string
  circle: CircleRef
  status: InviteStatus
  createdAt: number
  expiresAt: number
  usedAt: number | null
}

export interface InviteList {
  quota: number
  ttlDays: number
  list: Invite[]
}

/** 话题流条目（community.listTopics）：只有摘要，不含正文；author 已按匿名脱敏 */
export interface TopicSummary {
  id: string
  /** 所属圈子；旧话题 / 不可见圈子为空 */
  circle: CircleRef | null
  title: string
  excerpt: string
  tags: string[]
  anon: boolean
  author: AuthorView
  replyCount: number
  createdAt: number
  lastReplyAt: number
  featured: boolean
  /** M6 慢话题（D11）：冷静期截止时间（毫秒），到点前不开放回复；null = 不限制（旧话题与未开启的都是 null） */
  slowUntil: number | null
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
  /** 所属圈子；缺省时云端仅在恰好加入 1 个圈子时自动归属 */
  circleId?: string
  title: string
  body: string
  anon?: boolean
  tags?: string[]
  /** M6 慢话题：true → 发出后 TOPIC_RULES.slowHours 小时内不开放回复（云端落 slowUntil） */
  slow?: boolean
}

export interface ReplyInput {
  topicId: string
  body: string
  anon?: boolean
  quoteId?: string
}
