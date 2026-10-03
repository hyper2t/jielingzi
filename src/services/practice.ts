/** practice 云函数服务（M5）：私人打卡和仅本人的月度记录。 */
import type { CheckinMonth, PracticeCheckinInput, PromptAnswer, PromptAnswerInput, PromptAnswerPage, PromptToday } from '@/types/models'
import { canSync, isAdultConfirmed } from '@/store/user'
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