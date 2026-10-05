/** 冥想计时：预设时长、开始 / 结束轻提示、后台恢复与一键私人打卡（FE-M5-01/02）。 */
import { useEffect, useState } from 'react'
import { View, Text } from '@tarojs/components'
import { Button, Screen, SectionTitle } from '@/components'
import { PRACTICES } from '@/constants/community'
import type { PracticeId } from '@/constants/community'
import { useTrackPage } from '@/hooks/useTrackPage'
import { markTimerCheckedIn, resetPracticeTimer, setTimerPractice, startPracticeTimer, TIMER_PRESETS, usePracticeTimer, formatCountdown } from '@/features/practice/timer'
import { readPendingCheckins, submitCheckin } from '@/features/practice/checkins'
import { localDateKey } from '@/features/practice/calendar'
import { a11yButton } from '@/utils/a11y'
import { tw } from '@/utils/tw'

const DEFAULT_PRACTICE: PracticeId = 'meditation'

export default function Timer () {
  useTrackPage('timer')
  const { timer, remainingMs } = usePracticeTimer()
  const [minutes, setMinutes] = useState(20)
  const [practice, setPractice] = useState<PracticeId>(DEFAULT_PRACTICE)
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (timer?.practice) setPractice(timer.practice)
  }, [timer?.practice])

  const choosePractice = (id: PracticeId) => {
    setPractice(id)
    setTimerPractice(id)
  }

  const begin = () => {
    if (timer?.status === 'checked-in') resetPracticeTimer()
    setNotice('')
    startPracticeTimer(minutes, Date.now())
  }

  const checkIn = async () => {
    if (!timer || timer.status !== 'completed' || submitting) return
    setSubmitting(true)
    setNotice('')
    try {
      await submitCheckin({
        sessionId: timer.sessionId,
        date: localDateKey(timer.completedAt || timer.endsAt),
        practice,
        minutes: timer.minutes
      }, timer.ownerId)
      markTimerCheckedIn()
      const isPending = readPendingCheckins().some(row => row.sessionId === timer.sessionId)
      setNotice(isPending ? '已暂存在本机，联网并完成同意与 18+ 确认后会自动补传。' : '已完成打卡，记录仅你本人可见。')
    } catch {
      setNotice('暂时无法保存，请稍后重试。')
    } finally {
      setSubmitting(false)
    }
  }

  const status = timer?.status || 'idle'
  const clock = status === 'running'
    ? formatCountdown(remainingMs)
    : status === 'completed' || status === 'checked-in'
      ? '00:00'
      : `${String(minutes).padStart(2, '0')}:00`
  const clockHint = status === 'running'
    ? '练习进行中'
    : status === 'completed'
      ? '这一段练习完成了'
      : status === 'checked-in'
        ? '这一段练习已记录'
        : '选择一个适合自己的时长'
  const queued = timer ? readPendingCheckins().some(row => row.sessionId === timer.sessionId) : false

  return (
    <Screen nav={{ title: '冥想计时', showBack: true }}>
      <View {...tw('flex flex-col px-page pt-4')}>
        <Text {...tw('font-title font-bold text-title text-ink')}>把注意力带回此刻</Text>
        <Text {...tw('mt-1 font-body text-body text-ink-soft')}>开始与结束时会有轻提示音。</Text>

        <View {...tw('mt-6 flex flex-col items-center rounded-2xl border border-solid border-paper-dark bg-paper-light px-5 py-6')}>
          <View
            style={{ width: 232, height: 232, borderRadius: 116, borderWidth: 1, borderColor: '#DCE4D4', backgroundColor: '#F8F7F1', alignItems: 'center', justifyContent: 'center' }}
          >
            <Text {...tw('font-title font-bold text-hero text-ink')}>{clock}</Text>
            <Text {...tw('mt-2 font-body text-body text-ink-soft')}>{clockHint}</Text>
          </View>

          {(status === 'idle' || status === 'checked-in') && (
            <View {...tw('mt-5 w-full')}>
              <Text {...tw('mb-3 text-center font-body text-body text-ink-soft')}>预设时长</Text>
              <View style={{ display: 'flex', flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap' }}>
                {TIMER_PRESETS.map(value => (
                  <View
                    key={value}
                    {...tw('mx-1 mb-2 flex min-h-touch items-center justify-center rounded-full border border-solid px-4', minutes === value ? 'border-brand bg-brand' : 'border-paper-dark bg-paper-light')}
                    style={{ minWidth: 68 }}
                    onClick={() => setMinutes(value)}
                    {...a11yButton(`${value} 分钟`)}
                  >
                    <Text {...tw('font-body font-bold text-body', minutes === value ? 'text-paper-light' : 'text-ink')}>{`${value} 分钟`}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {status === 'completed' && (
            <View {...tw('mt-5 w-full')}>
              <SectionTitle title='练习方式' className='px-0' />
              <View style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap' }}>
                {PRACTICES.map(item => (
                  <View
                    key={item.id}
                    {...tw('mr-2 mb-2 rounded-full border border-solid px-3 py-2', practice === item.id ? 'border-brand bg-brand' : 'border-paper-dark bg-paper-light')}
                    onClick={() => choosePractice(item.id)}
                    {...a11yButton(`选择${item.label}`)}
                  >
                    <Text {...tw('font-body text-caption', practice === item.id ? 'text-paper-light' : 'text-ink')}>{item.label}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {status === 'idle' && (
            <Button block size='kid' label='开始冥想计时' className='mt-5' onClick={begin}>开始计时</Button>
          )}
          {status === 'running' && (
            <Text {...tw('mt-5 text-center font-body text-caption text-ink-soft')}>
              切到后台或锁屏后，回来时会按真实时间自动恢复。
            </Text>
          )}
          {status === 'completed' && (
            <Button block size='kid' label='记录这次练习' loading={submitting} className='mt-5' onClick={checkIn}>一键打卡</Button>
          )}
          {status === 'checked-in' && (
            <View {...tw('mt-5 w-full')}>
              <Text {...tw('text-center font-body text-body text-ink-soft')}>
                {queued ? '记录已暂存在本机，之后会自动补传。' : '记录已保存到个人日历。'}
              </Text>
              <Button block size='kid' label='开始下一段练习' className='mt-4' onClick={begin}>开始下一段</Button>
            </View>
          )}
          {!!notice && <Text {...tw('mt-3 text-center font-body text-caption text-brand-dark')}>{notice}</Text>}
        </View>

        <Text {...tw('mt-4 px-2 font-body text-caption text-ink-soft')}>
          计时依据开始与结束时间计算；通话、锁屏或切换应用后，回到页面即可继续或完成。
        </Text>
      </View>
    </Screen>
  )
}
