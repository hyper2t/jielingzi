/**
 * FE-M6-02（M6 D11 / D12）在页面上的三件事：发起话题的「慢话题」开关、话题详情页的冷静期提示与回复栏锁定、
 * 圈内「只看精华」筛选。慢话题与精华的规则本身在云端（community/topics.js、moderation.markFeatured），
 * 这里只验前端把字段传对、把状态显示对、到点自动放开。
 */
import { act, create, ReactTestRenderer } from 'react-test-renderer'
import Taro from '@tarojs/taro'
import CirclePage, { CIRCLE_FEATURED_EMPTY } from '@/pkg-community/pages/circle/index'
import TopicNew, { PUBLISH_TEXT } from '@/pkg-community/pages/topic-new/index'
import TopicPage, { REPLY_ANON_LABEL, SEND_TEXT } from '@/pkg-community/pages/topic/index'
import { FEATURED_BADGE } from '@/components/TopicCard'
import { SLOW_HINT, SLOW_LABEL, SLOW_LOCK_LABEL } from '@/features/topic/rules'
import { markRulesRead } from '@/features/consent/rules'
import { mockControl } from '@/services/mock/client'
import { invalidate } from '@/hooks/requestCache'
import { useUserStore } from '@/store/user'
import type { Profile } from '@/types/models'

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const mounted: ReactTestRenderer[] = []
const render = (el: JSX.Element) => { let r!: ReactTestRenderer; act(() => { r = create(el) }); mounted.push(r); return r }
afterEach(() => { mounted.splice(0).forEach(r => act(() => r.unmount())) })
const unmountRenderer = (r: ReactTestRenderer) => { act(() => r.unmount()); const i = mounted.indexOf(r); if (i >= 0) mounted.splice(i, 1) }
const hosts = (r: ReactTestRenderer, pred: (n: any) => boolean) => r.root.findAll(n => typeof n.type === 'string' && pred(n))
const texts = (r: ReactTestRenderer) => hosts(r, n => n.type === 'Text').map(n => String(n.props.children))
const has = (r: ReactTestRenderer, s: string) => texts(r).includes(s)
const some = (r: ReactTestRenderer, sub: string) => texts(r).some(t => t.includes(sub))
const labelled = (r: ReactTestRenderer, label: string) => hosts(r, n => n.props.ariaLabel === label && typeof n.props.onClick === 'function')
const click = (r: ReactTestRenderer, label: string) => act(() => { labelled(r, label)[0].props.onClick() })
const typeInto = (r: ReactTestRenderer, type: 'Input' | 'Textarea', label: string, value: string) =>
  act(() => { hosts(r, n => n.type === type && n.props.ariaLabel === label)[0].props.onInput({ detail: { value } }) })
const calls = (action: string) => mockControl.calls.filter(c => c.action === action)
const toastTitles = () => (Taro.showToast as jest.Mock).mock.calls.map(c => c[0].title)

const ACCOUNT = { phoneVerified: true, adult: true, role: 'mod' as const, bannedUntil: null, mutedUntil: null }
const LIN: Profile = { nickname: '林然', avatar: 'preset:leaf', practices: ['mindfulness'], years: 3, goal: '', bio: '', anonAlias: '竹影', badges: [], updatedAt: 1 }
const BODY = '静坐时总是走神，试了数呼吸也很难坚持，想听听大家的经验。'.repeat(3)
const HOUR = 3600000

/** 已同意、已确认 18+、已实名、读过公约：能读也能发（role: mod 才能顺手验精华的入口行为） */
function signIn () {
  useUserStore.setState({ consent: 'agreed', adult: 'confirmed', account: { ...ACCOUNT } })
  mockControl.setAccount({ adult: true, phoneVerified: true, role: 'mod' })
  mockControl.setProfile(LIN)
  markRulesRead()
}
const seedCircle = () => {
  mockControl.seedCircles([{ id: 'circle-mindful', slug: 'mindful', name: '静观练习', desc: '练习分享' }])
  mockControl.setMemberships(['circle-mindful'])
}
const seedTopic = (o: Record<string, unknown> = {}) => {
  mockControl.seedTopics([{ title: '静坐走神怎么办', body: BODY, tags: ['冥想'], ...o } as any])
  return mockControl.topics[mockControl.topics.length - 1].id
}
const openTopic = async (id: string) => {
  ;(Taro as any).__routerParams = { id }
  const r = render(<TopicPage />)
  await flush()
  return r
}
const openCircle = async () => {
  ;(Taro as any).__routerParams = { id: 'circle-mindful' }
  const r = render(<CirclePage />)
  await flush()
  return r
}

beforeEach(() => {
  mockControl.reset()
  mockControl.latency = 0
  invalidate()
  ;(Taro as any).__storage.clear()
  ;(Taro as any).__routerParams = {}
  useUserStore.setState({ consent: 'unknown', adult: 'unknown', account: null, sheetOpen: false, phoneSheetOpen: false, phoneSheetReason: undefined })
  jest.clearAllMocks()
})

describe('发起话题：慢话题开关（FE-M6-02）', () => {
  it('默认关闭；开着发布时把 slow 发给云端，云端落 slowUntil（前端不自己算时间）', async () => {
    signIn()
    seedCircle()
    const r = render(<TopicNew />)
    await flush()
    expect(has(r, SLOW_LABEL)).toBe(true)
    expect(has(r, SLOW_HINT)).toBe(true) // 要说清开启后多久不开放回复
    expect(hosts(r, n => n.props.ariaLabel === `${SLOW_LABEL}，已关闭`)).toHaveLength(1)
    typeInto(r, 'Input', '标题', '静坐走神怎么办')
    typeInto(r, 'Textarea', '正文', BODY)
    click(r, `${SLOW_LABEL}，已关闭`)
    expect(hosts(r, n => n.props.ariaLabel === `${SLOW_LABEL}，已开启`)).toHaveLength(1)
    click(r, PUBLISH_TEXT)
    await flush()
    expect(calls('createTopic')).toHaveLength(1)
    expect(calls('createTopic')[0].data).toMatchObject({ slow: true })
    expect(toastTitles()).toContain('已发布')
    const d = mockControl.topics[mockControl.topics.length - 1]
    expect(d.slowUntil).not.toBeNull()
    expect(d.slowUntil! - d.createdAt).toBe(24 * HOUR)
  })
  it('不开就完全不带 slow 键（避免把 false 传上去）；草稿恢复保留开关状态', async () => {
    signIn()
    seedCircle()
    const r = render(<TopicNew />)
    await flush()
    typeInto(r, 'Input', '标题', '静坐走神怎么办')
    typeInto(r, 'Textarea', '正文', BODY)
    click(r, PUBLISH_TEXT)
    await flush()
    expect(calls('createTopic')[0].data).not.toHaveProperty('slow')
    expect(mockControl.topics[mockControl.topics.length - 1].slowUntil).toBeNull()

    const r2 = render(<TopicNew />)
    await flush()
    typeInto(r2, 'Input', '标题', '下次再发的标题')
    click(r2, `${SLOW_LABEL}，已关闭`)
    unmountRenderer(r2)
    const r3 = render(<TopicNew />)
    await flush()
    expect(hosts(r3, n => n.props.ariaLabel === `${SLOW_LABEL}，已开启`)).toHaveLength(1)
  })
})

describe('话题详情：冷静期只锁回复（FE-M6-02）', () => {
  it('未到点：没有输入框与发送按钮，底部说明还剩多久；到点：回复栏回来', async () => {
    signIn()
    seedCircle()
    const lockedId = seedTopic({ slowUntil: Date.now() + 2 * HOUR + 60000 })
    const r = await openTopic(lockedId)
    expect(has(r, SEND_TEXT)).toBe(false)
    expect(hosts(r, n => n.type === 'Textarea')).toHaveLength(0)
    expect(some(r, '还在冷静期')).toBe(true)
    expect(some(r, '2 小时 1 分后开放回复')).toBe(true) // 给准数，不写「稍后再试」
    expect(hosts(r, n => n.props.ariaLabel === '举报该话题')).toHaveLength(1) // 锁的是回复，不是整页

    const openId = seedTopic({ slowUntil: Date.now() - 1000 })
    const r2 = await openTopic(openId)
    expect(has(r2, SEND_TEXT)).toBe(true)
    expect(has(r2, REPLY_ANON_LABEL)).toBe(true)
  })
  it('列表卡片带冷静期状态标，详情页带精华标；两者互不影响', async () => {
    signIn()
    seedCircle()
    const id = seedTopic({ featured: true, slowUntil: Date.now() + HOUR })
    const r = await openTopic(id)
    expect(has(r, FEATURED_BADGE)).toBe(true)
    const feed = await openCircle()
    expect(texts(feed)).toContain(SLOW_LOCK_LABEL)
    expect(has(feed, FEATURED_BADGE)).toBe(true)
  })
})

describe('圈内话题：只看精华筛选（FE-M6-02）', () => {
  it('成员默认看全部；切到只看精华会重新取数并带 featured: true，列表只剩精华', async () => {
    signIn()
    seedCircle()
    seedTopic({ title: '普通话题' })
    seedTopic({ title: '精华话题', featured: true })
    const r = await openCircle()
    expect(calls('listTopics').slice(-1)[0].data).toEqual({ page: 1, size: 20, circleId: 'circle-mindful' })
    expect(has(r, '普通话题')).toBe(true)
    expect(has(r, '精华话题')).toBe(true)
    expect(has(r, '看全部')).toBe(true)
    click(r, '只看精华')
    await flush()
    expect(calls('listTopics').slice(-1)[0].data).toEqual({ page: 1, size: 20, circleId: 'circle-mindful', featured: true })
    expect(has(r, '普通话题')).toBe(false)
    expect(has(r, '精华话题')).toBe(true)
    expect(has(r, '只看精华')).toBe(true)
    click(r, '取消只看精华')
    await flush()
    expect(has(r, '普通话题')).toBe(true)
  })
  it('圈子里还没有精华话题：空态说清是「没有精华话题」，不谎报「还没有话题」', async () => {
    signIn()
    seedCircle()
    seedTopic({ title: '普通话题' })
    const r = await openCircle()
    click(r, '只看精华')
    await flush()
    expect(has(r, CIRCLE_FEATURED_EMPTY)).toBe(true)
    expect(has(r, '这个圈子还没有话题')).toBe(false)
  })
})
