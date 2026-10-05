/**
 * M1 前端（小程序 / mock 数据源）：首次进入（同意 → 18+，FE-M1-01）、18+ 退出可回退、发布前实名拦截与手机号弹层（FE-M1-02）、
 * 档案卡与编辑档案（FE-M1-03，校验与后端一致）。App 端分支见 features/auth/__tests__/gates.test.ts 与 login-flow.test.tsx。
 */
import { act, create, ReactTestRenderer } from 'react-test-renderer'
import Taro from '@tarojs/taro'
import type { Profile } from '@/types/models'
import { ConsentSheet, PhoneSheet } from '@/components'
import Adult, { ADULT_CONFIRM, ADULT_EXIT } from '@/pkg-user/pages/adult/index'
import ProfileEdit, { SAVE_TEXT } from '@/pkg-user/pages/profile-edit/index'
import Mine, { ADULT_HINT, PROFILE_SETUP, ProfileCard } from '@/pages/mine/index'
import Index, { NEW_TOPIC } from '@/pages/index/index'
import { mockControl, MOCK_EXPIRED_PHONE_CODE, MOCK_TAKEN_PHONE_CODE } from '@/services/mock/client'
import { invalidate } from '@/hooks/requestCache'
import { useUserStore } from '@/store/user'
import { markRulesRead } from '@/features/consent/rules'

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const mounted: ReactTestRenderer[] = []
const render = (el: JSX.Element) => { let r!: ReactTestRenderer; act(() => { r = create(el) }); mounted.push(r); return r }
afterEach(() => { mounted.splice(0).forEach(r => act(() => r.unmount())) })
const hosts = (r: ReactTestRenderer, pred: (n: any) => boolean) => r.root.findAll(n => typeof n.type === 'string' && pred(n))
const texts = (r: ReactTestRenderer) => hosts(r, n => n.type === 'Text').map(n => String(n.props.children))
const click = (r: ReactTestRenderer, label: string) =>
  act(() => { hosts(r, n => n.props.ariaLabel === label && typeof n.props.onClick === 'function')[0].props.onClick() })
const typeInto = (r: ReactTestRenderer, label: string, value: string) =>
  act(() => { hosts(r, n => n.type === 'Input' && n.props.ariaLabel === label)[0].props.onInput({ detail: { value } }) })
const inputValue = (r: ReactTestRenderer, label: string) => hosts(r, n => n.type === 'Input' && n.props.ariaLabel === label)[0].props.value
const phoneButton = (r: ReactTestRenderer) => hosts(r, n => n.type === 'Button' && n.props.openType === 'getPhoneNumber')[0]
const calls = () => mockControl.calls.map(c => `${c.name}.${c.action}`)
const left = () => (Taro.navigateBack as jest.Mock).mock.calls.length + (Taro.switchTab as jest.Mock).mock.calls.length

const LIN: Profile = {
  nickname: '林然', avatar: 'preset:leaf', practices: ['mindfulness', 'taichi'], years: 3, goal: '', bio: '在呼吸里找回自己',
  anonAlias: '竹影', badges: [], updatedAt: 1
}

beforeEach(() => {
  mockControl.reset()
  mockControl.latency = 0
  invalidate()
  ;(Taro as any).__storage.clear()
  ;(Taro as any).__routerParams = {}
  useUserStore.setState({ consent: 'unknown', sheetOpen: false, sheetReason: undefined, adult: 'unknown', account: null, phoneSheetOpen: false, phoneSheetReason: undefined })
  jest.clearAllMocks()
})

describe('首次进入（FE-M1-01）', () => {
  it('同意协议后进入 18+ 确认；确认写云端 confirmAdult（带协议版本）、本机 confirmed、返回', async () => {
    const sheet = render(<ConsentSheet />)
    click(sheet, '同意并开始')
    await flush()
    expect(Taro.navigateTo).toHaveBeenCalledWith({ url: '/pkg-user/pages/adult/index' })
    const page = render(<Adult />)
    expect(texts(page)).toEqual(expect.arrayContaining(['年龄确认', '结灵子仅面向年满 18 周岁的用户。']))
    click(page, ADULT_CONFIRM)
    await flush()
    expect(mockControl.calls.find(c => c.action === 'confirmAdult')?.data).toEqual({ consentVersion: 'v0.1' })
    expect(useUserStore.getState().adult).toBe('confirmed')
    expect(useUserStore.getState().account).toMatchObject({ adult: true })
    expect(left()).toBe(1)
  })

  it('已确认过 18+ 的用户同意协议后不再进入确认页', async () => {
    useUserStore.setState({ adult: 'confirmed' })
    const sheet = render(<ConsentSheet />)
    click(sheet, '同意并开始')
    await flush()
    expect(Taro.navigateTo).not.toHaveBeenCalled()
  })

  it('退出：本机 declined、不写云端；「我的」显示确认提示，可回到确认页重新确认（拒绝路径可回退）', async () => {
    useUserStore.setState({ consent: 'agreed' })
    const page = render(<Adult />)
    click(page, ADULT_EXIT)
    expect(useUserStore.getState().adult).toBe('declined')
    expect(calls()).not.toContain('user.confirmAdult')
    expect(left()).toBe(1)
    const mine = render(<Mine />)
    await flush()
    expect(texts(mine)).toContain(ADULT_HINT)
    click(mine, '去确认')
    expect(Taro.navigateTo).toHaveBeenLastCalledWith({ url: '/pkg-user/pages/adult/index' })
    const again = render(<Adult />)
    expect(texts(again)).toContain('你之前选择了退出，确认后即可参与交流')
    click(again, ADULT_CONFIRM)
    await flush()
    expect(useUserStore.getState().adult).toBe('confirmed')
  })

  it('returnTo：确认后回到发起页；未同意协议直接进入时先打开同意弹层', async () => {
    useUserStore.setState({ consent: 'agreed' })
    ;(Taro as any).__routerParams = { returnTo: 'profileEdit', reason: '编辑档案' }
    const page = render(<Adult />)
    expect(texts(page)).toContain('编辑档案前请先确认年龄')
    click(page, ADULT_CONFIRM)
    await flush()
    expect(Taro.redirectTo).toHaveBeenCalledWith({ url: '/pkg-user/pages/profile-edit/index' })

    useUserStore.setState({ consent: 'declined', adult: 'unknown' })
    ;(Taro as any).__routerParams = {}
    const p2 = render(<Adult />)
    click(p2, ADULT_CONFIRM)
    await flush()
    expect(useUserStore.getState()).toMatchObject({ sheetOpen: true, sheetReason: '确认年龄前需同意协议', adult: 'unknown' })
  })
})

describe('发布前实名拦截（FE-M1-02）', () => {
  it('未确认 18+ 点「发起话题」先去确认年龄，不弹手机号', () => {
    useUserStore.setState({ consent: 'agreed' })
    const home = render(<Index />)
    click(home, NEW_TOPIC)
    expect(Taro.navigateTo).toHaveBeenCalledWith({ url: `/pkg-user/pages/adult/index?reason=${encodeURIComponent(NEW_TOPIC)}` })
    expect(useUserStore.getState().phoneSheetOpen).toBe(false)
  })

  it('未实名点「发起话题」被拦截：弹手机号验证；授权 code → bindPhoneWeapp → 关闭并提示；之后放行', async () => {
    useUserStore.setState({ consent: 'agreed', adult: 'confirmed' })
    const home = render(<Index />)
    click(home, NEW_TOPIC)
    expect(Taro.navigateTo).not.toHaveBeenCalledWith({ url: '/pkg-community/pages/topic-new/index' })
    expect(texts(home)).toEqual(expect.arrayContaining(['验证手机号', '发起话题前请先验证手机号']))
    await act(async () => { await phoneButton(home).props.onGetPhoneNumber({ detail: { code: 'mock-phone-code-0001' } }) })
    expect(mockControl.calls.find(c => c.action === 'bindPhoneWeapp')?.data).toEqual({ code: 'mock-phone-code-0001' })
    expect(useUserStore.getState().account).toMatchObject({ phoneVerified: true })
    expect(texts(home)).not.toContain('验证手机号')
    expect(Taro.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '验证成功' }))
    // 首次发布前还要读一次社区公约（FE-M2-03）
    click(home, NEW_TOPIC)
    expect(Taro.navigateTo).toHaveBeenLastCalledWith({ url: '/pkg-user/pages/agreement/index?type=rules&mode=gate' })
    markRulesRead()
    click(home, NEW_TOPIC)
    expect(Taro.navigateTo).toHaveBeenLastCalledWith({ url: '/pkg-community/pages/topic-new/index' })
  })

  it('拒绝授权 / code 失效 / 号码已被他人绑定：留在弹层显示原因，可重试或关闭', async () => {
    useUserStore.setState({ consent: 'agreed', adult: 'confirmed' })
    act(() => useUserStore.getState().openPhoneSheet('发起话题'))
    const r = render(<PhoneSheet />)
    await act(async () => { await phoneButton(r).props.onGetPhoneNumber({ detail: { errMsg: 'getPhoneNumber:fail user deny' } }) })
    expect(texts(r)).toContain('需要授权手机号才能发布，可稍后再试')
    expect(calls()).not.toContain('user.bindPhoneWeapp')
    await act(async () => { await phoneButton(r).props.onGetPhoneNumber({ detail: { code: `${MOCK_EXPIRED_PHONE_CODE}-0001` } }) })
    expect(texts(r)).toContain('手机号验证已失效，请重新获取')
    await act(async () => { await phoneButton(r).props.onGetPhoneNumber({ detail: { code: `${MOCK_TAKEN_PHONE_CODE}-0001` } }) })
    expect(texts(r)).toContain('该手机号已绑定其他账号')
    expect(useUserStore.getState().phoneSheetOpen).toBe(true)
    expect(useUserStore.getState().account?.phoneVerified).not.toBe(true)
    click(r, '暂不验证')
    expect(useUserStore.getState().phoneSheetOpen).toBe(false)
  })
})

describe('练习档案（FE-M1-03）', () => {
  it('我的：已同意才拉档案；没有档案显示「完善练习档案」；未确认 18+ 点击先去确认，确认后进编辑页', async () => {
    useUserStore.setState({ consent: 'agreed' })
    const mine = render(<Mine />)
    await flush()
    expect(calls()).toContain('community.getProfile')
    expect(texts(mine)).toContain(PROFILE_SETUP)
    click(mine, PROFILE_SETUP)
    expect(Taro.navigateTo).toHaveBeenLastCalledWith({ url: `/pkg-user/pages/adult/index?returnTo=profileEdit&reason=${encodeURIComponent('编辑档案')}` })
    act(() => useUserStore.setState({ adult: 'confirmed' }))
    click(mine, PROFILE_SETUP)
    expect(Taro.navigateTo).toHaveBeenLastCalledWith({ url: '/pkg-user/pages/profile-edit/index' })
  })

  it('我的：档案卡展示头像 / 昵称 / 练习方式 · 年限 / 介绍', async () => {
    useUserStore.setState({ consent: 'agreed', adult: 'confirmed' })
    mockControl.setProfile(LIN)
    const mine = render(<Mine />)
    await flush()
    expect(texts(mine)).toEqual(expect.arrayContaining(['林然', '正念 · 太极  练习 3 年', '“在呼吸里找回自己”']))
    expect(hosts(mine, n => n.props.ariaLabel === '林然，编辑档案')).toHaveLength(1)
  })

  it('档案卡快照：有档案 / 未完善', () => {
    expect(render(<ProfileCard profile={LIN} loading={false} onEdit={() => {}} />).toJSON()).toMatchSnapshot()
    expect(render(<ProfileCard profile={null} loading={false} onEdit={() => {}} />).toJSON()).toMatchSnapshot()
  })

  it('编辑档案：载入已有档案与匿名代号；校验不通过不提交并逐项提示（与后端同文案）；只提交改动字段；保存成功返回', async () => {
    useUserStore.setState({ consent: 'agreed', adult: 'confirmed' })
    mockControl.setAccount({ adult: true })
    mockControl.setProfile(LIN)
    const page = render(<ProfileEdit />)
    await flush()
    expect(inputValue(page, '昵称')).toBe('林然')
    expect(texts(page)).toContain('匿名·竹影')
    typeInto(page, '昵称', '林')
    typeInto(page, '一句话介绍', 'x'.repeat(81))
    click(page, SAVE_TEXT)
    await flush()
    expect(texts(page)).toEqual(expect.arrayContaining(['昵称至少 2 个字', '一句话介绍最多 80 个字']))
    expect(calls()).not.toContain('community.updateProfile')
    typeInto(page, '昵称', '  林 然 ')
    typeInto(page, '一句话介绍', '日日是好日')
    click(page, '练习方式：站桩')
    click(page, '头像：月')
    click(page, SAVE_TEXT)
    await flush()
    expect(mockControl.calls.find(c => c.action === 'updateProfile')?.data).toEqual({
      nickname: '林 然', avatar: 'preset:moon', practices: ['mindfulness', 'taichi', 'zhanzhuang'], bio: '日日是好日'
    })
    expect(mockControl.profile).toMatchObject({ nickname: '林 然', avatar: 'preset:moon', anonAlias: '竹影' })
    expect(Taro.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '已保存' }))
    expect(left()).toBe(1)
  })

  it('编辑档案：昵称必填；练习方式最多 5 项；云端 40303（未确认 18+）时引导去确认', async () => {
    useUserStore.setState({ consent: 'agreed', adult: 'confirmed' })
    const page = render(<ProfileEdit />)
    await flush()
    click(page, SAVE_TEXT)
    await flush()
    expect(texts(page)).toContain('昵称至少 2 个字')
    typeInto(page, '昵称', '小禾')
    for (const label of ['冥想', '正念', '内观', '太极', '站桩', '瑜伽']) click(page, `练习方式：${label}`)
    expect(texts(page)).toContain('练习方式最多选 5 项')
    click(page, SAVE_TEXT)
    await flush()
    expect(mockControl.calls.find(c => c.action === 'updateProfile')?.data).toEqual({ nickname: '小禾', practices: ['meditation', 'mindfulness', 'vipassana', 'taichi', 'zhanzhuang'] })
    expect(Taro.navigateTo).toHaveBeenLastCalledWith({ url: `/pkg-user/pages/adult/index?reason=${encodeURIComponent('编辑档案')}` })
  })

  it('编辑档案：没有改动只提示，不发请求；未同意时不取数并引导同意', async () => {
    useUserStore.setState({ consent: 'agreed', adult: 'confirmed' })
    mockControl.setProfile(LIN)
    const page = render(<ProfileEdit />)
    await flush()
    mockControl.calls = []
    click(page, SAVE_TEXT)
    await flush()
    expect(mockControl.calls).toHaveLength(0)
    expect(Taro.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '没有修改' }))

    invalidate()
    useUserStore.setState({ consent: 'declined' })
    const p2 = render(<ProfileEdit />)
    await flush()
    expect(mockControl.calls).toHaveLength(0)
    expect(texts(p2)).toContain('同意协议后可编辑档案')
  })
})
