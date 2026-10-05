/**
 * FE-M6-03：站内消息的服务层与 mock 云端（对等实现）。
 * 钉的是「前端不越权、不越礼」：门禁未过不发请求、只看得见写给自己的、已读只在云端确认后才算、
 * 以及 mock 的文案与云端 topics.js 的固定说明同源（改了云端就要同时改这里，测试会红）。
 */
import * as fs from 'fs'
import * as path from 'path'
import Taro from '@tarojs/taro'
import { mockControl } from '@/services/mock/client'
import { createReply } from '@/services/community'
import {NOTIFICATIONS_KEY, listNotifications, markNotificationsRead, notificationsUnread } from '@/services/practice'
import { NOTIFICATIONS_TITLE } from '@/features/notify/rules'
import { CloudError, ERROR_CODES } from '@/services/cloud.types'
import { markRulesRead } from '@/features/consent/rules'
import { useUserStore } from '@/store/user'

jest.mock('@/hooks/requestCache', () => {
  const actual = jest.requireActual('@/hooks/requestCache')
  return { ...actual, invalidate: jest.fn(actual.invalidate) }
})
// eslint-disable-next-line import/first
import { invalidate } from '@/hooks/requestCache'

const calls = (action: string) => mockControl.calls.filter(c => c.action === action)
const payloadOf = (action: string) => calls(action).map(c => c.data)
const OLD = Date.UTC(2020, 0, 1)

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
  markRulesRead()
}

/** 预置 N 条写给我的未读消息（createdAt 递增，新的在后） */
function seedMine(n: number, o: Record<string, unknown> = {}) {
  mockControl.seedNotifications(
    Array.from({ length: n }, (_x, i) => ({
      text: `消息 ${i + 1}`,
      createdAt: OLD + i * 1000,
      ...o,
    })),
  )
}

beforeEach(() => {
  mockControl.reset()
  mockControl.latency = 0
  invalidate()
  ;(Taro as any).__storage.clear()
  useUserStore.setState({
    consent: 'unknown',
    adult: 'unknown',
    account: null,
  })
  jest.clearAllMocks()
})

describe('门禁未过时不发请求', () => {
  it.each(['unknown', 'declined'] as const)('consent=%s：返回空页，且不请求云端', async c => {
    useUserStore.setState({ consent: c, adult: 'confirmed' })
    seedMine(3)
    await expect(listNotifications()).resolves.toEqual({
      page: 1,
      size: 0,
      hasMore: false,
      unread: 0,
      list: [],
    })
    expect(calls('listNotifications')).toHaveLength(0)
  })

  it('未确认 18+ 时同样不请求（服务端也会 40303）', async () => {
    useUserStore.setState({
      consent: 'agreed',
      adult: 'unknown',
      account: null,
    })
    await expect(listNotifications(2)).resolves.toEqual({
      page: 2,
      size: 0,
      hasMore: false,
      unread: 0,
      list: [],
    })
    expect(calls('listNotifications')).toHaveLength(0)
  })

  it('标记已读是写动作：未同意时被本地拦下，不发出请求', async () => {
    seedMine(2)
    await expect(markNotificationsRead()).rejects.toBeInstanceOf(CloudError)
    await expect(markNotificationsRead()).rejects.toMatchObject({
      code: ERROR_CODES.CONSENT_REQUIRED,
    })
    expect(calls('markNotificationsRead')).toHaveLength(0)
    expect(mockControl.notifications.every(n => !n.read)).toBe(true)
  })
})

describe('读取本人消息', () => {
  it('返回体与云端同形：page / size / hasMore / unread / list，倒序', async () => {
    signIn()
    seedMine(3)
    const r = await listNotifications()
    expect(r).toEqual({
      page: 1,
      size: 20,
      hasMore: false,
      unread: 3,
      list: [
        {
          id: 'nt3',
          type: 'reply',
          refType: 'topic',
          refId: null,
          text: '消息 3',
          read: false,
          createdAt: OLD + 2000,
        },
        {
          id: 'nt2',
          type: 'reply',
          refType: 'topic',
          refId: null,
          text: '消息 2',
          read: false,
          createdAt: OLD + 1000,
        },
        {
          id: 'nt1',
          type: 'reply',
          refType: 'topic',
          refId: null,
          text: '消息 1',
          read: false,
          createdAt: OLD,
        },
      ],
    })
    expect(r.list[0].id).toBeTruthy()
  })

  it('第一页 20 条，之后按 size 翻页直到 hasMore 关；请求里只带用得到的键', async () => {
    signIn()
    seedMine(25)
    const p1 = await listNotifications()
    expect(p1.list).toHaveLength(20)
    expect(p1.hasMore).toBe(true)
    expect(p1.unread).toBe(25)
    const p2 = await listNotifications(2, 10)
    expect(p2.list.map(n => n.id)).toEqual(['nt15', 'nt14', 'nt13', 'nt12', 'nt11', 'nt10', 'nt9', 'nt8', 'nt7', 'nt6'])
    expect(p2.hasMore).toBe(true)
    const p3 = await listNotifications(3, 10)
    expect(p3.list.map(n => n.id)).toEqual(['nt5', 'nt4', 'nt3', 'nt2', 'nt1'])
    expect(p3.hasMore).toBe(false)
    expect(payloadOf('listNotifications')).toStrictEqual([{ page: 1 }, { page: 2, size: 10 }, { page: 3, size: 10 }])
  })

  it('入口只取未读数：一页一条，不带多余字段', async () => {
    signIn()
    seedMine(7)
    const r = await listNotifications(1, 1)
    expect(r.list).toHaveLength(1)
    expect(r.unread).toBe(7)
    expect(r.hasMore).toBe(true)
    expect(payloadOf('listNotifications')).toStrictEqual([{ page: 1, size: 1 }])
  })

  it('notificationsUnread()：入口只要那个数，并且也只发这一页', async () => {
    signIn()
    seedMine(9)
    expect(await notificationsUnread()).toBe(9)
    expect(payloadOf('listNotifications')).toStrictEqual([{ page: 1, size: 1 }])
    // 门禁没过时同样不打扰：返回 0，也不多打一次请求（18+ 以账号里的 adult 为准，所以这里撤同意）
    useUserStore.setState({ consent: 'unknown' })
    expect(await notificationsUnread()).toBe(0)
    expect(payloadOf('listNotifications')).toHaveLength(1)
  })

  it('一条消息都没有时返回空列表，不报错', async () => {
    signIn()
    await expect(listNotifications()).resolves.toEqual({
      page: 1,
      size: 20,
      hasMore: false,
      unread: 0,
      list: [],
    })
  })

  it('参数不对由云端拒绝（与云函数同码：40001）', async () => {
    signIn()
    await expect(listNotifications(0)).rejects.toMatchObject({
      code: ERROR_CODES.BAD_PARAM,
    })
    await expect(listNotifications(1, 51)).rejects.toMatchObject({
      code: ERROR_CODES.BAD_PARAM,
    })
    await expect(listNotifications(1, 50)).resolves.toMatchObject({ size: 50 })
  })
})

describe('只看得见写给自己的', () => {
  it('owner=other 的消息既不出现在列表里，也不计入未读，更不会被「全部已读」改动', async () => {
    signIn()
    mockControl.seedNotifications([{ text: '我的第一条' }, { text: '别人的（我看不到）', owner: 'other' }, { text: '我的第二条' }])
    const r = await listNotifications()
    expect(r.list.map(n => n.text)).toEqual(['我的第二条', '我的第一条'])
    expect(r.unread).toBe(2)
    await markNotificationsRead()
    expect(mockControl.notifications.find(n => n.owner === 'other')!.read).toBe(false)
    expect(mockControl.notifications.filter(n => n.owner === 'me').every(n => n.read)).toBe(true)
  })

  it('传别人的 id 也只命中 0 条：不报错，也不暴露它存在', async () => {
    signIn()
    mockControl.seedNotifications([
      { id: 'mine-1', text: '我的' },
      { id: 'other-1', text: '别人的', owner: 'other' },
    ])
    const r = await markNotificationsRead(['other-1'])
    expect(r).toEqual({ updated: 0, unread: 1 })
    expect(mockControl.notifications.find(n => n.id === 'other-1')!.read).toBe(false)
    expect(mockControl.notifications.find(n => n.id === 'mine-1')!.read).toBe(false)
  })

  it('封禁中的账号读不到消息（与云端 guardWrite 同码）', async () => {
    signIn({ bannedUntil: Date.now() + 60 * 1000 })
    seedMine(2)
    await expect(listNotifications()).rejects.toMatchObject({
      code: ERROR_CODES.BANNED,
    })
  })
})

describe('标记已读', () => {
  it('单条：只改这一条；重复标记 updated=0；返回剩余未读', async () => {
    signIn()
    seedMine(3)
    const first = await markNotificationsRead(['nt2'])
    expect(first).toEqual({ updated: 1, unread: 2 })
    expect(await markNotificationsRead(['nt2'])).toEqual({
      updated: 0,
      unread: 2,
    })
    expect(mockControl.notifications.map(n => n.read)).toEqual([false, true, false])
  })

  it('成功后清掉列表缓存，让入口与角标下次取到新未读数', async () => {
    signIn()
    seedMine(2)
    await markNotificationsRead(['nt1'])
    expect(invalidate).toHaveBeenCalledWith(NOTIFICATIONS_KEY)
  })

  it('不传 ids 就是全部已读；已读完再点是幂等的 0', async () => {
    signIn()
    seedMine(4)
    expect(await markNotificationsRead()).toEqual({ updated: 4, unread: 0 })
    expect(await markNotificationsRead()).toEqual({ updated: 0, unread: 0 })
    const r = await listNotifications()
    expect(r.unread).toBe(0)
    expect(r.list.every(n => n.read)).toBe(true)
  })

  it('入参形状与云端一致：空数组不算「全部」，超限与脏值都是 40001', async () => {
    signIn()
    seedMine(2)
    await expect(markNotificationsRead([])).rejects.toMatchObject({
      code: ERROR_CODES.BAD_PARAM,
    })
    await expect(markNotificationsRead(new Array(101).fill('nt1'))).rejects.toMatchObject({ code: ERROR_CODES.BAD_PARAM })
    expect(calls('markNotificationsRead').length).toBeGreaterThan(0)
    await expect(listNotifications()).resolves.toMatchObject({ unread: 2 })
  })
})

describe('与云端的口径一致', () => {
  it('mock 生成的回复通知文案 = 云端 topics.js 的 REPLY_NOTICE', async () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../cloudfunctions/community/topics.js'), 'utf8').replace(/\r\n/g, '\n')
    const m = /const REPLY_NOTICE = '([^']+)'/.exec(src)
    expect(m).toBeTruthy()
    const notice = m![1]
    expect(notice).toBe('你的话题收到了新回复')

    signIn()
    mockControl.seedCircles([{ id: 'circle-1', slug: 'mindful', name: '静观练习' }])
    mockControl.setMemberships(['circle-1'])
    mockControl.seedTopics([
      {
        title: '别人的话题',
        body: '正文'.repeat(30),
        mine: false,
        circleId: 'circle-1',
      },
    ])
    const id = mockControl.topics[0].id
    await expect(createReply({ topicId: id, body: '我的回复内容' })).resolves.toBeTruthy()
    const pushed = mockControl.notifications.find(n => n.type === 'reply')
    expect(pushed!.text).toBe(notice)
    expect(pushed!.owner).toBe('other')
    expect(pushed!.refId).toBe(id)
  })

  it('我回复自己的话题不产生未读；别人回复我的话题会有一条', async () => {
    signIn()
    mockControl.seedCircles([{ id: 'circle-1', slug: 'mindful', name: '静观练习' }])
    mockControl.setMemberships(['circle-1'])
    mockControl.seedTopics([
      {
        title: '我的话题',
        body: '正文'.repeat(30),
        mine: true,
        circleId: 'circle-1',
      },
    ])
    const mine = mockControl.topics[0].id
    await expect(createReply({ topicId: mine, body: '补充一句：我后来把坐香缩短了。' })).resolves.toBeTruthy()
    expect(mockControl.notifications).toHaveLength(0)

    mockControl.seedReplies([{ topicId: mine, body: '别人给我的回复内容' }])
    const r = await listNotifications()
    expect(r.unread).toBe(1)
    expect(r.list[0]).toMatchObject({
      type: 'reply',
      refType: 'topic',
      refId: mine,
      read: false,
    })
  })

  it('空列表的文案与页面标题同源（消息页与「我的」入口用同一个常量）', async () => {
    expect(NOTIFICATIONS_TITLE).toBe('消息')
  })
})
