/**
 * 通过 Apple 登录编排（session.ts signInWithApple / bindApple、account.ts deleteAccount 撤销授权）。
 * 云函数客户端、Apple 授权、进度补传均为替身；登录态 store 为真实实现。
 */
const OLD_TARO_ENV = process.env.TARO_ENV
process.env.TARO_ENV = 'rn'

const mockCall = jest.fn()
const mockSignIn = jest.fn(async () => undefined)
const mockDeleteCloudUser = jest.fn(async () => undefined)
let mockSession: object | null = null
jest.mock('@/services/client', () => ({
  __esModule: true,
  getClient: () => ({
    fn: { call: (...a: unknown[]) => mockCall(...a) },
    auth: { custom: { signIn: (...a: unknown[]) => (mockSignIn as any)(...a) }, session: () => mockSession, deleteCloudUser: () => mockDeleteCloudUser() }
  })
}))
const mockApple = { available: true, request: jest.fn() }
jest.mock('@/features/auth/apple', () => ({
  __esModule: true,
  isAppleLoginAvailable: async () => mockApple.available,
  requestAppleAuth: () => mockApple.request()
}))
jest.mock('@/features/auth/wechat', () => ({ __esModule: true, requestWechatAuth: jest.fn(), isWechatLoginAvailable: async () => false }))
const mockLogin = jest.fn()
jest.mock('@/services/me', () => ({ __esModule: true, login: (...a: unknown[]) => mockLogin(...a) }))
const mockReset = jest.fn(async () => undefined)
jest.mock('@/features/auth/clear', () => ({ __esModule: true, resetLocalData: (...a: unknown[]) => (mockReset as any)(...a) }))
const mockTrack = jest.fn()
jest.mock('@/utils/track', () => ({ __esModule: true, track: (...a: unknown[]) => mockTrack(...a) }))
jest.mock('@/hooks/requestCache', () => ({ __esModule: true, invalidate: jest.fn() }))

/* eslint-disable @typescript-eslint/no-var-requires */
const session = require('@/features/auth/session') as typeof import('@/features/auth/session')
const account = require('@/features/auth/account') as typeof import('@/features/auth/account')
const { useUserStore } = require('@/store/user') as typeof import('@/store/user')
const { CloudError, ERROR_CODES } = require('@/services/cloud.types') as typeof import('@/services/cloud.types')
/* eslint-enable @typescript-eslint/no-var-requires */

afterAll(() => { process.env.TARO_ENV = OLD_TARO_ENV })

export {}

const CRED = { identityToken: 'id.token.sig', nonce: 'raw-nonce-1', authorizationCode: 'auth-code-1' }

beforeEach(() => {
  jest.clearAllMocks()
  mockApple.available = true
  mockApple.request.mockResolvedValue(CRED)
  mockSession = null
  useUserStore.setState({ consent: 'agreed', auth: { signedIn: false } })
})

it('signInWithApple：Apple 授权 → user.appleLogin（identityToken + 原始 nonce）→ 票据换会话（method apple）→ user.login 带 linkToken', async () => {
  mockCall.mockResolvedValueOnce({ ticket: 'tk-1', linkToken: 'lt-1', isNew: true, accountId: 'ap_x' })
  mockLogin.mockResolvedValueOnce({ openid: 'ap_x', accountId: 'ap_x', isNew: true, merged: false })
  const r = await session.signInWithApple()
  expect(mockCall).toHaveBeenCalledWith('user', 'appleLogin', { identityToken: 'id.token.sig', nonce: 'raw-nonce-1' })
  expect(mockSignIn).toHaveBeenCalledWith('tk-1', 'apple')
  expect(mockLogin).toHaveBeenCalledWith({ linkToken: 'lt-1' })
  expect(r).toMatchObject({ accountId: 'ap_x' })
  expect(mockTrack).toHaveBeenCalledWith('login', { method: 'apple', is_new: true, merged: false })
})

it('signInWithApple：用户取消 → 抛 AUTH_CANCELLED，不调云函数', async () => {
  mockApple.request.mockRejectedValueOnce(new CloudError(ERROR_CODES.AUTH_CANCELLED, '已取消通过 Apple 登录'))
  await expect(session.signInWithApple()).rejects.toMatchObject({ code: ERROR_CODES.AUTH_CANCELLED })
  expect(mockCall).not.toHaveBeenCalled()
})

it('bindApple：需登录；成功后 identities.apple = true，merged 时埋点带 merged', async () => {
  await expect(session.bindApple()).rejects.toMatchObject({ code: ERROR_CODES.LOGIN_REQUIRED })
  mockSession = { uid: 'u1' }
  useUserStore.setState({ auth: { signedIn: true, method: 'phone', identities: { mp: false, wechat: false, phone: true } } as any })
  mockCall.mockResolvedValueOnce({ ok: true, merged: true })
  await expect(session.bindApple()).resolves.toEqual({ ok: true, merged: true })
  expect(mockCall).toHaveBeenCalledWith('user', 'bindApple', { identityToken: 'id.token.sig', nonce: 'raw-nonce-1' })
  expect(useUserStore.getState().auth.identities).toEqual({ mp: false, wechat: false, phone: true, apple: true })
  expect(mockTrack).toHaveBeenCalledWith('bind_apple', { merged: true })
})

it('deleteAccount：关联了 Apple ID → 先重新授权拿 authorizationCode 随注销上送；取消授权则不注销', async () => {
  useUserStore.setState({ auth: { signedIn: true, method: 'phone', identities: { mp: false, wechat: false, phone: true, apple: true } } as any })
  mockCall.mockResolvedValue({ ok: true, removed: { progress: 0, favorites: 0, user: 1, links: 2 }, appleRevoked: true })
  await account.deleteAccount()
  expect(mockCall).toHaveBeenCalledWith('user', 'deleteAccount', { confirm: 'DELETE', appleAuthorizationCode: 'auth-code-1' })
  expect(mockReset).toHaveBeenCalledWith({ keepAuth: false })

  jest.clearAllMocks()
  useUserStore.setState({ auth: { signedIn: true, method: 'apple', identities: { mp: false, wechat: false, phone: false, apple: true } } as any })
  mockApple.request.mockRejectedValueOnce(new CloudError(ERROR_CODES.AUTH_CANCELLED, '已取消通过 Apple 登录'))
  await expect(account.deleteAccount()).rejects.toMatchObject({ code: ERROR_CODES.AUTH_CANCELLED })
  expect(mockCall).not.toHaveBeenCalled()
  expect(mockReset).not.toHaveBeenCalled()
})

it('deleteAccount：未关联 Apple / 本机不能重新授权（如 Android）→ 不拉 Apple，照常注销', async () => {
  useUserStore.setState({ auth: { signedIn: true, method: 'phone', identities: { mp: false, wechat: false, phone: true } } as any })
  mockCall.mockResolvedValue({ ok: true, removed: { progress: 0, favorites: 0, user: 1, links: 1 } })
  await account.deleteAccount()
  expect(mockApple.request).not.toHaveBeenCalled()
  expect(mockCall).toHaveBeenCalledWith('user', 'deleteAccount', { confirm: 'DELETE' })

  jest.clearAllMocks()
  mockApple.available = false
  useUserStore.setState({ auth: { signedIn: true, method: 'apple', identities: { mp: false, wechat: false, phone: false, apple: true } } as any })
  await account.deleteAccount()
  expect(mockApple.request).not.toHaveBeenCalled()
  expect(mockCall).toHaveBeenCalledWith('user', 'deleteAccount', { confirm: 'DELETE' })
})
