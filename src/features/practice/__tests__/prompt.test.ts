/**
 * FE-M6-00 / 01：每日一题的前端规则与状态机。
 * 这里的断言锁的是「与云函数同一口径」：字数、默认匿名、可见性提示与错误码到文案的映射。
 */
import { PROMPT_RULES } from '@/constants/community'
import {
  DUPLICATED_TEXT, LIMIT_TEXT, NEED_ANSWER_TEXT, PENDING_TAG,
  answerAuthorText, answerCounter, promptCtaOf, promptError, promptStateOf, promptTagOf, validatePromptAnswer
} from '@/features/practice/prompt'
import { CloudError, ERROR_CODES } from '@/services/cloud.types'
import type { PromptAnswerItem, PromptToday } from '@/types/models'

const today = (over: Partial<NonNullable<PromptToday['prompt']>> = {}): PromptToday => ({
  prompt: { id: 'p1', date: '2026-10-03', text: '题目', answered: false, myStatus: null, answerCount: 0, ...over }
})
const item = (over: Partial<PromptAnswerItem> = {}): PromptAnswerItem => ({
  id: 'a1', date: '2026-10-03', text: '回答', status: 'ok', createdAt: 0,
  authorName: '竹影', anon: true, isSelf: false, deleted: false, ...over
})

describe('promptStateOf 卡片状态机', () => {
  it('无题目（含门禁未过、当日未录入）→ none', () => {
    expect(promptStateOf(null)).toBe('none')
    expect(promptStateOf(undefined)).toBe('none')
    expect(promptStateOf({ prompt: null })).toBe('none')
  })
  it('未作答 / 已作答 / 待复核', () => {
    expect(promptStateOf(today())).toBe('unanswered')
    expect(promptStateOf(today({ answered: true, myStatus: 'ok' }))).toBe('answered')
    expect(promptStateOf(today({ answered: true, myStatus: 'pending' }))).toBe('pending')
  })
  it('标签与 CTA 随状态变化：待复核不算「已作答」，但同样能看到他人回答', () => {
    expect(promptTagOf('unanswered')).toBe('')
    expect(promptTagOf('answered')).toBe('已作答')
    expect(promptTagOf('pending')).toBe(PENDING_TAG)
    expect(promptCtaOf('unanswered')).toBe('写下今天的回答')
    expect(promptCtaOf('answered')).toBe('看看其他人的回答')
    expect(promptCtaOf('pending')).toBe('看看其他人的回答')
  })
})

describe('validatePromptAnswer / answerCounter', () => {
  it('与云函数同口径：去首尾空白后 5–500 字', () => {
    const { min, max } = PROMPT_RULES.answer
    expect(validatePromptAnswer('一二三四')).toContain(`至少 ${min} 个字`)
    expect(validatePromptAnswer('   ')).toContain(`至少 ${min} 个字`)
    expect(validatePromptAnswer('一二三四五')).toBeNull()
    expect(validatePromptAnswer(`  一二三四五  `)).toBeNull()
    expect(validatePromptAnswer('字'.repeat(max))).toBeNull()
    expect(validatePromptAnswer('字'.repeat(max + 1))).toContain(`最多 ${max} 个字`)
  })
  it('计数器按去空白后的长度统计', () => {
    const max = PROMPT_RULES.answer.max
    expect(answerCounter('  今天很好  ')).toEqual({ len: 4, hint: `4/${max}` })
    expect(answerCounter('')).toEqual({ len: 0, hint: `0/${max}` })
  })
})

describe('promptError', () => {
  it('40901 / 42901 / 40301 各给明确的下一步', () => {
    expect(promptError(new CloudError(ERROR_CODES.CONFLICT, 'x'))).toBe(DUPLICATED_TEXT)
    expect(promptError(new CloudError(ERROR_CODES.TOO_MANY, 'x'))).toBe(LIMIT_TEXT)
    expect(promptError(new CloudError(ERROR_CODES.FORBIDDEN, 'x'))).toBe(NEED_ANSWER_TEXT)
  })
  it('其它错误回落到通用文案，不抛出对象', () => {
    expect(promptError(new Error('boom'))).not.toBe(DUPLICATED_TEXT)
    expect(promptError({ code: ERROR_CODES.CONFLICT })).toBe(DUPLICATED_TEXT)
    expect(typeof promptError(null)).toBe('string')
    expect(promptError(null)).toBeTruthy()
  })
})

describe('answerAuthorText 展示形态', () => {
  it('匿名给代号、实名给昵称、本人标「你」、注销标「已注销用户」', () => {
    expect(answerAuthorText(item())).toBe('匿名 · 竹影')
    expect(answerAuthorText(item({ anon: false }))).toBe('竹影')
    expect(answerAuthorText(item({ isSelf: true }))).toBe('你')
    expect(answerAuthorText(item({ isSelf: true, status: 'pending' }))).toBe(`你 · ${PENDING_TAG}`)
    expect(answerAuthorText(item({ deleted: true, authorName: '' }))).toBe('已注销用户')
  })
})
