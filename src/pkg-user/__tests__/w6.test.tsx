/** 登录前验证（ParentGate，与 luming 相同）/ 设置页 / 清除本机数据 */
import { act, create, ReactTestRenderer } from 'react-test-renderer'
import Taro from '@tarojs/taro'
import { ParentGate, GATE_TITLE, GATE_WRONG } from '@/components'
import { newQuestion, checkAnswer, __resetGateForTest, COOLDOWN_MS } from '@/features/parent/gate'
import Settings, { CLEAR_TITLE } from '@/pkg-user/pages/settings/index'
import { mockControl } from '@/services/mock/client'
import { invalidate } from '@/hooks/requestCache'
import { useUserStore } from '@/store/user'
import { useSettingsStore } from '@/store/settings'
import { setItem, getItem, STORAGE_KEYS } from '@/utils/storage'

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const mounted: ReactTestRenderer[] = []
const render = (el: JSX.Element) => { let r!: ReactTestRenderer; act(() => { r = create(el) }); mounted.push(r); return r }
afterEach(() => { mounted.splice(0).forEach(r => act(() => r.unmount())) })
const hosts = (r: ReactTestRenderer, pred: (n: any) => boolean) => r.root.findAll(n => typeof n.type === 'string' && pred(n))
const texts = (r: ReactTestRenderer) => hosts(r, n => n.type === 'Text').map(n => String(n.props.children))
const click = (r: ReactTestRenderer, label: string) => act(() => { hosts(r, n => n.props.ariaLabel === label && typeof n.props.onClick === 'function')[0].props.onClick() })
const typeAnswer = (r: ReactTestRenderer, n: number) => { String(n).split('').forEach(d => click(r, d)); click(r, '确定') }
const question = (r: ReactTestRenderer) => {
  const m = /^(\d+) \+ (\d+) = \?$/.exec(texts(r).find(t => /\+/.test(t)) || '')
  return m ? Number(m[1]) + Number(m[2]) : NaN
}

beforeEach(() => {
  mockControl.reset()
  mockControl.latency = 0
  invalidate()
  ;(Taro as any).__storage.clear()
  useUserStore.setState({ consent: 'agreed', sheetOpen: false })
  useSettingsStore.setState({ settings: {} })
  __resetGateForTest()
  jest.clearAllMocks()
})

describe('家长验证', () => {
  it('题目：两位数、和 < 100、每次换题', () => {
    let seed = 0
    const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280)
    let prev = newQuestion(rand)
    for (let i = 0; i < 50; i++) {
      const q = newQuestion(rand, prev)
      expect(q.a).toBeGreaterThanOrEqual(10)
      expect(q.b).toBeLessThan(50)
      expect(q.answer).toBeLessThan(100)
      expect([q.a, q.b]).not.toEqual([prev.a, prev.b])
      prev = q
    }
  })
  it('连错 3 次冷却 30s，冷却期内正确答案也不通过', () => {
    const q = { a: 10, b: 10, answer: 20 }
    expect(checkAnswer(q, 1, 0)).toBe('wrong')
    expect(checkAnswer(q, 1, 0)).toBe('wrong')
    expect(checkAnswer(q, 1, 0)).toBe('cooldown')
    expect(checkAnswer(q, 20, COOLDOWN_MS - 1)).toBe('cooldown')
    expect(checkAnswer(q, 20, COOLDOWN_MS)).toBe('ok')
  })
  it('组件：答错提示且换题、不显示答案；答对 onPass', () => {
    const onPass = jest.fn()
    const r = render(<ParentGate open onPass={onPass} />)
    expect(texts(r)).toContain(GATE_TITLE)
    const ans = question(r)
    typeAnswer(r, ans + 1)
    expect(texts(r)).toContain(GATE_WRONG)
    expect(texts(r).join()).not.toContain(`= ${ans}`)
    typeAnswer(r, question(r))
    expect(onPass).toHaveBeenCalled()
  })
})

describe('设置 / 清除本机数据', () => {
  it('小程序端不显示账号区；清除按钮存在', () => {
    const r = render(<Settings />)
    expect(texts(r)).not.toContain('账号')
    expect(texts(r)).toContain(CLEAR_TITLE)
  })

  it('清除：确认后清本地设置与同意记录、回首页；不发云端请求', async () => {
    useSettingsStore.getState().patch({ demo: 1 })
    setItem(STORAGE_KEYS.consentAt, 123)
    ;(Taro.showModal as jest.Mock).mockResolvedValueOnce({ confirm: true })
    const r = render(<Settings />)
    click(r, CLEAR_TITLE)
    await flush()
    expect(useUserStore.getState().consent).toBe('unknown')
    expect(useSettingsStore.getState().settings).toEqual({})
    expect(getItem(STORAGE_KEYS.consentAt)).toBeUndefined()
    expect(Taro.reLaunch).toHaveBeenCalledWith({ url: '/pages/index/index' })
    expect(mockControl.calls).toHaveLength(0)
  })

  it('清除：取消则不动', async () => {
    ;(Taro.showModal as jest.Mock).mockResolvedValueOnce({ confirm: false })
    const r = render(<Settings />)
    click(r, CLEAR_TITLE)
    await flush()
    expect(useUserStore.getState().consent).toBe('agreed')
    expect(Taro.reLaunch).not.toHaveBeenCalled()
  })
})
