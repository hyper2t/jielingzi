/* eslint-disable react/jsx-key -- 快照用例表，元素不参与列表渲染 */
import { act, create, ReactTestRenderer } from 'react-test-renderer'
import Taro from '@tarojs/taro'
import {
  Button, Empty, ErrorRetry, Icon, NavBar, NetTip, Screen, Seal, Skeleton, toast
} from '@/components'

function render (el: JSX.Element): ReactTestRenderer {
  let r!: ReactTestRenderer
  act(() => { r = create(el) })
  return r
}

/** 热区：可点击节点必须带 ≥ 44pt 的尺寸类（min-h-touch / min-h-btn / min-h-touch-kid / h-touch） */
const HIT = /(^|\s)(min-h-touch|min-h-btn|min-h-touch-kid|h-touch)(\s|$)/
/** RN 不支持的工具类（04-ui §7 / 使用规范） */
const RN_UNSAFE = /(^|\s)(hover:|group-|peer-|before:|after:|space-[xy]-|divide-|grid|ring|blur|bg-gradient|animate-|rotate-|transition)/

function assertTree (r: ReactTestRenderer) {
  r.root.findAll(n => typeof n.type === 'string').forEach(n => {
    const cls: string = n.props.className || ''
    expect(cls).not.toMatch(RN_UNSAFE)
    if (typeof n.props.onClick === 'function') expect(cls).toMatch(HIT)
  })
}

describe('基础组件快照', () => {
  const cases: Array<[string, JSX.Element]> = [
    ['Icon', <Icon name='play' tone='brand' size='lg' label='播放' />],
    ['Icon 装饰', <Icon name='sparkles' tone='apricot' size='xs' />],
    ['Seal', <Seal text='结灵' />],
    ['Button primary', <Button icon='play' onClick={() => {}}>开始听</Button>],
    ['Button kid', <Button size='kid' onClick={() => {}}>播放</Button>],
    ['Button secondary', <Button variant='secondary' icon='heart'>收藏</Button>],
    ['Button text', <Button variant='text'>去同意</Button>],
    ['Button loading', <Button loading>加载中</Button>],
    ['Button disabled', <Button disabled>不可用</Button>],
    ['Skeleton text', <Skeleton rows={2} />],
    ['Skeleton list', <Skeleton variant='list' rows={2} />],
    ['Skeleton card', <Skeleton variant='card' rows={2} />],
    ['Skeleton reader', <Skeleton variant='reader' rows={2} />],
    ['Empty', <Empty text='还没有收藏' actionText='去首页听听' onAction={() => {}} />],
    ['Empty compact', <Empty compact text='还没有听过内容' actionText='去首页' onAction={() => {}} />],
    ['ErrorRetry block', <ErrorRetry onRetry={() => {}} />],
    ['ErrorRetry inline', <ErrorRetry inline onRetry={() => {}} />],
    ['NetTip offline', <NetTip online={false} onRetry={() => {}} />],
    ['NetTip online', <NetTip online />],
    ['NavBar', <NavBar title='标题' showBack seal='结灵' />],
    ['Screen ready', <Screen nav={{ title: '首页' }} online tabPage>内容</Screen>],
    ['Screen loading', <Screen status='loading' online />],
    ['Screen error', <Screen status='error' online onRetry={() => {}} />],
    ['Screen empty', <Screen status='empty' online emptyText='这里还空空的' />]
  ]

  it.each(cases)('%s', (_name, el) => {
    const r = render(el)
    expect(r.toJSON()).toMatchSnapshot()
    assertTree(r)
  })
})

describe('交互', () => {
  it('Button 点击触发；禁用 / 加载时不触发', () => {
    const fn = jest.fn()
    const click = (el: JSX.Element) => render(el).root.findByType('View' as any).props.onClick({})
    click(<Button onClick={fn}>好</Button>)
    click(<Button disabled onClick={fn}>好</Button>)
    click(<Button loading onClick={fn}>好</Button>)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('Button 读屏标签默认取文字', () => {
    const v = render(<Button>播放</Button>).root.findByType('View' as any)
    expect(v.props.ariaLabel).toBe('播放')
    expect(v.props.accessibilityRole).toBe('button')
  })

  it('NavBar 按胶囊计算导航高度', () => {
    const r = render(<NavBar title='t' />)
    const inner = r.root.findAll(n => n.type === ('View' as any) && n.props.style?.height)[0]
    // (24 - 20) * 2 + 32 = 40，右侧让出胶囊 375 - 281 = 94
    expect(inner.props.style).toEqual({ height: 40, paddingRight: 94 })
  })

  it('NetTip 自动模式：断网时出现', async () => {
    const r = render(<NetTip />)
    await act(async () => { await Promise.resolve() })
    expect(r.toJSON()).toBeNull()
    act(() => { (Taro as any).__emitNetwork(false) })
    expect(r.toJSON()).not.toBeNull()
  })

  it('toast 使用 1.5s 无图标', () => {
    toast.show('已收藏')
    expect(Taro.showToast).toHaveBeenCalledWith({ title: '已收藏', icon: 'none', duration: 1500 })
  })
})
