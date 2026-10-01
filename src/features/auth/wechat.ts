/**
 * 微信登录能力探测（FE-L05，Phase 2）。小程序 / H5 版：App 微信登录不适用，恒为不可用。
 * RN 实现见 wechat.rn.ts（Taro 按平台后缀解析）。
 */
import { CloudError, ERROR_CODES } from '@/services/cloud.types'

export interface WechatAuthResult { code: string, state: string }

export async function isWechatLoginAvailable (): Promise<boolean> {
  return false
}

export async function requestWechatAuth (): Promise<WechatAuthResult> {
  throw new CloudError(ERROR_CODES.WECHAT_UNAVAILABLE, '微信登录暂不可用')
}
