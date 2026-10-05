/**
 * Toast：操作结果轻提示，1.5s 自动消失，文字 ≤ 8 字（04-ui §6）。
 * 三端统一走 Taro.showToast（RN 由 taro-rn 实现）。
 */
import Taro from '@tarojs/taro'

export const TOAST_DURATION = 1500
export const TOAST_MAX_LEN = 8

export function showToast (title: string, opts: { duration?: number } = {}) {
  if (process.env.NODE_ENV !== 'production' && Array.from(title).length > TOAST_MAX_LEN) {
    console.warn(`[Toast] 文案超过 ${TOAST_MAX_LEN} 字：${title}`)
  }
  return Taro.showToast({ title, icon: 'none', duration: opts.duration ?? TOAST_DURATION })
}

export function hideToast () {
  return Taro.hideToast()
}

export const toast = { show: showToast, hide: hideToast }
export default toast
