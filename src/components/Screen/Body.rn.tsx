/**
 * Screen 内容区（RN，FE-RN-06）：Taro RN 默认把整页包进 ScrollView（@tarojs/runtime-rn page.js），
 * 页面里 absolute 的 浮层 / 底部控件会跟着内容一起滚。策略：
 * - 所有页面 *.config.ts 在 RN 上 disableScroll: true，关掉 Taro 的页面级 ScrollView；
 * - Screen 自己用这个 ScrollView 只包 body，footer / overlay 留在滚动区之外，absolute bottom-0 就等价于小程序的 fixed；
 * - 触底、手势滚动、scrollTo 通过 props / 句柄暴露（播放页自动滚动、分类页翻页）。
 */
import type { ComponentType, ReactNode, Ref } from 'react'
import { useImperativeHandle, useRef } from 'react'
import { ScrollView as RNScrollView } from 'react-native'
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, ScrollViewProps } from 'react-native'
import type { ScreenScrollHandle } from './types'

/**
 * 仓库里 @types/react 18.3 与 RN 0.70 自带的组件类型（class 组件缺 refs 声明）不兼容，直接写 <ScrollView> 会报 TS2786；
 * 这里只收窄类型，不改运行时（tsc 校验的是 weapp 视角，RN 打包走 babel 不做类型检查）。
 */
const ScrollView = RNScrollView as unknown as ComponentType<ScrollViewProps & { ref?: Ref<RNScrollView> }>

export interface ScreenBodyProps {
  children?: ReactNode
  scrollRef?: Ref<ScreenScrollHandle>
  onUserScroll?: () => void
  onReachBottom?: () => void
  reachBottomDistance?: number
}

export const DEFAULT_REACH_BOTTOM_DISTANCE = 100

export default function ScreenBody ({ children, scrollRef, onUserScroll, onReachBottom, reachBottomDistance = DEFAULT_REACH_BOTTOM_DISTANCE }: ScreenBodyProps) {
  const ref = useRef<RNScrollView>(null)
  const viewport = useRef(0)
  /** 触底只在「进入触底区」时触发一次，离开后才能再次触发（与小程序 onReachBottom 语义一致） */
  const inBottom = useRef(false)

  useImperativeHandle(scrollRef, () => ({
    scrollTo: (y, animated = true) => ref.current?.scrollTo({ y: Math.max(0, y), animated }),
    viewportHeight: () => viewport.current
  }), [])

  const onLayout = (e: LayoutChangeEvent) => { viewport.current = e.nativeEvent.layout.height }

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!onReachBottom) return
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent
    const near = contentOffset.y + layoutMeasurement.height + reachBottomDistance >= contentSize.height
    if (near && !inBottom.current) onReachBottom()
    inBottom.current = near
  }

  return (
    <ScrollView
      ref={ref}
      style={{ flex: 1 }}
      contentContainerStyle={{ flexGrow: 1 }}
      keyboardShouldPersistTaps='handled'
      scrollEventThrottle={16}
      onLayout={onLayout}
      onScroll={onScroll}
      onScrollBeginDrag={onUserScroll}
    >
      {children}
    </ScrollView>
  )
}
