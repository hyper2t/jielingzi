import type { DailyCheckin } from '@/types/models'
import type { PendingCheckin } from './checkins'

export interface CalendarCell {
  date: string
  day: number
  minutes: number
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 用设备本地日期，避免 toISOString() 把 UTC 零点附近的打卡记到前 / 后一天。 */
export function localDateKey (timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export function localMonthKey (timestamp = Date.now()): string {
  return localDateKey(timestamp).slice(0, 7)
}

export function shiftMonth (month: string, delta: number): string {
  const [year, value] = month.split('-').map(Number)
  const date = new Date(year, value - 1 + delta, 1)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`
}

export function monthLabel (month: string): string {
  const [year, value] = month.split('-').map(Number)
  return `${year} 年 ${value} 月`
}

export function mergePendingCheckins (remote: DailyCheckin[], pending: PendingCheckin[]): DailyCheckin[] {
  const byDate = new Map<string, DailyCheckin>()
  remote.forEach(row => byDate.set(row.date, { ...row, practices: { ...row.practices } }))
  pending.forEach(row => {
    const day = byDate.get(row.date) || { date: row.date, minutes: 0, practices: {} }
    day.minutes += row.minutes
    day.practices[row.practice] = (day.practices[row.practice] || 0) + row.minutes
    byDate.set(row.date, day)
  })
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

export function buildCalendarCells (month: string, rows: DailyCheckin[]): Array<CalendarCell | null> {
  const [year, value] = month.split('-').map(Number)
  const firstWeekday = new Date(year, value - 1, 1).getDay()
  const lastDay = new Date(year, value, 0).getDate()
  const minutesByDate = new Map(rows.map(row => [row.date, row.minutes]))
  const cells: Array<CalendarCell | null> = []
  for (let index = 0; index < 42; index++) {
    const day = index - firstWeekday + 1
    if (day < 1 || day > lastDay) cells.push(null)
    else {
      const date = `${month}-${pad2(day)}`
      cells.push({ date, day, minutes: minutesByDate.get(date) || 0 })
    }
  }
  return cells
}

/** 连续天数：今天未打卡时从昨天开始算，未来日期不计入。 */
export function streakDays (rows: DailyCheckin[], now = Date.now()): number {
  const dates = new Set(rows.filter(row => row.minutes > 0).map(row => row.date))
  const today = new Date(now)
  let cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const todayKey = localDateKey(cursor.getTime())
  if (!dates.has(todayKey)) cursor.setDate(cursor.getDate() - 1)
  let streak = 0
  while (dates.has(localDateKey(cursor.getTime()))) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

export function heatColor (minutes: number): string {
  if (minutes <= 0) return '#EDE8DC'
  if (minutes < 15) return '#D7E3CF'
  if (minutes < 30) return '#A9C099'
  return '#5E7D4F'
}
