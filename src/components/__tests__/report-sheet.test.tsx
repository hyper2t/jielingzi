/** FE-M2-01：举报弹层（原因单选 + 补充说明；重复举报提示；云端拒绝时显示原因） */
import { act, create, ReactTestRenderer } from 'react-test-renderer'
import Taro from '@tarojs/taro'
import { ReportSheet, REPORT_DONE, REPORT_DUP, REPORT_PICK, REPORT_SUBMIT } from '@/components'
import { mockControl } from '@/services/mock/client'
import { useUserStore } from '@/store/user'

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const render = (el: JSX.Element) => { let r!: ReactTestRenderer; act(() => { r = create(el) }); return r }
const hosts = (r: ReactTestRenderer, pred: (n: any) => boolean) => r.root.findAll(n => typeof n.type === 'string' && pred(n))
const texts = (r: ReactTestRenderer) => hosts(r, n => n.type === 'Text').map(n => String(n.props.children))
const click = (r: ReactTestRenderer, label: string) => act(() => { hosts(r, n => n.props.ariaLabel === label && typeof n.props.onClick === 'function')[0].props.onClick() })
const typeInto = (r: ReactTestRenderer, label: string, value: string) => act(() => { hosts(r, n => n.type === 'Input' && n.props.ariaLabel === label)[0].props.onInput({ detail: { value } }) })

beforeEach(() => {
  mockControl.reset()
  mockControl.latency = 0
  ;(Taro as any).__storage.clear()
  useUserStore.setState({ consent: 'agreed', adult: 'confirmed', account: null })
  jest.clearAllMocks()
})

it('未选原因提示；选原因 + 补充说明提交 → moderation.report；成功提示并关闭；重复举报提示已举报', async () => {
  mockControl.setAccount({ adult: true })
  mockControl.seedTopics([{ title: '举报用话题', body: '这是一条供举报测试使用的圈内话题内容。' }])
  const onClose = jest.fn()
  const onDone = jest.fn()
  const r = render(<ReportSheet open target={{ targetType: 'topic', targetId: 't1' }} onClose={onClose} onDone={onDone} />)
  expect(texts(r)).toContain('举报话题')
  click(r, REPORT_SUBMIT)
  await flush()
  expect(texts(r)).toContain(REPORT_PICK)
  expect(mockControl.calls).toHaveLength(0)
  click(r, '站外引流（微信号 / 二维码等）')
  typeInto(r, '补充说明', '  留了微信号  ')
  click(r, REPORT_SUBMIT)
  await flush()
  expect(mockControl.calls.find(c => c.action === 'report')?.data).toEqual({ targetType: 'topic', targetId: 't1', reason: 'diversion', note: '留了微信号' })
  expect(Taro.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: REPORT_DONE }))
  expect(onDone).toHaveBeenCalledWith({ duplicate: false, folded: false })
  expect(onClose).toHaveBeenCalled()
  const again = render(<ReportSheet open target={{ targetType: 'topic', targetId: 't1' }} onClose={() => {}} />)
  click(again, '刷屏 / 广告')
  click(again, REPORT_SUBMIT)
  await flush()
  expect(Taro.showToast).toHaveBeenLastCalledWith(expect.objectContaining({ title: REPORT_DUP }))
})

it('举报用户：传他发布的内容（contentType + targetId），不需要 uid；云端拒绝（未确认 18+）时显示原因、不关闭', async () => {
  const onClose = jest.fn()
  const r = render(<ReportSheet open target={{ targetType: 'user', targetId: 'r9', contentType: 'reply' }} onClose={onClose} />)
  expect(texts(r)).toContain('举报用户')
  click(r, '人身攻击 / 骚扰')
  click(r, REPORT_SUBMIT)
  await flush()
  expect(mockControl.calls.find(c => c.action === 'report')?.data).toEqual({ targetType: 'user', targetId: 'r9', contentType: 'reply', reason: 'abuse' })
  expect(texts(r)).toContain('结灵子仅面向年满 18 周岁的用户')
  expect(onClose).not.toHaveBeenCalled()
  expect(render(<ReportSheet open={false} target={{ targetType: 'topic', targetId: 't1' }} onClose={() => {}} />).toJSON()).toBeNull()
})
