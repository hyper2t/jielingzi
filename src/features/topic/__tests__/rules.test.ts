/**
 * 话题 / 回复表单规则（FE-M3-02 / 03）。与云函数的一致性：校验用例读 tests/fixtures/topic-validation.json，
 * 云函数侧 tests/cloudfunctions/m3-parity.test.js 读同一份——两边任何一边改了规则或文案，另一边立刻失败。
 */
import * as fs from 'fs'
import * as path from 'path'
import { CloudError, ERROR_CODES } from '@/services/cloud.types'
import { STORAGE_KEYS } from '@/utils/storage'
import Taro from '@tarojs/taro'
import {
  bodyCounter, clearDraft, clip, effectiveLength, EMPTY_TOPIC_FORM, foldShortReplies, formatPostTime, isEmptyForm, isShortReply, loadDraft,
  normalizeBody, parseTags, publishError, REPLY_LIMIT_TEXT, replyError, saveDraft, TOPIC_LIMIT_TEXT, toTopicInput, topicInputError, validateTopicForm
} from '../rules'

type Gen = string | { repeat: string, times: number }
const fx = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../tests/fixtures/topic-validation.json'), 'utf8')) as {
  topics: Array<{ name: string, input: Record<string, Gen | Gen[]>, error: string | null }>
  replies: Array<{ name: string, body: Gen, error: string | null, short?: boolean }>
}
const expand = (v: Gen): string => (typeof v === 'object' ? v.repeat.repeat(v.times) : v)
const expandInput = (o: Record<string, Gen | Gen[]>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.map(expand) : typeof v === 'object' ? expand(v) : v])) as any

describe('与云函数一致的校验用例（共用 fixtures）', () => {
  it.each(fx.topics.map(c => [c.name, c] as const))('话题：%s', (_n, c) => {
    expect(topicInputError(expandInput(c.input)) ?? null).toBe(c.error)
  })
  it.each(fx.replies.map(c => [c.name, c] as const))('回复：%s', (_n, c) => {
    const body = expand(c.body)
    expect(replyError(body) ?? null).toBe(c.error)
    if (c.error === null) expect(isShortReply(body)).toBe(c.short)
  })
})

describe('清洗与字数', () => {
  it('normalizeBody：统一换行、去行尾空白、3 个以上连续换行折叠为 2 个', () => {
    expect(normalizeBody('  第一行  \r\n第二行\t\n\n\n\n第三行  ')).toBe('第一行\n第二行\n\n第三行')
  })
  it('有效字数不含任何空白，按码点计（emoji 算 1 个）', () => {
    expect(effectiveLength(' 静 坐\n\t😀 ')).toBe(3)
  })
  it('bodyCounter：未达标显示「已写 / 至少」，达标只显示字数', () => {
    expect(bodyCounter('静坐')).toMatchObject({ count: 2, ok: false, hint: '2 / 至少 50 字' })
    expect(bodyCounter('静'.repeat(50))).toMatchObject({ count: 50, ok: true, hint: '50 字' })
    expect(bodyCounter('静'.repeat(10001)).ok).toBe(false)
  })
  it('clip：折叠空白后按码点截断', () => {
    expect(clip('一\n二三四五', 4)).toBe('一 二三…')
    expect(clip('一二三四五六', 4)).toBe('一二三四…')
    expect(clip('短', 10)).toBe('短')
  })
})

describe('标签输入', () => {
  it('空格 / 逗号 / 顿号 / # 都是分隔符，去重，保持顺序', () => {
    expect(parseTags('冥想 呼吸,睡眠、冥想 #放松')).toEqual(['冥想', '呼吸', '睡眠', '放松'])
    expect(parseTags('  ')).toEqual([])
    expect(parseTags('#冥想#呼吸')).toEqual(['冥想', '呼吸'])
  })
})

describe('整表校验与入参', () => {
  const ok = { title: '静坐走神怎么办', body: '静'.repeat(60), tags: '冥想 呼吸', anon: true }
  it('通过时返回空对象；各字段分别给第一条错误', () => {
    expect(validateTopicForm(ok)).toEqual({})
    expect(validateTopicForm({ title: '短', body: '少', tags: 'a b c d', anon: false })).toEqual({
      title: '标题至少 5 个字', body: '正文至少 50 个字', tags: '标签最多 3 个'
    })
  })
  it('toTopicInput：标题折叠空白、正文清洗、标签数组化、匿名原样', () => {
    expect(toTopicInput({ title: '  静坐   走神 ', body: ' 正文\r\n\r\n\r\n\r\n结尾 ', tags: '#冥想 呼吸', anon: true }))
      .toEqual({ title: '静坐 走神', body: '正文\n\n结尾', anon: true, tags: ['冥想', '呼吸'] })
  })
})

describe('简短回复折叠（PRD T3）', () => {
  const mk = (id: string, o: Partial<{ short: boolean, folded: boolean, pending: boolean, isSelf: boolean }> = {}) =>
    ({ id, short: false, folded: false, pending: false, ...o, author: { isSelf: !!o.isSelf } })

  it('连续的简短回复合并成一行；长回复把它们分成两段', () => {
    const list = [mk('a', { short: true }), mk('b', { short: true }), mk('c'), mk('d', { short: true })]
    expect(foldShortReplies(list, new Set())).toEqual([
      { kind: 'fold', id: 'a', count: 2 },
      { kind: 'reply', reply: list[2] },
      { kind: 'fold', id: 'd', count: 1 }
    ])
  })
  it('展开某一段后显示原回复，其他段仍折叠', () => {
    const list = [mk('a', { short: true }), mk('b', { short: true }), mk('c'), mk('d', { short: true })]
    const rows = foldShortReplies(list, new Set(['a']))
    expect(rows.map(r => (r.kind === 'reply' ? r.reply.id : `fold:${r.id}`))).toEqual(['a', 'b', 'c', 'fold:d'])
  })
  it('自己发的、待审的、被举报折叠的不进折叠段（刚发的回复不会消失）', () => {
    const list = [mk('a', { short: true, isSelf: true }), mk('b', { short: true, pending: true }), mk('c', { short: true, folded: true })]
    expect(foldShortReplies(list, new Set()).every(r => r.kind === 'reply')).toBe(true)
  })
  it('没有回复 → 没有行', () => {
    expect(foldShortReplies([], new Set())).toEqual([])
  })
})

describe('时间与发布错误', () => {
  const NOW = new Date(2026, 9, 1, 12, 0, 0).getTime()
  it('刚刚 / 分钟 / 小时 / 当年 MM-DD / 跨年带年份', () => {
    expect(formatPostTime(NOW - 30 * 1000, NOW)).toBe('刚刚')
    expect(formatPostTime(NOW - 5 * 60000, NOW)).toBe('5 分钟前')
    expect(formatPostTime(NOW - 3 * 3600000, NOW)).toBe('3 小时前')
    expect(formatPostTime(new Date(2026, 8, 3, 8, 0, 0).getTime(), NOW)).toBe('09-03')
    expect(formatPostTime(new Date(2025, 11, 31, 8, 0, 0).getTime(), NOW)).toBe('2025-12-31')
    expect(formatPostTime(NOW + 5000, NOW)).toBe('刚刚')
  })
  it('额度用尽说清上限；机审拒绝等 40001 直出云端中文；其余走通用文案', () => {
    expect(publishError(new CloudError(ERROR_CODES.TOO_MANY, 'x'), 'topic')).toBe(TOPIC_LIMIT_TEXT)
    expect(publishError(new CloudError(ERROR_CODES.TOO_MANY, 'x'), 'reply')).toBe(REPLY_LIMIT_TEXT)
    expect(TOPIC_LIMIT_TEXT).toContain('2 条')
    expect(REPLY_LIMIT_TEXT).toContain('20 条')
    expect(publishError(new CloudError(ERROR_CODES.BAD_PARAM, '内容不符合社区公约，请修改后再发布'), 'topic')).toBe('内容不符合社区公约，请修改后再发布')
    expect(publishError(new CloudError(ERROR_CODES.MUTED, 'x'), 'reply')).toBe('账号禁言中，暂时不能发布')
  })
})

describe('本地草稿', () => {
  beforeEach(() => { ;(Taro as any).__storage.clear() })
  it('保存 → 读取；清除后为 null', () => {
    expect(loadDraft()).toBeNull()
    saveDraft({ title: '标题', body: '正文', tags: '冥想', anon: true }, 123)
    expect(loadDraft()).toEqual({ title: '标题', body: '正文', tags: '冥想', anon: true, savedAt: 123 })
    clearDraft()
    expect(loadDraft()).toBeNull()
  })
  it('内容全空时直接删除，不留空壳；只改了匿名开关不算有内容', () => {
    saveDraft({ title: '标题', body: '', tags: '', anon: false })
    saveDraft({ ...EMPTY_TOPIC_FORM, anon: true })
    expect((Taro as any).__storage.has(STORAGE_KEYS.topicDraft)).toBe(false)
    expect(isEmptyForm({ ...EMPTY_TOPIC_FORM, anon: true })).toBe(true)
  })
  it('存储里是损坏的数据：当作没有草稿，不抛错', () => {
    ;(Taro as any).setStorageSync(STORAGE_KEYS.topicDraft, 'oops')
    expect(loadDraft()).toBeNull()
    ;(Taro as any).setStorageSync(STORAGE_KEYS.topicDraft, { title: 5, body: null, tags: [] })
    expect(loadDraft()).toBeNull()
  })
})
