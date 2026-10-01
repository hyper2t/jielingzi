/** FE-M1-01 / FE-M1-02：发布门禁顺序（同意 → 18+ →（App）登录 → 实名）与各端引导方式 */
import Taro from '@tarojs/taro'
import type { AccountStatus } from '@/types/models'
import { useUserStore } from '@/store/user'
import { ensureAdult, profileGate, publishGate, requirePhone } from '@/features/auth/gates'
import { isRulesRead, markRulesRead } from '@/features/consent/rules'

const STATUS: AccountStatus = { phoneVerified: false, adult: false, role: 'user', bannedUntil: null, mutedUntil: null }
const reset = (p: Record<string, unknown> = {}) =>
  useUserStore.setState({ consent: 'agreed', adult: 'unknown', account: null, sheetOpen: false, sheetReason: undefined, phoneSheetOpen: false, phoneSheetReason: undefined, ...p })

beforeEach(() => {
  ;(Taro as any).__storage.clear()
  jest.clearAllMocks()
  reset()
})

describe('小程序（默认 TARO_ENV=weapp）', () => {
  it('顺序：未同意 → 同意弹层；未确认 18+ → 18+ 页（带 returnTo / reason）；未实名 → 手机号弹层；都满足放行', () => {
    reset({ consent: 'declined' })
    expect(publishGate()).toBe('consent')
    expect(requirePhone({ reason: '发起话题' })).toBe(false)
    expect(useUserStore.getState()).toMatchObject({ sheetOpen: true, sheetReason: '发起话题需同意协议后可用' })

    reset()
    expect(publishGate()).toBe('adult')
    expect(requirePhone({ reason: '发起话题', returnTo: 'index' })).toBe(false)
    expect(Taro.navigateTo).toHaveBeenCalledWith({ url: `/pkg-user/pages/adult/index?returnTo=index&reason=${encodeURIComponent('发起话题')}` })

    reset({ adult: 'confirmed' })
    expect(publishGate()).toBe('phone')
    expect(requirePhone({ reason: '发起话题' })).toBe(false)
    expect(useUserStore.getState()).toMatchObject({ phoneSheetOpen: true, phoneSheetReason: '发起话题' })

    // 已实名但没读过社区公约（FE-M2-03）：先去读公约
    reset({ adult: 'confirmed', account: { ...STATUS, adult: true, phoneVerified: true } })
    expect(publishGate()).toBe('rules')
    expect(requirePhone({ reason: '发起话题' })).toBe(false)
    expect(Taro.navigateTo).toHaveBeenLastCalledWith({ url: '/pkg-user/pages/agreement/index?type=rules&mode=gate' })
    markRulesRead()
    expect(isRulesRead()).toBe(true)
    expect(publishGate()).toBeNull()
    expect(requirePhone()).toBe(true)
    // 公约版本变了要重读
    ;(Taro as any).__storage.set('rules_read', 'v0.0')
    expect(publishGate()).toBe('rules')
  })

  it('云端已确认 18+（换设备 / 重装）也算确认；编辑档案只要求到 18+，不要求实名', () => {
    reset({ account: { ...STATUS, adult: true } })
    expect(profileGate()).toBeNull()
    expect(ensureAdult()).toBe(true)
    expect(publishGate()).toBe('phone')
    // setAccount 会把本机状态同步为 confirmed
    useUserStore.getState().setAccount({ ...STATUS, adult: true })
    expect(useUserStore.getState().adult).toBe('confirmed')
    expect((Taro as any).__storage.get('adult')).toBe('confirmed')
  })

  it('选择过「退出」的用户仍可通过入口回到 18+ 确认（拒绝路径可回退）', () => {
    reset({ adult: 'declined' })
    expect(ensureAdult({ reason: '编辑档案', returnTo: 'profileEdit' })).toBe(false)
    expect(Taro.navigateTo).toHaveBeenCalledWith({ url: `/pkg-user/pages/adult/index?returnTo=profileEdit&reason=${encodeURIComponent('编辑档案')}` })
  })
})

describe('H5 / App', () => {
  function load (env: 'h5' | 'rn') {
    const old = process.env.TARO_ENV
    process.env.TARO_ENV = env
    let mods: any
    jest.isolateModules(() => {
      mods = {
        Taro: require('@tarojs/taro').default,
        store: require('@/store/user'),
        gates: require('@/features/auth/gates')
      }
    })
    process.env.TARO_ENV = old
    return mods as { Taro: any, store: typeof import('@/store/user'), gates: typeof import('@/features/auth/gates') }
  }

  it('H5：没有手机号验证能力，未实名只提示，不弹小程序授权', () => {
    const { Taro: T, store, gates } = load('h5')
    store.useUserStore.setState({ consent: 'agreed', adult: 'confirmed', account: null })
    expect(gates.requirePhone()).toBe(false)
    expect(T.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: gates.PHONE_ONLY_IN_APP_HINT }))
    expect(store.useUserStore.getState().phoneSheetOpen).toBe(false)
  })

  it('App：未登录 → 登录页；已登录未实名 → 绑定手机号页（mode=bind）', () => {
    const { Taro: T, store, gates } = load('rn')
    store.useUserStore.setState({ consent: 'agreed', adult: 'confirmed', account: null, auth: { signedIn: false } })
    expect(gates.publishGate()).toBe('login')
    expect(gates.requirePhone({ reason: '发起话题' })).toBe(false)
    expect(T.navigateTo).toHaveBeenLastCalledWith({ url: expect.stringMatching(/^\/pkg-user\/pages\/login\/index\?reason=/) })
    store.useUserStore.setState({ auth: { signedIn: true, uid: 'u1', method: 'wechat' } })
    expect(gates.publishGate()).toBe('phone')
    expect(gates.requirePhone({ reason: '发起话题' })).toBe(false)
    expect(T.navigateTo).toHaveBeenLastCalledWith({ url: expect.stringContaining('mode=bind') })
    expect(store.useUserStore.getState().phoneSheetOpen).toBe(false)
  })
})
