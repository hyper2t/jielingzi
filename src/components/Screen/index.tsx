/**
 * Screen：页面容器（所有页必用）。宣纸底 + NavBar + 弱网条 + 骨架 / 错误 / 空态切换。
 * - status: loading 显示骨架（可传 skeleton 自定义）；error 显示整页 ErrorRetry；empty 显示 Empty
 * - 非 tabBar 页底部预留安全区（小程序 / H5 用 .jl-safe-bottom）
 * - 底部固定区挂在 footer；全屏浮层（ConsentSheet）挂在 overlay
 * - 内容区 Body：小程序 / H5 为普通 View（页面自己滚动）；RN 为 Screen 自己的 ScrollView（Body.rn.tsx，FE-RN-06），
 *   footer / overlay 在滚动区之外，absolute 定位才等价于小程序的 fixed
 */
import type { ReactNode, Ref } from 'react'
import { View } from '@tarojs/components'
import { mergeTw, tw, TwProps } from '@/utils/tw'
import NavBar, { NavBarProps } from '../NavBar'
import NetTip from '../NetTip'
import Skeleton from '../Skeleton'
import ErrorRetry from '../ErrorRetry'
import Empty from '../Empty'
import ScreenBody from './Body'
import type { ScreenScrollHandle } from './types'

export type { ScreenScrollHandle } from './types'

export type ScreenStatus = 'ready' | 'loading' | 'error' | 'empty'

export interface ScreenProps extends TwProps {
  children?: ReactNode
  nav?: NavBarProps | false
  status?: ScreenStatus
  skeleton?: ReactNode
  errorText?: string
  emptyText?: string
  emptyActionText?: string
  onEmptyAction?: () => void
  onRetry?: () => void
  /** tabBar 页由原生 tabBar 处理底部安全区 */
  tabPage?: boolean
  /** 覆盖网络状态（测试用）；默认自动监听 */
  online?: boolean
  footer?: ReactNode
  /** 全屏浮层（如 ConsentSheet），不受 status 切换影响，渲染在根节点最后 */
  overlay?: ReactNode
  /** 内容区滚动句柄（RN 端可 scrollTo；小程序 / H5 为空实现，请用 Taro.pageScrollTo） */
  scrollRef?: Ref<ScreenScrollHandle>
  /** RN：用户开始手势滚动；小程序 / H5 不触发 */
  onUserScroll?: () => void
  /** RN：内容区触底（页面 disableScroll 后 Taro.useReachBottom 不再触发，翻页请同时传这里）；小程序 / H5 不触发 */
  onReachBottom?: () => void
}

const safeBottom: TwProps = process.env.TARO_ENV === 'rn' ? {} : { className: 'jl-safe-bottom' }

export default function Screen (props: ScreenProps) {
  const {
    children, nav = {}, status = 'ready', skeleton, errorText, emptyText = '这里还空空的',
    emptyActionText, onEmptyAction, onRetry, tabPage = false, online, footer, overlay, className, style,
    scrollRef, onUserScroll, onReachBottom
  } = props

  let body: ReactNode = children
  if (status === 'loading') body = skeleton || <Skeleton rows={4} {...tw('pt-4')} />
  else if (status === 'error') body = <ErrorRetry message={errorText} onRetry={onRetry || (() => {})} />
  else if (status === 'empty') body = <Empty text={emptyText} actionText={emptyActionText} onAction={onEmptyAction} />

  const root = mergeTw(tw('flex flex-col flex-1 min-h-screen bg-paper'), tabPage ? undefined : safeBottom)
  return (
    <View {...mergeTw(root, { className, style })}>
      {nav !== false && <NavBar {...nav} />}
      <NetTip online={online} onRetry={onRetry} />
      <ScreenBody scrollRef={scrollRef} onUserScroll={onUserScroll} onReachBottom={onReachBottom}>{body}</ScreenBody>
      {footer}
      {overlay}
    </View>
  )
}
