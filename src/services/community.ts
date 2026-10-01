/**
 * 社区服务（community 云函数，docs/api/community.md）。M1：练习档案（docs/api/profile.md，FE-M1-03）。
 * - 读：未同意 / App 未登录时不发请求，直接返回 null（与 services/me.ts 同一规则）
 * - 写：assertCanWrite 拦截未同意 / 未登录；成功后刷新档案缓存
 * 页面取数：useRequest(ready ? PROFILE_KEY : null, getProfile)
 */
import type { Profile, ProfilePatch } from '@/types/models'
import { canSync } from '@/store/user'
import { invalidate } from '@/hooks/requestCache'
import { getClient } from './client'
import { assertCanWrite } from './guard'

/** 本人档案的请求缓存 key */
export const PROFILE_KEY = 'me:profile'

export async function getProfile (): Promise<Profile | null> {
  if (!canSync()) return null
  const res = await getClient().fn.call('community', 'getProfile')
  return res.profile
}

/** 部分更新档案；需已确认 18+（云端 40303）。返回完整档案 */
export async function updateProfile (patch: ProfilePatch): Promise<Profile> {
  assertCanWrite()
  const res = await getClient().fn.call('community', 'updateProfile', patch)
  invalidate(PROFILE_KEY)
  return res.profile
}
