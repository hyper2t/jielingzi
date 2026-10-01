/**
 * 设置：入口在「我的」导航栏右侧（App 端需先登录，决策 L1）。
 * - TODO(business)：业务设置项。模式：本地立即生效（useSettingsStore），已同意（App 端且已登录）时经 services/me.ts setSettings 写 users.settings；
 *   云端白名单在 cloudfunctions/_shared/settings.js
 * - App 端「账号」区（account.tsx）：登录方式、绑定手机号 / 微信 / Apple、退出登录、注销账号
 * - 清除本机数据：二次确认 → 清本地缓存、设置与同意记录（保留登录态与云端数据）→ 回到首次流程
 */
import Taro from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { Button, Screen } from '@/components'
import { HAS_LOGIN, useUserStore } from '@/store/user'
import { CLEAR_CONFIRM, resetLocalData } from '@/features/auth/clear'
import { tw } from '@/utils/tw'
import AccountSection, { ACCOUNT_NOTE } from './account'

function Section ({ title, note, children }: { title: string, note?: string, children: JSX.Element }) {
  return (
    <View {...tw('flex flex-col mb-section')}>
      <Text {...tw('font-title font-bold text-subtitle text-ink mb-1')}>{title}</Text>
      {!!note && <Text {...tw('font-body text-caption text-ink-soft mb-2')}>{note}</Text>}
      {children}
    </View>
  )
}

export const CLEAR_TITLE = '清除本机数据'

export default function Settings () {
  const consent = useUserStore(s => s.consent)
  const signedIn = useUserStore(s => !HAS_LOGIN || s.auth.signedIn)

  const onClear = async () => {
    const r = await Taro.showModal({ title: CLEAR_TITLE, content: CLEAR_CONFIRM, confirmText: '清除', confirmColor: '#A4432F' })
    if (!r.confirm) return
    await resetLocalData()
  }

  return (
    <Screen nav={{ title: '设置', showBack: true }}>
      <View {...tw('flex flex-col px-page py-4')}>
        {consent !== 'agreed' && <Text {...tw('font-body text-caption text-ink-soft mb-4')}>未同意协议：设置只保存在本机</Text>}
        {consent === 'agreed' && !signedIn && <Text {...tw('font-body text-caption text-ink-soft mb-4')}>未登录：设置只保存在本机</Text>}
        {HAS_LOGIN && (
          <Section title='账号' note={ACCOUNT_NOTE}>
            <AccountSection />
          </Section>
        )}
        <Button variant='secondary' onClick={() => { void onClear() }} {...tw('mt-6')}>{CLEAR_TITLE}</Button>
        <Text {...tw('font-body text-caption text-ink-faint mt-2')}>{CLEAR_CONFIRM}</Text>
      </View>
    </Screen>
  )
}
