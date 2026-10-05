/** 区块标题：宋体 title 左对齐，可选右侧「全部›」 */
import { View, Text } from '@tarojs/components'
import { mergeTw, tw, TwProps } from '@/utils/tw'
import { a11yButton } from '@/utils/a11y'
import Icon from '../Icon'

export interface SectionTitleProps extends TwProps {
  title: string
  moreText?: string
  onMore?: () => void
}

export default function SectionTitle ({ title, moreText = '全部', onMore, className, style }: SectionTitleProps) {
  return (
    <View {...mergeTw(tw('flex flex-row items-center justify-between px-page mb-3'), { className, style })}>
      <Text {...tw('font-title font-bold text-title text-ink')}>{title}</Text>
      {onMore && (
        <View {...tw('flex flex-row items-center min-h-touch pl-3')} onClick={onMore} {...a11yButton(`${title}，${moreText}`)}>
          <Text {...tw('font-body text-body text-ink-soft')}>{moreText}</Text>
          <Icon name='chevron-right' tone='soft' size='sm' />
        </View>
      )}
    </View>
  )
}
