/**
 * 站内消息的前端规则（FE-M6-03，契约见 docs/api/practice.md「站内消息与每日提醒」）。
 *
 * 分工：消息正文由云端写好（固定说明，不含他人内容原文），前端只补「哪一类 + 什么时候」和能不能点开的判断。
 * 可点与否只看 `refType` / `refId`（不解析 text、也不猜），缺任一项就退成纯文本；
 * 类型的权威定义在云端 `cloudfunctions/_shared/notify.js` 的 `NOTIFY_TYPES`，一致性由
 * `src/services/__tests__/practice-notifications.test.ts` 比对（前端不新增第四类）。
 */
import type { AppNotification, NotificationTarget } from '@/types/models'
import { formatPostTime } from '@/features/topic/rules'

/** 与云端 NOTIFY_TYPES 同序同集合 */
export const NOTIFICATION_TYPES = ['reply', 'moderation', 'prompt'] as const

export const NOTIFICATIONS_TITLE = '消息'
/** 类型标签：读屏与列表左侧都用它，不靠图标表意 */
export const NOTIFICATION_TAGS: Record<(typeof NOTIFICATION_TYPES)[number], string> = {
  reply: '回复',
  moderation: '处理结果',
  prompt: '每日一题',
}
export const UNREAD_TAG = '未读'
export const EMPTY_TEXT = '还没有消息'
/** 门禁未过时的说明（服务端同样会 40303，这里只是少发一次请求） */
export const GATE_TEXT = '确认年满 18 周岁后可查看消息'
export const MARK_ALL_TEXT = '全部标为已读'
export const MARKING_TEXT = '正在标记…'
export const MARKED_TEXT = '已全部标为已读'
export const LOAD_FAIL_TEXT = '消息没能加载出来'
export const MORE_TEXT = '查看更多消息'
/** tabBar 角标最多两位（超过显示 99+），页面内的「N 条未读」不受此限 */
export const TAB_BADGE_MAX = 99
/** 「我的」在 tabBar 里的下标；顺序来自 app.config.ts，用例里钉住 */
export const MINE_TAB_INDEX = 2

export const unreadLabel = (n: number): string => (n > 0 ? `${n} 条未读` : '暂无未读')
export const badgeText = (n: number): string => (n > TAB_BADGE_MAX ? `${TAB_BADGE_MAX}+` : String(n))
export const isUnread = (n: AppNotification): boolean => n.read !== true

/** 时间口径与话题列表一致：共用 formatPostTime，不另写一套 */
export function notificationTime(at: number | null | undefined, now: number = Date.now()): string {
  return typeof at === 'number' && Number.isFinite(at) ? formatPostTime(at, now) : ''
}

/** 未知 type（老数据）不崩，退成「消息」 */
export function notificationTag(type: string): string {
  return (NOTIFICATION_TAGS as Record<string, string>)[type] || NOTIFICATIONS_TITLE
}

/**
 * 点击后去哪：`reply` → 话题详情，`prompt` → 每日一题作答页；`moderation` 只是结果告知，没有对应页面。
 * 返回 null 表示这条不可点。
 */
export function notificationTarget(n: AppNotification): NotificationTarget | null {
  if (!n.refId) return null
  if (n.type === 'reply' && n.refType === 'topic') return { route: 'topic', params: { id: n.refId } }
  if (n.type === 'prompt' && n.refType === 'daily_prompt') return { route: 'prompt', params: { promptId: n.refId } }
  return null
}

/** 追加下一页：按 id 去重（两次请求之间可能有新消息插进来） */
export function mergeNotifications(prev: AppNotification[], next: AppNotification[]): AppNotification[] {
  const seen = new Set(prev.map(n => n.id))
  return [...prev, ...next.filter(n => !seen.has(n.id))]
}

/** 云端确认已读后本地同步（不做乐观更新：失败了前端不能先替云端改状态） */
export function markLocalRead(list: AppNotification[], ids?: string[]): AppNotification[] {
  if (!ids || !ids.length) return list.map(n => ({ ...n, read: true }))
  const hit = new Set(ids)
  return list.map(n => (hit.has(n.id) ? { ...n, read: true } : n))
}
