/** 设置页 / 清除本机数据 */
import { act, create, ReactTestRenderer } from 'react-test-renderer'
import Taro from '@tarojs/taro'
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

beforeEach(() => {
  mockControl.reset()
  mockControl.latency = 0
  invalidate()
  ;(Taro as any).__storage.clear()
  useUserStore.setState({ consent: 'agreed', sheetOpen: false })
  useSettingsStore.setState({ settings: {} })
  jest.clearAllMocks()
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
