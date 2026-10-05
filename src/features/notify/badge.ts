/**
 * tabBar 上的未读角标（「我的」Tab，FE-M6-03）。
 *
 * 只有小程序有原生 tabBar 角标：H5 / RN 没有对应 API 就直接跳过，**页面内「我的 → 消息」的未读数才是保证送达的展示**，
 * 这里只是省一次点击的提示，所以失败不重试、也不报错（微信在「本来没有角标」时调用 remove 也会 reject）。
 */
import Taro from '@tarojs/taro'
import { MINE_TAB_INDEX, badgeText } from './rules'

/** @returns 是否真的动过角标（测试与环境判断用；调用方不需要处理返回值） */
export async function syncTabBadge(unread: number, taro: any = Taro): Promise<boolean> {
  if (process.env.TARO_ENV !== 'weapp') return false
  if (!taro || typeof taro.setTabBarBadge !== 'function' || typeof taro.removeTabBarBadge !== 'function') return false
  try {
    if (unread > 0)
      await taro.setTabBarBadge({
        index: MINE_TAB_INDEX,
        text: badgeText(unread),
      })
    else await taro.removeTabBarBadge({ index: MINE_TAB_INDEX })
    return true
  } catch (e) {
    return false
  }
}
