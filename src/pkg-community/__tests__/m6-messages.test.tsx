/**
 * FE-M6-03：消息页与「我的」入口（契约见 docs/api/practice.md「站内消息与每日提醒」）。
 * 覆盖：门禁未过不请求、三类标签与时间、点开即已读（含跳转）、不可点的类型不挂点击、
 * 分页追加、标记失败时不假装已读、全部已读，以及「我的」里的未读数与 tabBar 角标。
 */
import { act, create, ReactTestRenderer } from 'react-test-renderer'
import Taro from '@tarojs/taro'
import MessagesPage, { CONSENT_TEXT, PAGE_TITLE } from '@/pkg-community/pages/messages/index'
import Mine from '@/pages/mine/index'
import { EMPTY_TEXT, GATE_TEXT, MARKED_TEXT, MORE_TEXT, UNREAD_TAG } from '@/features/notify/rules'
import { markRulesRead } from '@/features/consent/rules'
import { mockControl } from '@/services/mock/client'
import { invalidate } from '@/hooks/requestCache'
import { useUserStore } from '@/store/user'
import type { Profile } from '@/types/models'

const flush = () =>
  act(async () => {
    await new Promise(r => setTimeout(r, 0))
  })
const mounted: ReactTestRenderer[] = []
const render = (el: JSX.Element) => {
  let r!: ReactTestRenderer
  act(() => {
    r = create(el)
  })
  mounted.push(r)
  return r
}
afterEach(() => {
  mounted.splice(0).forEach(r => act(() => r.unmount()))
})
const hosts = (r: ReactTestRenderer, pred: (n: any) => boolean) => r.root.findAll(n => typeof n.type === 'string' && pred(n))
const texts = (r: ReactTestRenderer) => hosts(r, n => n.type === 'Text').map(n => String(n.props.children))
const has = (r: ReactTestRenderer, s: string) => texts(r).includes(s)
const some = (r: ReactTestRenderer, sub: string) => texts(r).some(t => t.includes(sub))
const labelled = (r: ReactTestRenderer, label: string) => hosts(r, n => n.props.ariaLabel === label)
const click = (r: ReactTestRenderer, label: string) =>
  act(() => {
    const node = labelled(r, label).find(n => typeof n.props.onClick === 'function')
    node?.props.onClick()
  })
const calls = (action: string) => mockControl.calls.filter(c => c.action === action)
const payloadOf = (action: string) => calls(action).map(c => c.data)
const toastTitles = () => (Taro.showToast as jest.Mock).mock.calls.map(c => c[0].title)
const navUrls = () => (Taro.navigateTo as jest.Mock).mock.calls.map(c => c[0].url)

/** 固定在过去的时间：相对时间文案才会稳定（跨年 → 带年份），快照不会每天漂 */
const OLD = Date.UTC(2020, 0, 1)
const HOUR = 3600 * 1000
const ROW_TEXT = '你的话题收到了新回复'
const LIN: Profile = {
  nickname: '林然',
  avatar: 'preset:leaf',
  practices: ['mindfulness'],
  years: 3,
  goal: '',
  bio: '',
  anonAlias: '竹影',
  badges: [],
  updatedAt: OLD,
}

function signIn(o: Record<string, unknown> = {}) {
  useUserStore.setState({
    consent: 'agreed',
    adult: 'confirmed',
    account: {
      phoneVerified: true,
      adult: true,
      role: 'user',
      bannedUntil: null,
      mutedUntil: null,
      ...o,
    },
  })
  mockControl.setAccount({ adult: true, phoneVerified: true, ...o })
  mockControl.setProfile(LIN)
  markRulesRead()
}

const open = async () => {
  const r = render(<MessagesPage />)
  await flush()
  return r
}

beforeEach(() => {
  mockControl.reset()
  mockControl.latency = 0
  invalidate()
  ;(Taro as any).__storage.clear()
  ;(Taro as any).__routerParams = {}
  useUserStore.setState({
    consent: 'unknown',
    adult: 'unknown',
    account: null,
  })
  jest.clearAllMocks()
})

describe('门禁未过时不打扰', () => {
  it('未同意：说明 + 「去同意」就地开同意弹层，并且一次请求都不发', async () => {
    const r = await open()
    expect(has(r, CONSENT_TEXT)).toBe(true)
    expect(calls('listNotifications')).toHaveLength(0)
    click(r, '去同意')
    expect(useUserStore.getState().sheetOpen).toBe(true)
    expect(calls('listNotifications')).toHaveLength(0)
  })

  it('已登录但未同意：同样只给说明，不替用户点同意', async () => {
    signIn()
    useUserStore.setState({ consent: 'unknown' })
    const r = await open()
    expect(has(r, CONSENT_TEXT)).toBe(true)
    expect(calls('listNotifications')).toHaveLength(0)
  })

  it('未确认 18+：给「确认年满 18 周岁后可查看消息」，点「去确认」进 18+ 页', async () => {
    signIn({ adult: false })
    useUserStore.setState({ adult: 'unknown' })
    const r = await open()
    expect(has(r, GATE_TEXT)).toBe(true)
    expect(calls('listNotifications')).toHaveLength(0)
    click(r, '去确认')
    expect(navUrls().some(u => u.includes('/pages/adult/index'))).toBe(true)
    expect(calls('listNotifications')).toHaveLength(0)
  })
})

describe('消息列表', () => {
  it('渲染类型标签、正文与未读标记；标题来自同一常量', async () => {
    signIn()
    mockControl.seedNotifications([
      {
        id: 'a',
        text: ROW_TEXT,
        type: 'reply',
        refType: 'topic',
        refId: 't-1',
        createdAt: OLD + 2 * HOUR,
      },
      {
        id: 'b',
        text: '内容已下架',
        type: 'moderation',
        refType: 'topic',
        refId: 't-2',
        createdAt: OLD + HOUR,
        read: true,
      },
    ])
    const r = await open()
    expect(PAGE_TITLE).toBe('消息')
    expect(some(r, '1 条未读')).toBe(true)
    expect(has(r, '回复')).toBe(true)
    expect(has(r, '处理结果')).toBe(true)
    expect(has(r, ROW_TEXT)).toBe(true)
    expect(has(r, '内容已下架')).toBe(true)
    expect(texts(r).filter(t => t === UNREAD_TAG)).toHaveLength(1)
    expect(has(r, '2020-01-01')).toBe(true)
    expect(calls('listNotifications')).toHaveLength(1)
  })

  it('空列表给「还没有消息」，不是错误态', async () => {
    signIn()
    const r = await open()
    expect(has(r, EMPTY_TEXT)).toBe(true)
    expect(calls('listNotifications')).toHaveLength(1)
  })

  it('只有能点开的条目挂点击：moderation 与缺 refId 的老数据不响应', async () => {
    signIn()
    mockControl.seedNotifications([
      {
        id: 'a',
        text: ROW_TEXT,
        type: 'reply',
        refType: 'topic',
        refId: 't-1',
      },
      {
        id: 'b',
        text: '老数据没有引用',
        type: 'reply',
        refType: null,
        refId: null,
      },
      {
        id: 'c',
        text: '内容已下架',
        type: 'moderation',
        refType: 'topic',
        refId: 't-2',
      },
    ])
    const r = await open()
    expect(labelled(r, `回复，${ROW_TEXT}`).some(n => typeof n.props.onClick === 'function')).toBe(true)
    expect(labelled(r, '回复，老数据没有引用')).toHaveLength(0)
    expect(labelled(r, '处理结果，内容已下架')).toHaveLength(0)
  })
})

describe('点开即已读', () => {
  it('未读消息：先标已读（只带这一条的 id），再跳话题；本地状态跟着变', async () => {
    signIn()
    mockControl.seedNotifications([
      {
        id: 'a',
        text: ROW_TEXT,
        type: 'reply',
        refType: 'topic',
        refId: 't-1',
      },
    ])
    const r = await open()
    click(r, `回复，${ROW_TEXT}`)
    await flush()
    expect(payloadOf('markNotificationsRead')).toEqual([{ ids: ['a'] }])
    expect(navUrls()).toContain('/pkg-community/pages/topic/index?id=t-1')
    expect(texts(r).filter(t => t === UNREAD_TAG)).toHaveLength(0)
    expect(some(r, '暂无未读')).toBe(true)
    expect(mockControl.notifications[0].read).toBe(true)
  })

  it('已读的条目再点只跳转，不再请求标记', async () => {
    signIn()
    mockControl.seedNotifications([
      {
        id: 'a',
        text: '今天的题',
        type: 'prompt',
        refType: 'daily_prompt',
        refId: 'p-9',
        read: true,
      },
    ])
    const r = await open()
    click(r, '每日一题，今天的题')
    await flush()
    expect(calls('markNotificationsRead')).toHaveLength(0)
    expect(navUrls()).toContain('/pkg-practice/pages/prompt/index?promptId=p-9')
  })

  it('标记失败不假装已读：仍然标着未读，下次进来照常提醒', async () => {
    signIn()
    mockControl.seedNotifications([
      {
        id: 'a',
        text: ROW_TEXT,
        type: 'reply',
        refType: 'topic',
        refId: 't-1',
      },
    ])
    const r = await open()
    mockControl.failTimes = 1 // 让标记这次请求失败
    click(r, `回复，${ROW_TEXT}`)
    await flush()
    expect(mockControl.notifications[0].read).toBe(false)
    expect(texts(r).filter(t => t === UNREAD_TAG)).toHaveLength(1)
    expect(some(r, '1 条未读')).toBe(true)
    expect(navUrls()).toContain('/pkg-community/pages/topic/index?id=t-1') // 跳转不受影响
  })
})

describe('全部已读与分页', () => {
  it('导航栏右侧的「全部标为已读」只在有未读时出现，点完归零并提示', async () => {
    signIn()
    mockControl.seedNotifications([
      { id: 'a', text: '第一条' },
      { id: 'b', text: '第二条' },
      { id: 'c', text: '第三条', read: true },
    ])
    const r = await open()
    expect(labelled(r, '全部标为已读').length).toBeGreaterThan(0)
    click(r, '全部标为已读')
    await flush()
    expect(payloadOf('markNotificationsRead')).toEqual([{ all: true }])
    expect(some(r, '暂无未读')).toBe(true)
    expect(toastTitles()).toContain(MARKED_TEXT)
    expect(mockControl.notifications.every(n => n.read)).toBe(true)
  })

  it('没有未读时不显示「全部标为已读」（不给一个点了没用的按钮）', async () => {
    signIn()
    mockControl.seedNotifications([{ id: 'a', text: '第一条', read: true }])
    const r = await open()
    expect(labelled(r, '全部标为已读')).toHaveLength(0)
  })

  it('超过一页：点「查看更多消息」再取下一页，重复的 id 不会渲染两遍', async () => {
    signIn()
    mockControl.seedNotifications(
      Array.from({ length: 25 }, (_x, i) => ({
        id: `n${i + 1}`,
        text: `消息 ${i + 1}`,
        refId: null,
        createdAt: OLD + i * 1000,
      })),
    )
    const r = await open()
    expect(calls('listNotifications')).toHaveLength(1)
    expect(some(r, '消息 25')).toBe(true)
    expect(has(r, '消息 5')).toBe(false)
    click(r, MORE_TEXT)
    await flush()
    expect(payloadOf('listNotifications')).toStrictEqual([{ page: 1 }, { page: 2 }])
    expect(has(r, '消息 5')).toBe(true)
    expect(labelled(r, MORE_TEXT)).toHaveLength(0)
  })
})

describe('「我的」里的入口', () => {
  const withWeapp = async (fn: () => Promise<void>) => {
    const prev = process.env.TARO_ENV
    process.env.TARO_ENV = 'weapp'
    try {
      await fn()
    } finally {
      process.env.TARO_ENV = prev
    }
  }

  it('入口显示未读条数，点击进消息页', async () => {
    signIn()
    mockControl.seedNotifications([
      { id: 'a', text: ROW_TEXT },
      { id: 'b', text: '内容已下架', type: 'moderation' },
    ])
    const r = render(<Mine />)
    await flush()
    expect(some(r, '消息')).toBe(true)
    expect(some(r, '2 条未读')).toBe(true)
    expect(payloadOf('listNotifications')).toStrictEqual([{ page: 1, size: 1 }])
    expect(calls('listNotifications')).toHaveLength(1)
    click(r, '消息，2 条未读')
    await flush()
    expect(navUrls()).toContain('/pkg-community/pages/messages/index')
  })

  it('没有未读时写「暂无未读」，小程序端还会摘掉 tabBar 角标', async () => {
    await withWeapp(async () => {
      signIn()
      mockControl.seedNotifications([{ id: 'a', text: '看过的', read: true }])
      const r = render(<Mine />)
      await flush()
      expect(some(r, '暂无未读')).toBe(true)
      expect(Taro.removeTabBarBadge).toHaveBeenCalledWith({ index: 2 })
    })
  })

  it('有未读时设置 tabBar 角标（数字来自同一份 unread，不是另一次请求）', async () => {
    await withWeapp(async () => {
      signIn()
      mockControl.seedNotifications([
        { id: 'a', text: ROW_TEXT },
        { id: 'b', text: '第二条' },
        { id: 'c', text: '第三条' },
      ])
      const r = render(<Mine />)
      await flush()
      expect(Taro.setTabBarBadge).toHaveBeenCalledWith({ index: 2, text: '3' })
      expect(calls('listNotifications')).toHaveLength(1)
      expect(some(r, '3 条未读')).toBe(true)
    })
  })

  it('超过 99 条按 99+ 显示，页面内仍是准数', async () => {
    await withWeapp(async () => {
      signIn()
      mockControl.seedNotifications(
        Array.from({ length: 120 }, (_x, i) => ({
          id: `n${i}`,
          text: `消息 ${i}`,
        })),
      )
      const r = render(<Mine />)
      await flush()
      expect(Taro.setTabBarBadge).toHaveBeenCalledWith({
        index: 2,
        text: '99+',
      })
      expect(some(r, '120 条未读')).toBe(true)
    })
  })

  it('门禁未过时入口不请求云端（也就没有角标）', async () => {
    await withWeapp(async () => {
      const r = render(<Mine />)
      await flush()
      expect(calls('listNotifications')).toHaveLength(0)
      expect(some(r, '消息')).toBe(false)
      expect(Taro.setTabBarBadge).not.toHaveBeenCalled()
    })
  })
})

describe('快照', () => {
  it('消息页（有未读 + 三种类型）', async () => {
    signIn()
    mockControl.seedNotifications([
      {
        id: 'a',
        text: ROW_TEXT,
        type: 'reply',
        refType: 'topic',
        refId: 't-1',
        createdAt: OLD + 2 * HOUR,
      },
      {
        id: 'b',
        text: '内容已下架',
        type: 'moderation',
        refType: 'topic',
        refId: 't-2',
        read: true,
        createdAt: OLD + HOUR,
      },
      {
        id: 'c',
        text: '今天的每日一题已经准备好，可以写下你的回答',
        type: 'prompt',
        refType: 'daily_prompt',
        refId: 'p-1',
        createdAt: OLD,
      },
    ])
    const r = await open()
    expect(r.toJSON()).toMatchSnapshot()
  })
})
