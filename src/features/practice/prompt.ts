/**
 * 每日一题的前端规则与展示口径（FE-M6-00 / 01，PRD W3）。
 * 校验与云函数 `cloudfunctions/practice/service.js` 同源：只读 `PROMPT_RULES`（权威定义在 `_shared/config.js`，
 * 一致性由 src/constants/__tests__/community.test.ts 比对），前端拦一遍只为少发一次请求，云端仍会再校验。
 */
import { ERROR_CODES } from '@/services/cloud.types'
import { errorCode, userFacingMessage } from '@/services/errors'
import { PROMPT_RULES } from '@/constants/community'
import type { PromptAnswerItem, PromptToday } from '@/types/models'

export const PROMPT_CARD_TITLE = '每日一题'
export const PROMPT_PAGE_TITLE = '每日一题'
export const ANSWER_CTA = '写下今天的回答'
export const ANSWERED_CTA = '看看其他人的回答'
export const ANSWERED_TAG = '已作答'
export const PENDING_TAG = '审核中'
export const PENDING_HINT = '你的回答已提交，审核通过后其他人才能看到'
export const SUBMIT_TEXT = '提交回答'
export const SUBMITTED_TEXT = '已提交，别人能看到你的回答'
/** showToast 只允许 8 字以内（components/Toast），长句留在页面里显示 */
export const SUBMITTED_TOAST = '已提交'
export const PENDING_TOAST = '待审核'
export const DUPLICATED_TEXT = '今天已经作答过了，明天再来'
export const LIMIT_TEXT = '每日一题每天只能作答一次，明天再来'
export const NEED_ANSWER_TEXT = '作答后即可查看他人的回答'
export const ANSWER_LABEL = '我的回答'
export const ANON_LABEL = '匿名回答'
export const ANON_HINT = '别人只看到匿名代号，不显示头像和档案；切到实名会显示昵称'
export const MORE_TEXT = '查看更多回答'
export const UNANSWERED_HINT = '作答后可见其他人的回答'
export const EMPTY_ANSWERS_TEXT = '还没有其他人作答，做第一个分享的人'
/** 卡片上的回答数文案：服务端按答案条数统计（含本人那条，一人一题只有一条），故写作「条」 */
export const answerCountText = (n: number) => `${n} 条回答`

export type PromptState = 'none' | 'unanswered' | 'answered' | 'pending'

/** 卡片状态机：无题目（含门禁未过）/ 未作答 / 已作答 / 待复核 */
export function promptStateOf (today: PromptToday | null | undefined): PromptState {
  const prompt = today && today.prompt
  if (!prompt) return 'none'
  if (!prompt.answered) return 'unanswered'
  return prompt.myStatus === 'pending' ? 'pending' : 'answered'
}

export function promptTagOf (state: PromptState): string {
  if (state === 'pending') return PENDING_TAG
  if (state === 'answered') return ANSWERED_TAG
  return ''
}

export function promptCtaOf (state: PromptState): string {
  return state === 'unanswered' ? ANSWER_CTA : ANSWERED_CTA
}

/** 与云函数 validateAnswer 同口径：去首尾空白后 5–500 字 */
export function validatePromptAnswer (text: string): string | null {
  const len = String(text || '').trim().length
  const { min, max } = PROMPT_RULES.answer
  if (len < min) return `至少 ${min} 个字（${len}/${min}）`
  if (len > max) return `最多 ${max} 个字（${len}/${max}）`
  return null
}

export function answerCounter (text: string): { len: number, hint: string } {
  const len = String(text || '').trim().length
  return { len, hint: `${len}/${PROMPT_RULES.answer.max}` }
}

/**
 * 服务端错误 → 界面文案。
 * 每日一题专属的三个码给「下一步做什么」（重复作答 / 今日额度 / 未作答先看），其余走通用映射：
 * 参数类错误（含机审拒绝）透出云函数的中文说明，其它码不外露英文串。
 */
export function promptError (e: unknown): string {
  const code = errorCode(e)
  if (code === ERROR_CODES.CONFLICT) return DUPLICATED_TEXT
  if (code === ERROR_CODES.TOO_MANY) return LIMIT_TEXT
  if (code === ERROR_CODES.FORBIDDEN) return NEED_ANSWER_TEXT
  return userFacingMessage(e)
}

/** 列表条目：自己的那条带「（你）」与状态，他人的按匿名 / 实名形态展示 */
export function answerAuthorText (item: PromptAnswerItem): string {
  if (item.isSelf) return `你${item.status === 'pending' ? ` · ${PENDING_TAG}` : ''}`
  if (item.deleted) return '已注销用户'
  return item.anon ? `匿名 · ${item.authorName}` : item.authorName
}
