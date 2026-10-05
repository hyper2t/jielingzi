/**
 * 协议页：用户协议 / 隐私政策 / 社区公约；type=rules&mode=gate 时为首次发布前的公约阅读（FE-M2-03）。
 * 长文排版：body 字号，行宽不超过 34 字（max-w-[34em]）。正文见 features/consent/agreements.ts（法务定稿后替换）。
 */
import Taro from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { Button, Screen, showToast } from '@/components'
import { AGREEMENTS, isAgreementType } from '@/features/consent/agreements'
import { markRulesRead } from '@/features/consent/rules'
import { back, parseParams } from '@/utils/router'

export const RULES_ACK = '我已阅读并遵守'
import { tw } from '@/utils/tw'

export default function Agreement () {
  let raw: Record<string, string | undefined> = {}
  try {
    raw = Taro.getCurrentInstance()?.router?.params || {}
  } catch (e) {
    raw = {}
  }
  const { type: t, mode } = parseParams<'agreement'>(raw)
  const doc = AGREEMENTS[isAgreementType(t) ? t : 'user']
  // 首次发布前的公约阅读（FE-M2-03）：底部确认后记本机并返回发布入口
  const gate = t === 'rules' && mode === 'gate'
  const footer = gate
    ? (
      <View {...tw('px-page pt-2 pb-6 bg-paper')}>
        <Button block size='kid' onClick={() => { markRulesRead(); showToast('感谢遵守公约'); void back() }}>{RULES_ACK}</Button>
      </View>
      )
    : undefined
  return (
    <Screen nav={{ title: doc.title, showBack: true }} footer={footer}>
      <View {...tw('flex flex-col px-page py-4 max-w-[34em]')}>
        {doc.sections.map(s => (
          <View key={s.heading} {...tw('flex flex-col mb-6')}>
            <Text {...tw('font-title font-bold text-subtitle text-ink mb-2')}>{s.heading}</Text>
            <Text {...tw('font-body text-body text-ink')}>{s.body}</Text>
          </View>
        ))}
      </View>
    </Screen>
  )
}
