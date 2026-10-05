/**
 * 账号服务：登录收尾（user.login）、同意协议、设置同步。业务数据的 service 另建文件（如 services/<业务>.ts），同样通过 getClient() 访问云端。
 * 规则（与 jielingzi 一致）：
 * - 云端读写的总开关是 canSync() = 已同意 && 已登录（小程序 / H5 恒为已登录，等价于「已同意」）：
 *   不满足时写入被拦截（CONSENT_REQUIRED / LOGIN_REQUIRED，请求不会发出），私有数据读取直接返回空（云端不会有数据，也省配额）；
 * - user.consent（同意动作本身）不拦截；App 端同意只记本机（没有匿名会话可写），登录时随 user.login 的 consentAt 上报。
 */
import type { AccountStatus, UserSettings } from '@/types/models'
import { CONSENT_VERSION } from '@/constants/community'
import { canSync, HAS_LOGIN, isSignedIn, pickAccountStatus, useUserStore } from '@/store/user'
import { useSettingsStore } from '@/store/settings'
import { invalidate } from '@/hooks/requestCache'
import { getItem, setItem, STORAGE_KEYS } from '@/utils/storage'
import { getClient } from './client'
import { FnInput, LoginInput, LoginResult } from './cloud.types'
import { assertCanWrite } from './guard'
import { syncPendingCheckins } from '@/features/practice/checkins'

/** user.updateSettings：成功后把云端返回的完整设置写回本地 */
export async function updateSettings (p: FnInput<'user', 'updateSettings'>) {
  assertCanWrite()
  const res = await getClient().fn.call('user', 'updateSettings', p)
  useSettingsStore.getState().applyRemote(res.settings)
  return res
}

/** 修改设置：本地立即生效；已同意（且已登录）时同步云端（失败不影响本地，调用方可 catch 提示） */
export async function setSettings (p: Partial<UserSettings>): Promise<void> {
  useSettingsStore.getState().patch(p)
  if (!canSync()) return
  await updateSettings(p)
}

/** App 端本机记录的同意时间（毫秒）；小程序 / H5 无 */
export function localConsentAt (): number | undefined {
  const v = getItem<number>(STORAGE_KEYS.consentAt)
  return typeof v === 'number' && v > 0 ? v : undefined
}

/** App 端本机记录的 18+ 确认时间（毫秒）；小程序 / H5 无（直接写云端） */
export function localAdultAt (): number | undefined {
  const v = getItem<number>(STORAGE_KEYS.adultAt)
  return typeof v === 'number' && v > 0 ? v : undefined
}

/** 把云函数返回里的账号状态写进 store（login / confirmAdult / bindPhoneWeapp） */
function applyStatus (res: unknown): AccountStatus | null {
  const status = pickAccountStatus(res)
  if (status) useUserStore.getState().setAccount(status)
  return status
}

/** 用户建立登录 / 同意 / 18+ 同步资格后，后台补传本机排队的私人练习。 */
function syncPracticeQueue (): void {
  void syncPendingCheckins().then(({ synced, error }) => {
    if (error) console.warn('[me] 离线练习补传失败，稍后重试', error)
    else if (synced) console.info(`[me] 已补传 ${synced} 条练习记录`)
  }).catch(e => console.warn('[me] 离线练习补传失败，稍后重试', e))
}

/**
 * 登录会 upsert users 记录，属于云端写入，同意（且 App 端已登录）后才调用。
 * 服务端同时下发云端已保存的 users.settings：换手机 / 重装 / 清缓存后本地只剩默认值，这里把云端值合并回本地。
 * App 端：随 platform:'app' 上报本机同意时间；把返回的 accountId / identities 写入登录态；merged 时失效全部请求缓存。
 */
export async function login (extra: Pick<LoginInput, 'linkToken'> = {}): Promise<LoginResult> {
  assertCanWrite()
  const input: LoginInput = HAS_LOGIN ? { platform: 'app', consentAt: localConsentAt(), adultConfirmedAt: localAdultAt(), ...extra } : { platform: 'weapp' }
  if (input.consentAt === undefined) delete input.consentAt
  if (input.adultConfirmedAt === undefined) delete input.adultConfirmedAt
  const res = await getClient().fn.call('user', 'login', input)
  applyStatus(res)
  if (HAS_LOGIN) {
    const accountId = res.accountId || res.openid
    if (accountId) getClient().auth?.attachAccount(accountId)
    useUserStore.getState().patchAuth({ accountId, identities: res.identities })
    if (res.merged) invalidate()
  }
  if (res.settings) useSettingsStore.getState().applyRemote(res.settings)
  // 不阻塞登录流程；失败时队列会保留并在练习页 / 下次登录重试。
  syncPracticeQueue()
  return res
}

/**
 * 启动时刷新账号与云端设置（已同意且已登录才调用；否则不发请求）。
 * 覆盖「另一台设备改了设置」的场景；失败静默，继续用本地值。
 */
export async function refreshRemoteSettings (): Promise<void> {
  if (!canSync()) return
  try {
    await login()
  } catch (e) {
    console.warn('[me] 刷新云端设置失败，沿用本地值', e)
  }
}

/**
 * 用户点击同意。小程序 / H5：写 guardianConsentAt，成功后才把本地状态置为 agreed。
 * App：没有匿名会话可写，只记本机时间（STORAGE_KEYS.consentAt），登录时随 user.login 上报（云端只在没有同意时间时采用）。
 */
export async function consent () {
  if (HAS_LOGIN) {
    const now = Date.now()
    setItem(STORAGE_KEYS.consentAt, now)
    useUserStore.getState().setConsent('agreed')
    syncPracticeQueue()
    return { guardianConsentAt: now }
  }
  const res = await getClient().fn.call('user', 'consent')
  useUserStore.getState().setConsent('agreed')
  syncPracticeQueue()
  return res
}

/**
 * 用户确认年满 18 周岁（FE-M1-01，PRD A3 / C5）。
 * - 小程序 / H5：写云端 user.confirmAdult（需已同意协议），成功后本机置 confirmed；
 * - App：登录前只记本机时间（随 user.login 上报）；已登录时同时写云端。
 */
export async function confirmAdult (): Promise<void> {
  const s = useUserStore.getState()
  if (HAS_LOGIN) {
    setItem(STORAGE_KEYS.adultAt, Date.now())
    s.setAdult('confirmed')
    if (!canSync()) {
      syncPracticeQueue()
      return
    }
  }
  assertCanWrite()
  const res = await getClient().fn.call('user', 'confirmAdult', { consentVersion: CONSENT_VERSION })
  applyStatus(res)
  s.setAdult('confirmed')
  syncPracticeQueue()
}

/** 用户选择「退出」：只能浏览公开内容，可随时重新确认（拒绝路径可回退） */
export function declineAdult (): void {
  useUserStore.getState().setAdult('declined')
}

/**
 * 小程序手机号快速验证（FE-M1-02）：<Button open-type="getPhoneNumber"> 回调里的 code 交给 user.bindPhoneWeapp。
 * 号码属于同一个人的 App 账号时云端会合并（merged），此时失效全部请求缓存。
 */
export async function bindPhoneWeapp (code: string): Promise<{ merged: boolean }> {
  assertCanWrite()
  const res = await getClient().fn.call('user', 'bindPhoneWeapp', { code })
  applyStatus(res)
  if (res.merged) invalidate()
  return { merged: res.merged }
}

/** App 端绑定 / 登录手机号成功后：本机账号状态标记为已实名（云端已在 linkPhoneSession / login 里标记） */
export function markPhoneVerified (): void {
  if (isSignedIn()) useUserStore.getState().patchAccount({ phoneVerified: true })
}
