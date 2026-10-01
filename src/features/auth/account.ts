/**
 * 退出登录与注销账号（FE-L04，决策 L9）。
 * - signOut：撤销会话（尽力）→ 清本地登录态 → 失效缓存。本机的同意状态、设置、本地进度保留（换个账号登录时进度会再补传一次）。
 * - deleteAccount：user.deleteAccount（删云端 favorites / play_progress / users / account_links）→ DELETE CloudBase 用户（尽力）
 *   → 清空本机全部数据（含登录态）→ 回首页重新走同意流程。云端删除失败时抛出，本地不动，家长可重试。
 *   关联了 Apple ID 的账号（iOS）：先重新走一次 Apple 授权拿 authorizationCode，随注销交给云端撤销 Apple 授权（审核指南 5.1.1(v)）；
 *   家长在 Apple 授权里取消 → 抛 AUTH_CANCELLED，不注销。非 iOS 设备上无法重新授权时照常注销（云端数据同样删除）。
 */
import { CloudError, ERROR_CODES } from '@/services/cloud.types'
import { getClient } from '@/services/client'
import { invalidate } from '@/hooks/requestCache'
import { isSignedIn, useUserStore } from '@/store/user'
import { resetLocalData } from '@/features/parent/clear'
import { track } from '@/utils/track'
import { isAppleLoginAvailable, requestAppleAuth } from './apple'

export const DELETE_ACCOUNT_WORD = '注销'
export const DELETE_ACCOUNT_CONFIRM = '注销后将删除该账号在云端的数据和设置，并解除微信 / 手机号 / Apple ID 关联，无法恢复；本机数据也会清空。'

export async function signOut (): Promise<void> {
  const client = getClient()
  const auth = client.auth
  if (auth) await auth.signOut()
  else if (client.signOut) await client.signOut()
  invalidate()
  track('logout', {})
}

/** 输入的确认词是否正确（去掉首尾空白与书名号） */
export function confirmWordOk (input: string): boolean {
  return String(input || '').trim().replace(/[「」『』《》"']/g, '') === DELETE_ACCOUNT_WORD
}

/** 账号关联了 Apple ID 且本机能重新授权时，取一次 authorizationCode 用于撤销；否则 undefined */
async function appleRevokeCode (): Promise<string | undefined> {
  const { auth } = useUserStore.getState()
  if (!(auth.identities?.apple || auth.method === 'apple')) return undefined
  if (!(await isAppleLoginAvailable())) return undefined
  const r = await requestAppleAuth()
  return r.authorizationCode || undefined
}

export async function deleteAccount (): Promise<void> {
  if (!isSignedIn()) throw new CloudError(ERROR_CODES.LOGIN_REQUIRED, '请先登录')
  const client = getClient()
  const appleAuthorizationCode = await appleRevokeCode()
  await client.fn.call('user', 'deleteAccount', appleAuthorizationCode ? { confirm: 'DELETE', appleAuthorizationCode } : { confirm: 'DELETE' })
  if (client.auth) await client.auth.deleteCloudUser()
  track('delete_account', {})
  await resetLocalData({ keepAuth: false })
}
