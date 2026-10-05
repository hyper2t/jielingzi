/**
 * Empty：小鹿插画 120 + 一句话 + 行动按钮（如"去首页听听"）。
 * 插画暂用品牌标志 mark.png 占位，正式插画到位后替换同名文件。
 */
import { View, Text, Image } from '@tarojs/components'
import { mergeTw, tw, TwProps } from '@/utils/tw'
import { a11yHidden } from '@/utils/a11y'
import mark from '@/assets/brand/mark.png'
import Button from '../Button'

export interface EmptyProps extends TwProps {
  text: string
  actionText?: string
  onAction?: () => void
  /** 区块内空态：插画 80、上下留白 16、文字 caption（如「我的」页最近播放 / 收藏） */
  compact?: boolean
}

export default function Empty ({ text, actionText, onAction, compact = false, className, style }: EmptyProps) {
  return (
    <View {...mergeTw(tw('flex flex-col items-center justify-center px-page', compact ? 'py-4' : 'py-section'), { className, style })}>
      <Image src={mark} mode='aspectFit' {...tw(compact ? 'w-20 h-20 mb-3' : 'w-[7.5rem] h-[7.5rem] mb-4')} {...a11yHidden()} />
      <Text {...tw('font-body', compact ? 'text-caption' : 'text-body', 'text-ink-soft text-center', compact ? 'mb-3' : 'mb-6')}>{text}</Text>
      {actionText && onAction && (
        <Button variant='secondary' onClick={onAction} {...tw('self-center')}>{actionText}</Button>
      )}
    </View>
  )
}
