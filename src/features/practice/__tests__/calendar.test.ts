import type { DailyCheckin } from '@/types/models'
import type { PendingCheckin } from '../checkins'
import { buildCalendarCells, localDateKey, mergePendingCheckins, shiftMonth, streakDays } from '../calendar'

describe('M5 personal practice calendar', () => {
  it('uses the device-local end date and shifts months across year boundaries', () => {
    const endAt = new Date(2026, 9, 2, 0, 5).getTime()
    expect(localDateKey(endAt)).toBe('2026-10-02')
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
  })

  it('lays out a 42-cell month and merges local pending minutes by practice', () => {
    const remote: DailyCheckin[] = [{ date: '2026-10-02', minutes: 10, practices: { meditation: 10 } }]
    const pending: PendingCheckin[] = [{
      sessionId: 'practice-pending-01',
      date: '2026-10-02',
      practice: 'meditation',
      minutes: 5,
      queuedAt: 1
    }]
    const merged = mergePendingCheckins(remote, pending)
    const cells = buildCalendarCells('2026-10', merged)

    expect(cells).toHaveLength(42)
    expect(cells[4]).toMatchObject({ date: '2026-10-01', day: 1 })
    expect(merged).toEqual([{ date: '2026-10-02', minutes: 15, practices: { meditation: 15 } }])
    expect(cells.find(cell => cell?.date === '2026-10-02')?.minutes).toBe(15)
  })

  it('counts the current streak and starts from yesterday when today is empty', () => {
    const now = new Date(2026, 9, 3, 12).getTime()
    const rows: DailyCheckin[] = [
      { date: '2026-10-01', minutes: 10, practices: { meditation: 10 } },
      { date: '2026-10-02', minutes: 10, practices: { meditation: 10 } }
    ]
    expect(streakDays(rows, now)).toBe(2)
  })
})
