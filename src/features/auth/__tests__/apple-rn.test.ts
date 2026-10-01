/**
 * 通过 Apple 登录（features/auth/apple.rn.ts，NA-L04）：平台 / 同意 / isSupported 判定、performRequest 参数（不申请邮箱姓名、启用 nonce）、
 * 取消与失败映射、缺凭证。react-native 为虚拟 mock，原生库用 __setAppleSdkForTest 注入替身。
 */
jest.mock('react-native', () => ({ __esModule: true, Platform: { OS: 'ios' } }), { virtual: true })
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockPlatform = (require('react-native') as { Platform: { OS: string } }).Platform

import type { AppleSdk } from '../apple.rn'
import { __setAppleSdkForTest, isAppleLoginAvailable, mapAppleError, requestAppleAuth } from '../apple.rn'
import { useUserStore } from '@/store/user'
import { ERROR_CODES } from '@/services/cloud.types'
import { authErrorMessage, errorCode } from '@/services/errors'

type Req = Parameters<AppleSdk['performRequest']>[0]
type Resp = Awaited<ReturnType<AppleSdk['performRequest']>>

function makeSdk (impl: (o: Req) => Promise<Resp>, isSupported = true): AppleSdk & { performRequest: jest.Mock } {
  return {
    isSupported,
    performRequest: jest.fn(impl),
    Operation: { LOGIN: 1 },
    Error: { CANCELED: '1001', UNKNOWN: '1000', FAILED: '1004' }
  }
}
const OK: Resp = { identityToken: 'header.payload.sig', authorizationCode: 'c-123', nonce: 'raw-nonce-abc', user: '001.abc.002' }
const appleErr = (code: string) => Object.assign(new Error('apple ' + code), { code })

beforeEach(() => {
  mockPlatform.OS = 'ios'
  useUserStore.setState({ consent: 'agreed' })
  __setAppleSdkForTest(makeSdk(async () => OK))
})

it('可用性：iOS + 已同意 + isSupported；Android / 未同意 / iOS 12 / 原生模块缺失均不可用', async () => {
  await expect(isAppleLoginAvailable()).resolves.toBe(true)
  useUserStore.setState({ consent: 'unknown' })
  await expect(isAppleLoginAvailable()).resolves.toBe(false)
  useUserStore.setState({ consent: 'agreed' })
  __setAppleSdkForTest(makeSdk(async () => OK, false))
  await expect(isAppleLoginAvailable()).resolves.toBe(false)
  __setAppleSdkForTest(null)
  await expect(isAppleLoginAvailable()).resolves.toBe(false)
  __setAppleSdkForTest(makeSdk(async () => OK))
  mockPlatform.OS = 'android'
  await expect(isAppleLoginAvailable()).resolves.toBe(false)
})

it('requestAppleAuth：只做 LOGIN、不申请邮箱 / 姓名、启用 nonce；返回 identityToken + 原始 nonce + authorizationCode', async () => {
  const sdk = makeSdk(async () => OK)
  __setAppleSdkForTest(sdk)
  await expect(requestAppleAuth()).resolves.toEqual({ identityToken: OK.identityToken, nonce: OK.nonce, authorizationCode: 'c-123' })
  expect(sdk.performRequest).toHaveBeenCalledWith({ requestedOperation: 1, requestedScopes: [], nonceEnabled: true })
  __setAppleSdkForTest(makeSdk(async () => ({ ...OK, authorizationCode: null })))
  await expect(requestAppleAuth()).resolves.toMatchObject({ authorizationCode: null })
})

it('取消 → AUTH_CANCELLED；其他错误 / 缺 identityToken / 非 iOS → APPLE_UNAVAILABLE（中文提示透出）', async () => {
  __setAppleSdkForTest(makeSdk(async () => { throw appleErr('1001') }))
  await expect(requestAppleAuth()).rejects.toMatchObject({ code: ERROR_CODES.AUTH_CANCELLED })

  __setAppleSdkForTest(makeSdk(async () => { throw appleErr('1000') }))
  const e = await requestAppleAuth().catch(x => x)
  expect(errorCode(e)).toBe(ERROR_CODES.APPLE_UNAVAILABLE)
  expect(authErrorMessage(e)).toBe('未完成 Apple 授权，请稍后再试')

  __setAppleSdkForTest(makeSdk(async () => ({ ...OK, identityToken: null })))
  await expect(requestAppleAuth()).rejects.toMatchObject({ code: ERROR_CODES.APPLE_UNAVAILABLE })

  __setAppleSdkForTest(makeSdk(async () => OK, false))
  await expect(requestAppleAuth()).rejects.toMatchObject({ code: ERROR_CODES.APPLE_UNAVAILABLE })

  mockPlatform.OS = 'android'
  await expect(requestAppleAuth()).rejects.toMatchObject({ code: ERROR_CODES.APPLE_UNAVAILABLE })

  expect(mapAppleError(appleErr('1001'), null).code).toBe(ERROR_CODES.AUTH_CANCELLED)
})
