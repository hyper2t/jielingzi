/**
 * 导航栏尺寸：状态栏高度 + 与小程序胶囊按钮对齐的导航内容高度。
 * 小程序用 getMenuButtonBoundingClientRect 对齐胶囊；H5 / RN 使用 44pt 默认值。
 */
import Taro from '@tarojs/taro'

export interface NavMetrics {
  statusBarHeight: number
  navHeight: number
  /** 右侧为胶囊按钮预留的宽度（px），非小程序为 0 */
  capsuleGap: number
}

const DEFAULT_NAV = 44
let cache: NavMetrics | null = null

export function getNavMetrics (): NavMetrics {
  if (cache) return cache
  let statusBarHeight = 0
  let navHeight = DEFAULT_NAV
  let capsuleGap = 0
  try {
    const sys = Taro.getSystemInfoSync()
    statusBarHeight = sys.statusBarHeight || 0
    if (process.env.TARO_ENV === 'weapp') {
      const menu = Taro.getMenuButtonBoundingClientRect()
      if (menu && menu.height) {
        navHeight = (menu.top - statusBarHeight) * 2 + menu.height
        capsuleGap = sys.windowWidth - menu.left
      }
    }
  } catch (e) {
    // 取不到时用默认值，不影响渲染
  }
  cache = { statusBarHeight, navHeight, capsuleGap }
  return cache
}
