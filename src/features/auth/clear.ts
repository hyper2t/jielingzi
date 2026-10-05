/**
 * 清空本机数据并回到首次流程（退出 / 注销后复用）。
 * keepAuth（默认 true）：保留登录会话；false：连登录态一起清（注销，见 features/auth/account.ts）。
 * 登录态在 store 里的镜像由 store/hydrate 的 readAuth 规则决定：保留时不变，清除时置为未登录。
 * 业务如需「删除云端数据但保留账号」，在业务云函数实现 clearData 后于此处先调用（luming 的 me.clearData 模式）。
 */
import Taro from '@tarojs/taro'
import { useUserStore } from '@/store/user'
import { useSettingsStore } from '@/store/settings'
import { invalidate } from '@/hooks/requestCache'
import { clearAll, flushStorage, STORAGE_KEYS } from '@/utils/storage'
import { buildUrl } from '@/utils/router'
import { resetPracticeTimer } from '@/features/practice/timer'
import { resetPracticeOwnerCache } from '@/features/practice/checkins'

/** 跨 clearAll 保留的 key（App 端登录态与设备号） */
const AUTH_KEYS = [STORAGE_KEYS.authSession, STORAGE_KEYS.authProfile, STORAGE_KEYS.deviceId]

export const CLEAR_CONFIRM = '将清除本机缓存、设置、同意记录及尚未同步的练习记录；账号与云端数据保留'

export async function resetLocalData (opts: { keepAuth?: boolean } = {}): Promise<void> {
  const keepAuth = opts.keepAuth !== false
  clearAll(keepAuth ? { keep: AUTH_KEYS } : {})
  resetPracticeTimer()
  resetPracticeOwnerCache()
  await flushStorage()
  invalidate()
  // 18+ 确认与账号状态镜像随本机数据一起清掉（重新走首次进入流程；账号状态在下次 login 时从云端恢复）
  useUserStore.setState({ consent: 'unknown', sheetOpen: false, sheetReason: undefined, adult: 'unknown', account: null, phoneSheetOpen: false, phoneSheetReason: undefined, ...(keepAuth ? {} : { auth: { signedIn: false } }) })
  useSettingsStore.getState().reset()
  await Taro.reLaunch({ url: buildUrl('index') })
}
