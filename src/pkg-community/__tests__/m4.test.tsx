/** M4 前端：圈子目录 / 详情、邀请码兑换与签发、分享 / 复制、「我的」入口。 */
import { act, create, ReactTestRenderer } from 'react-test-renderer'
import Taro from '@tarojs/taro'
import { ReportSheet, REPORT_SUBMIT } from '@/components'
import Circles, { OTHER_CIRCLES_TITLE, MY_CIRCLES_TITLE } from '@/pkg-community/pages/circles'
import CirclePage, { CIRCLE_MEMBER_HINT } from '@/pkg-community/pages/circle'
import JoinCircle, { JOIN_ACTION } from '@/pkg-community/pages/join-circle'
import Invites, { copyInviteToClipboard, inviteCopyText, inviteSharePayload } from '@/pkg-community/pages/invites'
import Mine from '@/pages/mine'
import { markRulesRead } from '@/features/consent/rules'
import { mockControl } from '@/services/mock/client'
import { invalidate } from '@/hooks/requestCache'
import { useUserStore } from '@/store/user'
import type { Invite } from '@/types/models'

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const mounted: ReactTestRenderer[] = []
const render = (el: JSX.Element) => { let r!: ReactTestRenderer; act(() => { r = create(el) }); mounted.push(r); return r }
const unmountRenderer = (r: ReactTestRenderer) => { act(() => r.unmount()); const i = mounted.indexOf(r); if (i >= 0) mounted.splice(i, 1) }
afterEach(() => { mounted.splice(0).forEach(r => act(() => r.unmount())) })
const hosts = (r: ReactTestRenderer, pred: (n: any) => boolean) => r.root.findAll(n => typeof n.type === 'string' && pred(n))
const texts = (r: ReactTestRenderer) => hosts(r, n => n.type === 'Text').map(n => String(n.props.children))
const has = (r: ReactTestRenderer, s: string) => texts(r).includes(s)
const labelled = (r: ReactTestRenderer, label: string) => hosts(r, n => n.props.ariaLabel === label && typeof n.props.onClick === 'function')
const click = (r: ReactTestRenderer, label: string) => act(() => { labelled(r, label)[0].props.onClick() })
const input = (r: ReactTestRenderer, label: string) => hosts(r, n => n.type === 'Input' && n.props.ariaLabel === label)[0]
const calls = (action: string) => mockControl.calls.filter(c => c.action === action)
const ACCOUNT = { phoneVerified: true, adult: true, role: 'user' as const, bannedUntil: null, mutedUntil: null }
const BODY = '静坐时总是走神，试了数呼吸也很难坚持，想听听大家的经验。'.repeat(3)

function signIn () {
  useUserStore.setState({ consent: 'agreed', adult: 'confirmed', account: { ...ACCOUNT } })
  mockControl.setAccount({ adult: true, phoneVerified: true })
  markRulesRead()
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

describe('圈子页面（FE-M4-01）', () => {
  it('圈子目录区分已加入与其他开放圈子；卡片可进详情或输入邀请码；有单页快照', async () => {
    signIn()
    mockControl.seedCircles([
      { id: 'circle-mindful', slug: 'mindful', name: '静观练习', desc: '练习分享', sort: 1 },
      { id: 'circle-tradition', slug: 'tradition', name: '传统养生', desc: '日常养生', sort: 2 }
    ])
    mockControl.setMemberships(['circle-mindful'])
    const r = render(<Circles />)
    await flush()
    expect(has(r, MY_CIRCLES_TITLE)).toBe(true)
    expect(has(r, OTHER_CIRCLES_TITLE)).toBe(true)
    expect(has(r, '静观练习')).toBe(true)
    expect(has(r, '传统养生')).toBe(true)
    expect(has(r, '已加入')).toBe(true)
    click(r, '查看圈子：传统养生')
    expect(Taro.navigateTo).toHaveBeenCalledWith({ url: '/pkg-community/pages/circle/index?id=circle-tradition' })
    expect(r.toJSON()).toMatchSnapshot()
  })

  it('非成员可以阅读简介与公约，但不会请求圈内话题；成员可加载话题流', async () => {
    signIn()
    mockControl.seedCircles([{ id: 'circle-mindful', slug: 'mindful', name: '静观练习', desc: '冥想练习', rules: ['尊重彼此的练习节奏。'] }])
    mockControl.setMemberships([])
    mockControl.seedTopics([{ title: '不应显示的话题', body: BODY, circleId: 'circle-mindful' }])
    ;(Taro as any).__routerParams = { id: 'circle-mindful' }
    const r = render(<CirclePage />)
    await flush()
    expect(has(r, '冥想练习')).toBe(true)
    expect(has(r, '尊重彼此的练习节奏。')).toBe(true)
    expect(has(r, CIRCLE_MEMBER_HINT)).toBe(true)
    expect(has(r, '不应显示的话题')).toBe(false)
    expect(calls('listTopics')).toHaveLength(0)

    unmountRenderer(r)
    mockControl.reset()
    mockControl.latency = 0
    invalidate()
    act(() => signIn())
    mockControl.seedTopics([{ title: '成员可见话题', body: BODY }])
    ;(Taro as any).__routerParams = { id: 'circle-mindful' }
    const member = render(<CirclePage />)
    await flush()
    expect(has(member, '成员可见话题')).toBe(true)
    expect(calls('listTopics').length).toBeGreaterThan(0)
  })
})

describe('邀请码兑换与签发（FE-M4-01）', () => {
  it('分享链接只预填并格式化邀请码，不会自动兑换；确认后才入圈并打开圈子详情', async () => {
    signIn()
    mockControl.setMemberships([])
    mockControl.seedInvites([{ code: 'ABCD2345', circleId: 'circle-mindful' }])
    ;(Taro as any).__routerParams = { code: 'abcd-2345' }
    const r = render(<JoinCircle />)
    await flush()
    expect(input(r, '邀请码').props.value).toBe('ABCD 2345')
    expect(calls('redeemInvite')).toHaveLength(0)
    click(r, JOIN_ACTION)
    await flush()
    expect(calls('redeemInvite').map(c => c.data)).toEqual([{ code: 'ABCD2345' }])
    expect(mockControl.memberships.some(m => m.circleId === 'circle-mindful')).toBe(true)
    expect(Taro.navigateTo).toHaveBeenCalledWith({ url: '/pkg-community/pages/circle/index?id=circle-mindful' })
  })

  it('邀请码格式错误显示本地校验；签发后展示名额、圈子、状态，并从分享按钮目标选中对应码', async () => {
    signIn()
    const r = render(<Invites />)
    await flush()
    expect(has(r, '剩余 3 个邀请码')).toBe(true)
    click(r, '生成邀请码')
    await flush()
    expect(calls('createInvite')).toHaveLength(1)
    expect(has(r, '剩余 2 个邀请码')).toBe(true)
    expect(has(r, '0000 0001')).toBe(true)
    expect(has(r, '可使用')).toBe(true)
    const shared = (Taro as any).__shareAppMessage({ target: { dataset: { code: '00000001' } } })
    expect(shared).toEqual({ title: '邀请你加入「静观练习」', path: '/pkg-community/pages/join-circle/index?code=00000001' })

    ;(Taro as any).__routerParams = {}
    const bad = render(<JoinCircle />)
    await flush()
    click(bad, JOIN_ACTION)
    expect(has(bad, '邀请码为 8 位')).toBe(true)
    expect(calls('redeemInvite')).toHaveLength(0)
  })

  it('App / H5 复制完整邀请文案（邀请码每四位分组）', async () => {
    const invite: Invite = {
      code: 'ABCD2345',
      circle: { id: 'circle-mindful', name: '静观练习' },
      status: 'active',
      createdAt: 1,
      expiresAt: 2,
      usedAt: null
    }
    expect(inviteCopyText(invite)).toBe('「静观练习」邀请码 ABCD 2345，7 天内有效。在结灵子「我的 → 邀请码」里输入。')
    expect(inviteSharePayload(invite)).toEqual({ title: '邀请你加入「静观练习」', path: '/pkg-community/pages/join-circle/index?code=ABCD2345' })
    await copyInviteToClipboard(invite)
    expect(Taro.setClipboardData).toHaveBeenCalledWith({ data: inviteCopyText(invite) })
  })
})

describe('举报圈内内容的成员门禁', () => {
  it('举报用户时按 contentType 找到其回复；非圈子成员看不到目标，成员可举报', async () => {
    signIn()
    mockControl.seedTopics([{ title: '圈内话题', body: BODY }])
    const topicId = mockControl.topics[mockControl.topics.length - 1].id
    mockControl.seedReplies([{ topicId, body: BODY, authorName: '松声' }])
    const replyId = mockControl.replies[mockControl.replies.length - 1].id
    mockControl.setMemberships([])

    const nonMember = render(<ReportSheet open target={{ targetType: 'user', targetId: replyId, contentType: 'reply' }} onClose={() => {}} />)
    click(nonMember, '人身攻击 / 骚扰')
    click(nonMember, REPORT_SUBMIT)
    await flush()
    expect(calls('report')).toHaveLength(1)
    expect(mockControl.reports).toHaveLength(0)

    mockControl.setMemberships(['circle-mindful'])
    const member = render(<ReportSheet open target={{ targetType: 'user', targetId: replyId, contentType: 'reply' }} onClose={() => {}} />)
    click(member, '人身攻击 / 骚扰')
    click(member, REPORT_SUBMIT)
    await flush()
    expect(mockControl.reports).toHaveLength(1)
    expect(mockControl.reports[0]).toMatchObject({ targetType: 'user', targetId: replyId, contentType: 'reply' })
  })
})

describe('「我的」M4 入口', () => {
  it('我的圈子与邀请码入口可用；剩余名额异步取得', async () => {
    signIn()
    const r = render(<Mine />)
    await flush()
    expect(has(r, '我的圈子')).toBe(true)
    expect(has(r, '邀请码（剩余 3）')).toBe(true)
    click(r, '我的圈子')
    expect(Taro.navigateTo).toHaveBeenCalledWith({ url: '/pkg-community/pages/circles/index' })
    click(r, '邀请码（剩余 3）')
    expect(Taro.navigateTo).toHaveBeenCalledWith({ url: '/pkg-community/pages/invites/index' })
  })
})
