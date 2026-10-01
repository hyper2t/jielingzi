/**
 * 登录体系（App 端，TARO_ENV=rn，mock 数据源）：登录门禁、手机号登录流程、绑定手机号、退出 / 注销、
 * 「清除本机数据」保留登录态、登录页交互、我的页登录卡片、设置页账号区。
 * 这里必须在加载任何业务模块前把 TARO_ENV 设为 rn（HAS_LOGIN 在模块加载时求值），所以全部用 require。
 */
import type { ReactTestRenderer } from 'react-test-renderer'

const OLD_TARO_ENV = process.env.TARO_ENV
process.env.TARO_ENV = 'rn'

const { act, create } = require('react-test-renderer') as typeof import('react-test-renderer')
const Taro = require('@tarojs/taro').default
const { useUserStore, isSignedIn, canSync, HAS_LOGIN, maskPhone } = require('@/store/user') as typeof import('@/store/user')
const { useSettingsStore } = require('@/store/settings') as typeof import('@/store/settings')
const { mockControl, MOCK_SMS_CODE } = require('@/services/mock/client') as typeof import('@/services/mock/client')
const me = require('@/services/me') as typeof import('@/services/me')
const { assertCanWrite } = require('@/services/guard') as typeof import('@/services/guard')
const { ERROR_CODES } = require('@/services/cloud.types') as typeof import('@/services/cloud.types')
const { invalidate } = require('@/hooks/requestCache') as typeof import('@/hooks/requestCache')
const { registerAfterSignIn, __resetAfterSignInForTest } = require('@/features/auth/after-sign-in') as typeof import('@/features/auth/after-sign-in')
const { ensureSignedIn, loginGate, gateHint } = require('@/features/auth/require-login') as typeof import('@/features/auth/require-login')
const session = require('@/features/auth/session') as typeof import('@/features/auth/session')
const account = require('@/features/auth/account') as typeof import('@/features/auth/account')
const { resetLocalData } = require('@/features/parent/clear') as typeof import('@/features/parent/clear')
const { __resetGateForTest, markGatePassed } = require('@/features/parent/gate') as typeof import('@/features/parent/gate')
const { GATE_TITLE } = require('@/components') as typeof import('@/components')
const LoginPage = require('@/pkg-user/pages/login/index') as typeof import('@/pkg-user/pages/login/index')
const Login = LoginPage.default
const MinePage = require('@/pages/mine/index') as typeof import('@/pages/mine/index')
const Mine = MinePage.default
const Settings = (require('@/pkg-user/pages/settings/index') as typeof import('@/pkg-user/pages/settings/index')).default

afterAll(() => { process.env.TARO_ENV = OLD_TARO_ENV })

const PHONE = '13800138000'
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const mounted: ReactTestRenderer[] = []
const render = (el: JSX.Element) => { let r!: ReactTestRenderer; act(() => { r = create(el) }); mounted.push(r); return r }
afterEach(() => { mounted.splice(0).forEach(r => act(() => r.unmount())) })
const hosts = (r: ReactTestRenderer, pred: (n: any) => boolean) => r.root.findAll(n => typeof n.type === 'string' && pred(n))
const texts = (r: ReactTestRenderer) => hosts(r, n => n.type === 'Text').map(n => String(n.props.children))
const click = (r: ReactTestRenderer, label: string) => act(() => { hosts(r, n => n.props.ariaLabel === label && typeof n.props.onClick === 'function')[0].props.onClick() })
const hasButton = (r: ReactTestRenderer, label: string) => hosts(r, n => n.props.ariaLabel === label && typeof n.props.onClick === 'function').length > 0
const typeInto = (r: ReactTestRenderer, label: string, value: string) => act(() => { hosts(r, n => n.type === 'Input' && n.props.ariaLabel === label)[0].props.onInput({ detail: { value } }) })
const inputValue = (r: ReactTestRenderer, label: string) => hosts(r, n => n.type === 'Input' && n.props.ariaLabel === label)[0].props.value
const typeAnswer = (r: ReactTestRenderer, n: number) => { String(n).split('').forEach(d => click(r, d)); click(r, '确定') }
const question = (r: ReactTestRenderer) => {
  // 登录页表单里还有「+86」，只认「a + b = ?」形式的题目
  const m = /^(\d+) \+ (\d+) = \?$/.exec(texts(r).find(t => /^\d+ \+ \d+ = \?$/.test(t)) || '')
  return m ? Number(m[1]) + Number(m[2]) : NaN
}
const calls = () => mockControl.calls.map(c => `${c.name}.${c.action}`)

async function signInPhone (phone = PHONE) {
  const v = await session.sendCode(phone)
  return session.signInWithCode({ phone, verificationId: v.verificationId, code: MOCK_SMS_CODE, isUser: v.isUser })
}

beforeEach(() => {
  mockControl.reset()
  mockControl.latency = 0
  invalidate()
  ;(Taro as any).__storage.clear()
  ;(Taro as any).__routerParams = {}
  __resetAfterSignInForTest()
  useUserStore.setState({ consent: 'agreed', sheetOpen: false, sheetReason: undefined, auth: { signedIn: false } })
  useSettingsStore.setState({ settings: {} })
  __resetGateForTest()
  jest.clearAllMocks()
})

describe('登录门禁（FE-L03）', () => {
  it('App 端有登录概念；未同意先走同意弹层，不跳登录页', () => {
    expect(HAS_LOGIN).toBe(true)
    useUserStore.setState({ consent: 'unknown' })
    expect(loginGate()).toBe('consent')
    expect(ensureSignedIn({ reason: '设置', returnTo: 'settings' })).toBe(false)
    expect(useUserStore.getState().sheetOpen).toBe(true)
    expect(useUserStore.getState().sheetReason).toBe(gateHint('consent', '设置'))
    expect(Taro.navigateTo).not.toHaveBeenCalled()
  })

  it('已同意未登录：跳登录页并带 reason / returnTo；不发任何身份类请求', async () => {
    expect(loginGate()).toBe('login')
    expect(isSignedIn()).toBe(false)
    expect(canSync()).toBe(false)
    expect(ensureSignedIn({ reason: '设置', returnTo: 'settings' })).toBe(false)
    expect(Taro.navigateTo).toHaveBeenCalledWith({ url: `/pkg-user/pages/login/index?reason=${encodeURIComponent('设置')}&returnTo=settings` })

    await me.refreshRemoteSettings()
    expect(() => assertCanWrite()).toThrow(expect.objectContaining({ code: ERROR_CODES.LOGIN_REQUIRED }))
    await expect(me.updateSettings({ theme: 'x' })).rejects.toMatchObject({ code: ERROR_CODES.LOGIN_REQUIRED })
    // 设置只写本机
    await me.setSettings({ theme: 'y' })
    expect(useSettingsStore.getState().settings).toMatchObject({ theme: 'y' })
    expect(mockControl.calls).toEqual([])
  })

  it('已登录：门禁放行', async () => {
    await signInPhone()
    expect(isSignedIn()).toBe(true)
    expect(canSync()).toBe(true)
    expect(ensureSignedIn({ reason: '设置' })).toBe(true)
    expect(Taro.navigateTo).not.toHaveBeenCalled()
  })
})

describe('同意与登录流程（FE-L01 / FE-L02 编排）', () => {
  it('App 端同意只记本机时间，不发请求', async () => {
    useUserStore.setState({ consent: 'unknown' })
    const res = await me.consent()
    expect(useUserStore.getState().consent).toBe('agreed')
    expect(typeof res.guardianConsentAt).toBe('number')
    expect((Taro as any).__storage.get('consent_at')).toBe(res.guardianConsentAt)
    expect(mockControl.calls).toEqual([])
  })

  it('手机号登录：验证码校验 → 会话 → user.login(platform app, consentAt) → 登录后同步钩子 → 登录态含脱敏手机号 / accountId / identities', async () => {
    ;(Taro as any).__storage.set('consent_at', 1790000000000)
    const hook = jest.fn()
    registerAfterSignIn(hook)
    registerAfterSignIn(() => { throw new Error('单个钩子失败不影响登录') })

    const v = await session.sendCode(PHONE)
    expect(v).toMatchObject({ verificationId: expect.any(String), isUser: true })
    const res = await session.signInWithCode({ phone: PHONE, verificationId: v.verificationId, code: MOCK_SMS_CODE, isUser: v.isUser })
    expect(res).toMatchObject({ accountId: 'mock-openid', identities: { phone: true } })

    const auth = useUserStore.getState().auth
    expect(auth).toMatchObject({ signedIn: true, method: 'phone', phoneMasked: '138****8000', accountId: 'mock-openid', identities: { phone: true } })
    expect(maskPhone(PHONE)).toBe('138****8000')
    expect((Taro as any).__storage.get('auth_session')).toMatchObject({ method: 'phone', accountId: 'mock-openid' })
    expect((Taro as any).__storage.get('auth_profile')).toMatchObject({ phoneMasked: '138****8000' })

    const login = mockControl.calls.find(c => c.action === 'login')
    expect(login?.data).toEqual({ platform: 'app', consentAt: 1790000000000 })
    expect(hook).toHaveBeenCalledTimes(1)
    expect(calls()).not.toContain('user.consent')
  })

  it('验证码错误：AUTH_CODE_INVALID，仍未登录', async () => {
    const v = await session.sendCode(PHONE)
    await expect(session.signInWithCode({ phone: PHONE, verificationId: v.verificationId, code: '000000' })).rejects.toMatchObject({ code: ERROR_CODES.AUTH_CODE_INVALID })
    expect(useUserStore.getState().auth.signedIn).toBe(false)
    expect(calls()).not.toContain('user.login')
  })

  it('绑定手机号：用另一份不落盘的会话调 user.linkPhoneSession，当前仍是微信登录，identities.phone 变为 true', async () => {
    const { getClient } = require('@/services/client') as typeof import('@/services/client')
    await getClient().auth!.custom.signIn('ticket-abc', 'wechat')
    await session.completeSignIn('wechat')
    expect(useUserStore.getState().auth).toMatchObject({ signedIn: true, method: 'wechat' })

    const v = await session.sendCode(PHONE)
    const r = await session.bindPhone({ phone: PHONE, verificationId: v.verificationId, code: MOCK_SMS_CODE, isUser: v.isUser })
    expect(r).toEqual({ ok: true, merged: false })
    const link = mockControl.calls.find(c => c.action === 'linkPhoneSession')
    expect(link?.data).toEqual({ otherAccessToken: `mock-at-mock-phone-${PHONE}` })
    const auth = useUserStore.getState().auth
    expect(auth).toMatchObject({ method: 'wechat', phoneMasked: '138****8000', identities: expect.objectContaining({ phone: true }) })
    expect((Taro as any).__storage.get('auth_session')).toMatchObject({ method: 'wechat' })
  })

  it('退出登录：清登录态，保留同意与本机数据', async () => {
    await signInPhone()
    ;(Taro as any).__storage.set('demo:a1', { x: 1 })
    await account.signOut()
    expect(useUserStore.getState().auth.signedIn).toBe(false)
    expect((Taro as any).__storage.has('auth_session')).toBe(false)
    expect(useUserStore.getState().consent).toBe('agreed')
    expect((Taro as any).__storage.get('demo:a1')).toEqual({ x: 1 })
    expect(canSync()).toBe(false)
  })

  it('注销账号：user.deleteAccount(confirm DELETE) → 清空本机（含登录态）→ 回首页；未登录直接拒绝', async () => {
    await expect(account.deleteAccount()).rejects.toMatchObject({ code: ERROR_CODES.LOGIN_REQUIRED })
    await signInPhone()
    ;(Taro as any).__storage.set('demo:a1', { x: 1 })
    await act(async () => { await account.deleteAccount() })
    const del = mockControl.calls.find(c => c.action === 'deleteAccount')
    expect(del?.data).toEqual({ confirm: 'DELETE' })
    expect((Taro as any).__storage.size).toBe(0)
    expect(useUserStore.getState().auth.signedIn).toBe(false)
    expect(useUserStore.getState().consent).toBe('unknown')
    expect(Taro.reLaunch).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining('pages/index/index') }))
    expect(account.confirmWordOk(' 「注销」 ')).toBe(true)
    expect(account.confirmWordOk('注消')).toBe(false)
  })

  it('清除本机数据：清本机但保留登录态；重新同意后（已登录）立刻 login + 同步钩子', async () => {
    await signInPhone()
    ;(Taro as any).__storage.set('demo:a1', { x: 1 })
    mockControl.calls = []
    await act(async () => { await resetLocalData() })
    expect(mockControl.calls).toEqual([])
    expect((Taro as any).__storage.has('demo:a1')).toBe(false)
    expect((Taro as any).__storage.get('auth_session')).toMatchObject({ method: 'phone' })
    expect(useUserStore.getState().auth.signedIn).toBe(true)
    expect(useUserStore.getState().consent).toBe('unknown')
    const hook = jest.fn()
    registerAfterSignIn(hook)
    const { agree } = require('@/features/consent') as typeof import('@/features/consent')
    await agree()
    expect(calls()).toContain('user.login')
    expect(hook).toHaveBeenCalled()
  })
})

describe('登录页（FE-L02）', () => {
  it('先验证；通过后显示表单；未勾选协议点获取验证码只提示不发码', async () => {
    const r = render(<Login />)
    expect(texts(r)).toContain(GATE_TITLE)
    typeAnswer(r, question(r))
    expect(texts(r)).toContain(LoginPage.LOGIN_TITLE)
    expect(texts(r)).not.toContain(GATE_TITLE)
    click(r, LoginPage.SEND_TEXT)
    expect(texts(r)).toContain(LoginPage.AGREE_HINT)
    expect(mockControl.calls).toEqual([])
    expect(hasButton(r, '微信登录')).toBe(false)
  })

  it('5 分钟内验证过：不再出题；发码 → 倒计时 → 6 位自动提交 → 登录成功回跳 returnTo', async () => {
    markGatePassed()
    ;(Taro as any).__routerParams = { reason: encodeURIComponent('设置'), returnTo: 'settings' }
    const r = render(<Login />)
    expect(texts(r)).not.toContain(GATE_TITLE)
    expect(texts(r)).toContain('设置需登录后可用')
    click(r, '同意协议')
    click(r, LoginPage.SEND_TEXT)
    expect(texts(r)).toContain(LoginPage.PHONE_HINT)
    typeInto(r, '手机号', PHONE)
    click(r, LoginPage.SEND_TEXT)
    await flush()
    expect(texts(r)).toContain(`验证码已发送至 138****8000`)
    expect(hasButton(r, '60 秒后可重新发送')).toBe(true)
    typeInto(r, '验证码', '12345')
    await flush()
    expect(useUserStore.getState().auth.signedIn).toBe(false)
    typeInto(r, '验证码', MOCK_SMS_CODE)
    await flush()
    await flush()
    expect(useUserStore.getState().auth).toMatchObject({ signedIn: true, method: 'phone', phoneMasked: '138****8000' })
    expect(Taro.redirectTo).toHaveBeenCalledWith({ url: '/pkg-user/pages/settings/index' })
    expect(Taro.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '登录成功' }))
  })

  it('验证码错误：提示并清空验证码，不回跳；没有 returnTo 时成功后返回上一页', async () => {
    markGatePassed()
    const r = render(<Login />)
    click(r, '同意协议')
    typeInto(r, '手机号', PHONE)
    click(r, LoginPage.SEND_TEXT)
    await flush()
    typeInto(r, '验证码', '000000')
    await flush()
    await flush()
    expect(texts(r)).toContain('验证码不正确或已过期')
    expect(inputValue(r, '验证码')).toBe('')
    expect(useUserStore.getState().auth.signedIn).toBe(false)
    typeInto(r, '验证码', MOCK_SMS_CODE)
    await flush()
    await flush()
    expect(useUserStore.getState().auth.signedIn).toBe(true)
    expect(Taro.redirectTo).not.toHaveBeenCalled()
    expect((Taro.switchTab as jest.Mock).mock.calls.length + (Taro.navigateBack as jest.Mock).mock.calls.length).toBeGreaterThan(0)
  })

  it('绑定模式：标题「绑定手机号」，成功调 linkPhoneSession 并返回', async () => {
    const { getClient } = require('@/services/client') as typeof import('@/services/client')
    await getClient().auth!.custom.signIn('ticket-xyz', 'wechat')
    markGatePassed()
    ;(Taro as any).__routerParams = { mode: 'bind' }
    const r = render(<Login />)
    expect(texts(r)).toContain(LoginPage.BIND_TITLE)
    click(r, '同意协议')
    typeInto(r, '手机号', PHONE)
    click(r, LoginPage.SEND_TEXT)
    await flush()
    typeInto(r, '验证码', MOCK_SMS_CODE)
    await flush()
    await flush()
    expect(calls()).toContain('user.linkPhoneSession')
    expect(useUserStore.getState().auth).toMatchObject({ method: 'wechat', identities: expect.objectContaining({ phone: true }) })
    expect(Taro.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '已绑定手机号' }))
  })
})

describe('我的页登录卡片 / 设置页账号区', () => {
  it('未登录：登录卡片；设置入口要求先登录（跳登录页）', async () => {
    const r = render(<Mine />)
    await flush()
    expect(texts(r)).toContain(MinePage.LOGIN_CARD_TEXT)
    expect(mockControl.calls).toEqual([])
    click(r, MinePage.LOGIN_ACTION)
    expect(Taro.navigateTo).toHaveBeenLastCalledWith({ url: '/pkg-user/pages/login/index' })
    click(r, '设置')
    expect(Taro.navigateTo).toHaveBeenLastCalledWith({ url: `/pkg-user/pages/login/index?reason=${encodeURIComponent('设置')}&returnTo=settings` })
  })

  it('已登录：显示登录方式；设置页账号区可退出、可注销（需输入「注销」）', async () => {
    await signInPhone()
    const r = render(<Mine />)
    await flush()
    expect(texts(r)).toContain('已登录 · 手机号 138****8000')

    const p = render(<Settings />)
    await flush()
    expect(texts(p)).toEqual(expect.arrayContaining(['登录方式', '手机号 138****8000']))
    expect(hasButton(p, '绑定手机号')).toBe(false)
    click(p, '注销账号')
    expect(texts(p)).toContain(account.DELETE_ACCOUNT_CONFIRM)
    typeInto(p, '确认词', '注消')
    click(p, '确认注销')
    await flush()
    expect(calls()).not.toContain('user.deleteAccount')
    typeInto(p, '确认词', '注销')
    click(p, '确认注销')
    await flush()
    await flush()
    expect(calls()).toContain('user.deleteAccount')
    expect(useUserStore.getState().auth.signedIn).toBe(false)
  })

  it('已登录（微信）：账号区显示「绑定手机号」；退出登录后回上一页', async () => {
    const { getClient } = require('@/services/client') as typeof import('@/services/client')
    await getClient().auth!.custom.signIn('ticket-xyz', 'wechat')
    const p = render(<Settings />)
    await flush()
    expect(hasButton(p, '绑定手机号')).toBe(true)
    click(p, '绑定手机号')
    expect(Taro.navigateTo).toHaveBeenLastCalledWith({ url: '/pkg-user/pages/login/index?mode=bind' })
    click(p, '退出登录')
    await flush()
    await flush()
    expect(useUserStore.getState().auth.signedIn).toBe(false)
  })
})
