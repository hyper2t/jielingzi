/** 页面曝光：每次页面显示（含 tab 切回）上报一次 page_view */
import { useDidShow } from '@tarojs/taro'
import { track } from '@/utils/track'

export function useTrackPage (page: string) {
  useDidShow(() => { track('page_view', { page }) })
}
