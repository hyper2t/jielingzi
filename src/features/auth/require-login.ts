/**
 * 登录门禁（FE-L03，docs/mvp/prompts/rn-login.md 决策 L1「软登录」）。
 * 浏览不需要登录；设置、练习档案等云端读写前调用 ensureSignedIn（发布类动作用 features/auth/gates.ts requirePhone）。
 * 顺序：未同意 → 打开同意弹层（与小程序一致）；已同意但 App 端未登录 → 跳登录页；都满足 → 返回 true 让调用方继续。
 * 小程序 / H5 恒为已登录，这里退化为原来的「同意拦截」。未满足时不会发出任何身份类请求。
 */
import type { ConsentState } from '@/types/models'
import { getConsent, HAS_LOGIN, isSignedIn, syncGate, SyncGate, useUserStore } from '@/store/user'
import { navigate, RouteName } from '@/utils/router'

export interface EnsureOptions {
  /** 触发原因，用于同意弹层 / 登录页顶部提示，如「收藏」 */
  reason?: string
  /** 登录成功后 redirect 到的页面（不传则返回上一页） */
  returnTo?: RouteName
}

/** 当前缺哪一道门（供页面渲染不同的空态 / 按钮） */
export function loginGate (consent: ConsentState = getConsent(), signedIn: boolean = isSignedIn()): SyncGate {
  return syncGate(consent, signedIn)
}

/** 门禁按钮文案 */
export function gateActionText (gate: SyncGate): string {
  return gate === 'login' ? '去登录' : '去同意'
}

/** 门禁提示：`${reason}需同意协议后可用` / `${reason}需登录后可用` */
export function gateHint (gate: SyncGate, reason = ''): string {
  if (gate === 'login') return `${reason}需登录后可用`
  return `${reason}需同意协议后可用`
}

/**
 * 满足门禁返回 true；否则引导（同意弹层或登录页）并返回 false。
 * 调用方拿到 false 直接 return，不要再弹 toast（这里已经引导）。
 */
export function ensureSignedIn (opts: EnsureOptions = {}): boolean {
  const gate = loginGate()
  if (!gate) return true
  if (gate === 'consent') {
    useUserStore.getState().openConsentSheet(opts.reason ? gateHint('consent', opts.reason) : undefined)
    return false
  }
  goLogin(opts)
  return false
}

/** 打开登录页（只在 App 端有意义） */
export function goLogin (opts: EnsureOptions = {}): void {
  if (!HAS_LOGIN) return
  const params: { reason?: string, returnTo?: RouteName } = {}
  if (opts.reason) params.reason = opts.reason
  if (opts.returnTo) params.returnTo = opts.returnTo
  void navigate('login', params)
}
