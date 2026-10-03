jest.mock('@/utils/practice-cue', () => ({ playPracticeCue: jest.fn() }))

import Taro from '@tarojs/taro'
import { playPracticeCue } from '@/utils/practice-cue'
import { __resetPracticeTimerForTest, formatCountdown, getPracticeTimer, getRemainingMs, refreshPracticeTimer, resetPracticeTimer, startPracticeTimer } from '../timer'

describe('M5 timestamp-based practice timer', () => {
  beforeEach(() => {
    ;(Taro as any).__storage.clear()
    __resetPracticeTimerForTest()
    jest.clearAllMocks()
  })

  it('derives remaining time from timestamps and completes once after a long background gap', () => {
    const startedAt = new Date(2026, 9, 1, 23, 55).getTime()
    const timer = startPracticeTimer(5, startedAt)

    expect(timer.endsAt).toBe(startedAt + 5 * 60 * 1000)
    expect(timer.sessionId).toMatch(/^[-A-Za-z0-9_]{8,80}$/)
    expect(getRemainingMs(timer, startedAt + 90_000)).toBe(210_000)
    expect(formatCountdown(61_001)).toBe('01:02')
    expect(refreshPracticeTimer(startedAt + 20 * 60 * 1000)?.status).toBe('completed')
    expect(getPracticeTimer()?.completedAt).toBe(timer.endsAt)
    expect(playPracticeCue).toHaveBeenNthCalledWith(1, 'start')
    expect(playPracticeCue).toHaveBeenNthCalledWith(2, 'end')

    refreshPracticeTimer(startedAt + 21 * 60 * 1000)
    expect(playPracticeCue).toHaveBeenCalledTimes(2)
  })

  it('clears an abandoned timer from both the view model and local storage', () => {
    startPracticeTimer(10, 1_800_000_000_000)
    resetPracticeTimer()
    expect(getPracticeTimer()).toBeNull()
    expect((Taro as any).__storage.has('practice_timer')).toBe(false)
  })
})
