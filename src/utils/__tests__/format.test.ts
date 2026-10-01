import { formatClock, formatTotalDuration, progressRatio } from '@/utils/format'
import { platform } from '@/utils/platform'

describe('format', () => {
  it('formatClock', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(135000)).toBe('2:15')
    expect(formatClock(192999)).toBe('3:12')
    expect(formatClock(3723000)).toBe('1:02:03')
    expect(formatClock(-5)).toBe('0:00')
    expect(formatClock(NaN)).toBe('0:00')
  })

  it('formatTotalDuration', () => {
    expect(formatTotalDuration(30)).toBe('不到1分钟')
    expect(formatTotalDuration(25 * 60)).toBe('25分钟')
    expect(formatTotalDuration(4800)).toBe('1小时20分')
    expect(formatTotalDuration(7200)).toBe('2小时')
  })

  it('进度比例', () => {
    expect(progressRatio(50, 100)).toBe(0.5)
    expect(progressRatio(5, 0)).toBe(0)
    expect(progressRatio(200, 100)).toBe(1)
  })
})

describe('platform', () => {
  it('platform', () => {
    expect(platform).toBe('weapp')
  })
})
