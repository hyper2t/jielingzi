/**
 * 冥想计时状态：落盘 startAt / endAt，剩余时间永远由 Date.now() 计算。
 * setInterval 只刷新界面；后台、锁屏、来电或进程暂停后不靠累计 tick 补时。
 */
import { useEffect, useState } from 'react'
import type { PracticeId } from '@/constants/community'
import { flushStorage, getItem, removeItem, setItem, STORAGE_KEYS } from '@/utils/storage'
import { onAppHide, onAppShow } from '@/utils/app-lifecycle'
import { playPracticeCue } from '@/utils/practice-cue'
import { useUserStore } from '@/store/user'

export const TIMER_PRESETS = [5, 10, 20, 30] as const
export type TimerStatus = 'running' | 'completed' | 'checked-in'

export interface PracticeTimerRecord {
  sessionId: string
  minutes: number
  startedAt: number
  endsAt: number
  status: TimerStatus
  /** 计时开始时的本机用户，避免退出后把旧会话写入另一账号。 */
  ownerId?: string
  practice?: PracticeId
  completedAt?: number
  endCuePlayed?: boolean
  checkedInAt?: number
}

let current: PracticeTimerRecord | null | undefined
const listeners = new Set<(timer: PracticeTimerRecord | null) => void>()

function validRecord (value: unknown): PracticeTimerRecord | null {
  const row = value as Partial<PracticeTimerRecord> | null
  if (!row || typeof row !== 'object') return null
  if (typeof row.sessionId !== 'string' || !Number.isInteger(row.minutes) || (row.minutes as number) < 1 || (row.minutes as number) > 180) return null
  if (typeof row.startedAt !== 'number' || typeof row.endsAt !== 'number' || row.endsAt <= row.startedAt) return null
  if (row.status !== 'running' && row.status !== 'completed' && row.status !== 'checked-in') return null
  return row as PracticeTimerRecord
}

export function getPracticeTimer (): PracticeTimerRecord | null {
  if (current === undefined) {
    current = validRecord(getItem<unknown>(STORAGE_KEYS.practiceTimer))
    if (!current) removeItem(STORAGE_KEYS.practiceTimer)
  }
  return current
}

function publish (next: PracticeTimerRecord | null): void {
  current = next
  if (next) setItem(STORAGE_KEYS.practiceTimer, next)
  else removeItem(STORAGE_KEYS.practiceTimer)
  listeners.forEach(listener => listener(next))
}

export function getRemainingMs (timer: PracticeTimerRecord | null, now = Date.now()): number {
  if (!timer || timer.status !== 'running') return 0
  return Math.max(0, timer.endsAt - now)
}

export function formatCountdown (ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

function newSessionId (now: number): string {
  return `practice-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function currentOwnerId (): string | undefined {
  const auth = useUserStore.getState().auth
  return auth.accountId || auth.uid || undefined
}

export function startPracticeTimer (minutes: number, now = Date.now()): PracticeTimerRecord {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) throw new Error('计时时长需为 1–180 分钟')
  const timer: PracticeTimerRecord = {
    sessionId: newSessionId(now),
    minutes,
    startedAt: now,
    endsAt: now + minutes * 60 * 1000,
    status: 'running',
    ownerId: currentOwnerId(),
    endCuePlayed: false
  }
  publish(timer)
  playPracticeCue('start')
  return timer
}

/** 前台恢复 / 定时刷新时校准；即使 JS 暂停很久，也以 endsAt 判定真实剩余时间。 */
export function refreshPracticeTimer (now = Date.now()): PracticeTimerRecord | null {
  const timer = getPracticeTimer()
  if (timer?.status === 'running' && now >= timer.endsAt) {
    const completed: PracticeTimerRecord = { ...timer, status: 'completed', completedAt: timer.endsAt, endCuePlayed: true }
    publish(completed)
    playPracticeCue('end')
    return completed
  }
  if (timer?.status === 'completed' && !timer.endCuePlayed) {
    const completed: PracticeTimerRecord = { ...timer, endCuePlayed: true }
    publish(completed)
    playPracticeCue('end')
    return completed
  }
  return timer
}

export function setTimerPractice (practice: PracticeId): void {
  const timer = getPracticeTimer()
  if (!timer || (timer.status !== 'completed' && timer.status !== 'checked-in')) return
  publish({ ...timer, practice })
}

export function markTimerCheckedIn (now = Date.now()): void {
  const timer = getPracticeTimer()
  if (!timer || timer.status !== 'completed') return
  publish({ ...timer, status: 'checked-in', checkedInAt: now })
}

export function resetPracticeTimer (): void {
  publish(null)
}

/** React view-model hook; timer progress comes from timestamps, not the interval count. */
export function usePracticeTimer () {
  const [timer, setTimer] = useState<PracticeTimerRecord | null>(() => getPracticeTimer())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const onTimer = (next: PracticeTimerRecord | null) => setTimer(next)
    listeners.add(onTimer)
    const refresh = () => {
      const at = Date.now()
      setNow(at)
      setTimer(refreshPracticeTimer(at))
    }
    const offShow = onAppShow(refresh)
    const offHide = onAppHide(() => {
      const latest = getPracticeTimer()
      if (latest) setItem(STORAGE_KEYS.practiceTimer, latest)
      void flushStorage()
    })
    const pulse = setInterval(refresh, 1000)
    refresh()
    return () => {
      clearInterval(pulse)
      offShow()
      offHide()
      listeners.delete(onTimer)
    }
  }, [])

  return { timer, now, remainingMs: getRemainingMs(timer, now) }
}

/** 测试隔离：清本地状态及订阅快照。 */
export function __resetPracticeTimerForTest (): void {
  current = undefined
  removeItem(STORAGE_KEYS.practiceTimer)
}
