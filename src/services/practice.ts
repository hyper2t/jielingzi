/** practice 云函数服务（M5）：私人打卡和仅本人的月度记录；M6 加每日一题与站内消息（都只按当前账号读写）。 */
import type { CheckinMonth, MarkReadResult, NotificationPage, PracticeCheckinInput, PromptAnswer, PromptAnswerInput, PromptAnswerPage, PromptToday } from '@/types/models'
import { canSync, isAdultConfirmed } from '@/store/user'
import { invalidate } from '@/hooks/requestCache'
import { assertCanWrite } from './guard'
import { getClient } from './client'

/** 今日题目的请求 key：卡片与作答页共用（门禁变化时 key 由 null 变有值，触发首次请求） */
export const TODAY_PROMPT_KEY = 'practice:todayPrompt'

export async function checkin (input: PracticeCheckinInput) {
  assertCanWrite()
  return getClient().fn.call('practice', 'checkin', input)
}

/** 未通过同意 / 登录 / 18+ 门禁时不发身份请求，页面仍可展示本机待同步记录。 */
export async function listCheckins (month: string): Promise<CheckinMonth> {
  if (!canSync() || !isAdultConfirmed()) return { month, list: [], totalMinutes: 0 }
  return getClient().fn.call('practice', 'listCheckins', { month })
}

/**
 * 今日题目（M6）：门禁未过时按「今日无题目」返回，练习 Tab 据此隐藏卡片，与 listCheckins 同策略。
 * 服务端只认当日 `status: 'ok'` 的题目，前端不缓存题目以外的字段。
 */
export async function todayPrompt (): Promise<PromptToday> {
  if (!canSync() || !isAdultConfirmed()) return { prompt: null }
  return getClient().fn.call('practice', 'todayPrompt', {})
}

/** 作答每日一题：写动作（需已过同意 / 登录门禁）；服务端再校验 18+ / 实名 / 禁言 / 每日额度 */
export async function answerPrompt (input: PromptAnswerInput): Promise<{ answer: PromptAnswer }> {
  assertCanWrite()
  return getClient().fn.call('practice', 'answerPrompt', input)
}

/**
 * 他人回答：服务端要求「本人已作答」，否则 40301；未作答时页面不该请求（这里也兜一层，
 * 门禁未过时返回空页，size=0 表示「没发过请求」）。
 */
export async function listAnswers (promptId: string, page = 1): Promise<PromptAnswerPage> {
  if (!canSync() || !isAdultConfirmed()) return { promptId, date: '', page, size: 0, hasMore: false, list: [], mine: null }
  return getClient().fn.call('practice', 'listAnswers', { promptId, page })
}
/** 消息列表的请求 key：消息页第一页与「我的」入口的未读数共用（标记已读后一起失效） */
export const NOTIFICATIONS_KEY = 'practice:notifications'
/** 入口只要未读数，取一页一条就够（服务端在同一份响应里带 unread，不必多一个动作） */
export const NOTIFICATIONS_ENTRY_SIZE = 1

/**
 * 站内消息分页（FE-M6-03）：门禁未过时按「空列表」返回，页面照常渲染但不发请求
 * （服务端同样会 40303，这里只是省一次往返），与 listCheckins / todayPrompt 同策略。
 */
export async function listNotifications (page = 1, size?: number): Promise<NotificationPage> {
  const empty: NotificationPage = { page, size: size ?? 0, hasMore: false, unread: 0, list: [] }
  if (!canSync() || !isAdultConfirmed()) return empty
  return getClient().fn.call('practice', 'listNotifications', { page, ...(size ? { size } : {}) })
}

/** 「我的」入口用：第一页响应里的未读数（红点与 tabBar 角标同源，不另开动作） */
export async function notificationsUnread (): Promise<number> {
  const r = await listNotifications(1, NOTIFICATIONS_ENTRY_SIZE)
  return r.unread
}

/**
 * 标记已读：不传 ids 就是「全部」。这是写动作（未同意 / 未登录时不发），
 * 成功后清掉列表缓存，让「我的」的未读数与角标在下次取数时拿到新值。
 */
export async function markNotificationsRead (ids?: string[]): Promise<MarkReadResult> {
  assertCanWrite()
  // 只有「没给 ids」才是全部已读；给了空数组要让云端按 40001 挡下（前端不替调用方改语义）
  const r = await getClient().fn.call('practice', 'markNotificationsRead', ids === undefined ? { all: true } : { ids })
  invalidate(NOTIFICATIONS_KEY)
  return r
}

/**
 * 上报一次订阅授权（D09b）：只在小程序真的弹过授权后调用，同意就换一次发送额度。
 * 这里不吞错也不 assertCanWrite——被禁言的用户照样该把 openid 记上；静默交给调用方（subscribe.ts）。
 */
export async function recordPromptSubscription (granted: boolean) {
  return getClient().fn.call('practice', 'recordPromptSubscription', { granted })
}
