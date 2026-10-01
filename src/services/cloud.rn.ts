/**
 * RN 端 CloudBase 接入（FE-RN-03 → FE-L01 登录体系）：CloudBase HTTP API（fetch），不用 Web SDK（js-sdk 的匿名登录在 RN 不可用，node-sdk 不能进客户端）。
 * 端点：https://{envId}.api.tcloudbasegateway.com（实测结论见 docs/api/user.md「App 登录流程」）
 *
 * 令牌策略（docs/api/user.md「App 登录流程」）：
 * 1. 公开读（PUBLIC_FUNCTIONS，starter 为空）：Publishable Key（TARO_APP_CLOUD_ACCESS_KEY）作 Bearer，不登录、不带任何设备标识；
 *    控制台须把这些函数设为 invoke: true；若被改回（403），已登录用户会改用会话 token 重试一次。
 * 2. 需要身份（user.* 及业务函数）：只用**用户登录后的会话**（手机号验证码 / 微信自定义登录票据），App 端不再有匿名登录。
 *    没有会话直接抛 LOGIN_REQUIRED（不发请求）；会话 { accessToken, refreshToken, expiresAt, uid, method, accountId? } 存 STORAGE_KEYS.authSession；
 *    过期前 60s 或收到 401 时刷新一次再重试；刷新 4xx（refresh_token 失效 / 30 天未使用）→ 清会话、同步 store 并抛 LOGIN_REQUIRED，由页面引导重新登录，不自动重登。
 *    免身份动作（user.wechatAppLogin / appleLogin 固定用 Publishable Key；user.whoami 无会话时用 Publishable Key）。
 * 3. 登录 API（auth 对象，见 cloud.types CloudAuth）：手机号 /auth/v1/verification → /verification/verify → /signin | /signup；
 *    微信 /auth/v1/signin/with/provider { provider_id: 'custom' }；退出 /auth/v1/revoke；注销 DELETE /auth/v1/user/me。
 *    这些请求带 Publishable Key + x-device-id（本地随机 UUID，非硬件标识，首次登录请求时才生成）。手机号只发给 CloudBase 身份认证服务。
 * 4. init() 只读本地会话，不发网络请求；identity() 未登录时返回 { uid: null }，不会为取身份触发登录。
 * 5. db.query / get：RN 不做数据库直连，业务层统一走云函数（me.favoriteIds 等），这里抛 NOT_READY。
 *
 * 响应结构（实测）：
 * - 函数调用成功：HTTP 200，body 即函数返回 { code, data, msg }（若网关外包一层 result / data.response_data 也兼容）；
 * - 网关错误：非 2xx，body { code: 'MISSING_CREDENTIALS' | 'EXCEED_AUTHORITY' | ..., message, requestId }；
 * - 认证接口错误：非 2xx，body { error, error_code, error_description }；
 * - 登录 / 刷新：{ token_type, access_token, refresh_token, expires_in, sub }；刷新会轮换 refresh_token。
 */
import { isConsented, readAuth, useUserStore } from '@/store/user'
import { getItem, removeItem, setItem, STORAGE_KEYS } from '@/utils/storage'
import { assertEnvId, cloudConfig } from './cloud.config'
import {
  AuthMethod, CloudAuth, CloudClient, CloudError, CloudIdentity, ERROR_CODES, FnName, FnResponse, SessionInfo, VerificationInfo, unwrap
} from './cloud.types'

export const REQUEST_TIMEOUT = 8000
/** 距过期不足该时长即先刷新 */
export const REFRESH_AHEAD = 60 * 1000
/** 大陆手机号：11 位，1 开头 */
export const PHONE_RE = /^1\d{10}$/

export interface AuthSession {
  accessToken: string
  refreshToken: string
  /** 毫秒时间戳 */
  expiresAt: number
  uid: string
  method: AuthMethod
  /** user.login 返回后由 auth.attachAccount 写入 */
  accountId?: string
}

/**
 * 不需要身份的函数（用 Publishable Key 调用）。starter 没有公开函数；业务的公开读函数（如内容列表）加在这里，
 * 并在 CloudBase 控制台把该函数的安全规则设为 invoke: true（见 docs/api/README.md）。
 */
export const PUBLIC_FUNCTIONS: string[] = [] // 元素为 FnName；声明为 string[] 便于测试注册虚构的公开函数
/** 固定用 Publishable Key 的动作（登录前的一跳） */
const PK_ONLY_ACTIONS: { [N in FnName]?: string[] } = { user: ['wechatAppLogin', 'appleLogin'] }
/** 有会话就带会话、没有也能用 Publishable Key 调的动作 */
const OPTIONAL_IDENTITY_ACTIONS: { [N in FnName]?: string[] } = { user: ['whoami'] }

const rt = {
  session: null as AuthSession | null,
  loaded: false,
  /** 单飞：同时只有一次刷新 */
  auth: null as Promise<AuthSession> | null,
  /** 公开函数规则被改回后已用会话 token 兜底成功过：后续公开读直接带 token，省一次 403 */
  publicNeedsToken: false
}

// ---------- 工具 ----------

function baseUrl (): string {
  return `https://${assertEnvId()}.api.tcloudbasegateway.com`
}

function publishableKey (): string {
  if (!cloudConfig.accessKey) throw new CloudError(ERROR_CODES.NOT_READY, '[cloud] 未配置 TARO_APP_CLOUD_ACCESS_KEY（Publishable Key）')
  return cloudConfig.accessKey
}

/** 本地随机设备号（UUID v4 格式）；仅用于身份认证接口的 x-device-id，首次登录请求时才生成 */
export function deviceId (): string {
  const saved = getItem<string>(STORAGE_KEYS.deviceId)
  if (saved) return saved
  const id = uuid()
  setItem(STORAGE_KEYS.deviceId, id)
  return id
}

function uuid (): string {
  let out = ''
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-'
    else if (i === 14) out += '4'
    else if (i === 19) out += ((Math.random() * 4) | 8).toString(16)
    else out += ((Math.random() * 16) | 0).toString(16)
  }
  return out
}

function isPublic (name: FnName): boolean {
  return PUBLIC_FUNCTIONS.includes(name as string)
}

function inList (table: { [N in FnName]?: string[] }, name: FnName, action: string): boolean {
  return (table[name] || []).includes(action)
}

function toCloudError (e: any): CloudError {
  if (e instanceof CloudError) return e
  if (e && e.name === 'AbortError') return new CloudError(ERROR_CODES.NETWORK, '请求超时')
  return new CloudError(ERROR_CODES.NETWORK, e?.message || '网络异常')
}

interface HttpResult {
  status: number
  body: any
}

const ok2xx = (r: HttpResult) => r.status >= 200 && r.status < 300

async function http (path: string, init: { method?: string, headers?: Record<string, string>, body?: unknown, timeout?: number } = {}): Promise<HttpResult> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), init.timeout || REQUEST_TIMEOUT) : null
  let res: { status: number, text(): Promise<string> }
  try {
    res = await fetch(baseUrl() + path, {
      method: init.method || 'POST',
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller ? controller.signal : undefined
    })
  } catch (e) {
    throw toCloudError(e)
  } finally {
    if (timer) clearTimeout(timer)
  }
  let body: any = null
  const text = await res.text().catch(() => '')
  if (text) {
    try {
      body = JSON.parse(text)
    } catch (e) {
      body = { raw: text }
    }
  }
  return { status: res.status, body }
}

/** 网关 / 认证接口的错误标识与文案 */
function errorParts (r: HttpResult, what: string): { code: string, msg: string } {
  const code = String(r.body?.code || r.body?.error || '')
  const msg = String(r.body?.message || r.body?.error_description || r.body?.raw || `${what} 失败（HTTP ${r.status}）`)
  return { code, msg }
}

/** 非 2xx 的网关错误 → CloudError */
function gatewayError (r: HttpResult, what: string): CloudError {
  const { code, msg } = errorParts(r, what)
  const suffix = code ? `（${code}）` : ''
  if (r.status === 401) return new CloudError(ERROR_CODES.UNAUTHORIZED, `${msg}${suffix}`)
  if (r.status === 403) return new CloudError(ERROR_CODES.FORBIDDEN, `${msg}${suffix}`)
  if (r.status === 429) return new CloudError(ERROR_CODES.TOO_MANY, msg)
  return new CloudError(ERROR_CODES.SERVER, `${msg}${suffix}`)
}

const isCaptcha = (r: HttpResult) => /captcha/i.test(String(r.body?.error || r.body?.code || '')) || r.body?.captcha_required === true

/** 认证接口（发码 / 校验 / 登录）的错误映射：文案直接给用户看 */
function authError (r: HttpResult, what: string, opts: { invalidCode?: boolean } = {}): CloudError {
  const { code, msg } = errorParts(r, what)
  if (isCaptcha(r)) return new CloudError(ERROR_CODES.AUTH_BUSY, '操作过于频繁，请稍后再试')
  if (r.status === 429) return new CloudError(ERROR_CODES.TOO_MANY, '发送太频繁，请 60 秒后再试')
  if (r.status >= 500) return new CloudError(ERROR_CODES.SERVER, `${msg}${code ? `（${code}）` : ''}`)
  if (opts.invalidCode && r.status >= 400 && r.status < 500) return new CloudError(ERROR_CODES.AUTH_CODE_INVALID, '验证码不正确或已过期')
  if (r.status === 401 || r.status === 403) return new CloudError(ERROR_CODES.UNAUTHORIZED, `${msg}${code ? `（${code}）` : ''}`)
  return new CloudError(ERROR_CODES.BAD_PARAM, `${msg}${code ? `（${code}）` : ''}`)
}

/** 网关可能直接返回函数结果，也可能包一层；统一取出 { code, data, msg } */
export function pickFnResponse (body: any): FnResponse<any> | undefined {
  if (!body || typeof body !== 'object') return undefined
  if (typeof body.code === 'number') return body as FnResponse<any>
  let inner = body.result !== undefined ? body.result : body.data?.response_data !== undefined ? body.data.response_data : body.data
  if (typeof inner === 'string') {
    try {
      inner = JSON.parse(inner)
    } catch (e) {
      return undefined
    }
  }
  return inner && typeof inner === 'object' && typeof inner.code === 'number' ? inner as FnResponse<any> : undefined
}

// ---------- 会话 ----------

const METHODS: AuthMethod[] = ['phone', 'wechat', 'apple']

function loadSession (): AuthSession | null {
  if (!rt.loaded) {
    rt.loaded = true
    const v = getItem<AuthSession>(STORAGE_KEYS.authSession)
    // 旧版匿名会话没有 method：视为未登录（切换到登录体系后匿名身份作废）
    rt.session = v && typeof v.accessToken === 'string' && typeof v.refreshToken === 'string' && typeof v.uid === 'string' && METHODS.includes(v.method) ? v : null
    if (v && !rt.session) removeItem(STORAGE_KEYS.authSession)
  }
  return rt.session
}

/** 落盘并同步 store（store 只拿摘要，不拿令牌） */
function saveSession (s: AuthSession | null) {
  rt.session = s
  rt.loaded = true
  if (s) setItem(STORAGE_KEYS.authSession, s)
  else {
    removeItem(STORAGE_KEYS.authSession)
    removeItem(STORAGE_KEYS.authProfile)
  }
  useUserStore.getState().setAuth(readAuth())
}

function toSession (body: any, method: AuthMethod, prev?: AuthSession | null): AuthSession {
  const access = body?.access_token
  const refresh = body?.refresh_token || prev?.refreshToken
  const uid = body?.sub || prev?.uid
  if (typeof access !== 'string' || !access || typeof refresh !== 'string' || typeof uid !== 'string') {
    throw new CloudError(ERROR_CODES.SERVER, '登录响应格式错误')
  }
  const ttl = Number(body.expires_in) > 0 ? Number(body.expires_in) * 1000 : 2 * 60 * 60 * 1000
  return { accessToken: access, refreshToken: refresh, expiresAt: Date.now() + ttl, uid, method, accountId: prev?.accountId }
}

const summary = (s: AuthSession): SessionInfo => ({ uid: s.uid, method: s.method, accountId: s.accountId, expiresAt: s.expiresAt })

const loginRequired = (msg = '请先登录') => new CloudError(ERROR_CODES.LOGIN_REQUIRED, msg)

/** 认证接口通用请求头：Publishable Key + 设备号 */
function authHeaders (): Record<string, string> {
  return { Authorization: `Bearer ${publishableKey()}`, 'x-device-id': deviceId() }
}

async function refresh (prev: AuthSession): Promise<AuthSession> {
  const r = await http('/auth/v1/token', {
    headers: authHeaders(),
    body: { grant_type: 'refresh_token', refresh_token: prev.refreshToken }
  })
  if (ok2xx(r)) {
    const s = toSession(r.body, prev.method, prev)
    saveSession(s)
    return s
  }
  if (r.status >= 500 || r.status === 429 || r.status === 0) throw gatewayError(r, '刷新登录态')
  // 4xx：refresh_token 已失效 / 已被别的进程轮换 / 30 天未使用：清会话，交给页面引导重新登录（不自动重登）
  console.warn('[cloud] 刷新登录态失败，需要重新登录', r.status, r.body?.error_code || r.body?.code)
  saveSession(null)
  throw loginRequired('登录已过期，请重新登录')
}

/** 取可用的 access_token（必要时刷新）；同意前抛 CONSENT_REQUIRED，未登录抛 LOGIN_REQUIRED，都不发请求 */
async function accessToken (opts: { force?: boolean } = {}): Promise<AuthSession> {
  if (!isConsented()) throw new CloudError(ERROR_CODES.CONSENT_REQUIRED, '需同意协议后可用')
  const s = loadSession()
  if (!s) throw loginRequired()
  if (rt.auth) return rt.auth
  if (!opts.force && s.expiresAt - Date.now() > REFRESH_AHEAD) return s
  rt.auth = refresh(s).finally(() => { rt.auth = null })
  return rt.auth
}

// ---------- 登录 API ----------

function formatPhone (phone: string): string {
  const digits = String(phone || '').replace(/\D/g, '')
  if (!PHONE_RE.test(digits)) throw new CloudError(ERROR_CODES.BAD_PARAM, '请输入 11 位手机号')
  return `+86 ${digits}`
}

const isNotFound = (r: HttpResult) => r.status === 404 || /not[_ ]?found|not[_ ]?exist/i.test(`${r.body?.error || ''} ${r.body?.error_description || ''}`)
const isExists = (r: HttpResult) => r.status === 409 || /exist|already|registered/i.test(`${r.body?.error || ''} ${r.body?.error_description || ''}`)

async function signInWithToken (verificationToken: string): Promise<HttpResult> {
  return http('/auth/v1/signin', { headers: authHeaders(), body: { verification_token: verificationToken } })
}

async function signUpWithToken (phoneNumber: string, verificationToken: string): Promise<HttpResult> {
  return http('/auth/v1/signup', { headers: authHeaders(), body: { phone_number: phoneNumber, verification_token: verificationToken } })
}

export const auth: CloudAuth = {
  session () {
    const s = loadSession()
    return s ? summary(s) : null
  },

  phone: {
    async sendCode (phone) {
      const r = await http('/auth/v1/verification', { headers: authHeaders(), body: { phone_number: formatPhone(phone), target: 'ANY' } })
      if (!ok2xx(r)) throw authError(r, '发送验证码')
      const id = r.body?.verification_id
      if (typeof id !== 'string' || !id) throw new CloudError(ERROR_CODES.SERVER, '发送验证码响应格式错误')
      const info: VerificationInfo = { verificationId: id, isUser: r.body?.is_user === true, expiresIn: Number(r.body?.expires_in) > 0 ? Number(r.body.expires_in) : 600 }
      return info
    },

    async verifyCode (verificationId, code) {
      const digits = String(code || '').trim()
      if (!/^\d{4,8}$/.test(digits)) throw new CloudError(ERROR_CODES.AUTH_CODE_INVALID, '验证码不正确或已过期')
      const r = await http('/auth/v1/verification/verify', { headers: authHeaders(), body: { verification_id: verificationId, verification_code: digits } })
      if (!ok2xx(r)) throw authError(r, '校验验证码', { invalidCode: true })
      const token = r.body?.verification_token
      if (typeof token !== 'string' || !token) throw new CloudError(ERROR_CODES.SERVER, '校验验证码响应格式错误')
      return token
    },

    async signIn (input, opts = {}) {
      const phoneNumber = formatPhone(input.phone)
      // 已注册走 signin、未注册走 signup；is_user 只是提示，两条路互为兜底
      let r: HttpResult
      if (input.isUser === false) {
        r = await signUpWithToken(phoneNumber, input.verificationToken)
        if (!ok2xx(r) && isExists(r)) r = await signInWithToken(input.verificationToken)
      } else {
        r = await signInWithToken(input.verificationToken)
        if (!ok2xx(r) && isNotFound(r)) r = await signUpWithToken(phoneNumber, input.verificationToken)
      }
      if (!ok2xx(r)) throw authError(r, '手机号登录', { invalidCode: true })
      const s = toSession(r.body, 'phone')
      if (opts.persist !== false) saveSession(s)
      return { ...summary(s), accessToken: s.accessToken }
    }
  },

  custom: {
    async signIn (ticket, method = 'wechat') {
      if (typeof ticket !== 'string' || !ticket) throw new CloudError(ERROR_CODES.BAD_PARAM, '登录票据为空')
      const r = await http('/auth/v1/signin/with/provider', { headers: authHeaders(), body: { provider_id: 'custom', provider_token: ticket } })
      if (!ok2xx(r)) throw authError(r, '微信登录')
      const s = toSession(r.body, method)
      saveSession(s)
      return summary(s)
    }
  },

  attachAccount (accountId) {
    const s = loadSession()
    if (!s || typeof accountId !== 'string' || !accountId || s.accountId === accountId) return
    saveSession({ ...s, accountId })
  },

  async signOut () {
    const s = loadSession()
    rt.auth = null
    rt.publicNeedsToken = false
    saveSession(null)
    if (!s) return
    try {
      await http('/auth/v1/revoke', { headers: { Authorization: `Bearer ${s.accessToken}` }, body: { refresh_token: s.refreshToken } })
    } catch (e) {
      console.warn('[cloud] 撤销会话失败（本地已清除）', e)
    }
  },

  async deleteCloudUser () {
    let s = loadSession()
    if (!s) return
    try {
      if (s.expiresAt - Date.now() <= REFRESH_AHEAD) s = await refresh(s)
      const r = await http('/auth/v1/user/me', { method: 'DELETE', headers: { Authorization: `Bearer ${s.accessToken}` } })
      if (!ok2xx(r)) console.warn('[cloud] 注销 CloudBase 用户失败', r.status, r.body?.error || r.body?.code)
    } catch (e) {
      console.warn('[cloud] 注销 CloudBase 用户失败', e)
    } finally {
      rt.auth = null
      rt.publicNeedsToken = false
      saveSession(null)
    }
  }
}

// ---------- 函数调用 ----------

async function invoke (name: string, payload: Record<string, unknown>, bearer: string): Promise<HttpResult> {
  return http(`/v1/functions/${name}`, { headers: { Authorization: `Bearer ${bearer}` }, body: payload })
}

async function callFunction (name: FnName, action: string, data: Record<string, unknown>): Promise<any> {
  const payload = { action, ...data }
  let r: HttpResult

  if (isPublic(name) && !rt.publicNeedsToken) {
    r = await invoke(name, payload, publishableKey())
    if ((r.status === 401 || r.status === 403) && isConsented() && loadSession()) {
      // 公开函数规则被改回：已登录用户改用会话 token 兜底
      const s = await accessToken()
      r = await invoke(name, payload, s.accessToken)
      if (ok2xx(r)) rt.publicNeedsToken = true
    }
  } else if (inList(PK_ONLY_ACTIONS, name, action) || (inList(OPTIONAL_IDENTITY_ACTIONS, name, action) && !loadSession())) {
    r = await invoke(name, payload, publishableKey())
  } else {
    let s = await accessToken()
    r = await invoke(name, payload, s.accessToken)
    if (r.status === 401) {
      s = await accessToken({ force: true })
      r = await invoke(name, payload, s.accessToken)
    }
  }

  if (!ok2xx(r)) throw gatewayError(r, `${name}.${action}`)
  return unwrap(pickFnResponse(r.body), name, action)
}

// ---------- CloudClient ----------

const notReady = () => Promise.reject(new CloudError(ERROR_CODES.NOT_READY, 'RN 端不直连数据库，请改用云函数（如 me.favoriteIds）'))

export const cloud: CloudClient = {
  platform: 'rn',

  init () {
    if (!cloudConfig.envId) console.warn('[cloud] 未配置 TARO_APP_CLOUD_ENV_ID')
    if (!cloudConfig.accessKey) console.warn('[cloud] 未配置 TARO_APP_CLOUD_ACCESS_KEY，公开内容将无法读取')
    // 只读本地会话；不发任何网络请求
    loadSession()
    return Promise.resolve()
  },

  async identity (): Promise<CloudIdentity> {
    const s = loadSession()
    return { uid: s ? s.uid : null, anonymous: false, method: s ? s.method : null, accountId: s?.accountId || null }
  },

  /** 退出登录（与 auth.signOut 相同；保留给通用调用方） */
  signOut: () => auth.signOut(),

  auth,

  db: {
    query: notReady,
    get: notReady
  },

  fn: {
    async call (name, action, ...rest) {
      try {
        return await callFunction(name, action, (rest[0] || {}) as Record<string, unknown>)
      } catch (e) {
        throw toCloudError(e)
      }
    }
  }
}

export function initCloud () {
  return cloud.init()
}

/** 测试用：忘掉内存中的会话与兜底标记 */
export function __resetCloudForTest (): void {
  rt.session = null
  rt.loaded = false
  rt.auth = null
  rt.publicNeedsToken = false
}

export * from './cloud.types'
