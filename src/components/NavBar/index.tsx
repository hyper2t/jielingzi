/**
 * NavBar：自定义导航（app.config 中 navigationStyle: custom）。
 * 状态栏占位 + 与小程序胶囊对齐的内容区；标题宋体左对齐，可选印章与右侧插槽。
 * 返回键热区 44×44；无上一页时回首页（router.back）。
 */
import type { ReactNode } from 'react'
import { View, Text } from '@tarojs/components'
import { mergeTw, tw, TwProps } from '@/utils/tw'
import { getNavMetrics } from '@/utils/system'
import { back } from '@/utils/router'
import { a11yButton } from '@/utils/a11y'
import Icon from '../Icon'
import Seal from '../Seal'

export interface NavBarProps extends TwProps {
  title?: string
  showBack?: boolean
  onBack?: () => void
  seal?: string
  right?: ReactNode
  /** 透明背景（播放页等叠在内容上） */
  transparent?: boolean
}

export default function NavBar ({ title, showBack = false, onBack, seal, right, transparent = false, className, style }: NavBarProps) {
  const { statusBarHeight, navHeight, capsuleGap } = getNavMetrics()
  return (
    <View {...mergeTw(tw(transparent ? 'bg-transparent' : 'bg-paper'), { className, style: { paddingTop: statusBarHeight, ...style } })}>
      <View {...tw('flex flex-row items-center px-2')} style={{ height: navHeight, paddingRight: capsuleGap || undefined }}>
        {showBack && (
          <View
            {...tw('flex items-center justify-center w-touch h-touch rounded-full')}
            hoverClass={tw('bg-paper-dark').className}
            onClick={() => (onBack ? onBack() : back())}
            {...a11yButton('返回')}
          >
            <Icon name='chevron-left' size='lg' />
          </View>
        )}
        {title && (
          <Text {...tw('flex-1 font-title font-bold text-subtitle text-ink', showBack ? 'ml-1' : 'ml-3')} numberOfLines={1}>{title}</Text>
        )}
        {!title && <View {...tw('flex-1')} />}
        {seal && <Seal text={seal} size='sm' {...tw('mr-2')} />}
        {right}
      </View>
    </View>
  )
}
