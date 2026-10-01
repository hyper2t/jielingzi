/**
 * App 端登录流程编排（FE-L02 / FE-L03，docs/mvp/prompts/rn-login.md §3）。页面只调这里，不直接碰 cloud.rn.ts。
 * - 手机号：sendCode → signInWithCode（校验验证码 → 取会话 → completeSignIn）
 * - 微信：signInWithWechat（SDK 取 code → user.wechatAppLogin 拿票据 → 票据换会话 → completeSignIn）；SDK 见 features/auth/wechat.rn.ts（未配置 AppID 时按钮不显示）
 * - completeSignIn：user.login（上报 platform / 本机同意时间，拿 accountId / identities）→ 业务的登录后同步钩子（after-sign-in.ts）→ 失效请求缓存
 * - bindPhone：已登录（微信）账号绑定手机号：用手机号另取一份**不落盘**的会话，把它的 access_token 交给 user.linkPhoneSession
 * - bindWechat：已登录（手机号）账号绑定微信：SDK 取 code → user.bindWechat（对方微信已有账号时并入当前账号）
 * - Apple（iOS，NA-L04）：signInWithApple（Apple 授权 → user.appleLogin 拿票据 → 票据换会话 → completeSignIn）；bindApple 同 bindWechat。见 features/auth/apple.rn.ts
 * 手机号只经过 CloudBase 身份认证服务；本地只保存脱敏后的显示用字符串。
 */
import type { AuthMethod, CloudAuth, LoginResult, VerificationInfo } from '@/services/cloud.types'
import { CloudError, ERROR_CODES } from '@/services/cloud.types'
import { getClient } from '@/services/client'
import { login, markPhoneVerified } from '@/services/me'
import { invalidate } from '@/hooks/requestCache'
import { maskPhone, useUserStore } from '@/store/user'
import { track } from '@/utils/track'
import { requestWechatAuth } from './wechat'
import { requestAppleAuth } from './apple'
import { runAfterSignIn } from './after-sign-in'

export interface PhoneCodeInput {
  phone: string
  verificationId: string
  code: string
  /** sendCode 返回的 isUser，决定先 signin 还是先 signup */
  isUser?: boolean
}

function authApi (): CloudAuth {
  const a = getClient().auth
  if (!a) throw new CloudError(ERROR_CODES.NOT_READY, '当前端不支持账号登录')
  return a
}

export function sendCode (phone: string): Promise<VerificationInfo> {
  return authApi().phone.sendCode(phone)
}

/**
 * 登录成功后的收尾：user.login → 登录后同步钩子 → 失效缓存 → 埋点。
 * user.login 失败不回滚登录态（会话已在），下次任一身份类调用 / 启动时 refreshRemoteSettings 会再试。
 */
export async function completeSignIn (method: AuthMethod, extra: { linkToken?: string } = {}): Promise<LoginResult | null> {
  let res: LoginResult | null = null
  try {
    res = await login(extra)
  } catch (e) {
    console.warn('[auth] 登录后 user.login 失败，稍后重试', e)
  }
  await runAfterSignIn()
  invalidate()
  track('login', { method, is_new: res?.isNew === true, merged: res?.merged === true })
  return res
}

/**
 * 手机号登录后用自己的会话调一次 user.linkPhoneSession（BE-M1-02）：云端标记实名并登记号码哈希，
 * 之后在小程序绑定同一号码时识别为同一人（合并账号）。尽力而为，失败不影响登录。
 */
async function registerOwnPhone (accessToken: string): Promise<void> {
  try {
    await getClient().fn.call('user', 'linkPhoneSession', { otherAccessToken: accessToken })
  } catch (e) {
    console.warn('[auth] 登记手机号失败，下次登录再试', e)
  }
}

/** 手机号验证码登录：校验验证码 → 取会话（落盘）→ 收尾（user.login）→ 登记号码（手机号登录即实名） */
export async function signInWithCode (input: PhoneCodeInput): Promise<LoginResult | null> {
  const api = authApi()
  const verificationToken = await api.phone.verifyCode(input.verificationId, input.code)
  const s = await api.phone.signIn({ phone: input.phone, verificationToken, isUser: input.isUser })
  useUserStore.getState().patchAuth({ phoneMasked: maskPhone(input.phone) })
  const res = await completeSignIn('phone')
  await registerOwnPhone(s.accessToken)
  markPhoneVerified()
  return res
}

/** 微信登录：SDK 取 code → user.wechatAppLogin 拿票据（Publishable Key）→ 票据换会话 → 收尾（linkToken 用于 unionid 兜底关联） */
export async function signInWithWechat (): Promise<LoginResult | null> {
  const api = authApi()
  const { code, state } = await requestWechatAuth()
  const { ticket, linkToken } = await getClient().fn.call('user', 'wechatAppLogin', { code, state })
  await api.custom.signIn(ticket, 'wechat')
  return completeSignIn('wechat', { linkToken })
}

/** 已登录账号绑定手机号（docs/api/user.md linkPhoneSession）；对方手机号已有账号时并入当前账号（merged） */
export async function bindPhone (input: PhoneCodeInput): Promise<{ ok: true, merged: boolean }> {
  const api = authApi()
  if (!api.session()) throw new CloudError(ERROR_CODES.LOGIN_REQUIRED, '请先登录')
  const verificationToken = await api.phone.verifyCode(input.verificationId, input.code)
  const other = await api.phone.signIn({ phone: input.phone, verificationToken, isUser: input.isUser }, { persist: false })
  const res = await getClient().fn.call('user', 'linkPhoneSession', { otherAccessToken: other.accessToken })
  const s = useUserStore.getState()
  const identities = { mp: false, wechat: false, ...(s.auth.identities || {}), phone: true }
  s.patchAuth({ phoneMasked: maskPhone(input.phone), identities })
  markPhoneVerified()
  if (res.merged) invalidate()
  track('bind_phone', { merged: res.merged === true })
  return res
}

/** 已登录账号绑定微信（docs/api/user.md bindWechat）；对方微信已有账号时并入当前账号（merged） */
export async function bindWechat (): Promise<{ ok: true, merged: boolean }> {
  const api = authApi()
  if (!api.session()) throw new CloudError(ERROR_CODES.LOGIN_REQUIRED, '请先登录')
  const { code, state } = await requestWechatAuth()
  const res = await getClient().fn.call('user', 'bindWechat', { code, state })
  const s = useUserStore.getState()
  const identities = { mp: false, phone: false, ...(s.auth.identities || {}), wechat: true }
  s.patchAuth({ identities })
  if (res.merged) invalidate()
  track('bind_wechat', { merged: res.merged === true })
  return res
}

/** 通过 Apple 登录（iOS）：Apple 授权 → user.appleLogin 拿票据（Publishable Key）→ 票据换会话 → 收尾 */
export async function signInWithApple (): Promise<LoginResult | null> {
  const api = authApi()
  const { identityToken, nonce } = await requestAppleAuth()
  const { ticket, linkToken } = await getClient().fn.call('user', 'appleLogin', { identityToken, nonce })
  await api.custom.signIn(ticket, 'apple')
  return completeSignIn('apple', { linkToken })
}

/** 已登录账号绑定 Apple ID（docs/api/user.md bindApple）；对方 Apple ID 已有账号时并入当前账号（merged） */
export async function bindApple (): Promise<{ ok: true, merged: boolean }> {
  const api = authApi()
  if (!api.session()) throw new CloudError(ERROR_CODES.LOGIN_REQUIRED, '请先登录')
  const { identityToken, nonce } = await requestAppleAuth()
  const res = await getClient().fn.call('user', 'bindApple', { identityToken, nonce })
  const s = useUserStore.getState()
  const identities = { mp: false, wechat: false, phone: false, ...(s.auth.identities || {}), apple: true }
  s.patchAuth({ identities })
  if (res.merged) invalidate()
  track('bind_apple', { merged: res.merged === true })
  return res
}
