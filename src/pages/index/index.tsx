/**
 * 首页（M3 起为话题流，PRD §7.1）。M1：导航栏「✎ 发起话题」入口先接上发布门禁（FE-M1-02）——
 * 同意 → 18+ →（App）登录 → 实名，未实名时小程序弹手机号验证（PhoneSheet）、App 进绑定手机号；通过后提示即将开放（M3 实现发帖页）。
 * 取数模式参考：useRequest(key, () => services/<业务>.ts 的函数)，未同意 / 未登录时 key 传 null 不发请求。
 */
import { View, Text } from '@tarojs/components'
import { ConsentSheet, Empty, Icon, PhoneSheet, Screen, showToast } from '@/components'
import { requirePhone } from '@/features/auth/gates'
import { useTrackPage } from '@/hooks/useTrackPage'
import { tw } from '@/utils/tw'
import { a11yButton } from '@/utils/a11y'

export const HOME_PLACEHOLDER = '深度话题即将开放'
export const NEW_TOPIC = '发起话题'
export const NEW_TOPIC_SOON = '话题即将开放'

export function onNewTopic (): void {
  if (requirePhone({ reason: NEW_TOPIC })) showToast(NEW_TOPIC_SOON)
}

export default function Index () {
  useTrackPage('home')
  const newTopic = (
    <View
      {...tw('flex flex-row items-center justify-center w-touch h-touch rounded-full')}
      hoverClass={tw('bg-paper-dark').className}
      onClick={onNewTopic}
      {...a11yButton(NEW_TOPIC)}
    >
      <Icon name='pencil' size='md' />
    </View>
  )
  return (
    <Screen tabPage nav={{ title: '结灵子', right: newTopic }} overlay={<><ConsentSheet /><PhoneSheet /></>}>
      <View {...tw('flex flex-col px-page pt-4')}>
        <Text {...tw('font-title font-bold text-title text-ink')}>结灵子</Text>
      </View>
      <Empty text={HOME_PLACEHOLDER} />
    </Screen>
  )
}
