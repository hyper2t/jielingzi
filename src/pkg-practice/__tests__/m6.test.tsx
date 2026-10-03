/**
 * FE-M6-01：练习 Tab 的「每日一题」卡片与作答页（走 mock 云端）。
 * 覆盖：无题目不渲染、状态机（未作答 / 已作答 / 审核中）、默认匿名、前端校验不发请求、
 * 「未作答时不请求 listAnswers」、他人答案只渲染可见条目、分页「查看更多」、40901 与 42901 的提示。
 */
import Taro from '@tarojs/taro'
import { act, create, ReactTestRenderer } from 'react-test-renderer'
import PromptCard from '@/features/practice/PromptCard'
import { PROMPT_RULES } from '@/constants/community'
import { MOCK_REVIEW_MARK, mockControl } from '@/services/mock/client'
import { invalidate } from '@/hooks/requestCache'
import { markRulesRead } from '@/features/consent/rules'
import { answerPrompt } from '@/services/practice'
import { useUserStore } from '@/store/user'
import PromptAnswerPage from '@/pkg-practice/pages/prompt/index'

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const QUESTION = '今天你想放下的一件小事是什么'
const GOOD = '想把睡前刷手机换成十分钟静坐'

const hosts = (r: ReactTestRenderer) => r.root.findAll(n => typeof n.type === 'string')
const texts = (r: ReactTestRenderer) => hosts(r).filter(n => String(n.type) === 'Text').map(n => String(n.props.children))
const clickByLabel = (r: ReactTestRenderer, label: string) => act(() => {
  const node = hosts(r).find(n => n.props.ariaLabel === label && typeof n.props.onClick === 'function')
  node?.props.onClick({})
})
const typeByLabel = (r: ReactTestRenderer, label: string, value: string) => act(() => {
  const node = hosts(r).find(n => n.props.ariaLabel === label && typeof n.props.onInput === 'function')
  node?.props.onInput({ detail: { value } })
})
const callsOf = (action: string) => mockControl.calls.filter((c: any) => c.action === action)
/** Toggle：整行可点，读屏标签带状态后缀，所以按 ariaRole 找 */
const clickSwitch = (r: ReactTestRenderer) => act(() => {
  const node = hosts(r).find(n => (n.props as any).ariaRole === 'switch')
  node?.props.onClick({})
})
/** 与 m3/m4 页面测试一致：发布门禁要读 store 里的 account.phoneVerified */
const ACCOUNT = { phoneVerified: true, adult: true, role: 'user' as const, bannedUntil: null, mutedUntil: null }

let mounted: ReactTestRenderer | null = null

beforeEach(() => {
  mockControl.reset()
  invalidate() // useRequest 有 5 分钟内存缓存，逐例清空才能看到各自的 mock 数据
  mockControl.latency = 0
  mockControl.setAccount({ adult: true, phoneVerified: true })
  ;(Taro as any).__storage.clear()
  ;(Taro as any).__routerParams = {}
  markRulesRead() // 发布类动作要求「已读社区公约」，与 m3 测试一致
  useUserStore.setState({ consent: 'agreed', adult: 'confirmed', account: { ...ACCOUNT }, auth: { signedIn: true } })
  jest.clearAllMocks()
})

afterEach(() => {
  if (mounted) act(() => mounted?.unmount())
  mounted = null
})

describe('练习 Tab 的每日一题卡片', () => {
  it('当日没有题目（或门禁未过）时整块不渲染', async () => {
    act(() => { mounted = create(<PromptCard />) })
    await flush()
    expect(texts(mounted!)).not.toContain('每日一题')
    expect(callsOf('todayPrompt')).toHaveLength(1)
  })

  it('未作答：显示题目与「写下今天的回答」，并提示作答后可见他人回答', async () => {
    mockControl.seedPrompts([{ text: QUESTION }])
    act(() => { mounted = create(<PromptCard />) })
    await flush()
    const t = texts(mounted!)
    expect(t).toContain('每日一题')
    expect(t).toContain(QUESTION)
    expect(t).toContain(today)
    expect(t).toContain('写下今天的回答')
    expect(t).toContain('作答后可见其他人的回答')
    expect(t).not.toContain('已作答')
  })

  it('已作答：标记状态并改为「看看其他人的回答」，附作答人数', async () => {
    mockControl.seedPrompts([{ text: QUESTION }])
    await answerPrompt({ promptId: 'p1', text: GOOD })
    act(() => { mounted = create(<PromptCard />) })
    await flush()
    const t = texts(mounted!)
    expect(t).toContain('已作答')
    expect(t).toContain('看看其他人的回答')
    expect(t).toContain('1 条回答')
  })

  it('待复核：卡片显示「审核中」而不是「已作答」', async () => {
    mockControl.seedPrompts([{ text: QUESTION }])
    await answerPrompt({ promptId: 'p1', text: `${GOOD}${MOCK_REVIEW_MARK}` })
    act(() => { mounted = create(<PromptCard />) })
    await flush()
    const t = texts(mounted!)
    expect(t).toContain('审核中')
    expect(t).not.toContain('已作答')
    expect(t).toContain('看看其他人的回答')
  })

  it('卡片快照（未作答态）', async () => {
    // 快照里带「今天」的日期（mock 的 prompt.date 缺省取运行当天），不钉住时钟这条用例每天会红一次
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 3, 12, 0, 0))
    try {
      mockControl.seedPrompts([{ text: QUESTION }])
      act(() => { mounted = create(<PromptCard />) })
      await flush()
      expect(mounted!.toJSON()).toMatchSnapshot()
    } finally {
      nowSpy.mockRestore()
    }
  })
})

describe('每日一题作答页', () => {
  it('未作答时不请求答案列表，提交成功前只做本地校验', async () => {
    mockControl.seedPrompts([{ text: QUESTION }])
    ;(Taro as any).__routerParams = { promptId: 'p1', date: today }
    act(() => { mounted = create(<PromptAnswerPage />) })
    await flush()
    expect(callsOf('listAnswers')).toHaveLength(0)
    expect(texts(mounted!)).toContain('提交回答')

    // 字数不足：前端就拦住，不发请求
    typeByLabel(mounted!, '我的回答', '太短了')
    clickByLabel(mounted!, '提交回答')
    await flush()
    expect(callsOf('answerPrompt')).toHaveLength(0)
    expect(texts(mounted!).some(x => x.indexOf(`至少 ${PROMPT_RULES.answer.min} 个字`) >= 0)).toBe(true)
  })

  it('默认匿名：不碰开关也能提交，答案首尾空白被裁掉', async () => {
    mockControl.seedPrompts([{ text: QUESTION }])
    ;(Taro as any).__routerParams = { promptId: 'p1', date: today }
    act(() => { mounted = create(<PromptAnswerPage />) })
    await flush()
    typeByLabel(mounted!, '我的回答', `  ${GOOD}  `)
    clickByLabel(mounted!, '提交回答')
    await flush()
    expect(mockControl.promptAnswers).toHaveLength(1)
    expect(mockControl.promptAnswers[0]).toMatchObject({ promptId: 'p1', mine: true, status: 'ok', text: GOOD, anon: true, date: today })
    expect(callsOf('listAnswers')).toHaveLength(1)
    expect(texts(mounted!)).toContain('其他人的回答')
  })

  it('切到实名后提交：mock 与云端一致地记 anon=false', async () => {
    mockControl.seedPrompts([{ text: QUESTION }])
    ;(Taro as any).__routerParams = { promptId: 'p1', date: today }
    act(() => { mounted = create(<PromptAnswerPage />) })
    await flush()
    clickSwitch(mounted!)
    typeByLabel(mounted!, '我的回答', GOOD)
    clickByLabel(mounted!, '提交回答')
    await flush()
    expect(mockControl.promptAnswers[0].anon).toBe(false)
    expect((Taro.showToast as jest.Mock).mock.calls.map((c: any) => c[0].title)).toContain('已提交')
  })

  it('已作答：渲染他人可见答案（不含 pending / removed），并可「查看更多」翻页', async () => {
    mockControl.seedPrompts([{ text: QUESTION }])
    await answerPrompt({ promptId: 'p1', text: GOOD })
    // 21 条他人答案：默认每页 20 条，第二页要靠「查看更多」取
    mockControl.seedPromptAnswers([
      { text: '待复核的那条', anon: true, authorName: '云眠', status: 'pending' },
      { text: '已被处理的那条', anon: true, authorName: '溪语', status: 'removed' },
      ...Array.from({ length: 21 }, (_, i) => ({ text: `其他人的回答 ${i + 1}`, anon: i % 2 === 0, authorName: '松声' }))
    ])
    ;(Taro as any).__routerParams = { promptId: 'p1', date: today }
    act(() => { mounted = create(<PromptAnswerPage />) })
    await flush()
    const first = texts(mounted!)
    expect(first).toContain('其他人的回答 1')
    expect(first).toContain('匿名 · 松声')
    expect(first).not.toContain('待复核的那条')
    expect(first).not.toContain('已被处理的那条')
    expect(first).not.toContain('其他人的回答 21')
    expect(first).toContain('我的回答')
    expect(first).toContain(GOOD)

    clickByLabel(mounted!, '查看更多回答')
    await flush()
    expect(texts(mounted!)).toContain('其他人的回答 21')
    expect(callsOf('listAnswers').map((x: any) => x.data.page)).toEqual([1, 2])
  })

  it('重复作答（云端 40901）：给出「今天已经作答过了」并回读状态', async () => {
    mockControl.seedPrompts([{ text: QUESTION }])
    mockControl.seedPromptAnswers([{ text: '别人先答了', anon: true, authorName: '松声' }])
    await answerPrompt({ promptId: 'p1', text: GOOD })
    // 绕过 UI 直接重复提交，验证 mock 与云端同为 40901
    await expect(answerPrompt({ promptId: 'p1', text: '换一个说法再交一次' })).rejects.toMatchObject({ code: 40901 })
    ;(Taro as any).__routerParams = { promptId: 'p1', date: today }
    act(() => { mounted = create(<PromptAnswerPage />) })
    await flush()
    expect(texts(mounted!)).toContain('其他人的回答')
  })

  it('同日第二次作答（额度 42901）：提示明天再来', async () => {
    mockControl.seedPrompts([{ text: QUESTION }, { date: '2020-01-01', text: '另一天的题目' }])
    await answerPrompt({ promptId: 'p1', text: GOOD })
    await expect(answerPrompt({ promptId: 'p2', text: '再答一道别的题' })).rejects.toMatchObject({ code: 42901 })
  })

  it('机审拒绝：mock 与云函数同一句话，答案不落库', async () => {
    mockControl.seedPrompts([{ text: QUESTION }])
    ;(Taro as any).__routerParams = { promptId: 'p1', date: today }
    act(() => { mounted = create(<PromptAnswerPage />) })
    await flush()
    typeByLabel(mounted!, '我的回答', `${GOOD}[reject]`)
    clickByLabel(mounted!, '提交回答')
    await flush()
    expect(mockControl.promptAnswers).toHaveLength(0)
    expect(texts(mounted!).some(x => x.indexOf('社区公约') >= 0)).toBe(true)
  })
})
