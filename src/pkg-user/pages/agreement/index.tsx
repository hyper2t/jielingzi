/**
 * 协议页：用户协议 / 隐私政策。
 * 长文排版：body 字号，行宽不超过 34 字（max-w-[34em]）。正文见 features/consent/agreements.ts（法务定稿后替换）。
 */
import Taro from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { Screen } from '@/components'
import { AGREEMENTS, isAgreementType } from '@/features/consent/agreements'
import { parseParams } from '@/utils/router'
import { tw } from '@/utils/tw'

export default function Agreement () {
  let raw: Record<string, string | undefined> = {}
  try {
    raw = Taro.getCurrentInstance()?.router?.params || {}
  } catch (e) {
    raw = {}
  }
  const t = parseParams<'agreement'>(raw).type
  const doc = AGREEMENTS[isAgreementType(t) ? t : 'user']
  return (
    <Screen nav={{ title: doc.title, showBack: true }}>
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
