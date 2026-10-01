/**
 * 通过 Apple 登录（NA-L04，App Store 审核指南 4.8；服务端见 docs/api/user.md appleLogin / bindApple）。
 * 库：@invertase/react-native-apple-authentication（只在 iOS 链接，react-native.config.js 关掉了 Android 自动链接）。
 *
 * 约定：
 * - 只在 iOS 13+ 且家长已同意时显示；不申请邮箱 / 姓名（requestedScopes 为空，决策 L8 最小采集）。
 * - nonce：库在本地生成原始 nonce，把 SHA-256 交给 Apple（写进 identityToken），原始值随结果返回；
 *   我们把原始 nonce 与 identityToken 一起交给云函数比对，防重放。
 * - 家长取消（1001）→ AUTH_CANCELLED；其余失败 → APPLE_UNAVAILABLE（带中文提示）。
 * - 注销账号前重新走一次授权拿 authorizationCode，交给 user.deleteAccount 撤销 Apple 授权（审核指南 5.1.1(v)）。
 */
import { Platform } from 'react-native'
import { CloudError, ERROR_CODES } from '@/services/cloud.types'
import { isConsented } from '@/store/user'

export interface AppleAuthResult {
  identityToken: string
  /** 原始 nonce（未哈希） */
  nonce: string
  authorizationCode: string | null
}

/** 库的子集 */
export interface AppleSdk {
  isSupported: boolean
  performRequest: (opts: { requestedOperation: number, requestedScopes: number[], nonceEnabled?: boolean }) => Promise<{
    identityToken: string | null
    authorizationCode: string | null
    nonce: string
    user: string
  }>
  Operation: { LOGIN: number }
  Error: { CANCELED: string, UNKNOWN?: string, FAILED?: string, INVALID_RESPONSE?: string, NOT_HANDLED?: string }
}

let sdk: AppleSdk | null | undefined

function loadSdk (): AppleSdk | null {
  if (sdk !== undefined) return sdk
  if (Platform.OS !== 'ios') return (sdk = null)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@invertase/react-native-apple-authentication')
    const a = mod && (mod.appleAuth || mod.default)
    sdk = a && typeof a.performRequest === 'function' ? (a as AppleSdk) : null
  } catch (e) {
    console.warn('[apple] 原生模块加载失败，通过 Apple 登录不可用', e)
    sdk = null
  }
  return sdk
}

/** 测试用：注入替身；传 undefined 恢复真实 require */
export function __setAppleSdkForTest (s: AppleSdk | null | undefined): void {
  sdk = s
}

/** 是否显示「通过 Apple 登录 / 绑定 Apple ID」：iOS 13+、原生模块在、家长已同意 */
export async function isAppleLoginAvailable (): Promise<boolean> {
  if (Platform.OS !== 'ios' || !isConsented()) return false
  const s = loadSdk()
  return !!(s && s.isSupported)
}

const unavailable = (msg = '通过 Apple 登录暂不可用，请改用其他方式') => new CloudError(ERROR_CODES.APPLE_UNAVAILABLE, msg)

export function mapAppleError (e: unknown, s: AppleSdk | null = sdk || null): CloudError {
  if (e instanceof CloudError) return e
  const code = String((e as any)?.code ?? '')
  if (code === (s?.Error?.CANCELED ?? '1001')) return new CloudError(ERROR_CODES.AUTH_CANCELLED, '已取消通过 Apple 登录')
  return unavailable('未完成 Apple 授权，请稍后再试')
}

/** 拉起 Apple 授权。调用方：session.ts signInWithApple / bindApple、account.ts deleteAccount（撤销授权） */
export async function requestAppleAuth (): Promise<AppleAuthResult> {
  if (Platform.OS !== 'ios') throw unavailable()
  const s = loadSdk()
  if (!s || !s.isSupported) throw unavailable()
  let r
  try {
    r = await s.performRequest({ requestedOperation: s.Operation.LOGIN, requestedScopes: [], nonceEnabled: true })
  } catch (e) {
    throw mapAppleError(e, s)
  }
  if (!r || !r.identityToken || !r.nonce) throw unavailable('没有收到 Apple 登录凭证，请稍后再试')
  return { identityToken: r.identityToken, nonce: r.nonce, authorizationCode: r.authorizationCode || null }
}
