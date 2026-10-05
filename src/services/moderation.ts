/**
 * 内容安全服务（moderation 云函数，docs/api/moderation.md，M2）。
 * - report：举报（FE-M2-01 ReportSheet 调用）；需已同意（App 还需已登录），云端另要求 18+
 * - getQueue / decide：审核页（FE-M2-02，pkg-admin），云端只允许 mod / admin（40301）
 * - markTopicFeatured：标 / 取消精华（M6 FE-M6-02 → moderation.markFeatured），同样只允许 mod / admin
 */
import type { ModDecision, ReportTarget } from '@/types/models'
import type { ReportReasonId } from '@/constants/moderation'
import { invalidate } from '@/hooks/requestCache'
import { getClient } from './client'
import { assertCanWrite } from './guard'
import { topicKey, touchFeed } from './community'

export function report (target: ReportTarget, reason: ReportReasonId, note?: string) {
  assertCanWrite()
  const input: ReportTarget & { reason: string, note?: string } = { ...target, reason }
  const n = (note || '').trim()
  if (n) input.note = n
  return getClient().fn.call('moderation', 'report', input)
}

export function getQueue (state: 'open' | 'resolved' = 'open', page = 1) {
  return getClient().fn.call('moderation', 'queue', { state, page, size: 20 })
}

export function decide (target: ReportTarget, decision: ModDecision, extra: { days?: number, note?: string } = {}) {
  assertCanWrite()
  return getClient().fn.call('moderation', 'decide', { ...target, decision, ...extra })
}

/** 图片人工复核队列（BE-M2-02，仅 mod / admin） */
export function getMediaQueue (page = 1) {
  return getClient().fn.call('moderation', 'mediaQueue', { page, size: 20 })
}

export function decideMedia (mediaId: string, decision: 'pass' | 'reject', note?: string) {
  assertCanWrite()
  return getClient().fn.call('moderation', 'decideMedia', note ? { mediaId, decision, note } : { mediaId, decision })
}
/**
 * 标 / 取消精华（moderation.markFeatured，M6 BE-M6-02 / FE-M6-02）。只改 topics.featured，不动 status
 * （D12：精华不解除圈子可见性，所以这里不需要任何权限以外的分支）。成功后让该话题的详情缓存失效、
 * 话题流版本号 +1，回到列表就会重新取数、徽标立刻出现。
 */
export async function markTopicFeatured (topicId: string, featured: boolean): Promise<{ ok: true, featured: boolean, changed: boolean }> {
  assertCanWrite()
  const res = await getClient().fn.call('moderation', 'markFeatured', { topicId, featured })
  invalidate(topicKey(topicId))
  touchFeed()
  return res
}
