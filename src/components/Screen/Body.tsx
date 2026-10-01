/**
 * Screen 内容区（小程序 / H5）：页面本身就是滚动容器（小程序原生页面滚动 / H5 body 滚动），这里只是一个撑满的 View；
 * fixed 定位的浮层由 CSS 处理。RN 端见 Body.rn.tsx。
 */
import type { ReactNode, Ref } from 'react'
import { useImperativeHandle } from 'react'
import { View } from '@tarojs/components'
import { tw } from '@/utils/tw'
import type { ScreenScrollHandle } from './types'

export interface ScreenBodyProps {
  children?: ReactNode
  scrollRef?: Ref<ScreenScrollHandle>
  /** 用户手势滚动开始（RN 用；小程序页面滚动由页面自己监听 onTouchMove） */
  onUserScroll?: () => void
  /** 触底（RN 用；小程序 / H5 请继续用 Taro.useReachBottom） */
  onReachBottom?: () => void
  reachBottomDistance?: number
}

const noop: ScreenScrollHandle = { scrollTo: () => undefined, viewportHeight: () => 0 }

export default function ScreenBody ({ children, scrollRef }: ScreenBodyProps) {
  useImperativeHandle(scrollRef, () => noop, [])
  return <View {...tw('flex flex-col flex-1')}>{children}</View>
}
