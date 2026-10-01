/**
 * 冥想计时（占位，FE-M0-01）。M5 实现：预设时长、提示音、切后台按时间戳恢复、完成后打卡。布局见 docs/prd/README.md §7.4。
 */
import { Empty, Screen } from '@/components'
import { useTrackPage } from '@/hooks/useTrackPage'

export const TIMER_PLACEHOLDER = '冥想计时即将开放'

export default function Timer () {
  useTrackPage('timer')
  return (
    <Screen nav={{ title: '冥想计时', showBack: true }}>
      <Empty text={TIMER_PLACEHOLDER} />
    </Screen>
  )
}
