import { act, create, ReactTestRenderer } from 'react-test-renderer'
import Taro from '@tarojs/taro'
import Timer from '@/pkg-practice/pages/timer/index'
import { __resetPracticeTimerForTest, getPracticeTimer, refreshPracticeTimer, startPracticeTimer } from '@/features/practice/timer'
import { currentOwnerId, pendingCheckinsForMonth, readPendingCheckins, submitCheckin, syncPendingCheckins } from '@/features/practice/checkins'
import { resetLocalData } from '@/features/auth/clear'
import { listCheckins } from '@/services/practice'
import { mockControl } from '@/services/mock/client'
import { useUserStore } from '@/store/user'
import { localDateKey, localMonthKey } from '@/features/practice/calendar'
import { setItem, STORAGE_KEYS } from '@/utils/storage'
// babel-jest 会把 jest.mock 提升到 import 之前，放在这里只为满足仓库的 import/first 风格
jest.mock('@/utils/practice-cue', () => ({ playPracticeCue: jest.fn() }))

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const hosts = (r: ReactTestRenderer) => r.root.findAll(n => typeof n.type === 'string')
const texts = (r: ReactTestRenderer) => hosts(r).filter(n => String(n.type) === 'Text').map(n => String(n.props.children))
const clickByLabel = (r: ReactTestRenderer, label: string) => act(() => {
  const node = hosts(r).find(n => n.props.ariaLabel === label && typeof n.props.onClick === 'function')
  node?.props.onClick({})
})

let mounted: ReactTestRenderer | null = null

beforeEach(() => {
  mockControl.reset()
  mockControl.latency = 0
  mockControl.setAccount({ adult: true })
  ;(Taro as any).__storage.clear()
  __resetPracticeTimerForTest()
  useUserStore.setState({ consent: 'agreed', adult: 'confirmed', account: null, auth: { signedIn: true } })
  jest.clearAllMocks()
})

afterEach(() => {
  if (mounted) act(() => mounted?.unmount())
  mounted = null
})

describe('FE-M5-02 offline private check-in', () => {
  it('keeps a completed cross-midnight session locally, then syncs it idempotently', async () => {
    const startedAt = new Date(2026, 9, 1, 23, 55).getTime()
    const timer = startPracticeTimer(5, startedAt)
    refreshPracticeTimer(timer.endsAt)
    mockControl.failTimes = 1

    act(() => { mounted = create(<Timer />) })
    expect(texts(mounted!)).toContain('一键打卡')
    clickByLabel(mounted!, '记录这次练习')
    await flush()

    expect(texts(mounted!)).toContain('已暂存在本机，联网并完成同意与 18+ 确认后会自动补传。')
    expect(readPendingCheckins()).toHaveLength(1)
    expect(mockControl.checkins).toHaveLength(0)

    await syncPendingCheckins()
    expect(readPendingCheckins()).toHaveLength(0)
    expect(mockControl.checkins).toHaveLength(1)
    expect(mockControl.checkins[0].date).toBe(localDateKey(timer.endsAt))
    expect(mockControl.checkins[0].sessionIds).toContain(timer.sessionId)

    const month = localMonthKey(timer.endsAt)
    const result = await listCheckins(month)
    expect(result.totalMinutes).toBe(5)
    expect(result.list[0]).toMatchObject({ date: localDateKey(timer.endsAt), minutes: 5 })
  })

  // M5-D05 复盘：同一台设备轮换 QA 账号时，本机队列里的记录不能串到下一个账号
  it('binds a check-in to the cloud identity when the store has no account id', async () => {
    // 未确认 18+ 时补传整轮跳过，只剩「入队即绑定归属」这一步可观察
    useUserStore.setState({ consent: 'agreed', adult: 'unknown', account: null, auth: { signedIn: true } })
    const startedAt = new Date(2026, 9, 2, 9, 0).getTime()
    const timer = startPracticeTimer(30, startedAt)
    refreshPracticeTimer(timer.endsAt)
    await submitCheckin({ sessionId: timer.sessionId, date: localDateKey(timer.endsAt), practice: 'mindfulness', minutes: 30 }, timer.ownerId)

    const rows = readPendingCheckins()
    expect(rows).toHaveLength(1)
    expect(rows[0].ownerId).toBeTruthy()
    const owner = rows[0].ownerId as string
    expect(pendingCheckinsForMonth(localMonthKey(timer.endsAt), owner)).toHaveLength(1)
    expect(mockControl.checkins).toHaveLength(0)
  })

  it('claims ownerless rows for the syncing account and hides them from the next one', async () => {
    const at = new Date(2026, 9, 2, 9, 0).getTime()
    const date = localDateKey(at)
    const month = localMonthKey(at)
    setItem(STORAGE_KEYS.practiceCheckinQueue, [{ sessionId: 'practice-legacy-1', date, practice: 'mindfulness', minutes: 30, queuedAt: at }])
    useUserStore.setState({ consent: 'agreed', adult: 'confirmed', account: null, auth: { signedIn: true } })
    mockControl.failTimes = 1

    const first = await syncPendingCheckins()
    expect(first.synced).toBe(0)
    const rows = readPendingCheckins()
    expect(rows).toHaveLength(1)
    const owner = rows[0].ownerId as string
    expect(owner).toBeTruthy()

    useUserStore.setState({ consent: 'agreed', adult: 'confirmed', auth: { signedIn: true, accountId: 'qa-b', uid: 'qa-b' } })
    expect(pendingCheckinsForMonth(month)).toHaveLength(0)
    expect(await listCheckins(month)).toMatchObject({ month, totalMinutes: 0 })

    useUserStore.setState({ consent: 'agreed', adult: 'confirmed', auth: { signedIn: true, accountId: owner, uid: owner } })
    expect(pendingCheckinsForMonth(month)).toHaveLength(1)
    expect(readPendingCheckins()).toHaveLength(1)
  })

  // M5-D06：「清除本机数据」后计时与待同步队列都不残留，也不把上一个账号的归属带到下一个账号
  it('drops the timer, the pending queue and the owner cache on local wipe', async () => {
    const startedAt = new Date(2026, 9, 2, 9, 0).getTime()
    const timer = startPracticeTimer(20, startedAt)
    refreshPracticeTimer(timer.endsAt)
    mockControl.failTimes = 1
    await submitCheckin({ sessionId: timer.sessionId, date: localDateKey(timer.endsAt), practice: 'meditation', minutes: 20 }, timer.ownerId)

    expect(readPendingCheckins()).toHaveLength(1)
    expect(getPracticeTimer()).not.toBeNull()
    expect(currentOwnerId()).toBeTruthy()

    await act(async () => { await resetLocalData() })

    expect(readPendingCheckins()).toHaveLength(0)
    expect((Taro as any).__storage.has(STORAGE_KEYS.practiceCheckinQueue)).toBe(false)
    expect(getPracticeTimer()).toBeNull()
    expect(currentOwnerId()).toBeUndefined()
    expect(mockControl.checkins).toHaveLength(0)
  })
})
