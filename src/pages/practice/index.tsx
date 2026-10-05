/** 练习 Tab：计时练习入口 + 仅本人可见的打卡日历（M5）；布局见 docs/prd/README.md §7.4。 */
import { View, Text } from '@tarojs/components'
import { Button, ConsentSheet, Screen } from '@/components'
import CheckinCalendar from '@/features/practice/CheckinCalendar'
import { useTrackPage } from '@/hooks/useTrackPage'
import { usePracticeTimer, formatCountdown } from '@/features/practice/timer'
import { navigate } from '@/utils/router'
import { tw } from '@/utils/tw'

export default function Practice () {
  useTrackPage('practice')
  const { timer, remainingMs } = usePracticeTimer()
  const active = timer?.status === 'running'
  const completed = timer?.status === 'completed'
  const headline = active ? formatCountdown(remainingMs) : completed ? '练习已完成' : '给自己一点时间'
  const detail = active
    ? '计时会按真实时间继续；切到后台或锁屏后回来会自动校准。'
    : completed
      ? '选择练习方式，一键记录这次练习。'
      : timer?.status === 'checked-in'
        ? '上一段练习已记录，想开始时随时回来。'
        : '不求专注，只需回到当下。'
  const action = active ? '继续计时' : completed ? '完成打卡' : timer?.status === 'checked-in' ? '开始下一段' : '设定练习时间'

  return (
    <Screen tabPage nav={{ title: '练习' }} overlay={<ConsentSheet />}>
      <View {...tw('flex flex-col px-page pt-4')}>
        <Text {...tw('font-title font-bold text-title text-ink')}>练习</Text>
        <Text {...tw('mt-1 font-body text-body text-ink-soft')}>为自己留一段安静的时间</Text>
      </View>

      <View {...tw('mx-4 mt-5 rounded-2xl border border-solid border-paper-dark bg-paper-light p-5')}>
        <Text {...tw('font-body text-caption font-bold text-brand-dark')}>冥想计时</Text>
        <Text {...tw('mt-3 font-title text-display font-bold text-ink')}>{headline}</Text>
        <Text {...tw('mt-2 font-body text-body text-ink-soft')}>{detail}</Text>
        <Button block size='kid' label={action} className='mt-5' onClick={() => navigate('timer')}>
          {action}
        </Button>
      </View>

      <CheckinCalendar />
    </Screen>
  )
}
