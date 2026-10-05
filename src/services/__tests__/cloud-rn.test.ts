/**
 * RN 端 CloudBase HTTP 客户端（cloud.rn.ts，FE-L01 登录体系）：用 fetch 替身验证令牌策略
 * （公开读只走 Publishable Key；身份类调用无会话 → LOGIN_REQUIRED 且不发请求；手机号三步登录；票据登录；刷新 / 401 重试；刷新 4xx 清会话不自动重登）、
 * 响应解包与错误映射。端点与响应结构以 docs/mvp/plans/rn-backend-spike.md、rn-login-spike.md 的实测为准。
 */
export {}

const OLD_ENV = process.env
const BASE = 'https://env-rn.api.tcloudbasegateway.com'

interface Call { url: string, method: string, headers: Record<string, string>, body: any }

function jsonRes (status: number, body: unknown) {
  return { status, text: async () => (body === undefined ? '' : JSON.stringify(body)) }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function setup (opts: { consented?: boolean, session?: any, accessKey?: string } = {}) {
  jest.resetModules()
  process.env = { ...OLD_ENV, TARO_ENV: 'rn', TARO_APP_CLOUD_ENV_ID: 'env-rn', TARO_APP_CLOUD_ACCESS_KEY: opts.accessKey === undefined ? 'pk_test' : opts.accessKey }
  const Taro = require('@tarojs/taro').default
  Taro.__storage.clear()
  if (opts.session) Taro.__storage.set('auth_session', opts.session)
  const calls: Call[] = []
  const queue: Array<{ status: number, body: unknown } | Error> = []
  const fetchMock = jest.fn(async (url: string, init: any) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined })
    const next = queue.shift()
    if (!next) throw new Error(`unexpected request ${url}`)
    if (next instanceof Error) throw next
    return jsonRes(next.status, next.body)
  })
  ;(global as any).fetch = fetchMock
  const { useUserStore, readAuth } = require('@/store/user')
  useUserStore.setState({ consent: opts.consented === false ? 'unknown' : 'agreed', auth: readAuth() })
  const mod = require('@/services/cloud.rn')
  // starter 没有公开函数：注册一个虚构的 demo 函数来覆盖公开读路径（业务的公开函数同理加入 PUBLIC_FUNCTIONS）
  mod.PUBLIC_FUNCTIONS.splice(0, mod.PUBLIC_FUNCTIONS.length, 'demo')
  const { ERROR_CODES } = require('@/services/cloud.types')
  const reply = (status: number, body: unknown) => queue.push({ status, body })
  const fail = (e: Error) => queue.push(e)
  return { mod, cloud: mod.cloud, auth: mod.auth, calls, reply, fail, ERROR_CODES, Taro, useUserStore }
}

const tokenBody = (uid = 'uid-1', at = 'at-1', rt = 'rt-1') => ({ token_type: 'Bearer', access_token: at, refresh_token: rt, expires_in: 7200, sub: uid })
const fnOk = (data: unknown) => ({ code: 0, data, msg: 'ok' })
const phoneSession = (over: Record<string, unknown> = {}) => ({ accessToken: 'at-p', refreshToken: 'rt-p', expiresAt: Date.now() + 3600 * 1000, uid: 'uid-p', method: 'phone', ...over })

afterEach(() => { process.env = OLD_ENV })

describe('cloud.rn：公开读', () => {
  it('公开函数用 Publishable Key 直接调函数，不登录、不带设备号（登录与否都一样）', async () => {
    const { cloud, calls, reply } = setup({ consented: false })
    reply(200, fnOk({ banners: [] }))
    const data = await (cloud.fn.call as any)('demo', 'list', { age: '3-5' })
    expect(data).toEqual({ banners: [] })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${BASE}/v1/functions/demo`)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].headers.Authorization).toBe('Bearer pk_test')
    expect(calls[0].headers['x-device-id']).toBeUndefined()
    expect(calls[0].body).toEqual({ action: 'list', age: '3-5' })
  })

  it('公开读 403（规则被改回）：已登录用户改用会话 token 兜底，之后直接带 token', async () => {
    const { cloud, calls, reply } = setup({ session: phoneSession() })
    reply(403, { code: 'EXCEED_AUTHORITY', message: 'no permission' })
    reply(200, fnOk({ list: [1] }))
    expect(await cloud.fn.call('demo', 'detail', { id: 'a' })).toEqual({ list: [1] })
    expect(calls.map(c => c.url)).toEqual([`${BASE}/v1/functions/demo`, `${BASE}/v1/functions/demo`])
    expect(calls[1].headers.Authorization).toBe('Bearer at-p')
    reply(200, fnOk({ list: [2] }))
    await cloud.fn.call('demo', 'list')
    expect(calls).toHaveLength(3)
    expect(calls[2].headers.Authorization).toBe('Bearer at-p')
  })

  it('公开读 403 且未登录：抛 FORBIDDEN，不会尝试登录', async () => {
    const { cloud, calls, reply, ERROR_CODES } = setup()
    reply(403, { code: 'EXCEED_AUTHORITY', message: 'no permission' })
    await expect(cloud.fn.call('demo', 'list')).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN })
    expect(calls).toHaveLength(1)
  })

  it('未配置 Publishable Key 时公开读抛 NOT_READY', async () => {
    const { cloud, ERROR_CODES } = setup({ accessKey: '' })
    await expect(cloud.fn.call('demo', 'list')).rejects.toMatchObject({ code: ERROR_CODES.NOT_READY })
  })
})

describe('cloud.rn：需要身份的调用（无匿名登录）', () => {
  it('未登录时身份类调用直接抛 LOGIN_REQUIRED，不发任何请求；identity 为空', async () => {
    const { cloud, calls, ERROR_CODES, useUserStore } = setup()
    await expect(cloud.fn.call('user', 'updateSettings', { theme: 'x' })).rejects.toMatchObject({ code: ERROR_CODES.LOGIN_REQUIRED })
    await expect(cloud.fn.call('user', 'login', { platform: 'app' })).rejects.toMatchObject({ code: ERROR_CODES.LOGIN_REQUIRED })
    expect(calls).toHaveLength(0)
    expect(await cloud.identity()).toEqual({ uid: null, anonymous: false, method: null, accountId: null })
    expect(useUserStore.getState().auth.signedIn).toBe(false)
  })

  it('未同意时即使有会话也抛 CONSENT_REQUIRED（同意门先于登录门）', async () => {
    const { cloud, calls, ERROR_CODES } = setup({ consented: false, session: phoneSession() })
    await expect(cloud.fn.call('user', 'updateSettings', { theme: 'x' })).rejects.toMatchObject({ code: ERROR_CODES.CONSENT_REQUIRED })
    expect(calls).toHaveLength(0)
  })

  it('user.wechatAppLogin 固定用 Publishable Key；user.whoami 无会话时也用 Publishable Key', async () => {
    const { cloud, calls, reply } = setup()
    reply(200, fnOk({ ticket: 't', linkToken: 'l' }))
    reply(200, fnOk({ anonymous: false }))
    await cloud.fn.call('user', 'wechatAppLogin', { code: 'abcdefgh' })
    await cloud.fn.call('user', 'whoami')
    expect(calls.map(c => c.headers.Authorization)).toEqual(['Bearer pk_test', 'Bearer pk_test'])
    expect(calls[0].body).toEqual({ action: 'wechatAppLogin', code: 'abcdefgh' })
  })

  it('旧版匿名会话（无 method）视为未登录并从本地删除', async () => {
    const legacy = { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1e6, uid: 'anon-uid' }
    const { cloud, calls, ERROR_CODES, Taro } = setup({ session: legacy })
    await cloud.init()
    expect(Taro.__storage.has('auth_session')).toBe(false)
    expect(await cloud.identity()).toMatchObject({ uid: null })
    await expect(cloud.fn.call('user', 'updateSettings', { theme: 'x' })).rejects.toMatchObject({ code: ERROR_CODES.LOGIN_REQUIRED })
    expect(calls.filter(c => c.url.includes('/auth/'))).toHaveLength(0)
  })

  it('已登录：带 access_token 调函数，第二次复用会话', async () => {
    const { cloud, calls, reply, useUserStore } = setup({ session: phoneSession({ accountId: 'acc-1' }) })
    reply(200, fnOk({ ids: ['a1'] }))
    expect(await cloud.fn.call('user', 'updateSettings', { theme: 'x' })).toEqual({ ids: ['a1'] })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${BASE}/v1/functions/user`)
    expect(calls[0].headers.Authorization).toBe('Bearer at-p')
    expect(calls[0].body).toEqual({ action: 'updateSettings', theme: 'x' })
    expect(await cloud.identity()).toEqual({ uid: 'uid-p', anonymous: false, method: 'phone', accountId: 'acc-1' })
    expect(useUserStore.getState().auth).toMatchObject({ signedIn: true, uid: 'uid-p', method: 'phone', accountId: 'acc-1' })
    reply(200, fnOk(1))
    await cloud.fn.call('user', 'updateSettings', { theme: 'x' })
    expect(calls).toHaveLength(2)
    expect(calls[1].headers.Authorization).toBe('Bearer at-p')
  })

  it('会话临近过期：先用 refresh_token 刷新（Publishable Key + 设备号，轮换后落盘）再调函数；并发只刷新一次', async () => {
    const soon = phoneSession({ accessToken: 'old-at', refreshToken: 'old-rt', expiresAt: Date.now() + 30 * 1000 })
    const { cloud, calls, reply, Taro } = setup({ session: soon })
    reply(200, tokenBody('uid-p', 'new-at', 'new-rt'))
    reply(200, fnOk('ok'))
    reply(200, fnOk('ok2'))
    const [a, b] = await Promise.all([cloud.fn.call('user', 'updateSettings', { theme: 'x' }), cloud.fn.call('user', 'updateSettings', { theme: 'x' })])
    expect([a, b]).toEqual(['ok', 'ok2'])
    expect(calls[0].url).toBe(`${BASE}/auth/v1/token`)
    expect(calls[0].headers.Authorization).toBe('Bearer pk_test')
    expect(calls[0].headers['x-device-id']).toMatch(UUID_RE)
    expect(calls[0].body).toEqual({ grant_type: 'refresh_token', refresh_token: 'old-rt' })
    expect(calls.filter(c => c.url.includes('/auth/'))).toHaveLength(1)
    expect(calls[1].headers.Authorization).toBe('Bearer new-at')
    expect(Taro.__storage.get('auth_session')).toMatchObject({ accessToken: 'new-at', refreshToken: 'new-rt', uid: 'uid-p', method: 'phone' })
  })

  it('函数返回 401：强制刷新后重试一次', async () => {
    const { cloud, calls, reply } = setup({ session: phoneSession({ accessToken: 'at-old', refreshToken: 'rt-old' }) })
    reply(401, { code: 'INVALID_TOKEN', message: 'expired' })
    reply(200, tokenBody('uid-p', 'at-new', 'rt-new'))
    reply(200, fnOk('again'))
    expect(await cloud.fn.call('user', 'updateSettings', { theme: 'x' })).toBe('again')
    expect(calls.map(c => c.url)).toEqual([`${BASE}/v1/functions/user`, `${BASE}/auth/v1/token`, `${BASE}/v1/functions/user`])
    expect(calls[2].headers.Authorization).toBe('Bearer at-new')
  })

  it('refresh_token 失效（4xx）：清会话、store 变为未登录、抛 LOGIN_REQUIRED，不自动重登', async () => {
    const stale = phoneSession({ refreshToken: 'rt-used', expiresAt: 0 })
    const { cloud, calls, reply, ERROR_CODES, Taro, useUserStore } = setup({ session: stale })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    reply(400, { error: 'invalid_grant', error_code: 4026, error_description: 'refresh token invalid' })
    await expect(cloud.fn.call('user', 'updateSettings', { theme: 'x' })).rejects.toMatchObject({ code: ERROR_CODES.LOGIN_REQUIRED })
    expect(calls.map(c => c.url)).toEqual([`${BASE}/auth/v1/token`])
    expect(Taro.__storage.has('auth_session')).toBe(false)
    expect(useUserStore.getState().auth.signedIn).toBe(false)
    expect(await cloud.identity()).toMatchObject({ uid: null })
    // 再调一次：不会再发请求
    await expect(cloud.fn.call('user', 'updateSettings', { theme: 'x' })).rejects.toBeTruthy()
    expect(calls.filter(c => c.url.includes('/auth/'))).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('刷新遇到 5xx 不清会话，直接抛 SERVER', async () => {
    const { cloud, calls, reply, ERROR_CODES, Taro } = setup({ session: phoneSession({ expiresAt: 0 }) })
    reply(500, { code: 'INTERNAL', message: 'oops' })
    await expect(cloud.fn.call('user', 'updateSettings', { theme: 'x' })).rejects.toMatchObject({ code: ERROR_CODES.SERVER })
    expect(calls).toHaveLength(1)
    expect(Taro.__storage.has('auth_session')).toBe(true)
  })

  it('db 直连抛 NOT_READY', async () => {
    const { cloud, ERROR_CODES } = setup()
    await expect(cloud.db.query('favorites', {})).rejects.toMatchObject({ code: ERROR_CODES.NOT_READY })
  })
})

describe('cloud.rn：手机号验证码登录（auth.phone）', () => {
  it('sendCode：+86 格式、target ANY、Publishable Key + 设备号；返回 verificationId / isUser', async () => {
    const { auth, calls, reply, Taro, mod } = setup()
    reply(200, { verification_id: 'vid-1', expires_in: 600, is_user: true })
    expect(await auth.phone.sendCode('13800138000')).toEqual({ verificationId: 'vid-1', isUser: true, expiresIn: 600 })
    expect(calls[0].url).toBe(`${BASE}/auth/v1/verification`)
    expect(calls[0].headers.Authorization).toBe('Bearer pk_test')
    expect(calls[0].headers['x-device-id']).toMatch(UUID_RE)
    expect(calls[0].body).toEqual({ phone_number: '+86 13800138000', target: 'ANY' })
    expect(Taro.__storage.get('device_id')).toBe(calls[0].headers['x-device-id'])
    expect(mod.deviceId()).toBe(calls[0].headers['x-device-id'])
  })

  it('sendCode：手机号不合法不发请求；429 → TOO_MANY；captcha_required → AUTH_BUSY', async () => {
    const { auth, calls, reply, ERROR_CODES } = setup()
    await expect(auth.phone.sendCode('1380013')).rejects.toMatchObject({ code: ERROR_CODES.BAD_PARAM })
    expect(calls).toHaveLength(0)
    reply(429, { error: 'too_many_requests', error_description: 'slow down' })
    await expect(auth.phone.sendCode('13800138000')).rejects.toMatchObject({ code: ERROR_CODES.TOO_MANY, message: '发送太频繁，请 60 秒后再试' })
    reply(400, { error: 'captcha_required', error_description: 'need captcha' })
    await expect(auth.phone.sendCode('13800138000')).rejects.toMatchObject({ code: ERROR_CODES.AUTH_BUSY })
  })

  it('verifyCode：返回 verification_token；4xx → AUTH_CODE_INVALID；格式不对不发请求', async () => {
    const { auth, calls, reply, ERROR_CODES } = setup()
    reply(200, { verification_token: 'vt-1' })
    expect(await auth.phone.verifyCode('vid-1', '123456')).toBe('vt-1')
    expect(calls[0].url).toBe(`${BASE}/auth/v1/verification/verify`)
    expect(calls[0].body).toEqual({ verification_id: 'vid-1', verification_code: '123456' })
    reply(400, { error: 'invalid_verification_code', error_description: 'wrong code' })
    await expect(auth.phone.verifyCode('vid-1', '000000')).rejects.toMatchObject({ code: ERROR_CODES.AUTH_CODE_INVALID })
    await expect(auth.phone.verifyCode('vid-1', 'ab')).rejects.toMatchObject({ code: ERROR_CODES.AUTH_CODE_INVALID })
    expect(calls).toHaveLength(2)
  })

  it('signIn：已注册走 /signin，会话落盘（method phone）并同步 store', async () => {
    const { auth, calls, reply, Taro, useUserStore, cloud } = setup()
    reply(200, tokenBody('uid-p1', 'at-1', 'rt-1'))
    const s = await auth.phone.signIn({ phone: '13800138000', verificationToken: 'vt-1', isUser: true })
    expect(s).toMatchObject({ uid: 'uid-p1', method: 'phone', accessToken: 'at-1' })
    expect(calls.map(c => c.url)).toEqual([`${BASE}/auth/v1/signin`])
    expect(calls[0].body).toEqual({ verification_token: 'vt-1' })
    expect(Taro.__storage.get('auth_session')).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1', uid: 'uid-p1', method: 'phone' })
    expect(useUserStore.getState().auth).toMatchObject({ signedIn: true, uid: 'uid-p1', method: 'phone' })
    expect(auth.session()).toMatchObject({ uid: 'uid-p1', method: 'phone' })
    // 随后身份类调用直接带新会话
    reply(200, fnOk({ ok: true }))
    await cloud.fn.call('user', 'login', { platform: 'app' })
    expect(calls[1].headers.Authorization).toBe('Bearer at-1')
  })

  it('signIn：未注册（signin not_found）自动改走 /signup；isUser=false 先 signup、已存在再回退 signin', async () => {
    const { auth, calls, reply } = setup()
    reply(404, { error: 'not_found', error_description: 'user not found' })
    reply(200, tokenBody('uid-new'))
    await auth.phone.signIn({ phone: '13800138000', verificationToken: 'vt-1' })
    expect(calls.map(c => c.url)).toEqual([`${BASE}/auth/v1/signin`, `${BASE}/auth/v1/signup`])
    expect(calls[1].body).toEqual({ phone_number: '+86 13800138000', verification_token: 'vt-1' })

    calls.length = 0
    reply(409, { error: 'user_already_exists' })
    reply(200, tokenBody('uid-old'))
    await auth.phone.signIn({ phone: '13800138000', verificationToken: 'vt-2', isUser: false })
    expect(calls.map(c => c.url)).toEqual([`${BASE}/auth/v1/signup`, `${BASE}/auth/v1/signin`])
  })

  it('signIn persist:false：只返回会话，不落盘、不改变当前登录态（绑定手机号用）', async () => {
    const { auth, reply, Taro, useUserStore } = setup({ session: phoneSession({ uid: 'uid-wx', method: 'wechat' }) })
    reply(200, tokenBody('uid-other', 'at-other', 'rt-other'))
    const s = await auth.phone.signIn({ phone: '13800138000', verificationToken: 'vt', isUser: true }, { persist: false })
    expect(s).toMatchObject({ uid: 'uid-other', accessToken: 'at-other' })
    expect(Taro.__storage.get('auth_session')).toMatchObject({ uid: 'uid-wx', method: 'wechat' })
    expect(useUserStore.getState().auth).toMatchObject({ uid: 'uid-wx', method: 'wechat' })
  })
})

describe('cloud.rn：票据登录、账号、退出、注销', () => {
  it('custom.signIn：POST /signin/with/provider { provider_id: custom }，method 默认 wechat；attachAccount 写入 accountId', async () => {
    const { auth, calls, reply, Taro, useUserStore, cloud } = setup()
    reply(200, tokenBody('acc-unionid-1', 'at-c', 'rt-c'))
    expect(await auth.custom.signIn('kid/@@/jwt')).toMatchObject({ uid: 'acc-unionid-1', method: 'wechat' })
    expect(calls[0].url).toBe(`${BASE}/auth/v1/signin/with/provider`)
    expect(calls[0].headers.Authorization).toBe('Bearer pk_test')
    expect(calls[0].body).toEqual({ provider_id: 'custom', provider_token: 'kid/@@/jwt' })
    auth.attachAccount('acc-unionid-1')
    expect(Taro.__storage.get('auth_session')).toMatchObject({ uid: 'acc-unionid-1', method: 'wechat', accountId: 'acc-unionid-1' })
    expect(useUserStore.getState().auth).toMatchObject({ signedIn: true, method: 'wechat', accountId: 'acc-unionid-1' })
    expect(await cloud.identity()).toEqual({ uid: 'acc-unionid-1', anonymous: false, method: 'wechat', accountId: 'acc-unionid-1' })
  })

  it('signOut：先清本地（会话 + 摘要）再尽力 revoke；revoke 失败也算退出', async () => {
    const { auth, calls, reply, Taro, useUserStore } = setup({ session: phoneSession() })
    Taro.__storage.set('auth_profile', { phoneMasked: '138****8000' })
    reply(500, { error: 'boom' })
    await auth.signOut()
    expect(calls.map(c => c.url)).toEqual([`${BASE}/auth/v1/revoke`])
    expect(calls[0].headers.Authorization).toBe('Bearer at-p')
    expect(calls[0].body).toEqual({ refresh_token: 'rt-p' })
    expect(Taro.__storage.has('auth_session')).toBe(false)
    expect(Taro.__storage.has('auth_profile')).toBe(false)
    expect(useUserStore.getState().auth.signedIn).toBe(false)
    // 未登录时 signOut 不发请求
    await auth.signOut()
    expect(calls).toHaveLength(1)
  })

  it('deleteCloudUser：DELETE /auth/v1/user/me（带 access_token），失败不抛出，之后本地未登录', async () => {
    const { auth, calls, reply, Taro, useUserStore } = setup({ session: phoneSession() })
    reply(204, undefined)
    await auth.deleteCloudUser()
    expect(calls[0]).toMatchObject({ url: `${BASE}/auth/v1/user/me`, method: 'DELETE' })
    expect(calls[0].headers.Authorization).toBe('Bearer at-p')
    expect(Taro.__storage.has('auth_session')).toBe(false)
    expect(useUserStore.getState().auth.signedIn).toBe(false)

    const again = setup({ session: phoneSession() })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    again.reply(403, { error: 'forbidden' })
    await expect(again.auth.deleteCloudUser()).resolves.toBeUndefined()
    expect(again.Taro.__storage.has('auth_session')).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('cloud.rn：响应解包与错误映射', () => {
  it('pickFnResponse 兼容直接返回 / result 包装 / response_data 字符串', () => {
    const { mod } = setup()
    const body = { code: 0, data: { a: 1 }, msg: 'ok' }
    expect(mod.pickFnResponse(body)).toEqual(body)
    expect(mod.pickFnResponse({ result: body })).toEqual(body)
    expect(mod.pickFnResponse({ data: { response_data: JSON.stringify(body) } })).toEqual(body)
    expect(mod.pickFnResponse({ data: 'not json' })).toBeUndefined()
    expect(mod.pickFnResponse(null)).toBeUndefined()
  })

  it('函数业务错误码按 unwrap 抛出', async () => {
    const { cloud, reply, ERROR_CODES } = setup()
    reply(200, { code: 40001, data: null, msg: '参数错误' })
    await expect(cloud.fn.call('demo', 'detail', {})).rejects.toMatchObject({ code: 40001 })
    reply(200, { unexpected: true })
    await expect(cloud.fn.call('demo', 'list')).rejects.toMatchObject({ code: ERROR_CODES.SERVER })
  })

  it('网关 429 / 5xx / 网络失败 / 超时 分别映射', async () => {
    const { cloud, reply, fail, ERROR_CODES } = setup()
    reply(429, { code: 'RATE_LIMIT', message: 'slow down' })
    await expect(cloud.fn.call('demo', 'list')).rejects.toMatchObject({ code: ERROR_CODES.TOO_MANY })
    reply(502, { message: 'bad gateway' })
    await expect(cloud.fn.call('demo', 'list')).rejects.toMatchObject({ code: ERROR_CODES.SERVER, message: expect.stringContaining('bad gateway') })
    fail(new TypeError('Network request failed'))
    await expect(cloud.fn.call('demo', 'list')).rejects.toMatchObject({ code: ERROR_CODES.NETWORK, message: 'Network request failed' })
    const abort = new Error('Aborted')
    abort.name = 'AbortError'
    fail(abort)
    await expect(cloud.fn.call('demo', 'list')).rejects.toMatchObject({ code: ERROR_CODES.NETWORK, message: '请求超时' })
  })

  it('init 只读本地会话不发请求；未配置 envId 时调用报错', async () => {
    const { cloud, calls } = setup({ session: phoneSession({ uid: 'u9' }) })
    await cloud.init()
    expect(calls).toHaveLength(0)
    expect(await cloud.identity()).toMatchObject({ uid: 'u9', method: 'phone' })

    jest.resetModules()
    process.env = { ...OLD_ENV, TARO_ENV: 'rn', TARO_APP_CLOUD_ENV_ID: '', TARO_APP_CLOUD_ACCESS_KEY: 'pk' }
    const bare = require('@/services/cloud.rn')
    bare.PUBLIC_FUNCTIONS.push('demo')
    await expect(bare.cloud.fn.call('demo', 'list')).rejects.toThrow('TARO_APP_CLOUD_ENV_ID')
  })
})
