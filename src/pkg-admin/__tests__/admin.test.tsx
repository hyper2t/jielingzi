/** FE-M2-02 审核页（仅 mod / admin）+ FE-M2-03 首次发布前公约阅读页 + 「我的」审核入口 */
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
