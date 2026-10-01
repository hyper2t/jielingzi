/**
 * 微信登录能力（features/auth/wechat.rn.ts）：SDK 替身覆盖
 * 未配置 / 未同意 / 未安装 / 懒 registerApp 只做一次 / 成功 / state 不一致 / 取消与拒绝映射 / 切回 App 宽限期与总超时。
 * 原生模块与 react-native 均为虚拟 mock；前后台事件由 app-lifecycle 替身手动触发。
 */
jest.mock('react-native', () => ({ __esModule: true, Platform: { OS: 'android' }, NativeModules: {} }), { virtual: true })
// 与模块内拿到的是同一个对象，测试里直接改 OS
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockPlatform = (require('react-native') as { Platform: { OS: string } }).Platform

const lifecycle = { show: [] as Array<() => void>, hide: [] as Array<() => void> }
jest.mock('@/utils/app-lifecycle', () => ({
  __esModule: true,
  onAppShow: (cb: () => void) => { lifecycle.show.push(cb); return () => { lifecycle.show = lifecycle.show.filter(f => f !== cb) } },
  onAppHide: (cb: () => void) => { lifecycle.hide.push(cb); return () => { lifecycle.hide = lifecycle.hide.filter(f => f !== cb) } }
}))

import type { WechatAuthResp, WechatSdk } from '../wechat.rn'
import { useUserStore } from '@/store/user'
import { ERROR_CODES } from '@/services/cloud.types'
import { errorCode } from '@/services/errors'

// import 会被提升到文件顶部，AppID 必须在模块求值前写入环境变量 → 用 require
process.env.TARO_APP_WX_APP_ID = 'wx-test-appid'
process.env.TARO_APP_WX_UNIVERSAL_LINK = ''
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  __setWechatSdkForTest, AUTH_TIMEOUT_MS, isWechatConfigured, isWechatLoginAvailable, mapWechatError, randomState,
  requestWechatAuth, RESUME_GRACE_MS, WX_APP_ID, WX_SCOPE
} = require('../wechat.rn') as typeof import('../wechat.rn')

class WechatError extends Error {
  code: number
  constructor (code: number, msg = '') { super(msg || String(code)); this.name = 'WechatError'; this.code = code }
}

interface FakeSdk extends WechatSdk {
  registerApp: jest.Mock<Promise<boolean>, [string, string?]>
  isWXAppInstalled: jest.Mock<Promise<boolean>, []>
  sendAuthRequest: jest.Mock<Promise<WechatAuthResp>, [string | string[], string?]>
  /** 手动完成上一次 sendAuthRequest */
  respond: (resp: WechatAuthResp | WechatError) => void
}

function makeSdk (opts: { installed?: boolean, register?: boolean } = {}): FakeSdk {
  let settle: { resolve: (r: WechatAuthResp) => void, reject: (e: unknown) => void } | null = null
  const sdk: FakeSdk = {
    registerApp: jest.fn(async (_appId: string, _link?: string) => opts.register !== false),
    isWXAppInstalled: jest.fn(async () => opts.installed !== false),
    sendAuthRequest: jest.fn((_scope: string | string[], _state?: string) => new Promise<WechatAuthResp>((resolve, reject) => { settle = { resolve, reject } })),
    respond: (resp) => {
      if (!settle) throw new Error('no pending sendAuthRequest')
      if (resp instanceof Error) settle.reject(resp)
      else settle.resolve(resp)
      settle = null
    }
  }
  return sdk
}

const flush = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve() }
/** 发起授权并等到 SDK 真的收到 sendAuthRequest（中间有 registerApp / isWXAppInstalled 两次 await）；先挂一个空 catch 防止未处理拒绝 */
const startAuth = async (sdk: FakeSdk) => {
  const before = sdk.sendAuthRequest.mock.calls.length
  const p = requestWechatAuth()
  p.catch(() => undefined)
  for (let i = 0; i < 200 && sdk.sendAuthRequest.mock.calls.length === before; i++) await Promise.resolve()
  if (sdk.sendAuthRequest.mock.calls.length === before) throw new Error('sendAuthRequest 未被调用')
  return { p, state: sdk.sendAuthRequest.mock.calls[before][1] as string }
}
const goBackgroundAndBack = async () => {
  lifecycle.hide.forEach(f => f())
  lifecycle.show.forEach(f => f())
  await flush()
}

beforeEach(() => {
  useUserStore.setState({ consent: 'agreed', auth: { signedIn: false } })
  lifecycle.show = []
  lifecycle.hide = []
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  __setWechatSdkForTest(undefined)
  mockPlatform.OS = 'android'
  jest.clearAllTimers()
  jest.useRealTimers()
  jest.restoreAllMocks()
})

test('配置来自 TARO_APP_WX_APP_ID；Android + 已配置即 configured', () => {
  expect(WX_APP_ID).toBe('wx-test-appid')
  expect(WX_SCOPE).toBe('snsapi_userinfo')
  expect(isWechatConfigured()).toBe(true)
})

test('iOS：必须同时配置 Universal Link 才算 configured（微信 SDK 2.x registerApp 需要）', () => {
  mockPlatform.OS = 'ios'
  // 本文件加载时 TARO_APP_WX_UNIVERSAL_LINK 为空
  expect(isWechatConfigured()).toBe(false)
  const prev = process.env.TARO_APP_WX_UNIVERSAL_LINK
  process.env.TARO_APP_WX_UNIVERSAL_LINK = 'https://example.com/app/'
  try {
    jest.isolateModules(() => {
      // isolateModules 里是全新的模块注册表：react-native 替身也是新实例，要单独设成 iOS
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const rn = require('react-native') as { Platform: { OS: string } }
      rn.Platform.OS = 'ios'
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fresh = require('../wechat.rn') as typeof import('../wechat.rn')
      expect(fresh.WX_UNIVERSAL_LINK).toBe('https://example.com/app/')
      expect(fresh.isWechatConfigured()).toBe(true)
      rn.Platform.OS = 'web'
      expect(fresh.isWechatConfigured()).toBe(false)
    })
  } finally {
    process.env.TARO_APP_WX_UNIVERSAL_LINK = prev
  }
})

test('randomState：32 位十六进制且每次不同', () => {
  const a = randomState()
  expect(a).toMatch(/^[0-9a-f]{32}$/)
  expect(randomState()).not.toBe(a)
})

test('用户未同意：不可用，且不会 registerApp（决策 L8）；requestWechatAuth 抛 CONSENT_REQUIRED', async () => {
  useUserStore.setState({ consent: 'unknown' })
  const sdk = makeSdk()
  __setWechatSdkForTest(sdk)
  await expect(isWechatLoginAvailable()).resolves.toBe(false)
  expect(sdk.registerApp).not.toHaveBeenCalled()
  await expect(requestWechatAuth()).rejects.toMatchObject({ code: ERROR_CODES.CONSENT_REQUIRED })
  expect(sdk.registerApp).not.toHaveBeenCalled()
})

test('原生模块缺失（iOS 未链接 / 未安装原生包）：不可用，requestWechatAuth 抛 WECHAT_UNAVAILABLE', async () => {
  __setWechatSdkForTest(null)
  await expect(isWechatLoginAvailable()).resolves.toBe(false)
  const err = await requestWechatAuth().catch(e => e)
  expect(errorCode(err)).toBe(ERROR_CODES.WECHAT_UNAVAILABLE)
  expect(err.message).toContain('手机号')
})

test('未链接微信原生模块时不 require SDK，不触发 registerApp of null 红屏', async () => {
  __setWechatSdkForTest(undefined)
  await expect(isWechatLoginAvailable()).resolves.toBe(false)
  await expect(requestWechatAuth()).rejects.toMatchObject({ code: ERROR_CODES.WECHAT_UNAVAILABLE })
})

test('本机未安装微信：不可用；requestWechatAuth 给出「未安装微信」提示且不拉起授权', async () => {
  const sdk = makeSdk({ installed: false })
  __setWechatSdkForTest(sdk)
  await expect(isWechatLoginAvailable()).resolves.toBe(false)
  const err = await requestWechatAuth().catch(e => e)
  expect(errorCode(err)).toBe(ERROR_CODES.WECHAT_UNAVAILABLE)
  expect(err.message).toBe('未安装微信，请先用手机号登录')
  expect(sdk.sendAuthRequest).not.toHaveBeenCalled()
})

test('registerApp 懒执行且只做一次；失败后允许重试', async () => {
  const sdk = makeSdk()
  __setWechatSdkForTest(sdk)
  expect(sdk.registerApp).not.toHaveBeenCalled()
  await expect(isWechatLoginAvailable()).resolves.toBe(true)
  await expect(isWechatLoginAvailable()).resolves.toBe(true)
  expect(sdk.registerApp).toHaveBeenCalledTimes(1)
  expect(sdk.registerApp).toHaveBeenCalledWith('wx-test-appid', '')

  const bad = makeSdk()
  bad.registerApp.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(true)
  __setWechatSdkForTest(bad)
  await expect(isWechatLoginAvailable()).resolves.toBe(false)
  await expect(isWechatLoginAvailable()).resolves.toBe(true)
  expect(bad.registerApp).toHaveBeenCalledTimes(2)

  const refused = makeSdk({ register: false })
  __setWechatSdkForTest(refused)
  await expect(isWechatLoginAvailable()).resolves.toBe(false)
  await expect(requestWechatAuth()).rejects.toMatchObject({ code: ERROR_CODES.WECHAT_UNAVAILABLE })
})

test('成功：sendAuthRequest(snsapi_userinfo, state) → 返回 code 与校验过的 state', async () => {
  const sdk = makeSdk()
  __setWechatSdkForTest(sdk)
  const { p, state } = await startAuth(sdk)
  expect(sdk.sendAuthRequest).toHaveBeenCalledTimes(1)
  expect(sdk.sendAuthRequest.mock.calls[0][0]).toBe('snsapi_userinfo')
  expect(state).toMatch(/^[0-9a-f]{32}$/)
  sdk.respond({ errCode: 0, code: 'CODE-1', state })
  await expect(p).resolves.toEqual({ code: 'CODE-1', state })
  // 成功后监听器已释放
  expect(lifecycle.show).toHaveLength(0)
  expect(lifecycle.hide).toHaveLength(0)
})

test('state 不一致 / 没有 code：按不可用处理，不把 code 交给后端', async () => {
  const sdk = makeSdk()
  __setWechatSdkForTest(sdk)
  const a = await startAuth(sdk)
  sdk.respond({ errCode: 0, code: 'CODE-X', state: 'someone-else' })
  await expect(a.p).rejects.toMatchObject({ code: ERROR_CODES.WECHAT_UNAVAILABLE })

  const b = await startAuth(sdk)
  sdk.respond({ errCode: 0, code: '', state: b.state })
  await expect(b.p).rejects.toMatchObject({ code: ERROR_CODES.WECHAT_UNAVAILABLE })
})

test('微信错误码映射：-2 取消 → AUTH_CANCELLED；-4 拒绝 → AUTH_DENIED；-5 不支持 / 其他 → WECHAT_UNAVAILABLE', async () => {
  const sdk = makeSdk()
  __setWechatSdkForTest(sdk)

  const cancel = await startAuth(sdk)
  sdk.respond(new WechatError(-2))
  const e1 = await cancel.p.catch(e => e)
  expect(errorCode(e1)).toBe(ERROR_CODES.AUTH_CANCELLED)
  expect(e1.message).toBe('已取消微信登录')

  const deny = await startAuth(sdk)
  sdk.respond(new WechatError(-4, 'auth denied'))
  const e2 = await deny.p.catch(e => e)
  expect(errorCode(e2)).toBe(ERROR_CODES.AUTH_DENIED)
  expect(e2.message).toContain('拒绝')

  expect(errorCode(mapWechatError(new WechatError(-5)))).toBe(ERROR_CODES.WECHAT_UNAVAILABLE)
  expect(mapWechatError(new WechatError(-5)).message).toContain('版本')
  expect(errorCode(mapWechatError(new WechatError(-1)))).toBe(ERROR_CODES.WECHAT_UNAVAILABLE)
  expect(errorCode(mapWechatError(new Error('x')))).toBe(ERROR_CODES.WECHAT_UNAVAILABLE)
  expect(errorCode(mapWechatError(undefined))).toBe(ERROR_CODES.WECHAT_UNAVAILABLE)
})

test('切回 App 后宽限期内仍无回调 → AUTH_CANCELLED（微信被划掉 / 未完成授权），后续迟到的回调被忽略', async () => {
  jest.useFakeTimers()
  const sdk = makeSdk()
  __setWechatSdkForTest(sdk)
  const { p, state } = await startAuth(sdk)
  expect(lifecycle.hide).toHaveLength(1)
  expect(lifecycle.show).toHaveLength(1)
  // 未曾切到后台的 show（如首次渲染）不触发宽限计时
  lifecycle.show.forEach(f => f())
  jest.advanceTimersByTime(RESUME_GRACE_MS + 10)
  await flush()
  await goBackgroundAndBack()
  jest.advanceTimersByTime(RESUME_GRACE_MS - 1)
  await flush()
  let settled = false
  p.then(() => { settled = true }, () => { settled = true })
  await flush()
  expect(settled).toBe(false)
  jest.advanceTimersByTime(2)
  const err = await p.catch(e => e)
  expect(errorCode(err)).toBe(ERROR_CODES.AUTH_CANCELLED)
  expect(lifecycle.show).toHaveLength(0)
  sdk.respond({ errCode: 0, code: 'LATE', state })
  await flush()
})

test('切回 App 后宽限期内收到回调 → 正常成功', async () => {
  jest.useFakeTimers()
  const sdk = makeSdk()
  __setWechatSdkForTest(sdk)
  const { p, state } = await startAuth(sdk)
  await goBackgroundAndBack()
  jest.advanceTimersByTime(RESUME_GRACE_MS / 2)
  sdk.respond({ errCode: 0, code: 'CODE-2', state })
  await expect(p).resolves.toEqual({ code: 'CODE-2', state })
  jest.advanceTimersByTime(AUTH_TIMEOUT_MS)
})

test('总超时：一直没有回调也没切回 → AUTH_CANCELLED', async () => {
  jest.useFakeTimers()
  const sdk = makeSdk()
  __setWechatSdkForTest(sdk)
  const { p } = await startAuth(sdk)
  jest.advanceTimersByTime(AUTH_TIMEOUT_MS + 1)
  const err = await p.catch(e => e)
  expect(errorCode(err)).toBe(ERROR_CODES.AUTH_CANCELLED)
  expect(err.message).toContain('超时')
})
