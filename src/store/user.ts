/**
 * 用户状态：协议同意（FE-22）+ 18+ 确认与账号状态（FE-M1-01 / M1-02）+ App 端登录态（FE-L01/L03）。
 * - consent 决定是否允许任何云端写入：只有 'agreed' 才放行（见 services/guard.ts）。
 *   同意弹层（components/ConsentSheet）：consent 为 unknown 时始终显示；已拒绝的用户可从「我的」、收藏入口等主动打开。
 * - auth：App 端家长登录后的会话摘要（不含令牌，令牌在 services/cloud.rn.ts）。小程序 / H5 由平台提供身份，恒为已登录。
 *   云端读写的总开关是 canSync() = 已同意 && 已登录：小程序上等价于原来的 isConsented()，App 上多一道登录门禁。
 */
import { create } from 'zustand'
import type { AccountStatus, AdultState, ConsentState } from '@/types/models'
import type { AccountIdentities, AuthMethod } from '@/services/cloud.types'
import { getItem, removeItem, setItem, STORAGE_KEYS } from '@/utils/storage'

export interface AuthState {
  signedIn: boolean
  method?: AuthMethod
  /** CloudBase 会话 uid */
  uid?: string
  /** user.login 返回的账号 ID（登录成功后才有） */
  accountId?: string
  /** 脱敏手机号（来自本次输入，只存本机；如 138****1234） */
  phoneMasked?: string
  identities?: AccountIdentities
}

interface UserState {
  consent: ConsentState
  /** 主动打开的同意弹层（consent 为 unknown 时无论如何都显示） */
  sheetOpen: boolean
  /** 弹层顶部的触发原因，如「收藏需家长同意后可用」 */
  sheetReason?: string
  auth: AuthState
  /** 18+ 确认（本机；云端已确认时 setAccount 会同步为 confirmed） */
  adult: AdultState
  /** 云端账号状态（login / confirmAdult / bindPhoneWeapp 返回后更新）；null = 还没取到 */
  account: AccountStatus | null
  /** 小程序手机号授权弹层（components/PhoneSheet） */
  phoneSheetOpen: boolean
  phoneSheetReason?: string
  setConsent: (c: ConsentState) => void
  setAdult: (a: AdultState) => void
  /** 覆盖账号状态并持久化；status.adult 为 true 时本机 adult 同步为 confirmed */
  setAccount: (s: AccountStatus | null) => void
  patchAccount: (p: Partial<AccountStatus>) => void
  openPhoneSheet: (reason?: string) => void
  closePhoneSheet: () => void
  openConsentSheet: (reason?: string) => void
  closeConsentSheet: () => void
  /** 覆盖登录态（传 { signedIn: false } 即退出） */
  setAuth: (a: AuthState) => void
  /** 合并账号摘要（登录成功后写 accountId / identities / phoneMasked），并持久化到 authProfile */
  patchAuth: (p: Partial<AuthState>) => void
}

/** App 端才有登录概念；小程序 / H5 身份由平台提供 */
export const HAS_LOGIN = process.env.TARO_ENV === 'rn'

const SIGNED_OUT: AuthState = { signedIn: false }

/** 从本地读同意状态（RN 端存储预热后由 store/hydrate.ts 再读一次） */
export function readConsent (): ConsentState {
  const v = getItem<string>(STORAGE_KEYS.consent)
  return v === 'agreed' || v === 'declined' ? v : 'unknown'
}

/** 从本地读登录态：会话（uid / method / accountId）+ 账号摘要（phoneMasked / identities） */
export function readAuth (): AuthState {
  if (!HAS_LOGIN) return { signedIn: true }
  const s = getItem<{ uid?: unknown, method?: unknown, accountId?: unknown }>(STORAGE_KEYS.authSession)
  if (!s || typeof s.uid !== 'string' || typeof s.method !== 'string') return SIGNED_OUT
  const profile = getItem<{ phoneMasked?: string, identities?: AccountIdentities }>(STORAGE_KEYS.authProfile) || {}
  return {
    signedIn: true,
    uid: s.uid,
    method: s.method as AuthMethod,
    accountId: typeof s.accountId === 'string' ? s.accountId : undefined,
    phoneMasked: profile.phoneMasked,
    identities: profile.identities
  }
}

export function readAdult (): AdultState {
  const v = getItem<string>(STORAGE_KEYS.adult)
  return v === 'confirmed' || v === 'declined' ? v : 'unknown'
}

const ROLES = ['user', 'mod', 'admin'] as const
const numOrNull = (v: unknown) => (typeof v === 'number' ? v : null)

/** 从任意对象（login / confirmAdult / bindPhoneWeapp 的返回）取出账号状态；字段不全返回 null */
export function pickAccountStatus (v: unknown): AccountStatus | null {
  const o = v as Partial<AccountStatus> | null | undefined
  if (!o || typeof o !== 'object' || typeof o.phoneVerified !== 'boolean' || typeof o.adult !== 'boolean') return null
  return {
    phoneVerified: o.phoneVerified,
    adult: o.adult,
    role: ROLES.includes(o.role as typeof ROLES[number]) ? (o.role as AccountStatus['role']) : 'user',
    bannedUntil: numOrNull(o.bannedUntil),
    mutedUntil: numOrNull(o.mutedUntil)
  }
}

export function readAccount (): AccountStatus | null {
  return pickAccountStatus(getItem<AccountStatus>(STORAGE_KEYS.accountStatus))
}

export const useUserStore = create<UserState>((set, get) => ({
  consent: readConsent(),
  sheetOpen: false,
  sheetReason: undefined,
  auth: readAuth(),
  adult: readAdult(),
  account: readAccount(),
  phoneSheetOpen: false,
  phoneSheetReason: undefined,
  setConsent: (consent) => {
    setItem(STORAGE_KEYS.consent, consent)
    set({ consent })
  },
  setAdult: (adult) => {
    if (adult === 'unknown') removeItem(STORAGE_KEYS.adult)
    else setItem(STORAGE_KEYS.adult, adult)
    set({ adult })
  },
  setAccount: (account) => {
    if (account) setItem(STORAGE_KEYS.accountStatus, account)
    else removeItem(STORAGE_KEYS.accountStatus)
    if (account?.adult && get().adult !== 'confirmed') {
      setItem(STORAGE_KEYS.adult, 'confirmed')
      set({ account, adult: 'confirmed' })
    } else {
      set({ account })
    }
  },
  patchAccount: (p) => {
    const base: AccountStatus = get().account || { phoneVerified: false, adult: false, role: 'user', bannedUntil: null, mutedUntil: null }
    get().setAccount({ ...base, ...p })
  },
  openPhoneSheet: (reason) => set({ phoneSheetOpen: true, phoneSheetReason: reason }),
  closePhoneSheet: () => set({ phoneSheetOpen: false, phoneSheetReason: undefined }),
  openConsentSheet: (reason) => set({ sheetOpen: true, sheetReason: reason }),
  closeConsentSheet: () => set({ sheetOpen: false, sheetReason: undefined }),
  setAuth: (auth) => set({ auth: auth.signedIn ? auth : SIGNED_OUT }),
  patchAuth: (p) => {
    const auth = { ...get().auth, ...p }
    if (auth.signedIn) setItem(STORAGE_KEYS.authProfile, { phoneMasked: auth.phoneMasked, identities: auth.identities })
    set({ auth })
  }
}))

export function getConsent (): ConsentState {
  return useUserStore.getState().consent
}

export function isConsented (): boolean {
  return getConsent() === 'agreed'
}

/** 是否已有云端身份：小程序 / H5 恒为 true；App 端 = 家长已登录 */
export function isSignedIn (): boolean {
  return !HAS_LOGIN || useUserStore.getState().auth.signedIn
}

/** 云端读写总开关：已同意且已登录。未满足时读返回空、写被 guard 拦截（不发请求） */
export function canSync (): boolean {
  return isConsented() && isSignedIn()
}

/** 当前缺哪一道门：'consent' 先于 'login'；都满足为 null */
export type SyncGate = 'consent' | 'login' | null
export function syncGate (consent: ConsentState = getConsent(), signedIn: boolean = isSignedIn()): SyncGate {
  if (consent !== 'agreed') return 'consent'
  if (!signedIn) return 'login'
  return null
}

/** 已确认 18+：本机确认过，或云端账号已确认（换设备 / 重装后由 login 同步） */
export function isAdultConfirmed (): boolean {
  const s = useUserStore.getState()
  return s.adult === 'confirmed' || s.account?.adult === true
}

/** 已实名（绑定过手机号）；账号状态还没取到时为 false */
export function isPhoneVerified (): boolean {
  return useUserStore.getState().account?.phoneVerified === true
}

/** 登录方式的展示文案 */
export function authMethodText (a: AuthState): string {
  if (!a.signedIn) return '未登录'
  if (a.method === 'phone') return a.phoneMasked ? `手机号 ${a.phoneMasked}` : '手机号'
  if (a.method === 'wechat') return '微信'
  if (a.method === 'apple') return 'Apple'
  return '已登录'
}

/** 138****1234；非 11 位原样返回 */
export function maskPhone (phone: string): string {
  return /^\d{11}$/.test(phone) ? `${phone.slice(0, 3)}****${phone.slice(7)}` : phone
}
