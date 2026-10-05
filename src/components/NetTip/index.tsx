/**
 * NetTip：弱网 / 离线提示条（页面顶部）。在线时不渲染。
 * `online` 传入时由外部控制（测试 / 已知状态）；否则监听 Taro 网络状态。
 */
import { useEffect, useState } from 'react'
import Taro from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { mergeTw, tw, TwProps } from '@/utils/tw'
import { a11yButton } from '@/utils/a11y'
import Icon from '../Icon'

export function useNetworkOnline (): boolean {
  const [online, setOnline] = useState(true)
  useEffect(() => {
    let alive = true
    const onChange = (res: { isConnected: boolean }) => { if (alive) setOnline(res.isConnected) }
    Taro.getNetworkType()
      .then(res => { if (alive) setOnline(res.networkType !== 'none') })
      .catch(() => {})
    Taro.onNetworkStatusChange(onChange)
    return () => {
      alive = false
      if (Taro.offNetworkStatusChange) Taro.offNetworkStatusChange(onChange)
    }
  }, [])
  return online
}

export interface NetTipProps extends TwProps {
  online?: boolean
  text?: string
  onRetry?: () => void
}

function Bar ({ text, onRetry, className, style }: Omit<NetTipProps, 'online'>) {
  return (
    <View
      {...mergeTw(tw('flex flex-row items-center min-h-touch px-page bg-paper-dark'), { className, style })}
      onClick={onRetry}
      {...a11yButton(onRetry ? `${text}，点我重试` : text)}
    >
      <Icon name='wifi-off' tone='soft' size='sm' {...tw('mr-2')} />
      <Text {...tw('flex-1 font-body text-caption text-ink')}>{text}</Text>
      {onRetry && <Text {...tw('font-body text-caption font-bold text-brand-dark')}>点我重试</Text>}
    </View>
  )
}

function AutoNetTip (props: Omit<NetTipProps, 'online'>) {
  const online = useNetworkOnline()
  return online ? null : <Bar {...props} />
}

export default function NetTip ({ online, text = '网络不太好，先看看缓存的内容', ...rest }: NetTipProps) {
  if (online === undefined) return <AutoNetTip text={text} {...rest} />
  return online ? null : <Bar text={text} {...rest} />
}
