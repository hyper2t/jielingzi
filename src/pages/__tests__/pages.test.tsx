import { act, create, ReactTestRenderer } from 'react-test-renderer'
import Taro from '@tarojs/taro'
import Index from '@/pages/index/index'
import Mine, { CONSENT_HINT, H5_NOTICE, MINE_PLACEHOLDER } from '@/pages/mine/index'
import { mockControl } from '@/services/mock/client'
import { invalidate } from '@/hooks/requestCache'
import { useUserStore } from '@/store/user'

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

const mounted: ReactTestRenderer[] = []
function render (el: JSX.Element): ReactTestRenderer {
  let r!: ReactTestRenderer
  act(() => { r = create(el) })
  mounted.push(r)
  return r
}
afterEach(() => { mounted.splice(0).forEach(r => act(() => r.unmount())) })

const hosts = (r: ReactTestRenderer, pred: (n: any) => boolean) => r.root.findAll(n => typeof n.type === 'string' && pred(n))
const texts = (r: ReactTestRenderer) => hosts(r, n => n.type === 'Text').map(n => String(n.props.children))
const clickByLabel = (r: ReactTestRenderer, label: string) =>
  act(() => { hosts(r, n => n.props.ariaLabel === label && typeof n.props.onClick === 'function')[0].props.onClick() })

beforeEach(() => {
  mockControl.reset()
  mockControl.latency = 0
  invalidate()
  ;(Taro as any).__storage.clear()
  useUserStore.setState({ consent: 'unknown', sheetOpen: false })
  jest.clearAllMocks()
})

describe('首页（话题流，细节见 pkg-community/__tests__/m3.test.tsx）', () => {
  it('未同意：引导空态；首次进入弹同意；不发云端请求', async () => {
    const r = render(<Index />)
    await flush()
    expect(texts(r)).toEqual(expect.arrayContaining(['结灵子', '同意协议后可浏览话题', '请阅读并同意']))
    expect(mockControl.calls).toHaveLength(0)
  })
})

describe('我的', () => {
  it('未同意：提示条 + 协议页脚；不发云端请求', async () => {
    useUserStore.setState({ consent: 'declined' })
    const r = render(<Mine />)
    await flush()
    expect(texts(r)).toEqual(expect.arrayContaining([CONSENT_HINT, '用户协议', '隐私政策']))
    expect(texts(r)).not.toContain(H5_NOTICE)
    expect(mockControl.calls).toHaveLength(0)
  })

  it('已同意（小程序恒为已登录）：业务占位；设置入口直达', async () => {
    useUserStore.setState({ consent: 'agreed' })
    const r = render(<Mine />)
    await flush()
    expect(texts(r)).toContain(MINE_PLACEHOLDER)
    expect(texts(r)).not.toContain(CONSENT_HINT)
    clickByLabel(r, '设置')
    expect(Taro.navigateTo).toHaveBeenCalledWith({ url: '/pkg-user/pages/settings/index' })
  })

  it('协议页脚跳协议页', () => {
    const r = render(<Mine />)
    clickByLabel(r, '查看隐私政策')
    expect(Taro.navigateTo).toHaveBeenCalledWith({ url: '/pkg-user/pages/agreement/index?type=privacy' })
  })
})

describe('M0 新页面（空壳）', () => {
  it('练习 Tab：渲染占位并弹同意；话题详情未同意时引导、计时器占位，都不发请求', async () => {
    const { default: Practice, PRACTICE_PLACEHOLDER } = await import('@/pages/practice/index')
    const { default: Topic } = await import('@/pkg-community/pages/topic/index')
    const { default: Timer, TIMER_PLACEHOLDER } = await import('@/pkg-practice/pages/timer/index')
    const r = render(<Practice />)
    await flush()
    expect(texts(r)).toEqual(expect.arrayContaining(['练习', PRACTICE_PLACEHOLDER, '请阅读并同意']))
    expect(texts(render(<Topic />))).toEqual(expect.arrayContaining(['同意协议后可查看话题']))
    expect(texts(render(<Timer />))).toEqual(expect.arrayContaining([TIMER_PLACEHOLDER]))
    expect(mockControl.calls).toHaveLength(0)
  })

  it('路由与 app.config 一致：三个 Tab，新分包已注册', async () => {
    const { ROUTES, TAB_ROUTES } = await import('@/utils/router')
    expect(TAB_ROUTES).toEqual(['index', 'practice', 'mine'])
    const fs = await import('fs')
    const cfg = fs.readFileSync(require.resolve('@/app.config'), 'utf8')
    for (const p of [ROUTES.practice, ROUTES.topic, ROUTES.topicNew, ROUTES.timer]) {
      const seg = p.replace(/^\/(pkg-[a-z]+\/)?/, '')
      expect(cfg).toContain(`'${seg}'`)
    }
    expect(cfg).toContain("root: 'pkg-community'")
    expect(cfg).toContain("root: 'pkg-practice'")
  })
})
