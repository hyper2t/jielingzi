/**
 * 发布前的门禁（FE-M1-01 / FE-M1-02，PRD A2 / A3 / C4 / C5）。顺序与云端 guardWrite 一致：
 *   同意协议 → 18+ 确认 → 登录（仅 App）→ 实名（绑定手机号）→ 阅读社区公约（首次发布前一次，FE-M2-03）——后两道仅发布类动作
 * 未满足时就地引导并返回 false（调用方直接 return，不要再弹 toast）：
 *   - 未同意：打开同意弹层（ConsentSheet）
 *   - 未确认 18+：进 18+ 确认页（pkg-user/pages/adult），确认后回到原页面
 *   - App 未登录：进登录页
 *   - 未实名：小程序弹手机号授权（PhoneSheet，必须由用户点击微信的授权按钮）；App 进「绑定手机号」；H5 只提示
 *   - 没读过公约：进社区公约页（协议页 mode=gate），底部「我已阅读并遵守」后回来
 * 小程序 / H5 恒为已登录。未满足时不会发出任何云端请求。
 */
import Taro from '@tarojs/taro'
import { HAS_LOGIN, isAdultConfirmed, isPhoneVerified, syncGate, useUserStore } from '@/store/user'
import { navigate, RouteName } from '@/utils/router'
import { isRulesRead } from '@/features/consent/rules'
import { goLogin } from './require-login'

export type PublishGate = 'consent' | 'adult' | 'login' | 'phone' | 'rules' | null

export interface GateOptions {
  /** 触发原因，用于弹层 / 页面顶部提示，如「发起话题」 */
  reason?: string
  /** 18+ 确认 / 登录成功后回到的页面（不传则返回上一页） */
  returnTo?: RouteName
}

const IS_WEAPP = process.env.TARO_ENV === 'weapp'
export const PHONE_ONLY_IN_APP_HINT = '请在小程序或 App 中绑定手机号'

/** 档案类写入（不要求实名）缺哪一道门 */
export function profileGate (): Exclude<PublishGate, 'phone' | 'rules'> {
  const g = syncGate()
  if (g === 'consent') return 'consent'
  if (!isAdultConfirmed()) return 'adult'
  return g
}

/** 发布类写入缺哪一道门 */
export function publishGate (): PublishGate {
  const g = profileGate()
  if (g) return g
  if (!isPhoneVerified()) return 'phone'
  return isRulesRead() ? null : 'rules'
}

function lead (gate: PublishGate, opts: GateOptions): void {
  const s = useUserStore.getState()
  if (gate === 'consent') {
    s.openConsentSheet(opts.reason ? `${opts.reason}需同意协议后可用` : undefined)
  } else if (gate === 'adult') {
    void navigate('adult', { returnTo: opts.returnTo, reason: opts.reason })
  } else if (gate === 'login') {
    goLogin(opts)
  } else if (gate === 'phone') {
    if (HAS_LOGIN) void navigate('login', { mode: 'bind', reason: opts.reason, returnTo: opts.returnTo })
    else if (IS_WEAPP) s.openPhoneSheet(opts.reason)
    else void Taro.showToast({ title: PHONE_ONLY_IN_APP_HINT, icon: 'none', duration: 1500 })
  } else if (gate === 'rules') {
    void navigate('agreement', { type: 'rules', mode: 'gate' })
  }
}

/** 编辑档案等：同意 → 18+ →（App）登录 */
export function ensureAdult (opts: GateOptions = {}): boolean {
  const gate = profileGate()
  if (!gate) return true
  lead(gate, opts)
  return false
}

/** 发起话题 / 回复等发布动作：同意 → 18+ →（App）登录 → 实名 → 读过社区公约 */
export function requirePhone (opts: GateOptions = {}): boolean {
  const gate = publishGate()
  if (!gate) return true
  lead(gate, opts)
  return false
}
