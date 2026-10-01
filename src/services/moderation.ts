/**
 * 内容安全服务（moderation 云函数，docs/api/moderation.md，M2）。
 * - report：举报（FE-M2-01 ReportSheet 调用）；需已同意（App 还需已登录），云端另要求 18+
 * - getQueue / decide：审核页（FE-M2-02，pkg-admin），云端只允许 mod / admin（40301）
 */
import type { ModDecision, ReportTarget } from '@/types/models'
import type { ReportReasonId } from '@/constants/moderation'
import { getClient } from './client'
import { assertCanWrite } from './guard'

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
