/**
 * 社区服务（community 云函数，docs/api/community.md）。M1：练习档案（docs/api/profile.md，FE-M1-03）。
 * - 读：未同意 / App 未登录时不发请求，直接返回 null（与 services/me.ts 同一规则）
 * - 写：assertCanWrite 拦截未同意 / 未登录；成功后刷新档案缓存
 * 页面取数：useRequest(ready ? PROFILE_KEY : null, getProfile)
 */
import Taro from '@tarojs/taro'
import type { Profile, ProfilePatch } from '@/types/models'
import { canSync } from '@/store/user'
import { invalidate } from '@/hooks/requestCache'
import { getClient } from './client'
import { assertCanWrite } from './guard'
import { CloudError, ERROR_CODES } from './cloud.types'

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

/** 头像图片上限（与云函数 _shared/media.js MAX_IMAGE_BYTES 一致） */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024

/** 当前端能否上传头像（App 暂未接入存储上传，只能选预置头像） */
export function canUploadAvatar (): boolean {
  return !!getClient().storage
}

const rand = () => Math.random().toString(36).slice(2, 10)

/**
 * 选图 → 传到 uploads/avatar/<年月>/<随机名> → community.setAvatar 登记并机审（BE-M2-02）。
 * 返回 null 表示用户取消选图；审核通过前头像只在 avatarPending（只有本人看得到）。
 */
export async function uploadAvatar (): Promise<{ status: 'pending' | 'review', profile: Profile } | null> {
  assertCanWrite()
  const storage = getClient().storage
  if (!storage) throw new CloudError(ERROR_CODES.NOT_READY, '当前端暂不支持上传头像')
  let picked: any
  try {
    picked = await Taro.chooseImage({ count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'] })
  } catch (e: any) {
    if (/cancel/i.test(String(e?.errMsg || e?.message || ''))) return null
    throw new CloudError(ERROR_CODES.BAD_PARAM, '没能读取图片，请重试')
  }
  const file = picked?.tempFiles?.[0]
  const path: string | undefined = file?.path || picked?.tempFilePaths?.[0]
  if (!path) return null
  if (typeof file?.size === 'number' && file.size > AVATAR_MAX_BYTES) throw new CloudError(ERROR_CODES.BAD_PARAM, '图片不能超过 2MB')
  const ext = (/\.(png|webp|gif|jpe?g)(\?|$)/i.exec(path)?.[1] || 'jpg').toLowerCase().replace('jpeg', 'jpg')
  const d = new Date()
  const month = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
  const cloudPath = `uploads/avatar/${month}/${Date.now().toString(36)}${rand()}${rand()}.${ext}`
  const fileID = await storage.upload(path, cloudPath, file?.originalFileObj)
  const res = await getClient().fn.call('community', 'setAvatar', { fileID })
  invalidate(PROFILE_KEY)
  return res
}
