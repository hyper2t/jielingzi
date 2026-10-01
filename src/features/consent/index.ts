/**
 * 同意流程（用户协议 / 隐私政策）。
 * - 同意：调用 user.consent 写 guardianConsentAt（成功后才置 agreed；App 端只记本机，见 services/me.ts consent）
 *   → 已登录时 login（upsert users，并把云端已保存的设置恢复到本地）→ 业务的「登录后同步」钩子
 * - 拒绝：只改本地状态为 declined，不发任何云端请求；仍可浏览公开内容，数据只存本地。
 * 写入失败时抛出，由 ConsentSheet 提示重试；login / 同步失败不影响已同意状态。
 */
import Taro from '@tarojs/taro'
import { consent, login } from '@/services/me'
import { isAdultConfirmed, isSignedIn, useUserStore } from '@/store/user'
import { runAfterSignIn } from '@/features/auth/after-sign-in'
import { navigate, ROUTES } from '@/utils/router'

/**
 * 同意。App 端：同意只记本机；未登录时不发任何请求，登录后由 features/auth/session.ts completeSignIn 做同样的 login + 同步；
 * 已登录（如「清除本机数据」后重新同意）则和小程序一样立刻 login + 同步。
 */
export async function agree (): Promise<void> {
  await consent()
  useUserStore.getState().closeConsentSheet()
  if (isSignedIn()) {
    try {
      await login()
      await runAfterSignIn()
    } catch (e) {
      console.warn('[consent] 同意后同步失败，稍后重试', e)
    }
  }
}

export function decline (): void {
  const s = useUserStore.getState()
  s.setConsent('declined')
  s.closeConsentSheet()
}

/**
 * 首次进入流程的下一步（PRD §7.6：同意书 → 18+ 确认 →（App）登录）：同意后若还没确认 18+，进 18+ 确认页。
 * 当前已在 18+ 确认页（在那里打开的同意弹层）时不重复跳转。
 */
export function continueFirstEntry (): void {
  if (isAdultConfirmed()) return
  const pages = Taro.getCurrentPages() as Array<{ route?: string }>
  const current = pages.length ? pages[pages.length - 1]?.route || '' : ''
  if (current && ROUTES.adult.endsWith(current)) return
  void navigate('adult', {})
}
