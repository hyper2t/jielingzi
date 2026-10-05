/**
 * FE-M6-03：站内消息的纯前端规则（标签 / 时间 / 可点与否 / 分页合并）、订阅授权与 tabBar 角标。
 * 云端契约见 docs/api/practice.md；这里只钉「前端不做决定」的部分：不解析 text、不新增类型、缺配置就跳过。
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  EMPTY_TEXT,
  GATE_TEXT,
  MARK_ALL_TEXT,
  MINE_TAB_INDEX,
  NOTIFICATION_TAGS,
  NOTIFICATION_TYPES,
  TAB_BADGE_MAX,
  badgeText,
  isUnread,
  markLocalRead,
  mergeNotifications,
  notificationTag,
  notificationTarget,
  notificationTime,
  unreadLabel,
} from '@/features/notify/rules'
import { SUBSCRIBE_TEMPLATE_ENV, canRequestSubscribe, requestSubscribe, subscribeTemplateId } from '@/features/notify/subscribe'
import { syncTabBadge } from '@/features/notify/badge'
import type { AppNotification } from '@/types/models'

const ROW = (o: Partial<AppNotification> = {}): AppNotification => ({
  id: 'n-1',
  type: 'reply',
  refType: 'topic',
  refId: 't-1',
  text: '你的话题收到了新回复',
  read: false,
  createdAt: null,
  ...o,
})

const root = path.resolve(__dirname, '../../../..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')

/** 云端的文案与类型清单以源码为准比对：不在 jest 里加载云函数模块（它们会 require('./db')） */
const stringConst = (src: string, name: string): string => {
  const m = src.match(new RegExp(`const ${name} = '([^']+)'`))
  if (!m) throw new Error(`云端源码里找不到常量 ${name}`)
  return m[1]
}
const frozenList = (src: string, name: string): string[] => {
  const m = src.match(new RegExp(`const ${name} = Object\\.freeze\\(\\[([^\\]]*)\\]\\)`))
  if (!m) throw new Error(`云端源码里找不到常量 ${name}`)
  return m[1]
    .split(',')
    .map(x => x.trim().replace(/^'|'$/g, ''))
    .filter(Boolean)
}

describe('类型清单与文案同源', () => {
  it('NOTIFICATION_TYPES 与云端 NOTIFY_TYPES 同序（前端不新增第四类）', () => {
    expect([...NOTIFICATION_TYPES]).toEqual(frozenList(read('cloudfunctions/_shared/notify.js'), 'NOTIFY_TYPES'))
    expect(Object.keys(NOTIFICATION_TAGS)).toEqual([...NOTIFICATION_TYPES])
  })

  it('提醒文案与云端 reminder.js 一致（wording.md §7 的三方对齐）', () => {
    expect(stringConst(read('cloudfunctions/_shared/reminder.js'), 'REMINDER_TEXT')).toBe('今天的每日一题已经准备好，可以写下你的回答')
    expect(GATE_TEXT).toBe('确认年满 18 周岁后可查看消息')
    expect(MARK_ALL_TEXT).toBe('全部标为已读')
    expect(EMPTY_TEXT).toBe('还没有消息')
  })

  it('「我的」的 tabBar 下标与 app.config.ts 的顺序一致', () => {
    const src = read('src/app.config.ts')
    const bar = src.slice(src.indexOf('tabBar:'))
    const order = [...bar.matchAll(/pagePath: '([^']+)'/g)].map(m => m[1]).slice(0, 3)
    expect(order).toEqual(['pages/index/index', 'pages/practice/index', 'pages/mine/index'])
    expect(MINE_TAB_INDEX).toBe(order.indexOf('pages/mine/index'))
  })
})

describe('列表展示规则', () => {
  it('标签按类型给；未知 type 退成「消息」而不是崩', () => {
    expect(notificationTag('reply')).toBe('回复')
    expect(notificationTag('moderation')).toBe('处理结果')
    expect(notificationTag('prompt')).toBe('每日一题')
    expect(notificationTag('sms')).toBe('消息')
  })

  it('时间口径共用 formatPostTime：非法 / 缺失都返回空串', () => {
    const now = Date.UTC(2026, 9, 4, 8, 0, 0)
    expect(notificationTime(now - 30 * 1000, now)).toBe('刚刚')
    expect(notificationTime(now - 5 * 60 * 1000, now)).toBe('5 分钟前')
    expect(notificationTime(now - 3 * 3600 * 1000, now)).toBe('3 小时前')
    expect(notificationTime(Date.UTC(2020, 0, 1), now)).toBe('2020-01-01')
    expect(notificationTime(null)).toBe('')
    expect(notificationTime(undefined)).toBe('')
    expect(notificationTime('' as any)).toBe('')
  })

  it('能不能点开只看 type + refType + refId，不看正文', () => {
    expect(notificationTarget(ROW())).toEqual({
      route: 'topic',
      params: { id: 't-1' },
    })
    expect(notificationTarget(ROW({ type: 'prompt', refType: 'daily_prompt', refId: 'p-1' }))).toEqual({ route: 'prompt', params: { promptId: 'p-1' } })
    expect(notificationTarget(ROW({ type: 'moderation', refType: 'topic', refId: 't-1' }))).toBeNull()
    expect(notificationTarget(ROW({ refId: null }))).toBeNull()
    expect(notificationTarget(ROW({ refType: 'daily_prompt' }))).toBeNull()
    expect(notificationTarget(ROW({ type: 'prompt', refType: 'topic' }))).toBeNull()
    expect(notificationTarget(ROW({ type: 'sms' as AppNotification['type'] }))).toBeNull()
  })

  it('未读判断把缺失当未读（老数据不闪没）', () => {
    expect(isUnread(ROW())).toBe(true)
    expect(isUnread(ROW({ read: true }))).toBe(false)
    expect(isUnread(ROW({ read: undefined as any }))).toBe(true)
  })

  it('追加下一页按 id 去重；已读同步只改命中的那些', () => {
    const a = [ROW({ id: 'a' }), ROW({ id: 'b' })]
    const b = [ROW({ id: 'b' }), ROW({ id: 'c' })]
    expect(mergeNotifications(a, b).map(n => n.id)).toEqual(['a', 'b', 'c'])
    expect(markLocalRead(a, ['a']).map(n => `${n.id}:${n.read ? 1 : 0}`)).toEqual(['a:1', 'b:0'])
    expect(markLocalRead(a).every(n => n.read)).toBe(true)
    expect(markLocalRead(a, []).every(n => n.read)).toBe(true)
  })

  it('未读文案与角标上限', () => {
    expect(unreadLabel(0)).toBe('暂无未读')
    expect(unreadLabel(2)).toBe('2 条未读')
    expect(badgeText(0)).toBe('0')
    expect(badgeText(7)).toBe('7')
    expect(badgeText(TAB_BADGE_MAX + 1)).toBe('99+')
  })
})

describe('订阅消息授权（D14 / D17）', () => {
  const WEAPP = { TARO_ENV: 'weapp', [SUBSCRIBE_TEMPLATE_ENV]: 'tpl-1' }
  const taroOf = (impl?: any) => ({
    requestSubscribeMessage: impl ?? jest.fn(() => Promise.resolve({})),
  })

  it('模板 ID 只从环境变量读，前后空格都算没有', () => {
    expect(subscribeTemplateId(WEAPP)).toBe('tpl-1')
    expect(subscribeTemplateId({ [SUBSCRIBE_TEMPLATE_ENV]: '  ' })).toBe('')
    expect(subscribeTemplateId({})).toBe('')
    expect(subscribeTemplateId({ [SUBSCRIBE_TEMPLATE_ENV]: 42 as any })).toBe('')
  })

  it('非小程序端、缺模板 ID、没有该 API —— 都判为不可请求', () => {
    expect(canRequestSubscribe({ env: WEAPP, taro: taroOf() })).toBe(true)
    expect(
      canRequestSubscribe({
        env: { TARO_ENV: 'h5', [SUBSCRIBE_TEMPLATE_ENV]: 'tpl-1' },
        taro: taroOf(),
      }),
    ).toBe(false)
    expect(canRequestSubscribe({ env: { TARO_ENV: 'weapp' }, taro: taroOf() })).toBe(false)
    expect(canRequestSubscribe({ env: WEAPP, taro: {} })).toBe(false)
    expect(canRequestSubscribe({ env: WEAPP, taro: null })).toBe(false)
  })

  it('发起时只带一个模板 ID；拒绝与报错都静默（不影响调用方）', async () => {
    const taro = taroOf()
    expect(await requestSubscribe({ env: WEAPP, taro })).toBe('requested')
    expect(taro.requestSubscribeMessage).toHaveBeenCalledTimes(1)
    expect(taro.requestSubscribeMessage).toHaveBeenCalledWith({
      tmplIds: ['tpl-1'],
    })

    expect(await requestSubscribe({ env: { TARO_ENV: 'weapp' }, taro })).toBe('skipped')
    expect(taro.requestSubscribeMessage).toHaveBeenCalledTimes(1)

    const boom = taroOf(jest.fn(() => Promise.reject(new Error('用户拒绝'))))
    await expect(requestSubscribe({ env: WEAPP, taro: boom })).resolves.toBe('failed')

    const syncThrow = {
      requestSubscribeMessage: jest.fn(() => {
        throw new Error('boom')
      }),
    }
    await expect(requestSubscribe({ env: WEAPP, taro: syncThrow })).resolves.toBe('failed')
  })

  it('缺模板 ID 时连 requestSubscribeMessage 都不该被读到（避免在 H5 / RN 上调不存在的 API）', async () => {
    const spy = new Proxy(
      {},
      {
        get(_t, k) {
          throw new Error(`不该访问 ${String(k)}`)
        },
        has() {
          return false
        },
      },
    )
    expect(await requestSubscribe({ env: { TARO_ENV: 'h5' }, taro: spy })).toBe('skipped')
  })
})

describe('tabBar 未读角标（best-effort）', () => {
  const withWeapp = async (fn: () => Promise<void>) => {
    const prev = process.env.TARO_ENV
    process.env.TARO_ENV = 'weapp'
    try {
      await fn()
    } finally {
      process.env.TARO_ENV = prev
    }
  }

  it('小程序：有未读就设角标，归零就摘掉', async () => {
    await withWeapp(async () => {
      const taro = {
        setTabBarBadge: jest.fn(() => Promise.resolve()),
        removeTabBarBadge: jest.fn(() => Promise.resolve()),
      }
      expect(await syncTabBadge(3, taro)).toBe(true)
      expect(taro.setTabBarBadge).toHaveBeenCalledWith({
        index: MINE_TAB_INDEX,
        text: '3',
      })
      expect(taro.removeTabBarBadge).not.toHaveBeenCalled()
      expect(await syncTabBadge(0, taro)).toBe(true)
      expect(taro.removeTabBarBadge).toHaveBeenCalledWith({
        index: MINE_TAB_INDEX,
      })
    })
  })

  it('超过上限显示 99+；没有该 API 或平台不支持时静默 false', async () => {
    await withWeapp(async () => {
      const taro = {
        setTabBarBadge: jest.fn(() => Promise.resolve()),
        removeTabBarBadge: jest.fn(() => Promise.resolve()),
      }
      expect(await syncTabBadge(120, taro)).toBe(true)
      expect(taro.setTabBarBadge).toHaveBeenCalledWith({
        index: MINE_TAB_INDEX,
        text: '99+',
      })
      expect(await syncTabBadge(1, {})).toBe(false)
    })
    // test/setup.js 把 TARO_ENV 默认成 weapp，所以要显式切走才测得到「非小程序端不碰 tabBar」
    const prev = process.env.TARO_ENV
    process.env.TARO_ENV = 'h5'
    const taro = { setTabBarBadge: jest.fn(), removeTabBarBadge: jest.fn() }
    expect(await syncTabBadge(5, taro)).toBe(false)
    expect(taro.setTabBarBadge).not.toHaveBeenCalled()
    process.env.TARO_ENV = prev
  })

  it('微信在「本来没有角标」时 remove 会 reject：吞掉，不冒泡到页面', async () => {
    await withWeapp(async () => {
      const taro = {
        setTabBarBadge: jest.fn(() => Promise.resolve()),
        removeTabBarBadge: jest.fn(() => Promise.reject(new Error('no badge'))),
      }
      await expect(syncTabBadge(0, taro)).resolves.toBe(false)
    })
  })
})
