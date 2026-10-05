/**
 * 通过 Apple 登录（NA-L04）。小程序 / H5 版：不适用，恒为不可用。RN 实现见 apple.rn.ts。
 */
import { CloudError, ERROR_CODES } from '@/services/cloud.types'

export interface AppleAuthResult { identityToken: string, nonce: string, authorizationCode: string | null }

export async function isAppleLoginAvailable (): Promise<boolean> {
  return false
}

export async function requestAppleAuth (): Promise<AppleAuthResult> {
  throw new CloudError(ERROR_CODES.APPLE_UNAVAILABLE, '通过 Apple 登录暂不可用')
}
