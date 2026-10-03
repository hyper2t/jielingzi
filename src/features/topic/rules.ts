/**
 * 话题 / 回复表单规则（FE-M3-02 / FE-M3-03）：与云函数 cloudfunctions/community/topics.js 一一对应——同一份常量
 * （constants/community.ts，与 _shared/config.js 由测试比对）、同样的清洗方式、同样的提示文案。发布前前端先拦一次，后端仍会再校验。
 * 正文「有效字数」不含空白（防空格凑数）；字数按 Unicode 码点计（emoji、生僻字算 1 个）。
 */
import { DAILY_LIMITS, TEXT_RULES, TOPIC_RULES } from '@/constants/community'
import { INVISIBLE_RE, lineError, normalizeLine, textLength } from '@/features/profile/rules'
import type { TopicInput } from '@/types/models'
import { errorCode, userFacingMessage } from '@/services/errors'
import { ERROR_CODES } from '@/services/cloud.types'
import { getItem, removeItem, setItem, STORAGE_KEYS } from '@/utils/storage'

/** 多行正文清洗：统一换行、去行尾空白、3 个以上连续换行折叠为 2 个（与云函数一致） */
export const normalizeBody = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

/** 有效字数：不含任何空白 */
export const effectiveLength = (s: string): number => textLength(s.replace(/\s/g, ''))

function bodyError (label: string, raw: string, { min, max }: { min: number, max: number }): string | undefined {
  if (INVISIBLE_RE.test(raw.replace(/[\t\r\n]/g, ' '))) return `${label}含有不支持的字符`
  const text = normalizeBody(raw)
  if (effectiveLength(text) < min) return `${label}至少 ${min} 个字`
  if (textLength(text) > max) return `${label}最多 ${max} 个字`
  return undefined
}

export const titleError = (raw: string): string | undefined => lineError('标题', raw, TEXT_RULES.topicTitle)
export const topicBodyError = (raw: string): string | undefined => bodyError('正文', raw, TEXT_RULES.topicBody)
export const replyError = (raw: string): string | undefined => bodyError('回复', raw, TEXT_RULES.reply)

/** 标签输入框原文 → 标签数组：空格 / 逗号 / 顿号 / # 都是分隔符，去重 */
export function parseTags (raw: string): string[] {
  const out: string[] = []
  raw.split(/[\s,，、;；#＃]+/).map(normalizeLine).filter(Boolean).forEach(t => { if (!out.includes(t)) out.push(t) })
  return out
}

export function tagsError (tags: string[]): string | undefined {
  const clean = tags.map(t => t.replace(/^#+/, ''))
  for (const t of clean) {
    const e = lineError('标签', t, TOPIC_RULES.tag)
    if (e) return e
  }
  if (new Set(clean.map(normalizeLine)).size > TOPIC_RULES.tagsMax) return `标签最多 ${TOPIC_RULES.tagsMax} 个`
  return undefined
}

/** 简短回复：有效字数 < 30（云端以同一规则标记 short，前端默认折叠） */
export const isShortReply = (body: string): boolean => effectiveLength(normalizeBody(body)) < TEXT_RULES.shortReply

export interface TopicForm {
  /** 发布归属；草稿一并保存在本机 */
  circleId?: string
  title: string
  body: string
  /** 标签输入框原文 */
  tags: string
  anon: boolean
}
export type TopicField = 'title' | 'body' | 'tags'
export type TopicErrors = Partial<Record<TopicField, string>>

export const EMPTY_TOPIC_FORM: TopicForm = { title: '', body: '', tags: '', anon: false }

export function isEmptyForm (f: TopicForm): boolean {
  return !f.title.trim() && !f.body.trim() && !f.tags.trim()
}

/** 整表校验：返回各字段的第一条错误（没有错误为空对象） */
export function validateTopicForm (f: TopicForm): TopicErrors {
  const errors: TopicErrors = {}
  const t = titleError(f.title)
  if (t) errors.title = t
  const b = topicBodyError(f.body)
  if (b) errors.body = b
  const g = tagsError(parseTags(f.tags))
  if (g) errors.tags = g
  return errors
}

/** 校验云函数入参（mock 云端用，与云函数同一顺序：标题 → 正文 → 标签） */
export function topicInputError (input: TopicInput): string | undefined {
  return titleError(input.title) || topicBodyError(input.body) || tagsError(input.tags || [])
}

export function toTopicInput (f: TopicForm): TopicInput {
  return { ...(f.circleId ? { circleId: f.circleId } : {}), title: normalizeLine(f.title), body: normalizeBody(f.body), anon: f.anon, tags: parseTags(f.tags) }
}

/** 正文字数提示：还差多少 / 已达标（有效字数，不含空白） */
export function bodyCounter (body: string): { count: number, min: number, max: number, ok: boolean, hint: string } {
  const { min, max } = TEXT_RULES.topicBody
  const count = effectiveLength(normalizeBody(body))
  const ok = count >= min && textLength(normalizeBody(body)) <= max
  const hint = count >= min ? `${count} 字` : `${count} / 至少 ${min} 字`
  return { count, min, max, ok, hint }
}

/** 列表 / 引用里的摘要：折叠空白、按码点截断 */
export function clip (s: string, n: number): string {
  const chars = Array.from(s.replace(/\s+/g, ' ').trim())
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : chars.join('')
}

/** 发帖时间：刚刚 / N 分钟前 / N 小时前 / MM-DD（跨年带年份） */
export function formatPostTime (ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts)
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  const d = new Date(ts)
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()}-${md}`
}

export const TOPIC_LIMIT_TEXT = `今天最多发起 ${DAILY_LIMITS.createTopic} 条话题，明天再来`
export const REPLY_LIMIT_TEXT = `今天最多回复 ${DAILY_LIMITS.createReply} 条，明天再来`

/** 发布失败的提示：额度用尽说清上限；参数错误（含机审拒绝）云端给的是中文说明，直接透出 */
export function publishError (e: unknown, kind: 'topic' | 'reply'): string {
  if (errorCode(e) === ERROR_CODES.TOO_MANY) return kind === 'topic' ? TOPIC_LIMIT_TEXT : REPLY_LIMIT_TEXT
  return userFacingMessage(e)
}

interface ReplyLike { id: string, short: boolean, folded: boolean, pending: boolean, author: { isSelf?: boolean } }
export type ReplyRow<T extends ReplyLike> = { kind: 'reply', reply: T } | { kind: 'fold', id: string, count: number }

/** 可被折叠的简短回复：短、没被举报折叠、不是待审、不是我自己发的（刚发的回复不应该消失） */
const foldable = (r: ReplyLike) => r.short && !r.folded && !r.pending && r.author.isSelf !== true

/**
 * 简短回复折叠（PRD T3）：连续的简短回复合并成一行「展开 N 条简短回复」，id = 这一段第一条回复的 id；
 * expanded 里有该 id 就展开显示原回复。
 */
export function foldShortReplies<T extends ReplyLike> (list: T[], expanded: ReadonlySet<string>): Array<ReplyRow<T>> {
  const rows: Array<ReplyRow<T>> = []
  let run: T[] = []
  const flush = () => {
    if (!run.length) return
    if (expanded.has(run[0].id)) run.forEach(reply => rows.push({ kind: 'reply', reply }))
    else rows.push({ kind: 'fold', id: run[0].id, count: run.length })
    run = []
  }
  for (const r of list) {
    if (foldable(r)) run.push(r)
    else { flush(); rows.push({ kind: 'reply', reply: r }) }
  }
  flush()
  return rows
}

// ---------- 本地草稿（FE-M3-02）：只存在本机，发布成功后删除 ----------

export interface TopicDraft extends TopicForm { savedAt: number }

export function loadDraft (): TopicDraft | null {
  const d = getItem<Partial<TopicDraft> | undefined>(STORAGE_KEYS.topicDraft)
  if (!d || typeof d !== 'object') return null
  const form: TopicForm = {
    circleId: typeof d.circleId === 'string' && d.circleId ? d.circleId : undefined,
    title: typeof d.title === 'string' ? d.title : '',
    body: typeof d.body === 'string' ? d.body : '',
    tags: typeof d.tags === 'string' ? d.tags : '',
    anon: d.anon === true
  }
  return isEmptyForm(form) ? null : { ...form, savedAt: typeof d.savedAt === 'number' ? d.savedAt : 0 }
}

/** 内容为空时直接删除草稿（不留空壳） */
export function saveDraft (f: TopicForm, now: number = Date.now()): void {
  if (isEmptyForm(f)) { removeItem(STORAGE_KEYS.topicDraft); return }
  setItem(STORAGE_KEYS.topicDraft, { ...(f.circleId ? { circleId: f.circleId } : {}), title: f.title, body: f.body, tags: f.tags, anon: f.anon, savedAt: now })
}

export function clearDraft (): void {
  removeItem(STORAGE_KEYS.topicDraft)
}
