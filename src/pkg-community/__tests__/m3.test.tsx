/**
 * M3 前端（小程序 / mock 数据源）：首页话题流（FE-M3-01）、发起话题（FE-M3-02）、话题详情（FE-M3-03）。
 * 用例索引见 docs/test/cases/M3.md。校验规则与云函数的一致性见 src/features/topic/__tests__/rules.test.ts。
 */
import { act, create, ReactTestRenderer } from 'react-test-renderer'
import Taro from '@tarojs/taro'
import { REPORT_SUBMIT } from '@/components'
import Index, { FEED_END, HOME_EMPTY, NEED_ADULT_TEXT } from '@/pages/index/index'
import TopicNew, { ANON_LABEL, DRAFT_CLEAR, DRAFT_RESTORED, PENDING_TEXT, PUBLISHED_TEXT, PUBLISH_TEXT } from '@/pkg-community/pages/topic-new/index'
import Topic, { A11Y, DELETED_TEXT, FOLDED_NOTE, foldLabel, NOT_FOUND_TEXT, PENDING_NOTE, QUOTE_GONE, REPLY_ANON_LABEL, REPLY_PENDING, REPLY_SENT, SEND_TEXT } from '@/pkg-community/pages/topic/index'
import { markRulesRead } from '@/features/consent/rules'
import { TOPIC_LIMIT_TEXT, REPLY_LIMIT_TEXT } from '@/features/topic/rules'
import { createReply, createTopic } from '@/services/community'
import { mockControl } from '@/services/mock/client'
import { invalidate } from '@/hooks/requestCache'
import { useUserStore } from '@/store/user'
import type { Profile } from '@/types/models'

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const mounted: ReactTestRenderer[] = []
const render = (el: JSX.Element) => { let r!: ReactTestRenderer; act(() => { r = create(el) }); mounted.push(r); return r }
afterEach(() => { mounted.splice(0).forEach(r => act(() => r.unmount())) })
const hosts = (r: ReactTestRenderer, pred: (n: any) => boolean) => r.root.findAll(n => typeof n.type === 'string' && pred(n))
const texts = (r: ReactTestRenderer) => hosts(r, n => n.type === 'Text').map(n => String(n.props.children))
const has = (r: ReactTestRenderer, s: string) => texts(r).includes(s)
const labelled = (r: ReactTestRenderer, label: string) => hosts(r, n => n.props.ariaLabel === label && typeof n.props.onClick === 'function')
const click = (r: ReactTestRenderer, label: string) => act(() => { labelled(r, label)[0].props.onClick() })
const typeInto = (r: ReactTestRenderer, type: 'Input' | 'Textarea', label: string, value: string) =>
  act(() => { hosts(r, n => n.type === type && n.props.ariaLabel === label)[0].props.onInput({ detail: { value } }) })
const field = (r: ReactTestRenderer, type: 'Input' | 'Textarea', label: string) => hosts(r, n => n.type === type && n.props.ariaLabel === label)[0]
const calls = (action: string) => mockControl.calls.filter(c => c.action === action)
const toastTitles = () => (Taro.showToast as jest.Mock).mock.calls.map(c => c[0].title)

const ACCOUNT = { phoneVerified: true, adult: true, role: 'user' as const, bannedUntil: null, mutedUntil: null }
const LIN: Profile = { nickname: '林然', avatar: 'preset:leaf', practices: ['mindfulness'], years: 3, goal: '', bio: '', anonAlias: '竹影', badges: [], updatedAt: 1 }
const BODY = '静坐时总是走神，试了数呼吸也很难坚持，想听听大家的经验。'.repeat(3)
/** 补足字数，保证不会被当作简短回复（< 30 字）折叠 */
const long = (s: string) => `${s}，另外补充一些文字，保证这条回复不会被当作简短回复折叠起来。`

/** 已同意、已确认 18+、已实名、读过公约：能读也能发 */
function signIn (opts: { phone?: boolean } = {}) {
  const phone = opts.phone !== false
  useUserStore.setState({ consent: 'agreed', adult: 'confirmed', account: { ...ACCOUNT, phoneVerified: phone } })
  mockControl.setAccount({ adult: true, phoneVerified: phone })
  mockControl.setProfile(LIN)
  markRulesRead()
}
const seedTopic = (o: Record<string, unknown> = {}) => {
  mockControl.seedTopics([{ title: '静坐走神怎么办', body: BODY, tags: ['冥想'], ...o } as any])
  return mockControl.topics[mockControl.topics.length - 1].id
}
const openTopic = async (id: string) => {
  ;(Taro as any).__routerParams = { id }
  const r = render(<Topic />)
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

describe('首页话题流（FE-M3-01）', () => {
  it('新的在前；卡片带作者 / 标题 / 摘要 / 标签 / 回复数；点卡片进详情', async () => {
    signIn()
    seedTopic({ title: '较早的话题', authorName: '林然', createdAt: Date.now() - 100000 })
    const id = seedTopic({ title: '最新的话题', authorName: '松声', replyCount: 3, tags: ['冥想', '呼吸'], createdAt: Date.now() - 1000 })
    const r = render(<Index />)
    await flush()
    const all = texts(r)
    expect(all.indexOf('最新的话题')).toBeGreaterThan(-1)
    expect(all.indexOf('最新的话题')).toBeLessThan(all.indexOf('较早的话题'))
    expect(all).toEqual(expect.arrayContaining(['松声', '#冥想', '#呼吸', '3 条回复']))
    // 摘要不是全文（80 字 + …）
    expect(all.some(t => t.endsWith('…') && t.length <= 81)).toBe(true)
    click(r, '话题：最新的话题，3 条回复，静观练习')
    expect(Taro.navigateTo).toHaveBeenCalledWith({ url: `/pkg-community/pages/topic/index?id=${id}` })
  })

  it('匿名话题只显示「匿名·代号」；折叠的话题不进话题流（云端只给 ok）', async () => {
    signIn()
    seedTopic({ title: '匿名的话题', anon: true, authorName: '云眠' })
    seedTopic({ title: '被折叠的话题', status: 'folded' })
    seedTopic({ title: '已下架的话题', status: 'removed' })
    const r = render(<Index />)
    await flush()
    expect(has(r, '匿名·云眠')).toBe(true)
    expect(has(r, '被折叠的话题')).toBe(false)
    expect(has(r, '已下架的话题')).toBe(false)
  })

  it('没有话题：引导发起；点「发起话题」过门禁后进发帖页', async () => {
    signIn()
    const r = render(<Index />)
    await flush()
    expect(has(r, HOME_EMPTY)).toBe(true)
    click(r, '发起话题')
    expect(Taro.navigateTo).toHaveBeenCalledWith({ url: '/pkg-community/pages/topic-new/index' })
  })

  it('未入圈：首页介绍开放圈子与加入入口，不请求圈内话题', async () => {
    signIn()
    mockControl.seedCircles([
      { id: 'circle-mindful', slug: 'mindful', name: '静观练习', desc: '练习分享' },
      { id: 'circle-tradition', slug: 'tradition', name: '传统养生', desc: '日常养生' }
    ])
    mockControl.setMemberships([])
    mockControl.seedTopics([{ title: '不应出现的话题', body: BODY, circleId: 'circle-mindful' }])
    const r = render(<Index />)
    await flush()
    expect(has(r, '先加入一个圈子')).toBe(true)
    expect(texts(r)).toEqual(expect.arrayContaining(['静观练习', '传统养生']))
    expect(calls('listTopics')).toHaveLength(0)
    click(r, '输入邀请码')
    expect(Taro.navigateTo).toHaveBeenCalledWith({ url: '/pkg-community/pages/join-circle/index' })
    click(r, '浏览圈子')
    expect(Taro.navigateTo).toHaveBeenCalledWith({ url: '/pkg-community/pages/circles/index' })
  })

  it('多圈首页筛选只传所选 circleId，并切换后不保留旧列表', async () => {
    signIn()
    mockControl.seedCircles([
      { id: 'circle-mindful', slug: 'mindful', name: '静观练习' },
      { id: 'circle-tradition', slug: 'tradition', name: '传统养生' }
    ])
    mockControl.setMemberships(['circle-mindful', 'circle-tradition'])
    mockControl.seedTopics([
      { title: '静观圈话题', body: BODY, circleId: 'circle-mindful' },
      { title: '传统圈话题', body: BODY, circleId: 'circle-tradition' }
    ])
    const r = render(<Index />)
    await flush()
    expect(has(r, '静观圈话题')).toBe(true)
    expect(has(r, '传统圈话题')).toBe(true)
    expect(r.toJSON()).toMatchSnapshot('home feed with circle filter and circle labels')
    click(r, '圈子：传统养生')
    await flush()
    expect(has(r, '传统圈话题')).toBe(true)
    expect(has(r, '静观圈话题')).toBe(false)
    expect(calls('listTopics').slice(-1)[0].data).toEqual({ page: 1, size: 20, circleId: 'circle-tradition' })
    click(r, '发起话题')
    expect(Taro.navigateTo).toHaveBeenCalledWith({ url: '/pkg-community/pages/topic-new/index?circleId=circle-tradition' })
  })

  it('分页：首屏 20 条，触底再取第 2 页，到底显示「没有更多了」', async () => {
    signIn()
    mockControl.seedTopics(Array.from({ length: 25 }, (_v, i) => ({ title: `话题${i + 1}`, body: BODY })))
    const r = render(<Index />)
    await flush()
    expect(has(r, '话题25')).toBe(true)
    expect(has(r, '话题6')).toBe(true)
    expect(has(r, '话题5')).toBe(false)
    expect(has(r, FEED_END)).toBe(false)
    act(() => { (Taro as any).__emitReachBottom() })
    await flush()
    expect(has(r, '话题1')).toBe(true)
    expect(has(r, FEED_END)).toBe(true)
    expect(calls('listTopics').map(c => c.data)).toEqual([{ page: 1, size: 20 }, { page: 2, size: 20 }])
  })

  it('下拉刷新：重新取第 1 页，并收起下拉动画', async () => {
    signIn()
    seedTopic({ title: '旧话题' })
    const r = render(<Index />)
    await flush()
    seedTopic({ title: '刚发的新话题' })
    expect(has(r, '刚发的新话题')).toBe(false)
    act(() => { (Taro as any).__emitPullDown() })
    await flush()
    expect(has(r, '刚发的新话题')).toBe(true)
    expect(Taro.stopPullDownRefresh).toHaveBeenCalled()
  })

  it('发布后回到首页（页面重新显示）自动刷新话题流', async () => {
    signIn()
    seedTopic({ title: '旧话题' })
    const r = render(<Index />)
    await flush()
    await createTopic({ title: '我刚发的话题', body: BODY })
    act(() => { (Taro as any).__emitShow() })
    await flush()
    expect(has(r, '我刚发的话题')).toBe(true)
  })

  it('加载失败：整页重试；重试后恢复', async () => {
    signIn()
    seedTopic({ title: '会出现的话题' })
    mockControl.failTimes = 1
    const r = render(<Index />)
    await flush()
    expect(has(r, '网络不太好')).toBe(true)
    click(r, '点我重试')
    await flush()
    expect(has(r, '会出现的话题')).toBe(true)
  })

  it('未确认 18+：引导去确认，不发云端请求；云端返回 40303（本机与云端不一致）同样引导', async () => {
    useUserStore.setState({ consent: 'agreed', adult: 'unknown' })
    const r = render(<Index />)
    await flush()
    expect(has(r, NEED_ADULT_TEXT)).toBe(true)
    expect(mockControl.calls).toHaveLength(0)

    useUserStore.setState({ adult: 'confirmed' })
    mockControl.setAccount({ adult: false })
    const r2 = render(<Index />)
    await flush()
    expect(has(r2, NEED_ADULT_TEXT)).toBe(true)
    click(r2, '去确认')
    expect(Taro.navigateTo).toHaveBeenCalledWith({ url: expect.stringContaining('/pkg-user/pages/adult/index') })
  })
})

describe('发起话题（FE-M3-02）', () => {
  const fill = (r: ReactTestRenderer, o: { title?: string, body?: string, tags?: string } = {}) => {
    typeInto(r, 'Input', '标题', o.title ?? '静坐走神怎么办')
    typeInto(r, 'Textarea', '正文', o.body ?? BODY)
    if (o.tags !== undefined) typeInto(r, 'Input', '标签', o.tags)
  }

  it('未同意：引导同意，不渲染表单', () => {
    const r = render(<TopicNew />)
    expect(has(r, '同意协议后可发起话题')).toBe(true)
    expect(hosts(r, n => n.type === 'Textarea')).toHaveLength(0)
  })

  it('未入圈：介绍开放圈子与加入入口，不显示发话题表单', async () => {
    signIn()
    mockControl.seedCircles([{ id: 'circle-mindful', slug: 'mindful', name: '静观练习', desc: '练习分享' }])
    mockControl.setMemberships([])
    const r = render(<TopicNew />)
    await flush()
    expect(has(r, '先加入一个圈子')).toBe(true)
    expect(has(r, '静观练习')).toBe(true)
    expect(hosts(r, n => n.type === 'Textarea')).toHaveLength(0)
    click(r, '输入邀请码')
    expect(Taro.navigateTo).toHaveBeenCalledWith({ url: '/pkg-community/pages/join-circle/index' })
  })

  it('空表单提交：各字段给出与云端一致的提示，不发请求', async () => {
    signIn()
    const r = render(<TopicNew />)
    await flush()
    expect(labelled(r, '发布到：静观练习')).toHaveLength(0)
    click(r, PUBLISH_TEXT)
    await flush()
    expect(texts(r)).toEqual(expect.arrayContaining(['标题至少 5 个字', '正文至少 50 个字']))
    expect(calls('createTopic')).toHaveLength(0)
  })

  it('字数提示：正文不含空白计数，未达标显示「已写 / 至少」', async () => {
    signIn()
    const r = render(<TopicNew />)
    await flush()
    typeInto(r, 'Textarea', '正文', '静 坐 走 神')
    expect(has(r, '4 / 至少 50 字')).toBe(true)
    typeInto(r, 'Textarea', '正文', '静'.repeat(50))
    expect(has(r, '50 字')).toBe(true)
  })

  it('发布：提交清洗后的入参 → 提示已发布 → 进入详情；草稿删除', async () => {
    signIn()
    const r = render(<TopicNew />)
    await flush()
    fill(r, { title: '  静坐走神   怎么办 ', tags: '#冥想 呼吸 冥想' })
    expect((Taro as any).__storage.size).toBeGreaterThan(0)
    click(r, PUBLISH_TEXT)
    await flush()
    expect(calls('createTopic')[0].data).toEqual({ circleId: 'circle-mindful', title: '静坐走神 怎么办', body: BODY, anon: false, tags: ['冥想', '呼吸'] })
    expect(toastTitles()).toContain(PUBLISHED_TEXT)
    const id = mockControl.topics[0].id
    expect(Taro.redirectTo).toHaveBeenCalledWith({ url: `/pkg-community/pages/topic/index?id=${id}` })
    expect(mockControl.topics[0]).toMatchObject({ status: 'ok', anon: false, mine: true })
    // 再进来没有草稿
    expect(has(render(<TopicNew />), DRAFT_RESTORED)).toBe(false)
  })

  it('匿名：开关切换预览为「匿名·代号」，入参 anon: true', async () => {
    signIn()
    const r = render(<TopicNew />)
    await flush()
    expect(has(r, '林然')).toBe(true)
    click(r, `${ANON_LABEL}，已关闭`)
    expect(has(r, '匿名·竹影')).toBe(true)
    expect(has(r, '林然')).toBe(false)
    fill(r)
    click(r, PUBLISH_TEXT)
    await flush()
    expect(calls('createTopic')[0].data).toMatchObject({ anon: true })
  })

  it('多圈发话题可选择圈子，草稿恢复后继续提交到原圈子', async () => {
    signIn()
    mockControl.seedCircles([
      { id: 'circle-mindful', slug: 'mindful', name: '静观练习' },
      { id: 'circle-tradition', slug: 'tradition', name: '传统养生' }
    ])
    mockControl.setMemberships(['circle-mindful', 'circle-tradition'])
    ;(Taro as any).__routerParams = { circleId: 'circle-tradition' }
    const first = render(<TopicNew />)
    await flush()
    expect(labelled(first, '发布到：传统养生')).toHaveLength(1)
    click(first, '发布到：传统养生')
    click(first, '静观练习')
    fill(first, { title: '准备发布到静观圈', body: BODY })
    act(() => first.unmount())
    mounted.splice(mounted.indexOf(first), 1)

    const restored = render(<TopicNew />)
    await flush()
    expect(field(restored, 'Input', '标题').props.value).toBe('准备发布到静观圈')
    expect(labelled(restored, '发布到：静观练习')).toHaveLength(1)
    click(restored, PUBLISH_TEXT)
    await flush()
    expect(calls('createTopic')[0].data).toMatchObject({ circleId: 'circle-mindful' })
  })

  it('本地草稿：输入即存；重新进入恢复并提示；清除草稿后为空', async () => {
    signIn()
    const first = render(<TopicNew />)
    await flush()
    fill(first, { title: '写到一半的标题', body: '写到一半', tags: '冥想' })
    click(first, `${ANON_LABEL}，已关闭`)
    act(() => first.unmount())
    mounted.splice(mounted.indexOf(first), 1)

    const r = render(<TopicNew />)
    await flush()
    expect(has(r, DRAFT_RESTORED)).toBe(true)
    expect(field(r, 'Input', '标题').props.value).toBe('写到一半的标题')
    expect(field(r, 'Textarea', '正文').props.value).toBe('写到一半')
    expect(field(r, 'Input', '标签').props.value).toBe('冥想')
    expect(labelled(r, `${ANON_LABEL}，已开启`)).toHaveLength(1)

    click(r, DRAFT_CLEAR)
    expect(field(r, 'Input', '标题').props.value).toBe('')
    expect(has(r, DRAFT_RESTORED)).toBe(false)
    expect(has(render(<TopicNew />), DRAFT_RESTORED)).toBe(false)
  })

  it('机审待复核：提示「审核通过后展示」，仍进入详情（只有本人看得到）', async () => {
    signIn()
    const r = render(<TopicNew />)
    await flush()
    fill(r, { body: `${BODY}[review]` })
    click(r, PUBLISH_TEXT)
    await flush()
    expect(toastTitles()).toContain(PENDING_TEXT)
    expect(mockControl.topics[0].status).toBe('pending')
    expect(Taro.redirectTo).toHaveBeenCalled()
  })

  it('机审拒绝：提示修改，不进详情，内容与草稿保留，不占额度', async () => {
    signIn()
    const r = render(<TopicNew />)
    await flush()
    fill(r, { body: `${BODY}[reject]` })
    click(r, PUBLISH_TEXT)
    await flush()
    expect(has(r, '内容不符合社区公约，请修改后再发布')).toBe(true)
    expect(Taro.redirectTo).not.toHaveBeenCalled()
    expect(mockControl.topics).toHaveLength(0)
    expect(field(r, 'Textarea', '正文').props.value).toContain('[reject]')
    // 额度没被占：之后仍能发 2 条
    typeInto(r, 'Textarea', '正文', BODY)
    click(r, PUBLISH_TEXT)
    await flush()
    expect(mockControl.topics).toHaveLength(1)
  })

  it('当日额度用尽：提示上限，内容保留', async () => {
    signIn()
    await createTopic({ title: '今天的第一条', body: BODY })
    await createTopic({ title: '今天的第二条', body: BODY })
    const r = render(<TopicNew />)
    await flush()
    fill(r)
    click(r, PUBLISH_TEXT)
    await flush()
    expect(has(r, TOPIC_LIMIT_TEXT)).toBe(true)
    expect(Taro.redirectTo).not.toHaveBeenCalled()
    expect(field(r, 'Textarea', '正文').props.value).toBe(BODY)
  })

  it('未实名：发布被拦截（弹手机号验证），不发请求，内容保留', async () => {
    signIn({ phone: false })
    const r = render(<TopicNew />)
    await flush()
    fill(r)
    click(r, PUBLISH_TEXT)
    await flush()
    expect(useUserStore.getState().phoneSheetOpen).toBe(true)
    expect(calls('createTopic')).toHaveLength(0)
    expect(field(r, 'Textarea', '正文').props.value).toBe(BODY)
  })

  it('没读过社区公约：先进公约页，不发请求', async () => {
    signIn()
    ;(Taro as any).__storage.clear()
    const r = render(<TopicNew />)
    await flush()
    fill(r)
    click(r, PUBLISH_TEXT)
    await flush()
    expect(Taro.navigateTo).toHaveBeenCalledWith({ url: '/pkg-user/pages/agreement/index?type=rules&mode=gate' })
    expect(calls('createTopic')).toHaveLength(0)
  })

  it('禁言中：云端拒绝，提示禁言', async () => {
    signIn()
    mockControl.setAccount({ mutedUntil: Date.now() + 86400000 })
    const r = render(<TopicNew />)
    await flush()
    fill(r)
    click(r, PUBLISH_TEXT)
    await flush()
    expect(has(r, '账号禁言中，暂时不能发布')).toBe(true)
  })
})

describe('话题详情（FE-M3-03）', () => {
  it('正文 + 标签 + 作者；别人的话题只有「举报」，没有「删除」', async () => {
    signIn()
    const id = seedTopic({ title: '静坐走神怎么办', tags: ['冥想', '呼吸'], authorName: '松声' })
    const r = await openTopic(id)
    expect(texts(r)).toEqual(expect.arrayContaining(['静坐走神怎么办', BODY, '#冥想', '#呼吸', '松声', '静观练习']))
    expect(labelled(r, A11Y.reportTopic)).toHaveLength(1)
    expect(labelled(r, A11Y.deleteTopic)).toHaveLength(0)
    expect(calls('getTopic')[0].data).toEqual({ id })
    click(r, '圈子：静观练习')
    expect(Taro.navigateTo).toHaveBeenCalledWith({ url: '/pkg-community/pages/circle/index?id=circle-mindful' })
  })

  it('圈内话题：非成员或圈子已关闭时沿用统一不存在文案，且不加载回复', async () => {
    signIn()
    const nonMemberId = seedTopic({ title: '非成员不可见', circleId: 'circle-mindful' })
    mockControl.setMemberships([])
    const nonMember = await openTopic(nonMemberId)
    expect(has(nonMember, NOT_FOUND_TEXT)).toBe(true)
    expect(calls('listReplies')).toHaveLength(0)

    act(() => {
      mockControl.seedCircles([{ id: 'circle-mindful', slug: 'mindful', name: '静观练习', status: 'closed' }])
      mockControl.seedTopics([{ title: '关闭圈子话题', body: BODY, circleId: 'circle-mindful' }])
      ;(Taro as any).__routerParams = { id: mockControl.topics[mockControl.topics.length - 1].id }
    })
    const closedId = (Taro as any).__routerParams.id as string
    const closed = await openTopic(closedId)
    expect(has(closed, NOT_FOUND_TEXT)).toBe(true)
    expect(calls('listReplies')).toHaveLength(0)
  })

  it('匿名话题：只有「匿名·代号」；自己的匿名话题带「我」', async () => {
    signIn()
    const other = await openTopic(seedTopic({ anon: true, authorName: '云眠' }))
    expect(has(other, '匿名·云眠')).toBe(true)
    expect(has(other, '林然')).toBe(false)
    const mine = await openTopic(seedTopic({ anon: true, mine: true }))
    expect(has(mine, '匿名·竹影')).toBe(true)
    expect(has(mine, '我')).toBe(true)
  })

  it('话题不存在 / 已下架 / 别人的待审：统一提示，不暴露原因', async () => {
    signIn()
    expect(has(await openTopic('nope'), NOT_FOUND_TEXT)).toBe(true)
    expect(has(await openTopic(seedTopic({ status: 'removed' })), NOT_FOUND_TEXT)).toBe(true)
    expect(has(await openTopic(seedTopic({ status: 'pending' })), NOT_FOUND_TEXT)).toBe(true)
  })

  it('我的待审话题：标明「审核中」，不能回复', async () => {
    signIn()
    const r = await openTopic(seedTopic({ status: 'pending', mine: true }))
    expect(has(r, PENDING_NOTE)).toBe(true)
    expect(hosts(r, n => n.type === 'Textarea')).toHaveLength(0)
  })

  it('被举报折叠的话题：不显示正文，不能回复', async () => {
    signIn()
    const r = await openTopic(seedTopic({ status: 'folded' }))
    expect(has(r, FOLDED_NOTE)).toBe(true)
    expect(has(r, BODY)).toBe(false)
    expect(hosts(r, n => n.type === 'Textarea')).toHaveLength(0)
  })

  it('简短回复折叠成「展开 N 条简短回复」，点开后显示；长回复不折叠', async () => {
    signIn()
    const id = seedTopic({ authorName: '林然' })
    mockControl.seedReplies([
      { topicId: id, body: '赞同', authorName: '松声' },
      { topicId: id, body: '同感', authorName: '云眠' },
      { topicId: id, body: long('我也有过这样的阶段，后来把注意力放回脚底的感觉'), authorName: '溪语' },
      { topicId: id, body: '谢谢', authorName: '石径' }
    ])
    const r = await openTopic(id)
    expect(has(r, foldLabel(2))).toBe(true)
    expect(has(r, foldLabel(1))).toBe(true)
    expect(has(r, '赞同')).toBe(false)
    expect(has(r, '谢谢')).toBe(false)
    expect(has(r, long('我也有过这样的阶段，后来把注意力放回脚底的感觉'))).toBe(true)
    click(r, foldLabel(2))
    expect(has(r, '赞同')).toBe(true)
    expect(has(r, '同感')).toBe(true)
    expect(has(r, '谢谢')).toBe(false)
  })

  it('引用：显示被引用回复的作者与摘要；被引用的回复不可见时只提示不可见', async () => {
    signIn()
    const id = seedTopic()
    mockControl.seedReplies([{ topicId: id, body: long('我会先做三次深呼吸再开始，走神了也不责怪自己'), authorName: '松声' }])
    const quoted = mockControl.replies[0].id
    mockControl.seedReplies([{ topicId: id, body: long('这个办法对我也有用，谢谢你分享'), authorName: '云眠', quoteId: quoted }])
    mockControl.seedReplies([{ topicId: id, body: long('看到引用的回复已经被删除了'), authorName: '溪语', quoteId: 'gone' }])
    const r = await openTopic(id)
    expect(texts(r).some(t => t.startsWith('松声：我会先做三次深呼吸'))).toBe(true)
    expect(has(r, QUOTE_GONE)).toBe(true)
  })

  it('被举报折叠的回复保留位置、不显示正文', async () => {
    signIn()
    const id = seedTopic()
    mockControl.seedReplies([{ topicId: id, body: long('SECRET 违规内容'), authorName: '松声', status: 'folded' }])
    const r = await openTopic(id)
    expect(has(r, FOLDED_NOTE)).toBe(true)
    expect(texts(r).some(t => t.includes('SECRET'))).toBe(false)
  })

  it('回复：提交 → 提示已发布 → 列表出现，输入框清空，回复数 +1', async () => {
    signIn()
    const id = seedTopic()
    const r = await openTopic(id)
    expect(has(r, '回复 0')).toBe(true)
    typeInto(r, 'Textarea', '回复内容', '说得很有道理')
    click(r, SEND_TEXT)
    await flush()
    expect(calls('createReply')[0].data).toEqual({ topicId: id, body: '说得很有道理', anon: false })
    expect(toastTitles()).toContain(REPLY_SENT)
    expect(has(r, '说得很有道理')).toBe(true) // 自己发的简短回复不折叠
    expect(has(r, '回复 1')).toBe(true)
    expect(field(r, 'Textarea', '回复内容').props.value).toBe('')
  })

  it('引用回复：点「引用」出现引用条，发送带 quoteId，发送后清除；可取消引用', async () => {
    signIn()
    const id = seedTopic()
    mockControl.seedReplies([{ topicId: id, body: long('我会先做三次深呼吸再开始，走神了也不责怪自己'), authorName: '松声' }])
    const quoted = mockControl.replies[0].id
    const r = await openTopic(id)
    click(r, A11Y.quote('松声'))
    expect(texts(r).some(t => t.startsWith('引用 松声：我会先做三次深呼吸'))).toBe(true)
    click(r, '取消引用')
    expect(texts(r).some(t => t.startsWith('引用 松声：'))).toBe(false)
    click(r, A11Y.quote('松声'))
    typeInto(r, 'Textarea', '回复内容', '谢谢分享')
    click(r, SEND_TEXT)
    await flush()
    expect(calls('createReply')[0].data).toEqual({ topicId: id, body: '谢谢分享', anon: false, quoteId: quoted })
    expect(texts(r).some(t => t.startsWith('引用 松声：'))).toBe(false)
  })

  it('匿名回复：入参 anon: true；列表里自己的匿名回复显示「匿名·代号」与「我」', async () => {
    signIn()
    const r = await openTopic(seedTopic({ authorName: '松声' }))
    click(r, `${REPLY_ANON_LABEL}，已关闭`)
    typeInto(r, 'Textarea', '回复内容', '匿名说一句')
    click(r, SEND_TEXT)
    await flush()
    expect(calls('createReply')[0].data).toMatchObject({ anon: true })
    expect(has(r, '匿名·竹影')).toBe(true)
    expect(has(r, '我')).toBe(true)
    expect(has(r, '林然')).toBe(false)
  })

  it('回复机审：待复核提示「审核通过后展示」且标「审核中」；拒绝提示修改并保留输入', async () => {
    signIn()
    const r = await openTopic(seedTopic())
    typeInto(r, 'Textarea', '回复内容', '这条会被复核[review]')
    click(r, SEND_TEXT)
    await flush()
    expect(toastTitles()).toContain(REPLY_PENDING)
    expect(has(r, PENDING_NOTE)).toBe(true)
    typeInto(r, 'Textarea', '回复内容', '这条会被拒绝[reject]')
    click(r, SEND_TEXT)
    await flush()
    expect(has(r, '内容不符合社区公约，请修改后再发布')).toBe(true)
    expect(field(r, 'Textarea', '回复内容').props.value).toBe('这条会被拒绝[reject]')
  })

  it('回复当日额度用尽：提示上限，输入保留', async () => {
    signIn()
    const id = seedTopic()
    for (let i = 0; i < 20; i++) await createReply({ topicId: id, body: `第${i}条回复` })
    const r = await openTopic(id)
    typeInto(r, 'Textarea', '回复内容', '第 21 条')
    click(r, SEND_TEXT)
    await flush()
    expect(has(r, REPLY_LIMIT_TEXT)).toBe(true)
    expect(field(r, 'Textarea', '回复内容').props.value).toBe('第 21 条')
  })

  it('未实名回复：弹手机号验证，不发请求，输入保留', async () => {
    signIn({ phone: false })
    const r = await openTopic(seedTopic())
    typeInto(r, 'Textarea', '回复内容', '想说一句')
    click(r, SEND_TEXT)
    await flush()
    expect(useUserStore.getState().phoneSheetOpen).toBe(true)
    expect(calls('createReply')).toHaveLength(0)
    expect(field(r, 'Textarea', '回复内容').props.value).toBe('想说一句')
  })

  it('举报话题：先选原因再提交 → moderation.report', async () => {
    signIn()
    const id = seedTopic()
    const r = await openTopic(id)
    click(r, A11Y.reportTopic)
    expect(has(r, '举报话题')).toBe(true)
    click(r, '刷屏 / 广告')
    click(r, REPORT_SUBMIT)
    await flush()
    expect(calls('report')[0].data).toEqual({ targetType: 'topic', targetId: id, reason: 'spam' })
  })

  it('举报回复；自己的回复没有「举报」只有「删除」', async () => {
    signIn()
    const id = seedTopic()
    mockControl.seedReplies([
      { topicId: id, body: long('别人的回复'), authorName: '松声' },
      { topicId: id, body: long('我自己的回复'), mine: true }
    ])
    const replyId = mockControl.replies[0].id
    const r = await openTopic(id)
    expect(labelled(r, A11Y.reportReply)).toHaveLength(1)
    expect(labelled(r, A11Y.deleteReply)).toHaveLength(1)
    click(r, A11Y.reportReply)
    click(r, '人身攻击 / 骚扰')
    click(r, REPORT_SUBMIT)
    await flush()
    expect(calls('report')[0].data).toEqual({ targetType: 'reply', targetId: replyId, reason: 'abuse' })
  })

  it('删除我的回复：二次确认 → deleteMine → 从列表消失，回复数 −1；取消确认则不删', async () => {
    signIn()
    const id = seedTopic({ replyCount: 1 })
    const mine = long('我自己的回复')
    mockControl.seedReplies([{ topicId: id, body: mine, mine: true }])
    const replyId = mockControl.replies[0].id
    const r = await openTopic(id)
    ;(Taro.showModal as jest.Mock).mockResolvedValueOnce({ confirm: false })
    click(r, A11Y.deleteReply)
    await flush()
    expect(calls('deleteMine')).toHaveLength(0)
    expect(has(r, mine)).toBe(true)
    click(r, A11Y.deleteReply)
    await flush()
    expect(calls('deleteMine')[0].data).toEqual({ type: 'reply', id: replyId })
    expect(toastTitles()).toContain(DELETED_TEXT)
    expect(has(r, mine)).toBe(false)
    expect(has(r, '回复 0')).toBe(true)
  })

  it('删除我的话题：二次确认 → deleteMine → 返回；之后打开提示不存在', async () => {
    signIn()
    const id = seedTopic({ mine: true })
    const r = await openTopic(id)
    expect(labelled(r, A11Y.reportTopic)).toHaveLength(0)
    click(r, A11Y.deleteTopic)
    await flush()
    expect(calls('deleteMine')[0].data).toEqual({ type: 'topic', id })
    expect(Taro.switchTab).toHaveBeenCalledWith({ url: '/pages/index/index' })
    invalidate()
    expect(has(await openTopic(id), NOT_FOUND_TEXT)).toBe(true)
  })

  it('未同意 / 未确认 18+：引导，不发云端请求', async () => {
    ;(Taro as any).__routerParams = { id: 't1' }
    expect(has(render(<Topic />), '同意协议后可查看话题')).toBe(true)
    useUserStore.setState({ consent: 'agreed', adult: 'unknown' })
    expect(has(render(<Topic />), '确认年满 18 周岁后可查看话题')).toBe(true)
    await flush()
    expect(mockControl.calls).toHaveLength(0)
  })
})
