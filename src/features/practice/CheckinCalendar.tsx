/** 个人打卡日历热力图；只向 practice.listCheckins 请求当前身份的数据。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text } from '@tarojs/components'
import { useDidShow } from '@tarojs/taro'
import { Icon, useNetworkOnline } from '@/components'
import type { DailyCheckin } from '@/types/models'
import { listCheckins } from '@/services/practice'
import { pendingCheckinsForMonth, syncPendingCheckins } from './checkins'
import { buildCalendarCells, heatColor, localDateKey, localMonthKey, mergePendingCheckins, monthLabel, shiftMonth } from './calendar'
import { canSync, isAdultConfirmed } from '@/store/user'
import { a11yButton } from '@/utils/a11y'
import { tw } from '@/utils/tw'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

export default function CheckinCalendar () {
  const online = useNetworkOnline()
  const [month, setMonth] = useState(() => localMonthKey())
  const [rows, setRows] = useState<DailyCheckin[]>([])
  const [selectedDate, setSelectedDate] = useState(() => localDateKey(Date.now()))
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const activeMonth = useRef(month)
  const loadingRef = useRef(false)
  const lastLoaded = useRef({ month: '', at: 0 })
  const reloadRef = useRef<() => void>(() => undefined)
  activeMonth.current = month

  const load = useCallback(async (force = false) => {
    const targetMonth = month
    if (loadingRef.current) return
    if (!force && lastLoaded.current.month === targetMonth && Date.now() - lastLoaded.current.at < 2000) return
    loadingRef.current = true
    lastLoaded.current = { month: targetMonth, at: Date.now() }
    setLoading(true)
    let remote: DailyCheckin[] = []
    let failed = false
    try {
      try { await syncPendingCheckins() } catch { /* 日历仍可先显示本机队列 */ }
      const result = await listCheckins(targetMonth)
      remote = Array.isArray(result.list) ? result.list : []
    } catch {
      failed = true
    }
    // 归属判定统一走 checkins 的身份解析：小程序 / H5 的登录态不带 accountId
    const pending = pendingCheckinsForMonth(targetMonth)
    if (activeMonth.current === targetMonth) {
      setRows(mergePendingCheckins(remote, pending))
      setOffline(failed)
      setPendingCount(pending.length)
      setLoading(false)
    }
    loadingRef.current = false
    if (activeMonth.current !== targetMonth) reloadRef.current()
  }, [month])

  reloadRef.current = () => { void load(true) }

  useEffect(() => {
    lastLoaded.current = { month: '', at: 0 }
    setSelectedDate(month === localMonthKey() ? localDateKey(Date.now()) : `${month}-01`)
    void load(true)
  }, [month, load])

  useDidShow(() => {
    if (Date.now() - lastLoaded.current.at > 2000) reloadRef.current()
  })

  useEffect(() => {
    if (online) reloadRef.current()
  }, [online])

  const cells = buildCalendarCells(month, rows)
  const selected = rows.find(row => row.date === selectedDate)
  const totalMinutes = rows.reduce((sum, row) => sum + row.minutes, 0)
  const todayMonth = localMonthKey()
  const nextDisabled = month >= todayMonth
  const visibleOnlyLocally = !canSync() || !isAdultConfirmed()

  return (
    <View {...tw('mx-4 mt-6 mb-8 rounded-2xl border border-solid border-paper-dark bg-paper-light p-4')}>
      <View {...tw('mb-3 flex flex-row items-center justify-between')}>
        <View>
          <Text {...tw('font-title text-title font-bold text-ink')}>练习日历</Text>
          <Text {...tw('mt-1 font-body text-caption text-ink-soft')}>仅你本人可见</Text>
        </View>
        <View {...tw('flex flex-row items-center')}>
          <View {...tw('flex min-h-touch w-11 items-center justify-center')} onClick={() => setMonth(shiftMonth(month, -1))} {...a11yButton('上个月')}>
            <Icon name='chevron-left' tone='soft' size='sm' />
          </View>
          <Text {...tw('mx-2 font-body text-body font-bold text-ink')}>{monthLabel(month)}</Text>
          <View
            {...tw('flex min-h-touch w-11 items-center justify-center', nextDisabled && 'opacity-40')}
            onClick={() => { if (!nextDisabled) setMonth(shiftMonth(month, 1)) }}
            {...a11yButton('下个月')}
          >
            <Icon name='chevron-right' tone='soft' size='sm' />
          </View>
        </View>
      </View>

      <View {...tw('mb-4 flex flex-row items-center justify-between rounded-xl bg-paper p-3')}>
        <View>
          <Text {...tw('font-title text-title font-bold text-ink')}>{totalMinutes}</Text>
          <Text {...tw('font-body text-caption text-ink-soft')}>本月练习分钟</Text>
        </View>
        <View>
          <Text {...tw('font-title text-title font-bold text-ink')}>{rows.length}</Text>
          <Text {...tw('font-body text-caption text-ink-soft')}>练习天数</Text>
        </View>
        <Text {...tw('font-body text-caption text-brand-dark')}>
          {pendingCount ? `待同步 ${pendingCount}` : visibleOnlyLocally ? '本机记录' : offline ? '离线视图' : '已同步'}
        </Text>
      </View>

      <View style={{ display: 'flex', flexDirection: 'row', marginBottom: 4 }}>
        {WEEKDAYS.map(day => (
          <View key={day} style={{ width: '14.2857%', alignItems: 'center', paddingTop: 4, paddingBottom: 4 }}>
            <Text {...tw('font-body text-caption text-ink-soft')}>{day}</Text>
          </View>
        ))}
      </View>

      <View style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap' }}>
        {cells.map((cell, index) => cell
          ? (
            <View key={cell.date} style={{ width: '14.2857%', padding: 3 }}>
              <View
                style={{ minHeight: 42, borderRadius: 12, backgroundColor: heatColor(cell.minutes), borderWidth: selectedDate === cell.date ? 2 : 1, borderColor: selectedDate === cell.date ? '#456F55' : 'transparent', alignItems: 'center', justifyContent: 'center' }}
                onClick={() => setSelectedDate(cell.date)}
                {...a11yButton(`${cell.date}，${cell.minutes} 分钟`)}
              >
                <Text style={{ color: cell.minutes >= 30 ? '#FFFFFF' : '#29342E', fontSize: 13 }}>{cell.day}</Text>
              </View>
            </View>
          )
          : <View key={`blank-${month}-${index}`} style={{ width: '14.2857%', padding: 3, minHeight: 48 }} />
        )}
      </View>

      <View {...tw('mt-3 flex flex-row items-center justify-end')}>
        <Text {...tw('mr-2 font-body text-caption text-ink-soft')}>少</Text>
        {[0, 10, 20, 30].map(value => (
          <View key={value} style={{ width: 14, height: 14, borderRadius: 4, backgroundColor: heatColor(value), marginLeft: 2, marginRight: 2 }} />
        ))}
        <Text {...tw('ml-1 font-body text-caption text-ink-soft')}>多</Text>
      </View>

      <View {...tw('mt-4 border-t border-solid border-paper-dark pt-3')}>
        <Text {...tw('font-body text-body font-bold text-ink')}>{selectedDate}</Text>
        <Text {...tw('mt-1 font-body text-caption text-ink-soft')}>
          {selected ? `${selected.minutes} 分钟` : '这一天还没有练习记录'}
          {loading ? ' · 正在更新' : ''}
        </Text>
        {offline && <Text {...tw('mt-2 font-body text-caption text-ink-soft')}>暂时无法连接，已先显示本机记录。</Text>}
      </View>
    </View>
  )
}
