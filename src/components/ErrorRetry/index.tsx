/**
 * ErrorRetry：加载失败。
 * - inline：行内条「网络不太好，点我重试」，墨色字 + 朱砂重试链接，整行可点（≥ 44pt）
 * - block（默认）：整页失败，小鹿 + 文案 + 重试按钮
 */
import { View, Text } from '@tarojs/components'
import { mergeTw, tw, TwProps } from '@/utils/tw'
import { a11yButton } from '@/utils/a11y'
import Empty from '../Empty'
import Icon from '../Icon'

export interface ErrorRetryProps extends TwProps {
  message?: string
  inline?: boolean
  onRetry: () => void
}

export default function ErrorRetry ({ message = '网络不太好', inline = false, onRetry, className, style }: ErrorRetryProps) {
  if (!inline) {
    return <Empty text={message} actionText='点我重试' onAction={onRetry} className={className} style={style} />
  }
  return (
    <View
      {...mergeTw(tw('flex flex-row items-center justify-center min-h-touch px-page'), { className, style })}
      hoverClass={tw('bg-paper-dark').className}
      onClick={onRetry}
      {...a11yButton(`${message}，点我重试`)}
    >
      <Icon name='refresh-cw' tone='brand' size='sm' {...tw('mr-2')} />
      <Text {...tw('font-body text-body text-ink')}>{message}，</Text>
      <Text {...tw('font-body text-body font-bold text-brand-dark')}>点我重试</Text>
    </View>
  )
}
