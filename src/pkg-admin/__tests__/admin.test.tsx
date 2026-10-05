/** FE-M2-02 审核页（仅 mod / admin）+ FE-M2-03 首次发布前公约阅读页 + 「我的」审核入口
 * 精华入口的用例编号登记在 docs/test/cases/M6.md（M6-A18，QA-M6-02）。 */
import { act, create, ReactTestRenderer } from 'react-test-renderer'
import Taro from '@tarojs/taro'
import AdminQueue, { NO_PERMISSION, PASS_LABEL, QUEUE_EMPTY } from '@/pkg-admin/pages/queue/index'
import Agreement, { RULES_ACK } from '@/pkg-user/pages/agreement/index'
import Mine, { ADMIN_ENTRY } from '@/pages/mine/index'
import { isRulesRead } from '@/features/consent/rules'
import { mockControl } from '@/services/mock/client'
import { invalidate } from '@/hooks/requestCache'
import { useUserStore } from '@/store/user'

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const mounted: ReactTestRenderer[] = []
const render = (el: JSX.Element) => { let r!: ReactTestRenderer; act(() => { r = create(el) }); mounted.push(r); return r }
afterEach(() => { mounted.splice(0).forEach(r => act(() => r.unmount())) })
const hosts = (r: ReactTestRenderer, pred: (n: any) => boolean) => r.root.findAll(n => typeof n.type === 'string' && pred(n))
const texts = (r: ReactTestRenderer) => hosts(r, n => n.type === 'Text').map(n => String(n.props.children))
const click = (r: ReactTestRenderer, label: string) => act(() => { hosts(r, n => n.props.ariaLabel === label && typeof n.props.onClick === 'function')[0].props.onClick() })
const STATUS = { phoneVerified: true, adult: true, bannedUntil: null, mutedUntil: null }

beforeEach(() => {
  mockControl.reset()
  mockControl.latency = 0
  invalidate()
  ;(Taro as any).__storage.clear()
  ;(Taro as any).__routerParams = {}
  useUserStore.setState({ consent: 'agreed', adult: 'confirmed', account: { ...STATUS, role: 'user' } })
  jest.clearAllMocks()
})

describe('审核页（FE-M2-02）', () => {
  it('普通用户：显示仅审核员可访问，不请求队列', async () => {
    const r = render(<AdminQueue />)
    await flush()
    expect(texts(r)).toContain(NO_PERMISSION)
    expect(mockControl.calls).toHaveLength(0)
  })

  it('本机以为是 mod 但云端不是：40301 → 仅审核员可访问', async () => {
    useUserStore.setState({ account: { ...STATUS, role: 'mod' } })
    const r = render(<AdminQueue />)
    await flush()
    expect(mockControl.calls.map(c => c.action).sort()).toEqual(['mediaQueue', 'queue'])
    expect(texts(r)).toContain(NO_PERMISSION)
  })

  it('mod：按目标聚合展示人数 / 原因 / 说明；删除二次确认后调 decide 并刷新；禁言选择天数', async () => {
    useUserStore.setState({ account: { ...STATUS, role: 'mod' } })
    mockControl.setAccount({ role: 'mod', adult: true })
    mockControl.seedReports([
      { targetType: 'topic', targetId: 't1', reason: 'medical', by: 'u1', note: '说能治病' },
      { targetType: 'topic', targetId: 't1', reason: 'spam', by: 'u2' },
      { targetType: 'reply', targetId: 'r1', reason: 'abuse', by: 'u1' }
    ])
    const r = render(<AdminQueue />)
    await flush()
    expect(texts(r)).toEqual(expect.arrayContaining(['话题 · 2 人举报', '疗效承诺 / 劝人停药 ×1；刷屏 / 广告 ×1', '“说能治病”', '回复 · 1 人举报']))
    click(r, '删除')
    await flush()
    expect(Taro.showModal).toHaveBeenCalled()
    expect(mockControl.calls.find(c => c.action === 'decide')?.data).toEqual({ targetType: 'topic', targetId: 't1', contentType: 'topic', decision: 'remove' })
    expect(texts(r)).not.toContain('话题 · 2 人举报')
    click(r, '禁言')
    click(r, '禁言 7 天')
    await flush()
    expect(mockControl.calls.filter(c => c.action === 'decide').pop()?.data).toEqual({ targetType: 'reply', targetId: 'r1', contentType: 'reply', decision: 'mute', days: 7 })
    expect(texts(r)).toContain(QUEUE_EMPTY)
  })
})

describe('机审待复核的内容（M3）', () => {
  it('pending 条目显示「待审」与「通过」（调 dismiss 放行），不再显示「驳回」；放行后话题恢复可见', async () => {
    useUserStore.setState({ account: { ...STATUS, role: 'mod' } })
    mockControl.setAccount({ role: 'mod', adult: true })
    mockControl.seedTopics([{ title: '待复核的话题', body: '正文'.repeat(30), status: 'pending', authorName: '松声' }])
    const id = mockControl.topics[0].id
    mockControl.seedReports([{ targetType: 'topic', targetId: id, reason: 'other', by: 'system' }])
    const r = render(<AdminQueue />)
    await flush()
    expect(texts(r)).toContain('待审')
    expect(hosts(r, n => n.props.ariaLabel === '驳回')).toHaveLength(0)
    ;(Taro.showModal as jest.Mock).mockClear()
    click(r, PASS_LABEL)
    await flush()
    expect((Taro.showModal as jest.Mock).mock.calls[0][0].content).toContain('通过这条待审内容')
    expect(mockControl.calls.find(c => c.action === 'decide')?.data).toEqual({ targetType: 'topic', targetId: id, contentType: 'topic', decision: 'dismiss' })
    expect(mockControl.topics[0].status).toBe('ok')
    expect(texts(r)).toContain(QUEUE_EMPTY)
  })

  it('取消确认不调 decide', async () => {
    useUserStore.setState({ account: { ...STATUS, role: 'mod' } })
    mockControl.setAccount({ role: 'mod', adult: true })
    mockControl.seedTopics([{ title: '待复核的话题', body: '正文'.repeat(30), status: 'pending' }])
    mockControl.seedReports([{ targetType: 'topic', targetId: mockControl.topics[0].id, reason: 'other', by: 'system' }])
    const r = render(<AdminQueue />)
    await flush()
    ;(Taro.showModal as jest.Mock).mockResolvedValueOnce({ confirm: false })
    click(r, PASS_LABEL)
    await flush()
    expect(mockControl.calls.some(c => c.action === 'decide')).toBe(false)
    expect(mockControl.topics[0].status).toBe('pending')
  })
})

describe('首次发布前阅读社区公约（FE-M2-03）', () => {
  it('mode=gate 时底部「我已阅读并遵守」：记本机已读并返回；普通查看没有这个按钮', () => {
    ;(Taro as any).__routerParams = { type: 'rules', mode: 'gate' }
    const r = render(<Agreement />)
    expect(texts(r)).toContain('社区公约')
    click(r, RULES_ACK)
    expect(isRulesRead()).toBe(true)
    expect((Taro.navigateBack as jest.Mock).mock.calls.length + (Taro.switchTab as jest.Mock).mock.calls.length).toBe(1)
    ;(Taro as any).__routerParams = { type: 'rules' }
    const plain = render(<Agreement />)
    expect(hosts(plain, n => n.props.ariaLabel === RULES_ACK)).toHaveLength(0)
  })
})

describe('「我的」审核入口', () => {
  it('只对 mod / admin 显示，点击进入审核页', async () => {
    const r = render(<Mine />)
    await flush()
    expect(texts(r)).not.toContain(ADMIN_ENTRY)
    act(() => useUserStore.setState({ account: { ...STATUS, role: 'admin' } }))
    click(r, ADMIN_ENTRY)
    expect(Taro.navigateTo).toHaveBeenLastCalledWith({ url: '/pkg-admin/pages/queue/index' })
  })
})
describe('审核页的精华入口（QA-M6-02）', () => {
  const seed = (extra: Record<string, unknown> = {}) => {
    useUserStore.setState({ account: { ...STATUS, role: 'mod' } })
    mockControl.setAccount({ role: 'mod', adult: true })
    mockControl.seedTopics([{ title: '值得反复看的话题', body: '正文'.repeat(30), status: 'ok', ...extra }])
    const id = mockControl.topics[0].id
    mockControl.seedReports([{ targetType: 'topic', targetId: id, contentType: 'topic', reason: 'other', by: 'u1' }])
    return id
  }
  const featured = () => mockControl.topics[0].featured
  const sent = () => mockControl.calls.filter(c => c.action === 'markFeatured').map(c => c.data)
  const toasts = () => (Taro.showToast as jest.Mock).mock.calls.map((c: any) => c[0].title)
  const danger = (r: any) => hosts(r, n => String((n.props as any).className || '').includes('text-danger')).length

  it('ok 话题给「标为精华」：确认后调 markFeatured(true)、提示已标记，行内按钮翻成「取消精华」', async () => {
    const id = seed()
    const r = render(<AdminQueue />)
    await flush()
    expect(texts(r)).toContain('标为精华')
    ;(Taro.showModal as jest.Mock).mockClear()
    click(r, '标为精华')
    await flush()
    expect((Taro.showModal as jest.Mock).mock.calls[0][0].content).toContain('只加标记，不改变可见性与状态')
    expect(sent()).toEqual([{ topicId: id, featured: true }])
    expect(featured()).toBe(true)
    expect(toasts()).toContain('已标为精华')
    expect(texts(r)).toContain('取消精华')
    expect(texts(r)).not.toContain('标为精华')
  })

  it('已是精华的行只显示「取消精华」，点了带 featured:false', async () => {
    const id = seed({ featured: true })
    const r = render(<AdminQueue />)
    await flush()
    expect(texts(r)).not.toContain('标为精华')
    click(r, '取消精华')
    await flush()
    expect(sent()).toEqual([{ topicId: id, featured: false }])
    expect(featured()).toBe(false)
    expect(toasts()).toContain('已取消精华')
  })

  it('回复条目与待审话题不给「标为精华」；曾标精华但已删除的行仍可撤销（D12 只限制标、不限制撤）', async () => {
    const id = seed()
    mockControl.seedReplies([{ topicId: id, body: '这条回复也被举报了' }])
    mockControl.seedTopics([{ title: '待审的', body: '正文'.repeat(30), status: 'pending' }])
    const pendingId = mockControl.topics[1].id
    mockControl.seedTopics([{ title: '被删的精华', body: '正文'.repeat(30), status: 'removed', featured: true }])
    mockControl.seedReports([
      { targetType: 'topic', targetId: mockControl.topics[2].id, contentType: 'topic', reason: 'other', by: 'u4' },
      { targetType: 'reply', targetId: mockControl.replies[0].id, contentType: 'reply', reason: 'abuse', by: 'u2' },
      { targetType: 'topic', targetId: pendingId, contentType: 'topic', reason: 'other', by: 'u3' },
    ])
    const r = render(<AdminQueue />)
    await flush()
    expect((texts(r).filter(t => t === '标为精华')).length).toBe(0)
    expect(texts(r)).toContain('待审')
    expect((texts(r).filter(t => t === '取消精华')).length).toBe(1)
  })

  it('点下去时话题已经没了（队列里是兜底快照）：云端 40401，页面不假装成功、可以重试', async () => {
    useUserStore.setState({ account: { ...STATUS, role: 'mod' } })
    mockControl.setAccount({ role: 'mod', adult: true })
    mockControl.seedReports([{ targetType: 'topic', targetId: 'ghost-topic', contentType: 'topic', reason: 'other', by: 'u1' }])
    const r = render(<AdminQueue />)
    await flush()
    expect(texts(r)).toContain('标为精华')
    click(r, '标为精华')
    await flush()
    expect(sent()).toEqual([{ topicId: 'ghost-topic', featured: true }])
    expect(mockControl.topics).toHaveLength(0)
    expect(toasts()).not.toContain('已标为精华')
    expect(danger(r)).toBeGreaterThan(0)
    expect(r.root.findAll(n => typeof n.type !== 'string' && (n.props as any).label === '标为精华').length).toBe(1)
  })

  it('未同意协议时点标精华：一个请求都不发（写动作门禁）', async () => {
    seed()
    const r = render(<AdminQueue />)
    await flush()
    const before = mockControl.calls.length
    useUserStore.setState({ consent: 'unknown' })
    click(r, '标为精华')
    await flush()
    expect(mockControl.calls.slice(before).filter((c: any) => c.action === 'markFeatured')).toHaveLength(0)
    expect(featured()).toBe(false)
    expect(toasts()).not.toContain('已标为精华')
    expect(danger(r)).toBeGreaterThan(0)
  })

  it('请求飞行中按钮禁用，连点两次只发一次请求', async () => {
    seed()
    mockControl.latency = 300
    const r = render(<AdminQueue />)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 420)) })
    expect(texts(r)).toContain('标为精华')
    click(r, '标为精华')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    const btnProps = () => (r.root.findAll(n => typeof n.type !== 'string' && (n.props as any).label === '标为精华')[0] as any).props
    expect(btnProps().disabled).toBe(true)
    click(r, '标为精华')
    expect(mockControl.calls.filter(c => c.action === 'markFeatured')).toHaveLength(1)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 520)) })
    expect(mockControl.calls.filter(c => c.action === 'markFeatured')).toHaveLength(1)
    expect(featured()).toBe(true)
    mockControl.latency = 0
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)) })
  })

  it('取消确认就不发请求（与删除 / 驳回一致）', async () => {
    seed()
    const r = render(<AdminQueue />)
    await flush()
    ;(Taro.showModal as jest.Mock).mockResolvedValueOnce({ confirm: false })
    click(r, '标为精华')
    await flush()
    expect(mockControl.calls.some(c => c.action === 'markFeatured')).toBe(false)
    expect(featured()).toBe(false)
  })
})
