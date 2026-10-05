/** FE-22：ConsentSheet / 协议页 / 我的页同意入口 */
import { act, create, ReactTestRenderer } from 'react-test-renderer'
import Taro from '@tarojs/taro'
import { ConsentSheet, CONSENT_TITLE } from '@/components'
import Agreement from '@/pkg-user/pages/agreement/index'
import Mine, { CONSENT_HINT } from '@/pages/mine/index'
import { mockControl } from '@/services/mock/client'
import { useUserStore } from '@/store/user'

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const mounted: ReactTestRenderer[] = []
const render = (el: JSX.Element) => { let r!: ReactTestRenderer; act(() => { r = create(el) }); mounted.push(r); return r }
afterEach(() => { mounted.splice(0).forEach(r => act(() => r.unmount())) })
const hosts = (r: ReactTestRenderer, pred: (n: any) => boolean) => r.root.findAll(n => typeof n.type === 'string' && pred(n))
const texts = (r: ReactTestRenderer) => hosts(r, n => n.type === 'Text').map(n => String(n.props.children))
const click = (r: ReactTestRenderer, label: string) =>
  act(() => { hosts(r, n => n.props.ariaLabel === label && typeof n.props.onClick === 'function')[0].props.onClick() })

beforeEach(() => {
  mockControl.reset()
  mockControl.latency = 0
  ;(Taro as any).__storage.clear()
  useUserStore.setState({ consent: 'unknown', sheetOpen: false, sheetReason: undefined, adult: 'unknown', account: null })
  jest.clearAllMocks()
})

describe('ConsentSheet', () => {
  it('首次（unknown）自动显示；协议可点开', () => {
    const r = render(<ConsentSheet />)
    expect(texts(r)).toEqual(expect.arrayContaining([CONSENT_TITLE, '《用户协议》', '《隐私政策》']))
    click(r, '查看《隐私政策》')
    expect(Taro.navigateTo).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining('type=privacy') }))
  })

  it('同意：先写 consent 再 login，状态 agreed、弹层关闭；首次进入下一步是 18+ 确认页（M1，PRD §7.6）', async () => {
    const r = render(<ConsentSheet />)
    expect(texts(r)).toContain('《社区公约》')
    click(r, '同意并开始')
    await flush()
    expect(mockControl.calls.map(c => `${c.name}.${c.action}`).slice(0, 2)).toEqual(['user.consent', 'user.login'])
    expect(useUserStore.getState().consent).toBe('agreed')
    expect(texts(r)).not.toContain(CONSENT_TITLE)
    expect(Taro.navigateTo).toHaveBeenCalledTimes(1)
    expect(Taro.navigateTo).toHaveBeenCalledWith({ url: '/pkg-user/pages/adult/index' })
  })

  it('写入失败：保持 unknown、弹层不关，可重试成功', async () => {
    mockControl.failTimes = 1
    const r = render(<ConsentSheet />)
    click(r, '同意并开始')
    await flush()
    expect(useUserStore.getState().consent).toBe('unknown')
    expect(texts(r)).toContain(CONSENT_TITLE)
    click(r, '同意并开始')
    await flush()
    expect(useUserStore.getState().consent).toBe('agreed')
  })

  it('暂不同意：不发云端请求，declined 后隐藏；openConsentSheet 可带原因重新打开', () => {
    const r = render(<ConsentSheet />)
    click(r, '暂不同意')
    expect(mockControl.calls).toHaveLength(0)
    expect(useUserStore.getState().consent).toBe('declined')
    expect(texts(r)).not.toContain(CONSENT_TITLE)
    expect(Taro.navigateTo).not.toHaveBeenCalled()
    act(() => useUserStore.getState().openConsentSheet('同步需同意协议'))
    expect(texts(r)).toEqual(expect.arrayContaining([CONSENT_TITLE, '同步需同意协议']))
  })

})

describe('协议页', () => {
  it('按 type 显示对应协议，非法 type 回落用户协议', () => {
    const spy = jest.spyOn(Taro, 'getCurrentInstance')
    spy.mockReturnValue({ router: { params: { type: 'privacy' } } } as any)
    const a = render(<Agreement />)
    expect(hosts(a, n => n.type === 'Text').some(n => n.props.children === '隐私政策')).toBe(true)
    spy.mockReturnValue({ router: { params: { type: 'bogus' } } } as any)
    const b = render(<Agreement />)
    expect(texts(b)).toContain('一、服务内容')
    spy.mockReturnValue({ router: { params: { type: 'rules' } } } as any)
    const c = render(<Agreement />)
    expect(texts(c)).toEqual(expect.arrayContaining(['社区公约', '二、不允许', '三、未成年人']))
    spy.mockRestore()
  })
})

describe('我的页同意入口', () => {
  it('未同意时常驻入口可打开弹层；已同意时不显示', () => {
    useUserStore.setState({ consent: 'declined' })
    const r = render(<Mine />)
    expect(texts(r)).toContain(CONSENT_HINT)
    expect(texts(r)).not.toContain(CONSENT_TITLE)
    click(r, '去同意')
    expect(texts(r)).toContain(CONSENT_TITLE)
    act(() => useUserStore.setState({ consent: 'agreed', sheetOpen: false }))
    expect(texts(r)).not.toContain(CONSENT_HINT)
  })
})
