/**
 * 社区服务（community 云函数，docs/api/community.md）。M1：练习档案（docs/api/profile.md，FE-M1-03）。
 * - 读：未同意 / App 未登录时不发请求，直接返回 null（与 services/me.ts 同一规则）
 * - 写：assertCanWrite 拦截未同意 / 未登录；成功后刷新档案缓存
 * 页面取数：useRequest(ready ? PROFILE_KEY : null, getProfile)
 */
import Taro from '@tarojs/taro'
import type { Circle, CircleDetail, Invite, InviteList, Profile, ProfilePatch, Reply, ReplyInput, TopicDetail, TopicInput, TopicSummary } from '@/types/models'
import { INVITE_RULES } from '@/constants/community'
import { normalizeInviteCode } from '@/features/circle/rules'
import { canSync, isAdultConfirmed } from '@/store/user'
import { invalidate } from '@/hooks/requestCache'
import { getClient } from './client'
import { assertCanWrite } from './guard'
import { CloudError, ERROR_CODES } from './cloud.types'

/** 本人档案的请求缓存 key */
export const PROFILE_KEY = 'me:profile'

/** 圈子与本人邀请码的请求缓存 key */
export const CIRCLES_KEY = 'circles:all'
export const INVITES_KEY = 'invites:mine'
export const circleKey = (id: string) => `circle:${id}`

export async function getProfile (): Promise<Profile | null> {
  if (!canSync()) return null
  const res = await getClient().fn.call('community', 'getProfile')
  return res.profile
}

/** 全部开放圈子；未满足社区读取门槛时不发请求 */
export async function listCircles (): Promise<Circle[]> {
  if (!canReadCommunity()) return []
  const res = await getClient().fn.call('community', 'listCircles')
  return res.list
}

/** 圈子详情（含公约）；没有读取权限时返回 null */
export async function getCircle (id: string): Promise<CircleDetail | null> {
  if (!canReadCommunity()) return null
  const res = await getClient().fn.call('community', 'getCircle', { id })
  return res.circle
}

/** 我的剩余名额与邀请码；云端会在读取时懒初始化名额并回收过期码 */
export async function listInvites (): Promise<InviteList> {
  if (!canReadCommunity()) return { quota: 0, ttlDays: INVITE_RULES.ttlDays, list: [] }
  return getClient().fn.call('community', 'listInvites')
}

function invalidateCircleViews (): void {
  invalidate('circles:')
  invalidate('circle:')
  invalidate(INVITES_KEY)
  touchFeed()
}

/** 为已加入的圈子签发邀请码；成功后失效圈子 / 邀请缓存并刷新话题流 */
export async function createInvite (circleId: string): Promise<{ invite: Invite, quota: number }> {
  assertCanWrite()
  const res = await getClient().fn.call('community', 'createInvite', { circleId })
  invalidateCircleViews()
  return res
}

/** 规范化后兑换邀请码；成功后失效圈子 / 邀请缓存并刷新话题流 */
export async function redeemInvite (rawCode: string): Promise<{ circle: Circle, joined: true }> {
  assertCanWrite()
  const code = normalizeInviteCode(rawCode)
  const res = await getClient().fn.call('community', 'redeemInvite', { code })
  invalidateCircleViews()
  return res
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

// ---------------------------------------------------------------------------------------------
// 深度话题与回复（M3，docs/api/community.md）
// - 读：未同意 / App 未登录 / 未确认 18+ 时不发请求（云端读也要求 18+，否则 40303），返回空
// - 写：assertCanWrite 拦截未同意 / 未登录；成功后让话题流重新取数
// ---------------------------------------------------------------------------------------------

/** 话题流 / 回复列表条目：加上 usePaged 要求的 _id（= 接口的 id） */
export type TopicCard = TopicSummary & { _id: string }
export type ReplyItem = Reply & { _id: string }

export interface PagedResult<T> { list: T[], total: number, hasMore: boolean }

/** 话题详情的请求缓存 key */
export const topicKey = (id: string) => `topic:${id}`

/** 话题流版本：发布 / 删除后加 1，首页回到前台时据此决定是否重新取数（不依赖下拉刷新） */
let feedVersion = 0
export const getFeedVersion = () => feedVersion
const touchFeed = () => { feedVersion += 1 }

/** 当前能否读社区内容：已同意（App 还需登录）且已确认 18+ */
export function canReadCommunity (): boolean {
  return canSync() && isAdultConfirmed()
}

export const FEED_PAGE_SIZE = 20
export const REPLY_PAGE_SIZE = 30

export async function listTopics (page = 1, size = FEED_PAGE_SIZE, circleId?: string): Promise<PagedResult<TopicCard>> {
  if (!canReadCommunity()) return { list: [], total: 0, hasMore: false }
  const res = await getClient().fn.call('community', 'listTopics', { page, size, ...(circleId ? { circleId } : {}) })
  return { list: res.list.map(t => ({ ...t, _id: t.id })), total: res.total, hasMore: res.hasMore }
}

/** 话题详情；没有读权限时返回 null */
export async function getTopic (id: string): Promise<TopicDetail | null> {
  if (!canReadCommunity()) return null
  const res = await getClient().fn.call('community', 'getTopic', { id })
  return res.topic
}

export async function listReplies (topicId: string, page = 1, size = REPLY_PAGE_SIZE): Promise<PagedResult<ReplyItem>> {
  if (!canReadCommunity()) return { list: [], total: 0, hasMore: false }
  const res = await getClient().fn.call('community', 'listReplies', { topicId, page, size })
  return { list: res.list.map(r => ({ ...r, _id: r.id })), total: res.total, hasMore: res.hasMore }
}

/** 发起话题：status = pending 表示机审待复核（只有本人看得到） */
export async function createTopic (input: TopicInput): Promise<{ status: 'ok' | 'pending', topic: TopicDetail, remaining: number }> {
  assertCanWrite()
  const res = await getClient().fn.call('community', 'createTopic', input)
  touchFeed()
  return res
}

export async function createReply (input: ReplyInput): Promise<{ status: 'ok' | 'pending', reply: Reply, remaining: number }> {
  assertCanWrite()
  const res = await getClient().fn.call('community', 'createReply', input)
  invalidate(topicKey(input.topicId))
  touchFeed()
  return res
}

/** 删除自己的话题 / 回复（软删除，幂等） */
export async function deleteMine (type: 'topic' | 'reply', id: string): Promise<{ changed: boolean }> {
  assertCanWrite()
  const res = await getClient().fn.call('community', 'deleteMine', { type, id })
  if (type === 'topic') invalidate(topicKey(id))
  touchFeed()
  return { changed: res.changed }
}
