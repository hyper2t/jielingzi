/**
 * Mock CloudClient：实现与真实端相同的 CloudClient 接口，按 docs/api/*.md 契约返回 `{ code, data }` 解包后的数据。
 * 切换真实数据：在 .env / .env.local 写 TARO_APP_DATA_SOURCE=cloud（见 services/client.ts），业务层不改。
 * 业务云函数落地时：在 FunctionMap 声明后，这里的 handlers 必须补上同名实现（类型会强制要求）。
 */
import type { AccountStatus, AuthorView, CheckinMonth, Circle, DailyCheckin, Invite, MediaQueueItem, ModQueueItem, PracticeCheckinInput, PracticeCheckinResult, Profile, PromptAnswerInput, PromptAnswerItem, Reply, ReplyQuote, TopicDetail, TopicStatus, TopicSummary, User, UserSettings } from '@/types/models'
import type { AccountIdentities } from '../cloud.types'
import { CONSENT_VERSION, DAILY_LIMITS, INVITE_RULES, PROMPT_RULES, PRACTICES, TOPIC_RULES } from '@/constants/community'
import { normalizeInviteCode } from '@/features/circle/rules'
import { normalizeLine, patchError } from '@/features/profile/rules'
import { clip, isShortReply, normalizeBody, replyError, topicInputError } from '@/features/topic/rules'
import { readAuth, useUserStore } from '@/store/user'
import { removeItem, setItem, STORAGE_KEYS } from '@/utils/storage'
import {
  AuthMethod, CloudAuth, CloudClient, CloudError, CollectionMap, CollectionName, ERROR_CODES, FnAction, FnInput, FnName, FnOutput,
  SessionInfo, normalizePage, withRuleWhere
} from '../cloud.types'

/** mock 云端 users.settings：模拟「云端保存的设置」，login 时下发 */
let remoteSettings: UserSettings = {}

const NO_STATUS: AccountStatus = { phoneVerified: false, adult: false, role: 'user', bannedUntil: null, mutedUntil: null }
const MOCK_OPENID = 'mock-openid'
interface MockCircle {
  id: string
  slug: string
  name: string
  desc: string
  cover: string | null
  rules: string[]
  memberCount: number
  topicCount: number
  sort: number
  status: 'open' | 'closed'
}
interface MockMembership { circleId: string, accountId: string }
interface MockInvite {
  code: string
  circleId: string
  ownerId: string | null
  official: boolean
  createdAt: number
  expiresAt: number
  usedBy: string | null
  usedAt: number | null
  refunded: boolean
}
const DEFAULT_CIRCLE_ID = 'circle-mindful'
const defaultMockCircle = (): MockCircle => ({
  id: DEFAULT_CIRCLE_ID,
  slug: 'mindful',
  name: '静观练习',
  desc: '冥想、正念、内观的日常练习与困惑',
  cover: 'circle:mindful',
  rules: ['说具体：做法、时长、当时的感受，少下结论。', '讲方法时先说明这是个人经验，不替别人定「应该」。', '不评判他人的练习方式。'],
  memberCount: 1,
  topicCount: 0,
  sort: 1,
  status: 'open'
})
let circles: MockCircle[] = [defaultMockCircle()]
let memberships: MockMembership[] = [{ circleId: DEFAULT_CIRCLE_ID, accountId: MOCK_OPENID }]
let invites: MockInvite[] = []
let inviteQuota: number | undefined
let inviteSeq = 0
/** mock 云端账号状态（实名 / 18+ / 角色 / 处罚） */
let account: AccountStatus = { ...NO_STATUS }
/** mock 云端练习档案（community.getProfile / updateProfile） */
let profile: Profile | null = null
/** mock 云端举报（moderation.report / queue / decide） */
interface MockReport { targetType: ModQueueItem['targetType'], targetId: string, contentType: ModQueueItem['contentType'], reason: string, note: string, state: 'open' | 'resolved', by: string }
let reports: MockReport[] = []
/** mock 云端图片机审记录（setAvatar / mediaQueue / decideMedia） */
interface MockMedia { mediaId: string, fileID: string, status: 'pending' | 'review' | 'pass' | 'reject' }
let media: MockMedia[] = []
let mediaSeq = 0
/** 模拟机审结论落地（等价于 mediacheck 回调 / 人工复核） */
function settleMock (m: MockMedia, verdict: 'pass' | 'reject') {
  m.status = verdict
  if (profile && profile.avatarPending === m.fileID) {
    profile = { ...profile, avatarPending: null, ...(verdict === 'pass' ? { avatar: m.fileID } : {}) }
  }
}
/**
 * mock 云端话题 / 回复（community.createTopic / listTopics / getTopic / createReply / listReplies / deleteMine，M3）。
 * 规则与云函数一致（features/topic/rules.ts）；机审可用标记演示：标题 / 正文含 [reject] → 40001 拒绝，含 [review] → 待复核（pending，只有本人看得到）。
 */
interface MockTopic { id: string, circleId: string | null, title: string, body: string, tags: string[], anon: boolean, mine: boolean, authorName: string, status: TopicStatus, replyCount: number, createdAt: number, lastReplyAt: number, featured: boolean }
interface MockReply { id: string, topicId: string, body: string, anon: boolean, mine: boolean, authorName: string, status: TopicStatus, quoteId: string | null, createdAt: number }
let topics: MockTopic[] = []
let replies: MockReply[] = []
let postSeq = 0
interface MockCheckin { date: string, practice: PracticeCheckinInput['practice'], minutes: number, sessionIds: string[] }
let checkins: MockCheckin[] = []
interface MockPrompt { id: string, date: string, text: string, status: 'ok' | 'closed' }
interface MockPromptAnswer { id: string, promptId: string, date: string, text: string, anon: boolean, mine: boolean, authorName: string, status: 'ok' | 'pending' | 'removed', createdAt: number, deleted?: boolean }
let prompts: MockPrompt[] = []
let promptAnswers: MockPromptAnswer[] = []
let promptSeq = 0
let answerSeq = 0
/** 与云函数 _shared/config.js 的 cnDate 一致：每日一题按北京时间归日 */
const mockCnDate = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
/** 答案列表默认分页：与云函数 service.js 的 ANSWER_PAGE_SIZE 同值（同 mock 里 180 分钟上限的处理方式） */
const MOCK_ANSWER_PAGE_SIZE = 20
let postedToday = { topic: 0, reply: 0, answer: 0, createInvite: 0, redeemInvite: 0 }
export const MOCK_REJECT_MARK = '[reject]'
export const MOCK_REVIEW_MARK = '[review]'
/** getPhoneNumber 回调里以这个前缀开头的 code 视为失效（测试 / 演示「code 失效」分支） */
export const MOCK_EXPIRED_PHONE_CODE = 'mock-expired'
/** 视为「号码已绑定其他微信账号」的 code（演示 40901） */
export const MOCK_TAKEN_PHONE_CODE = 'mock-taken'

/** 测试 / 手动演示用的控制项 */
export const mockControl = {
  latency: 300,
  /** 接下来 N 次调用失败（NETWORK） */
  failTimes: 0,
  calls: [] as Array<{ name: string, action: string, data?: unknown }>,
  /** 设置 mock 云端已保存的 users.settings（测试换机 / 重装恢复） */
  setRemoteSettings (s: UserSettings) {
    remoteSettings = { ...s }
  },
  /** 设置 mock 云端账号状态（如已实名 / 已确认 18+ / 禁言中） */
  setAccount (p: Partial<AccountStatus>) {
    account = { ...account, ...p }
  },
  /** 设置 mock 云端档案（null = 还没有档案） */
  setProfile (p: Profile | null) {
    profile = p ? { ...p } : null
  },
  /** 预置举报（审核页演示 / 测试）；by 不同视为不同举报人 */
  seedReports (list: Array<Omit<MockReport, 'state' | 'note' | 'contentType'> & { note?: string, contentType?: MockReport['contentType'] }>) {
    reports = list.map(r => ({ note: '', contentType: r.targetType === 'user' ? 'topic' : r.targetType as MockReport['contentType'], ...r, state: 'open' }))
  },
  /** 预置官方圈子（默认 reset 只放静观练习一个圈子） */
  seedCircles (list: Array<Partial<MockCircle> & Pick<MockCircle, 'slug' | 'name'>>) {
    circles = list.map((c, i) => {
      const base = defaultMockCircle()
      return {
        ...base,
        ...c,
        id: c.id || `circle-${c.slug}`,
        slug: c.slug,
        desc: c.desc ?? '',
        cover: c.cover ?? (c.slug ? `circle:${c.slug}` : null),
        rules: c.rules ? [...c.rules] : [...base.rules],
        memberCount: c.memberCount ?? 0,
        topicCount: c.topicCount ?? 0,
        sort: c.sort ?? i + 1,
        status: c.status ?? 'open'
      }
    })
  },
  /** 覆盖当前 mock 账号的圈子成员关系；传 [] 模拟未入圈 */
  setMemberships (circleIds: string[]) {
    memberships = circleIds.map(circleId => ({ circleId, accountId: MOCK_OPENID }))
  },
  /** 预置邀请码（仅测试 / 演示使用） */
  seedInvites (list: Array<Partial<MockInvite> & Pick<MockInvite, 'code' | 'circleId'>>) {
    const now = Date.now()
    invites = list.map((inv, i) => ({
      code: inv.code,
      circleId: inv.circleId,
      ownerId: inv.ownerId ?? (inv.official ? null : MOCK_OPENID),
      official: inv.official ?? false,
      createdAt: inv.createdAt ?? now - (list.length - i) * 60000,
      expiresAt: inv.expiresAt ?? now + INVITE_RULES.ttlDays * 24 * 3600 * 1000,
      usedBy: inv.usedBy ?? null,
      usedAt: inv.usedAt ?? null,
      refunded: inv.refunded ?? false
    }))
  },
  setInviteQuota (quota: number | undefined) { inviteQuota = quota },
  get circles (): MockCircle[] { return circles.map(c => ({ ...c, rules: [...c.rules] })) },
  get memberships (): MockMembership[] { return memberships.map(m => ({ ...m })) },
  get invites (): MockInvite[] { return invites.map(i => ({ ...i })) },
  get inviteQuota (): number | undefined { return inviteQuota },
  get reports (): MockReport[] { return reports.map(r => ({ ...r })) },
  get media (): MockMedia[] { return media.map(m => ({ ...m })) },
  /** 模拟微信机审回调：最近一张待审头像的结论 */
  settleAvatar (verdict: 'pass' | 'reject') {
    const m = [...media].reverse().find(x => x.status === 'pending' || x.status === 'review')
    if (m) settleMock(m, verdict)
  },
  /** 预置话题（别人发的；mine: true 视为我发的）。未给的字段取默认值，createdAt 默认按顺序递增（后面的更新） */
  seedTopics (list: Array<Partial<MockTopic> & { title: string, body: string }>) {
    const base = Date.now() - list.length * 60000
    list.forEach((t, i) => {
      const createdAt = t.createdAt ?? base + i * 60000
      const circleId = t.circleId === undefined ? (circles.find(c => c.status === 'open')?.id ?? null) : t.circleId
      topics.push({ id: `t${++postSeq}`, tags: [], anon: false, mine: false, authorName: '林然', status: 'ok', replyCount: 0, lastReplyAt: createdAt, featured: false, ...t, circleId, createdAt })
    })
  },
  seedReplies (list: Array<Partial<MockReply> & { topicId: string, body: string }>) {
    const base = Date.now() - list.length * 1000
    list.forEach((r, i) => {
      replies.push({ id: `r${++postSeq}`, anon: false, mine: false, authorName: '松声', status: 'ok', quoteId: null, createdAt: base + i * 1000, ...r })
    })
  },
  get topics (): MockTopic[] { return topics.map(t => ({ ...t })) },
  get replies (): MockReply[] { return replies.map(r => ({ ...r })) },
  /** 预置每日一题题目（date 缺省为北京时间当日，status 缺省 ok） */
  seedPrompts (list: Array<Partial<MockPrompt> & { text: string }>) {
    list.forEach(p => {
      prompts.push({ id: p.id || `p${++promptSeq}`, date: p.date || mockCnDate(), text: p.text, status: p.status || 'ok' })
    })
  },
  /** 预置别人的回答（mine: true 视为我自己发的） */
  seedPromptAnswers (list: Array<Partial<MockPromptAnswer> & { text: string }>) {
    const base = Date.now() - list.length * 1000
    list.forEach((a, i) => {
      const wanted = a.promptId || (prompts[0] ? prompts[0].id : 'p1')
      const prompt = prompts.find(p => p.id === wanted)
      promptAnswers.push({
        id: `pa${++answerSeq}`,
        promptId: wanted,
        date: a.date || (prompt ? prompt.date : mockCnDate()),
        text: a.text,
        anon: a.anon ?? true,
        mine: a.mine ?? false,
        authorName: a.authorName || MOCK_ALIASES[0],
        status: a.status || 'ok',
        createdAt: a.createdAt ?? base + i * 1000,
        deleted: a.deleted ?? false
      })
    })
  },
  get prompts (): MockPrompt[] { return prompts.map(p => ({ ...p })) },
  get promptAnswers (): MockPromptAnswer[] { return promptAnswers.map(a => ({ ...a })) },
  get checkins (): MockCheckin[] { return checkins.map(c => ({ ...c, sessionIds: [...c.sessionIds] })) },
  get account (): AccountStatus { return { ...account } },
  get profile (): Profile | null { return profile ? { ...profile } : null },
  reset () {
    this.latency = 300
    this.failTimes = 0
    this.calls = []
    remoteSettings = {}
    mockSession = null
    identities = { mp: false, wechat: false, phone: false, apple: false }
    account = { ...NO_STATUS }
    profile = null
    reports = []
    media = []
    mediaSeq = 0
    topics = []
    replies = []
    checkins = []
    prompts = []
    promptAnswers = []
    promptSeq = 0
    answerSeq = 0
    postSeq = 0
    circles = [defaultMockCircle()]
    memberships = [{ circleId: DEFAULT_CIRCLE_ID, accountId: MOCK_OPENID }]
    invites = []
    inviteQuota = undefined
    inviteSeq = 0
    postedToday = { topic: 0, reply: 0, answer: 0, createInvite: 0, redeemInvite: 0 }
  }
}

/** mock 登录（App 端 mock 数据源联调登录页用）：任意 11 位手机号，验证码固定 MOCK_SMS_CODE */
export const MOCK_SMS_CODE = '123456'
type MockSession = SessionInfo & { accessToken: string }
let mockSession: MockSession | null = null
let identities: AccountIdentities = { mp: false, wechat: false, phone: false, apple: false }

const wait = () => new Promise<void>(resolve => {
  if (mockControl.latency > 0) setTimeout(resolve, mockControl.latency)
  else resolve()
})

async function gate () {
  await wait()
  if (mockControl.failTimes > 0) {
    mockControl.failTimes -= 1
    throw new CloudError(ERROR_CODES.NETWORK, 'mock: 网络异常')
  }
}

type Handler<N extends FnName, A extends FnAction<N>> = (data: FnInput<N, A>) => FnOutput<N, A>
type Handlers = { [N in FnName]: { [A in FnAction<N>]: Handler<N, A> } }

/** 与云端 guardWrite 一致的拦截：封禁 → 18+ → 实名 → 禁言 */
function guard (opts: { requirePhone: boolean, allowMuted?: boolean }) {
  const now = Date.now()
  if (account.bannedUntil && account.bannedUntil > now) throw new CloudError(ERROR_CODES.BANNED, 'mock: 账号已被封禁')
  if (!account.adult) throw new CloudError(ERROR_CODES.ADULT_REQUIRED, 'mock: 请先确认年满 18 周岁')
  if (opts.requirePhone && !account.phoneVerified) throw new CloudError(ERROR_CODES.PHONE_REQUIRED, 'mock: 请先绑定手机号')
  if (!opts.allowMuted && account.mutedUntil && account.mutedUntil > now) throw new CloudError(ERROR_CODES.MUTED, 'mock: 账号禁言中')
}

const MOCK_ALIASES = ['竹影', '松声', '云眠', '溪语', '石径', '月光']

// ---- 话题 / 回复（M3）：与云函数 topics.js 的脱敏、可见性、机审约定一致 ----
const badParam = (msg: string) => new CloudError(ERROR_CODES.BAD_PARAM, msg)
function noUnknown (input: unknown, allowed: string[]) {
  const bad = Object.keys((input || {}) as object).filter(k => !allowed.includes(k))
  if (bad.length) throw badParam(`不支持的参数：${bad.join(',')}`)
}
function readGuard () {
  if (!account.adult) throw new CloudError(ERROR_CODES.ADULT_REQUIRED, 'mock: 请先确认年满 18 周岁')
}
const presentCircle = (circle: MockCircle, joined: boolean): Circle => ({
  id: circle.id,
  slug: circle.slug,
  name: circle.name,
  desc: circle.desc,
  cover: circle.cover,
  memberCount: Math.max(0, Math.floor(circle.memberCount)),
  topicCount: Math.max(0, Math.floor(circle.topicCount)),
  joined
})
const isMockMember = (circleId: string | null | undefined, accountId = MOCK_OPENID): boolean =>
  !!circleId && circles.some(c => c.id === circleId && c.status === 'open') && memberships.some(m => m.circleId === circleId && m.accountId === accountId)
const hasMockMembership = (circleId: string | null | undefined, accountId = MOCK_OPENID): boolean =>
  !!circleId && memberships.some(m => m.circleId === circleId && m.accountId === accountId)
const openMembershipIds = (): Set<string> => new Set(circles.filter(c => c.status === 'open' && isMockMember(c.id)).map(c => c.id))
const circleRef = (circleId: string | null): { id: string, name: string } | null => {
  const c = circleId && circles.find(x => x.id === circleId && x.status === 'open')
  return c ? { id: c.id, name: c.name } : null
}
function ensureInviteQuota (): number {
  if (inviteQuota === undefined) inviteQuota = INVITE_RULES.initialQuota
  return inviteQuota
}
function refundExpiredMockInvites (ownerId: string, now: number): number {
  let refunded = 0
  for (const inv of invites) {
    if (inv.ownerId === ownerId && !inv.official && !inv.usedBy && !inv.refunded && inv.expiresAt <= now) {
      inv.refunded = true
      refunded += 1
    }
  }
  if (refunded) inviteQuota = ensureInviteQuota() + refunded
  return refunded
}
const presentInvite = (inv: MockInvite, now: number): Invite => {
  const circle = circles.find(c => c.id === inv.circleId)
  return {
    code: inv.code,
    circle: { id: inv.circleId, name: circle?.name || '' },
    status: inv.usedBy ? 'used' : inv.expiresAt <= now ? 'expired' : 'active',
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    usedAt: inv.usedAt
  }
}
function nextMockInviteCode (): string {
  const alphabet = INVITE_RULES.alphabet
  let n = ++inviteSeq
  let code = ''
  for (let i = 0; i < INVITE_RULES.codeLength; i++) {
    code = `${alphabet[n % alphabet.length]}${code}`
    n = Math.floor(n / alphabet.length)
  }
  return code
}
function ensureMockProfile () {
  if (!profile) profile = { nickname: '', avatar: null, practices: [], years: null, goal: '', bio: '', badges: [], anonAlias: MOCK_ALIASES[0], updatedAt: Date.now() }
  return profile
}
function mockModerate (text: string): 'ok' | 'pending' {
  if (text.includes(MOCK_REJECT_MARK)) throw badParam('内容不符合社区公约，请修改后再发布')
  return text.includes(MOCK_REVIEW_MARK) ? 'pending' : 'ok'
}
/** 匿名 → 代号（无头像 / 徽章 / 档案）；实名 → 档案；我自己的匿名内容也能看到 isSelf */
function mockAuthor (d: { anon: boolean, mine: boolean, authorName: string }): AuthorView {
  const p = profile
  const alias = (p && p.anonAlias) || MOCK_ALIASES[0]
  if (d.anon) return { name: d.mine ? alias : d.authorName, avatar: null, badges: [], practices: [], years: null, isSelf: d.mine, anon: true, deleted: false }
  if (d.mine) return { name: (p && p.nickname) || alias, avatar: p ? p.avatar : null, badges: (p && p.badges) || [], practices: (p && p.practices) || [], years: p ? p.years : null, isSelf: true, anon: false, deleted: false }
  return { name: d.authorName, avatar: null, badges: [], practices: [], years: null, isSelf: false, anon: false, deleted: false }
}
/** 答案条目的展示形态（与云函数 presentAnswer 一致：匿名给代号、实名给昵称、注销给「已注销用户」） */
function presentMockAnswer (a: MockPromptAnswer): PromptAnswerItem {
  const alias = (profile && profile.anonAlias) || MOCK_ALIASES[0]
  const nickname = (profile && profile.nickname) || alias
  const authorName = a.deleted ? '已注销用户' : (a.mine ? (a.anon ? alias : nickname) : a.authorName)
  return {
    id: a.id, date: a.date, text: a.text, status: a.status, createdAt: a.createdAt,
    authorName, anon: a.anon, isSelf: a.mine, deleted: a.deleted === true
  }
}

/** ok / folded 所有人可见；pending 只有作者；removed 不可见 */
const canSee = (d: { status: TopicStatus, mine: boolean }) => d.status === 'ok' || d.status === 'folded' || (d.status === 'pending' && d.mine)
function topicBase (d: MockTopic) {
  return {
    id: d.id, circle: circleRef(d.circleId), title: d.title, tags: [...d.tags], anon: d.anon, author: mockAuthor(d), replyCount: d.replyCount,
    createdAt: d.createdAt, lastReplyAt: d.lastReplyAt, featured: d.featured, images: [] as string[], folded: d.status === 'folded', pending: d.status === 'pending'
  }
}
const topicSummary = (d: MockTopic): TopicSummary => ({ ...topicBase(d), excerpt: d.status === 'folded' ? '' : clip(d.body, TOPIC_RULES.excerptLen) })
const topicDetail = (d: MockTopic): TopicDetail => ({ ...topicBase(d), body: d.status === 'folded' ? null : d.body })
function replyQuote (r: MockReply): ReplyQuote | null {
  if (!r.quoteId) return null
  const q = replies.find(x => x.id === r.quoteId)
  if (!q || q.status !== 'ok') return { id: r.quoteId, unavailable: true, authorName: null, anon: false, excerpt: null }
  const a = mockAuthor(q)
  return { id: q.id, unavailable: false, authorName: a.name, anon: !!a.anon, excerpt: clip(q.body, 60) }
}
const replyOut = (r: MockReply): Reply => ({
  id: r.id, topicId: r.topicId, body: r.status === 'folded' ? null : r.body, short: isShortReply(r.body), anon: r.anon, author: mockAuthor(r),
  quote: replyQuote(r), createdAt: r.createdAt, folded: r.status === 'folded', pending: r.status === 'pending'
})
function pageOf<T> (all: T[], input: { page?: number, size?: number } | undefined, defSize: number) {
  const size = Math.min(Math.max(1, (input && input.size) || defSize), 50)
  const page = Math.max(1, (input && input.page) || 1)
  return { list: all.slice((page - 1) * size, page * size), total: all.length, page, size, hasMore: page * size < all.length }
}

const handlers: Handlers = {
  user: {
    login: (input) => {
      // 与云端一致：App 端上报本机 18+ 确认；手机号登录方式即实名
      if (input && input.adultConfirmedAt) account = { ...account, adult: true }
      if (identities.phone) account = { ...account, phoneVerified: true }
      return { openid: MOCK_OPENID, accountId: MOCK_OPENID, isNew: false, identities: { ...identities }, merged: false, settings: { ...remoteSettings }, guardianConsentAt: null, ...account }
    },
    consent: () => ({ guardianConsentAt: Date.now() }),
    confirmAdult: (input) => {
      account = { ...account, adult: true }
      return { adultConfirmedAt: Date.now(), consentVersion: (input && input.consentVersion) || CONSENT_VERSION, ...account }
    },
    bindPhoneWeapp: ({ code }) => {
      if (!code || code.length < 8) throw new CloudError(ERROR_CODES.BAD_PARAM, 'code 必填')
      if (code.startsWith(MOCK_EXPIRED_PHONE_CODE)) throw new CloudError(ERROR_CODES.BAD_PARAM, '手机号验证已失效，请重新获取')
      if (code.startsWith(MOCK_TAKEN_PHONE_CODE)) throw new CloudError(ERROR_CODES.CONFLICT, '该手机号已绑定其他账号')
      account = { ...account, phoneVerified: true }
      identities = { ...identities, phone: true }
      return { ok: true, merged: false, ...account }
    },
    // 与真实端一致：设置项由云函数 _shared/settings.js 定义；starter 为空时空入参返回 40001
    updateSettings: (s) => {
      if (!s || Object.keys(s).length === 0) throw new CloudError(ERROR_CODES.BAD_PARAM, 'mock: 至少需要一个设置项')
      remoteSettings = { ...remoteSettings, ...s }
      return { settings: { ...remoteSettings } }
    },
    whoami: () => ({ source: mockSession ? 'custom' : null, loginType: mockSession ? 'CUSTOM' : null, account: !!mockSession, uid: !!mockSession, customUserId: false, anonymous: false, publishableKey: !mockSession, ...account }),
    // 与真实端一致：SDK 未接入 / 未配置 AppID 时 50201
    wechatAppLogin: () => { throw new CloudError(50201, 'mock: 微信登录未配置') },
    bindWechat: () => { throw new CloudError(50201, 'mock: 微信登录未配置') },
    appleLogin: () => { throw new CloudError(50201, 'mock: 通过 Apple 登录未配置') },
    bindApple: () => { throw new CloudError(50201, 'mock: 通过 Apple 登录未配置') },
    linkPhoneSession: ({ otherAccessToken }) => {
      if (!mockSession) throw new CloudError(ERROR_CODES.UNAUTHORIZED, 'mock: 未登录')
      if (!otherAccessToken) throw new CloudError(ERROR_CODES.BAD_PARAM, 'mock: 缺少 otherAccessToken')
      identities = { ...identities, phone: true }
      account = { ...account, phoneVerified: true }
      return { ok: true, merged: false }
    },
    deleteAccount: ({ confirm }) => {
      if (confirm !== 'DELETE') throw new CloudError(ERROR_CODES.BAD_PARAM, 'mock: confirm 必须为 DELETE')
      if (!mockSession) throw new CloudError(ERROR_CODES.UNAUTHORIZED, 'mock: 未登录')
      const removed = { user: 1, links: 1, profiles: profile ? 1 : 0 }
      for (const membership of memberships.filter(m => m.accountId === MOCK_OPENID)) {
        const circle = circles.find(c => c.id === membership.circleId)
        if (circle) circle.memberCount = Math.max(0, circle.memberCount - 1)
      }
      memberships = memberships.filter(m => m.accountId !== MOCK_OPENID)
      invites = invites.filter(inv => inv.ownerId !== MOCK_OPENID && inv.usedBy !== MOCK_OPENID)
      remoteSettings = {}
      identities = { mp: false, wechat: false, phone: false, apple: false }
      account = { ...NO_STATUS }
      profile = null
      return { ok: true, removed }
    }
  },
  community: {
    listCircles: () => {
      readGuard()
      const joined = openMembershipIds()
      const list = circles.filter(c => c.status === 'open').sort((a, b) => a.sort - b.sort || a.slug.localeCompare(b.slug)).map(c => presentCircle(c, joined.has(c.id)))
      return { list }
    },
    getCircle: ({ id }) => {
      readGuard()
      const circle = circles.find(c => c.id === id && c.status === 'open')
      if (!circle) throw new CloudError(ERROR_CODES.NOT_FOUND, '圈子不存在或已关闭')
      return { circle: { ...presentCircle(circle, isMockMember(circle.id)), rules: [...circle.rules] } }
    },
    listInvites: (input) => {
      noUnknown(input, [])
      readGuard()
      const now = Date.now()
      ensureInviteQuota()
      refundExpiredMockInvites(MOCK_OPENID, now)
      const list = invites.filter(inv => inv.ownerId === MOCK_OPENID).sort((a, b) => b.createdAt - a.createdAt).slice(0, INVITE_RULES.listMax).map(inv => presentInvite(inv, now))
      return { quota: ensureInviteQuota(), ttlDays: INVITE_RULES.ttlDays, list }
    },
    createInvite: (input) => {
      noUnknown(input, ['circleId'])
      if (!input.circleId) throw badParam('circleId 必填')
      guard({ requirePhone: true })
      const circle = circles.find(c => c.id === input.circleId && c.status === 'open')
      if (!circle || !isMockMember(input.circleId)) throw new CloudError(ERROR_CODES.FORBIDDEN, '加入圈子后才能邀请')
      if (postedToday.createInvite >= DAILY_LIMITS.createInvite) throw new CloudError(ERROR_CODES.TOO_MANY, 'mock: 今天创建的邀请码已达上限')
      const now = Date.now()
      ensureInviteQuota()
      refundExpiredMockInvites(MOCK_OPENID, now)
      if (inviteQuota! < 1) throw new CloudError(ERROR_CODES.TOO_MANY, '邀请名额已用完')
      inviteQuota = inviteQuota! - 1
      const invite: MockInvite = {
        code: nextMockInviteCode(), circleId: circle.id, ownerId: MOCK_OPENID, official: false,
        createdAt: now, expiresAt: now + INVITE_RULES.ttlDays * 24 * 3600 * 1000, usedBy: null, usedAt: null, refunded: false
      }
      invites.push(invite)
      postedToday.createInvite += 1
      return { invite: presentInvite(invite, now), quota: inviteQuota! }
    },
    redeemInvite: (input) => {
      noUnknown(input, ['code'])
      const code = normalizeInviteCode(input.code)
      guard({ requirePhone: true, allowMuted: true })
      if (postedToday.redeemInvite >= DAILY_LIMITS.redeemInvite) throw new CloudError(ERROR_CODES.TOO_MANY, 'mock: 今天兑换邀请码的尝试次数已达上限')
      postedToday.redeemInvite += 1
      const now = Date.now()
      const invite = invites.find(inv => inv.code === code)
      const circle = invite && circles.find(c => c.id === invite.circleId)
      if (!invite || invite.usedBy || invite.expiresAt <= now || !circle || circle.status !== 'open') {
        throw new CloudError(ERROR_CODES.NOT_FOUND, '邀请码无效、已被使用或已过期')
      }
      if (isMockMember(circle.id)) throw new CloudError(ERROR_CODES.CONFLICT, '你已在这个圈子里')
      invite.usedBy = MOCK_OPENID
      invite.usedAt = now
      memberships.push({ circleId: circle.id, accountId: MOCK_OPENID })
      circle.memberCount += 1
      return { circle: presentCircle(circle, true), joined: true }
    },
    getProfile: () => ({ profile: profile ? { ...profile } : null }),
    // 与云端一致：先校验字段（同一份规则），再走写入链路（需 18+，不要求实名），首次保存分配匿名代号
    updateProfile: (patch) => {
      const keys = Object.keys(patch || {})
      const allowed = ['nickname', 'avatar', 'practices', 'years', 'goal', 'bio']
      if (!keys.length) throw new CloudError(ERROR_CODES.BAD_PARAM, '至少需要修改一项')
      if (keys.some(k => !allowed.includes(k))) throw new CloudError(ERROR_CODES.BAD_PARAM, `不支持的参数：${keys.filter(k => !allowed.includes(k)).join(',')}`)
      const first = patchError(patch)
      if (first) throw new CloudError(ERROR_CODES.BAD_PARAM, first)
      guard({ requirePhone: false })
      const clean = (v: unknown) => (typeof v === 'string' ? normalizeLine(v) : v)
      profile = {
        nickname: '', avatar: null, practices: [], years: null, goal: '', bio: '', badges: [],
        anonAlias: MOCK_ALIASES[Math.floor(Math.random() * MOCK_ALIASES.length)],
        ...(profile || {}),
        ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, clean(v)])),
        updatedAt: Date.now()
      } as Profile
      return { profile: { ...profile } }
    },
    // 与云端一致：只接受本应用 uploads/avatar/ 下的文件；mock 一律进 pending（小程序有 openid）
    setAvatar: ({ fileID }) => {
      if (!fileID || !/^cloud:\/\/[^/]+\/uploads\/avatar\//.test(fileID)) throw new CloudError(ERROR_CODES.BAD_PARAM, '图片路径不正确，请重新上传')
      guard({ requirePhone: false })
      const m: MockMedia = { mediaId: `m${++mediaSeq}`, fileID, status: 'pending' }
      media.push(m)
      profile = {
        nickname: '', avatar: null, practices: [], years: null, goal: '', bio: '', badges: [],
        anonAlias: MOCK_ALIASES[0], updatedAt: Date.now(), ...(profile || {}), avatarPending: fileID
      }
      return { profile: { ...profile }, status: 'pending' }
    },
    // 与云端一致：先校验字段，再走写入链路（18+ → 实名 → 禁言 → 当日额度）→ 机审 → 落库
    createTopic: (input) => {
      noUnknown(input, ['title', 'body', 'anon', 'tags', 'circleId'])
      const first = topicInputError(input)
      if (first) throw badParam(first)
      guard({ requirePhone: true })
      if (input.circleId !== undefined && !input.circleId) throw badParam('circleId 格式不正确')
      const memberIds = [...openMembershipIds()]
      let circleId: string
      if (input.circleId) {
        if (!memberIds.includes(input.circleId)) throw new CloudError(ERROR_CODES.FORBIDDEN, '加入圈子后才能发帖')
        circleId = input.circleId
      } else if (memberIds.length === 1) circleId = memberIds[0]
      else if (memberIds.length > 1) throw badParam('请选择圈子')
      else throw new CloudError(ERROR_CODES.FORBIDDEN, '加入圈子后才能发帖')
      if (postedToday.topic >= DAILY_LIMITS.createTopic) throw new CloudError(ERROR_CODES.TOO_MANY, 'mock: 今天发起的话题已达上限')
      const tags = Array.from(new Set((input.tags || []).map(t => normalizeLine(t.replace(/^#+/, '')))))
      const status = mockModerate(`${input.title}\n${input.body}\n${tags.join(' ')}`)
      ensureMockProfile()
      const now = Date.now()
      const d: MockTopic = { id: `t${++postSeq}`, circleId, title: normalizeLine(input.title), body: normalizeBody(input.body), tags, anon: input.anon === true, mine: true, authorName: '', status, replyCount: 0, createdAt: now, lastReplyAt: now, featured: false }
      topics.push(d)
      if (status === 'ok') {
        const circle = circles.find(c => c.id === circleId)
        if (circle) circle.topicCount += 1
      }
      postedToday.topic += 1
      return { status: status === 'ok' ? 'ok' : 'pending', topic: topicDetail(d), remaining: DAILY_LIMITS.createTopic - postedToday.topic }
    },
    listTopics: (input) => {
      readGuard()
      noUnknown(input, ['page', 'size', 'circleId'])
      if (input.circleId !== undefined && !input.circleId) throw badParam('circleId 格式不正确')
      const memberIds = openMembershipIds()
      if (input.circleId && !memberIds.has(input.circleId)) throw new CloudError(ERROR_CODES.FORBIDDEN, '加入圈子后才能查看')
      const visibleIds = input.circleId ? new Set([input.circleId]) : memberIds
      const all = topics.filter(t => t.status === 'ok' && !!t.circleId && visibleIds.has(t.circleId)).sort((a, b) => b.createdAt - a.createdAt)
      const p = pageOf(all, input, 20)
      return { ...p, list: p.list.map(topicSummary) }
    },
    getTopic: ({ id }) => {
      readGuard()
      const t = topics.find(x => x.id === id)
      if (!t || !canSee(t) || !isMockMember(t.circleId)) throw new CloudError(ERROR_CODES.NOT_FOUND, '话题不存在或已下架')
      return { topic: topicDetail(t) }
    },
    createReply: (input) => {
      noUnknown(input, ['topicId', 'body', 'anon', 'quoteId'])
      const first = replyError(input.body)
      if (first) throw badParam(first)
      guard({ requirePhone: true })
      if (postedToday.reply >= DAILY_LIMITS.createReply) throw new CloudError(ERROR_CODES.TOO_MANY, 'mock: 今天发布的回复已达上限')
      const t = topics.find(x => x.id === input.topicId)
      if (!t || t.status !== 'ok' || !isMockMember(t.circleId)) throw new CloudError(ERROR_CODES.NOT_FOUND, '话题不存在或暂时不能回复')
      if (input.quoteId) {
        const q = replies.find(x => x.id === input.quoteId)
        if (!q || q.topicId !== t.id || q.status !== 'ok') throw badParam('引用的回复不存在或已不可用')
      }
      const status = mockModerate(input.body)
      ensureMockProfile()
      const now = Date.now()
      const d: MockReply = { id: `r${++postSeq}`, topicId: t.id, body: normalizeBody(input.body), anon: input.anon === true, mine: true, authorName: '', status, quoteId: input.quoteId || null, createdAt: now }
      replies.push(d)
      if (status === 'ok') { t.replyCount += 1; t.lastReplyAt = now }
      postedToday.reply += 1
      return { status: status === 'ok' ? 'ok' : 'pending', reply: replyOut(d), remaining: DAILY_LIMITS.createReply - postedToday.reply }
    },
    listReplies: (input) => {
      readGuard()
      const t = topics.find(x => x.id === input.topicId)
      if (!t || !canSee(t) || !isMockMember(t.circleId)) throw new CloudError(ERROR_CODES.NOT_FOUND, '话题不存在或已下架')
      const all = replies.filter(r => r.topicId === t.id && canSee(r)).sort((a, b) => a.createdAt - b.createdAt)
      const p = pageOf(all, input, 30)
      return { ...p, list: p.list.map(replyOut) }
    },
    deleteMine: (input) => {
      noUnknown(input, ['type', 'id'])
      if (input.type !== 'topic' && input.type !== 'reply') throw badParam('type 只能是 topic 或 reply')
      const doc = input.type === 'topic' ? topics.find(x => x.id === input.id) : replies.find(x => x.id === input.id)
      if (!doc || !doc.mine) throw new CloudError(ERROR_CODES.NOT_FOUND, '内容不存在或已下架')
      if (doc.status === 'removed') return { ok: true, changed: false }
      const wasOk = doc.status === 'ok'
      doc.status = 'removed'
      if (input.type === 'topic' && wasOk) {
        const circle = circles.find(c => c.id === (doc as MockTopic).circleId)
        if (circle) circle.topicCount = Math.max(0, circle.topicCount - 1)
      }
      if (input.type === 'reply' && wasOk) {
        const t = topics.find(x => x.id === (doc as MockReply).topicId)
        if (t) t.replyCount = Math.max(0, t.replyCount - 1)
      }
      return { ok: true, changed: true }
    }
  },
  // 与云端 moderation 一致：举报需 18+（禁言可举报）、同一人只计一次；队列 / 处理仅 mod / admin
  moderation: {
    report: (input) => {
      if (account.bannedUntil && account.bannedUntil > Date.now()) throw new CloudError(ERROR_CODES.BANNED, 'mock: 账号已被封禁')
      if (!account.adult) throw new CloudError(ERROR_CODES.ADULT_REQUIRED, 'mock: 请先确认年满 18 周岁')
      if (input.note && Array.from(input.note).length > 200) throw new CloudError(ERROR_CODES.BAD_PARAM, 'note 长度不能超过 200')
      if (input.targetType === 'user' && !input.contentType) throw badParam('举报用户时需提供 contentType（他发布的话题 / 回复）')
      if (input.targetType !== 'user' && input.contentType && input.contentType !== input.targetType) throw badParam('contentType 与 targetType 不一致')
      const contentType = input.contentType || (input.targetType === 'user' ? 'topic' : input.targetType)
      const target = contentType === 'topic' ? topics.find(t => t.id === input.targetId) : replies.find(r => r.id === input.targetId)
      const targetTopic = contentType === 'topic' ? target as MockTopic | undefined : topics.find(t => t.id === (target as MockReply | undefined)?.topicId)
      if (!target || !hasMockMembership(targetTopic?.circleId)) throw new CloudError(ERROR_CODES.NOT_FOUND, '内容不存在或已删除')
      if (target.mine) throw badParam('不能举报自己发布的内容')
      const dup = reports.some(r => r.targetType === input.targetType && r.targetId === input.targetId && r.by === MOCK_OPENID)
      if (!dup) {
        reports.push({ targetType: input.targetType, targetId: input.targetId, contentType, reason: input.reason, note: input.note || '', state: 'open', by: MOCK_OPENID })
      }
      return { ok: true, duplicate: dup, folded: false }
    },
    queue: (input) => {
      if (account.role !== 'mod' && account.role !== 'admin') throw new CloudError(ERROR_CODES.FORBIDDEN, '无权限')
      const state = (input && input.state) || 'open'
      const groups = new Map<string, ModQueueItem>()
      for (const r of reports.filter(x => x.state === state)) {
        const key = `${r.targetType}:${r.targetId}`
        const found = r.contentType === 'topic' ? topics.find(x => x.id === r.targetId) : replies.find(x => x.id === r.targetId)
        const g: ModQueueItem = groups.get(key) || {
          targetType: r.targetType, targetId: r.targetId, contentType: r.contentType, count: 0, reasons: {}, notes: [], latestAt: Date.now(),
          target: found
            ? { status: found.status, excerpt: clip(found.body, 60), anon: !!found.anon, authorDeleted: false }
            : { status: 'ok', excerpt: `mock 内容 ${r.targetId}`, anon: false, authorDeleted: false }
        }
        g.count++
        g.reasons[r.reason] = (g.reasons[r.reason] || 0) + 1
        if (r.note) g.notes.push(r.note)
        groups.set(key, g)
      }
      const list = [...groups.values()].sort((a, b) => b.count - a.count)
      return { list, total: list.length, page: 1, size: 20, hasMore: false }
    },
    decide: (input) => {
      if (account.role !== 'mod' && account.role !== 'admin') throw new CloudError(ERROR_CODES.FORBIDDEN, '无权限')
      if (input.decision === 'mute' && (!input.days || input.days > 30)) throw new CloudError(ERROR_CODES.BAD_PARAM, '禁言天数需为 1–30')
      let n = 0
      for (const r of reports) {
        if (r.targetType === input.targetType && r.targetId === input.targetId && r.state === 'open') { r.state = 'resolved'; n++ }
      }
      if (!n) throw new CloudError(ERROR_CODES.NOT_FOUND, '举报目标不存在')
      const status = input.decision === 'remove' ? 'removed' : input.decision === 'mute' || input.decision === 'ban' ? null : 'ok'
      const hit = input.targetType === 'topic' ? topics.find(x => x.id === input.targetId) : input.targetType === 'reply' ? replies.find(x => x.id === input.targetId) : undefined
      if (hit && status) hit.status = status
      return { ok: true, resolved: n, status }
    },
    mediaQueue: () => {
      if (account.role !== 'mod' && account.role !== 'admin') throw new CloudError(ERROR_CODES.FORBIDDEN, '无权限')
      const list: MediaQueueItem[] = media.filter(m => m.status === 'pending' || m.status === 'review').map(m => ({
        mediaId: m.mediaId, purpose: 'avatar', purposeLabel: '头像', status: m.status as MediaQueueItem['status'], provider: 'wx', label: null, createdAt: Date.now(), url: `https://mock.example/${m.mediaId}.jpg`
      }))
      return { list, total: list.length, page: 1, size: 20, hasMore: false }
    },
    decideMedia: ({ mediaId, decision }) => {
      if (account.role !== 'mod' && account.role !== 'admin') throw new CloudError(ERROR_CODES.FORBIDDEN, '无权限')
      const m = media.find(x => x.mediaId === mediaId)
      if (!m) throw new CloudError(ERROR_CODES.NOT_FOUND, '图片记录不存在')
      const changed = m.status === 'pending' || m.status === 'review'
      if (changed) settleMock(m, decision)
      return { ok: true, status: m.status, changed }
    }
  },
  practice: {
    checkin: (input: PracticeCheckinInput) => {
      noUnknown(input, ['sessionId', 'date', 'practice', 'minutes'])
      const date = typeof input.date === 'string' ? input.date : ''
      const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
      const dateOk = !!dateMatch && Number(dateMatch[1]) >= 2000 && Number(dateMatch[1]) <= 2100 && new Date(Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]))).toISOString().slice(0, 10) === date
      if (typeof input.sessionId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(input.sessionId)) throw badParam('sessionId 格式不正确')
      if (!dateOk) throw badParam('date 必须是有效的 YYYY-MM-DD 日期')
      if (!PRACTICES.some(p => p.id === input.practice)) throw badParam('practice 不在支持范围内')
      if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 180) throw badParam('minutes 必须为 1–180 的整数')
      guard({ requirePhone: false, allowMuted: true })
      let row = checkins.find(c => c.date === input.date && c.practice === input.practice)
      const duplicate = !!row?.sessionIds.includes(input.sessionId)
      if (!row) {
        row = { date: input.date, practice: input.practice, minutes: input.minutes, sessionIds: [input.sessionId] }
        checkins.push(row)
      } else if (!duplicate) {
        row.minutes += input.minutes
        row.sessionIds.push(input.sessionId)
      }
      const result: PracticeCheckinResult = { date: row.date, practice: row.practice, minutes: row.minutes, duplicate }
      return { checkin: result }
    },
    listCheckins: (input: { month: string }) => {
      noUnknown(input, ['month'])
      if (typeof input.month !== 'string' || !/^(\d{4})-(0[1-9]|1[0-2])$/.test(input.month) || Number(input.month.slice(0, 4)) < 2000 || Number(input.month.slice(0, 4)) > 2100) throw badParam('month 必须是 YYYY-MM 格式')
      guard({ requirePhone: false, allowMuted: true })
      const days = new Map<string, DailyCheckin>()
      checkins.filter(c => c.date.slice(0, 7) === input.month).forEach(c => {
        const day = days.get(c.date) || { date: c.date, minutes: 0, practices: {} }
        day.minutes += c.minutes
        day.practices[c.practice] = (day.practices[c.practice] || 0) + c.minutes
        days.set(c.date, day)
      })
      const list = [...days.values()].sort((a, b) => a.date.localeCompare(b.date))

      const result: CheckinMonth = { month: input.month, list, totalMinutes: list.reduce((sum, day) => sum + day.minutes, 0) }
      return result
    },
    todayPrompt: (input: Record<string, never>) => {
      noUnknown(input, [])
      guard({ requirePhone: false, allowMuted: true })
      const date = mockCnDate()
      const prompt = prompts.find(p => p.date === date && p.status === 'ok')
      if (!prompt) return { prompt: null }
      const mine = promptAnswers.find(a => a.promptId === prompt.id && a.mine)
      return {
        prompt: {
          id: prompt.id,
          date: prompt.date,
          text: prompt.text,
          answered: !!mine,
          myStatus: mine ? mine.status : null,
          answerCount: promptAnswers.filter(a => a.promptId === prompt.id && a.status === 'ok').length
        }
      }
    },
    /** 与云函数同序：先判「题目失效 / 我已作答」（40401 / 40901），再走每日额度（42901） */
    answerPrompt: (input: PromptAnswerInput) => {
      noUnknown(input, ['promptId', 'text', 'anon'])
      if (typeof input.promptId !== 'string' || !input.promptId) throw badParam('promptId 不能为空')
      const text = typeof input.text === 'string' ? input.text.trim() : ''
      const { min, max } = PROMPT_RULES.answer
      if (text.length < min || text.length > max) throw badParam(`答案需 ${min}–${max} 字`)
      if ('anon' in input && typeof input.anon !== 'boolean') throw badParam('anon 需为布尔值')
      const prompt = prompts.find(p => p.id === input.promptId)
      if (!prompt || prompt.status !== 'ok') throw new CloudError(ERROR_CODES.NOT_FOUND, 'mock: 题目不存在或已结束')
      if (promptAnswers.some(a => a.promptId === prompt.id && a.mine)) throw new CloudError(ERROR_CODES.CONFLICT, 'mock: 今天已经作答过了')
      guard({ requirePhone: true, allowMuted: false })
      if (postedToday.answer >= DAILY_LIMITS.answerPrompt) {
        throw new CloudError(ERROR_CODES.TOO_MANY, `mock: 今日额度已用完（每天 ${DAILY_LIMITS.answerPrompt} 次），明天再来`)
      }
      const status = mockModerate(text)
      const row: MockPromptAnswer = {
        id: `pa${++answerSeq}`,
        promptId: prompt.id,
        date: prompt.date,
        text,
        anon: input.anon !== false,
        mine: true,
        authorName: '',
        status,
        createdAt: Date.now(),
        deleted: false
      }
      promptAnswers.push(row)
      postedToday.answer += 1
      const { id, date: d, text: t, anon, status: st, createdAt } = row
      return { answer: { id, date: d, text: t, anon, status: st, createdAt } }
    },
    /** 未作答 → 40301，且不返回任何他人答案；他人只看得到 ok */
    listAnswers: (input: { promptId: string, page?: number, size?: number }) => {
      noUnknown(input, ['promptId', 'page', 'size'])
      if (typeof input.promptId !== 'string' || !input.promptId) throw badParam('promptId 不能为空')
      const page = input.page === undefined ? 1 : input.page
      if (!Number.isInteger(page) || page < 1) throw badParam('page 需为正整数')
      const size = input.size === undefined ? MOCK_ANSWER_PAGE_SIZE : input.size
      if (!Number.isInteger(size) || size < 1 || size > PROMPT_RULES.listMax) throw badParam(`size 需为 1–${PROMPT_RULES.listMax} 的整数`)
      guard({ requirePhone: false, allowMuted: true })
      const prompt = prompts.find(p => p.id === input.promptId)
      if (!prompt) throw new CloudError(ERROR_CODES.NOT_FOUND, 'mock: 题目不存在')
      const mine = promptAnswers.find(a => a.promptId === prompt.id && a.mine)
      if (!mine) throw new CloudError(ERROR_CODES.FORBIDDEN, '作答后即可查看他人的回答')
      const others = promptAnswers.filter(a => a.promptId === prompt.id && !a.mine && a.status === 'ok')
        .sort((x, y) => x.createdAt - y.createdAt)
      const skip = (page - 1) * size
      const rows = others.slice(skip, skip + size)
      return {
        promptId: prompt.id,
        date: prompt.date,
        page,
        size,
        hasMore: others.length > skip + rows.length,
        list: rows.map(presentMockAnswer),
        mine: presentMockAnswer(mine)
      }
    }

  }
}

const tables: { [C in CollectionName]?: () => Array<CollectionMap[C]> } = {
  users: (): User[] => [{ _id: 'mock-user', _openid: MOCK_OPENID, createdAt: 0, lastActiveAt: 0, settings: { ...remoteSettings } }]
}

/** 登录态落到 STORAGE_KEYS.authSession（与 cloud.rn 同一格式），让 store/user readAuth 在 RN mock 模式下也能恢复 */
function setMockSession (s: MockSession | null) {
  mockSession = s
  if (s) setItem(STORAGE_KEYS.authSession, { accessToken: s.accessToken, refreshToken: 'mock-rt', expiresAt: s.expiresAt, uid: s.uid, method: s.method, accountId: s.accountId })
  else {
    removeItem(STORAGE_KEYS.authSession)
    removeItem(STORAGE_KEYS.authProfile)
  }
  useUserStore.getState().setAuth(readAuth())
}

const newSession = (uid: string, method: AuthMethod): MockSession => ({ uid, method, expiresAt: Date.now() + 2 * 60 * 60 * 1000, accessToken: `mock-at-${uid}` })

const mockAuth: CloudAuth = {
  session: () => mockSession,
  phone: {
    async sendCode (phone) {
      await gate()
      if (!/^1\d{10}$/.test(phone)) throw new CloudError(ERROR_CODES.BAD_PARAM, '请输入 11 位手机号')
      return { verificationId: `mock-vid-${phone}`, isUser: true, expiresIn: 600 }
    },
    async verifyCode (verificationId, code) {
      await gate()
      if (!verificationId || code !== MOCK_SMS_CODE) throw new CloudError(ERROR_CODES.AUTH_CODE_INVALID, '验证码不正确或已过期')
      return `mock-vtoken-${verificationId}`
    },
    async signIn (input, opts = {}) {
      await gate()
      if (!input.verificationToken) throw new CloudError(ERROR_CODES.AUTH_CODE_INVALID, '验证码不正确或已过期')
      const s = newSession(`mock-phone-${input.phone}`, 'phone')
      if (opts.persist !== false) { identities = { ...identities, phone: true }; setMockSession(s) }
      return s
    }
  },
  custom: {
    async signIn (ticket, method = 'wechat') {
      await gate()
      if (!ticket) throw new CloudError(ERROR_CODES.BAD_PARAM, '登录票据为空')
      const s = newSession(`mock-${method}-${ticket.slice(0, 8)}`, method)
      identities = { ...identities, wechat: method === 'wechat' }
      setMockSession(s)
      return s
    }
  },
  attachAccount (accountId) {
    if (mockSession && mockSession.accountId !== accountId) setMockSession({ ...mockSession, accountId })
  },
  async signOut () {
    setMockSession(null)
  },
  async deleteCloudUser () {
    setMockSession(null)
  }
}

export const mockCloud: CloudClient = {
  platform: 'weapp',
  // mock 云存储：返回形如 cloud://mock-env.mock-bucket/<cloudPath> 的 fileID
  storage: {
    async upload (localPath, cloudPath) {
      await gate()
      if (!localPath) throw new CloudError(ERROR_CODES.BAD_PARAM, '没有选择文件')
      mockControl.calls.push({ name: 'storage', action: 'upload', data: { cloudPath } })
      return `cloud://mock-env.mock-bucket/${cloudPath}`
    }
  },
  init: () => Promise.resolve(),
  identity: () => Promise.resolve({ uid: MOCK_OPENID, anonymous: false, method: mockSession?.method || null, accountId: mockSession?.accountId || null }),
  signOut: () => mockAuth.signOut(),
  auth: mockAuth,
  db: {
    async query (collection, opts = {}) {
      await gate()
      const rows = ((tables[collection] as any)?.() || []) as any[]
      // 与真实端一致：公开集合补 status: 'online'，私有集合补 _openid
      const where = withRuleWhere(collection, opts.where, MOCK_OPENID)
      const hit = rows.filter(r => Object.entries(where).every(([k, v]) => r[k] === v))
      const p = normalizePage(opts.page, opts.size)
      return { list: hit.slice(p.skip, p.skip + p.size), page: p.page, size: p.size, hasMore: hit.length > p.skip + p.size }
    },
    async get (collection, id) {
      const r = await mockCloud.db.query(collection, { where: { _id: id } as any, size: 1 })
      return r.list[0] || null
    }
  },
  fn: {
    async call (name, action, ...rest) {
      mockControl.calls.push({ name, action, data: rest[0] })
      await gate()
      const h = (handlers[name] as any)[action]
      if (!h) throw new CloudError(ERROR_CODES.BAD_PARAM, `mock: 未实现 ${name}.${action}`)
      return h(rest[0] || {})
    }
  }
}
