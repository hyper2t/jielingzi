/**
 * 练习 Tab（空壳，FE-M0-01）。M5：冥想计时入口 + 打卡热力图；M6：每日一题卡片。布局见 docs/prd/README.md §7.4。
 */
import { View, Text } from '@tarojs/components'
import { ConsentSheet, Empty, Screen } from '@/components'
import { useTrackPage } from '@/hooks/useTrackPage'
import { tw } from '@/utils/tw'

export const PRACTICE_PLACEHOLDER = '冥想计时与打卡即将开放'

export default function Practice () {
  useTrackPage('practice')
  return (
    <Screen tabPage nav={{ title: '练习' }} overlay={<ConsentSheet />}>
      <View {...tw('flex flex-col px-page pt-4')}>
        <Text {...tw('font-title font-bold text-title text-ink')}>练习</Text>
      </View>
      <Empty text={PRACTICE_PLACEHOLDER} />
    </Screen>
  )
}
