/**
 * Mock CloudClient：实现与真实端相同的 CloudClient 接口，按 docs/api/*.md 契约返回 `{ code, data }` 解包后的数据。
 * 切换真实数据：在 .env / .env.local 写 TARO_APP_DATA_SOURCE=cloud（见 services/client.ts），业务层不改。
 * 业务云函数落地时：在 FunctionMap 声明后，这里的 handlers 必须补上同名实现（类型会强制要求）。
 */
import type { AccountStatus, Profile, User, UserSettings } from '@/types/models'
import type { AccountIdentities } from '../cloud.types'
import { CONSENT_VERSION } from '@/constants/community'
import { normalizeLine, patchError } from '@/features/profile/rules'
import { readAuth, useUserStore } from '@/store/user'
import { removeItem, setItem, STORAGE_KEYS } from '@/utils/storage'
import {
  AuthMethod, CloudAuth, CloudClient, CloudError, CollectionMap, CollectionName, ERROR_CODES, FnAction, FnInput, FnName, FnOutput,
  SessionInfo, normalizePage, withRuleWhere
} from '../cloud.types'

/** mock 云端 users.settings：模拟「云端保存的设置」，login 时下发 */
let remoteSettings: UserSettings = {}

const NO_STATUS: AccountStatus = { phoneVerified: false, adult: false, role: 'user', bannedUntil: null, mutedUntil: null }
/** mock 云端账号状态（实名 / 18+ / 角色 / 处罚） */
let account: AccountStatus = { ...NO_STATUS }
/** mock 云端练习档案（community.getProfile / updateProfile） */
let profile: Profile | null = null
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

const MOCK_OPENID = 'mock-openid'

type Handler<N extends FnName, A extends FnAction<N>> = (data: FnInput<N, A>) => FnOutput<N, A>
type Handlers = { [N in FnName]: { [A in FnAction<N>]: Handler<N, A> } }

/** 与云端 guardWrite 一致的拦截：封禁 → 18+ → 实名 → 禁言 */
function guard (opts: { requirePhone: boolean }) {
  const now = Date.now()
  if (account.bannedUntil && account.bannedUntil > now) throw new CloudError(ERROR_CODES.BANNED, 'mock: 账号已被封禁')
  if (!account.adult) throw new CloudError(ERROR_CODES.ADULT_REQUIRED, 'mock: 请先确认年满 18 周岁')
  if (opts.requirePhone && !account.phoneVerified) throw new CloudError(ERROR_CODES.PHONE_REQUIRED, 'mock: 请先绑定手机号')
  if (account.mutedUntil && account.mutedUntil > now) throw new CloudError(ERROR_CODES.MUTED, 'mock: 账号禁言中')
}

const MOCK_ALIASES = ['竹影', '松声', '云眠', '溪语', '石径', '月光']

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
      remoteSettings = {}
      identities = { mp: false, wechat: false, phone: false, apple: false }
      account = { ...NO_STATUS }
      profile = null
      return { ok: true, removed }
    }
  },
  community: {
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
