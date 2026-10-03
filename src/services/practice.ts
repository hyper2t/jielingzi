/** practice 云函数服务（M5）：私人打卡和仅本人的月度记录。 */
import type { CheckinMonth, PracticeCheckinInput } from '@/types/models'
import { canSync, isAdultConfirmed } from '@/store/user'
import { assertCanWrite } from './guard'
import { getClient } from './client'

export async function checkin (input: PracticeCheckinInput) {
  assertCanWrite()
  return getClient().fn.call('practice', 'checkin', input)
}

/** 未通过同意 / 登录 / 18+ 门禁时不发身份请求，页面仍可展示本机待同步记录。 */
export async function listCheckins (month: string): Promise<CheckinMonth> {
  if (!canSync() || !isAdultConfirmed()) return { month, list: [], totalMinutes: 0 }
  return getClient().fn.call('practice', 'listCheckins', { month })
}
