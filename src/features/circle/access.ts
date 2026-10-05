/** 圈子页面共用的社区读取门槛：同意协议 →（App）登录 → 确认 18+。 */
import { ensureAdult } from '@/features/auth/gates'
import { ensureSignedIn, gateActionText, loginGate } from '@/features/auth/require-login'
import { HAS_LOGIN, useUserStore } from '@/store/user'

export function useCircleAccess (reason = '浏览圈子') {
  const consent = useUserStore(s => s.consent)
  const signedIn = useUserStore(s => s.auth.signedIn)
  const adult = useUserStore(s => s.adult)
  const account = useUserStore(s => s.account)
  const gate = loginGate(consent, !HAS_LOGIN || signedIn)
  const adultOk = adult === 'confirmed' || account?.adult === true

  return {
    gate,
    adultOk,
    ready: !gate && adultOk,
    actionText: gate ? gateActionText(gate) : '去确认',
    onAction: () => {
      if (gate) ensureSignedIn({ reason })
      else ensureAdult({ reason })
    }
  }
}
