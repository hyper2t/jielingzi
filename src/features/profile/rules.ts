/**
 * 练习档案表单规则（FE-M1-03）：与云函数 cloudfunctions/community/profile.js 一一对应——同一份常量（constants/community.ts，
 * 与 _shared/config.js 由测试比对）、同样的清洗方式、同样的提示文案。保存前前端先拦一次，后端仍会再校验。
 * 字数按 Unicode 码点计（emoji、生僻字算 1 个）。
 */
import { AVATAR_PRESETS, PRACTICES, PROFILE_RULES, RESERVED_NICKNAME_WORDS, TEXT_RULES } from '@/constants/community'
import type { Profile, ProfilePatch } from '@/types/models'

/** 控制字符、零宽字符、双向控制符（可用来伪装昵称） */
const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/
const PRACTICE_IDS: readonly string[] = PRACTICES.map(p => p.id)
const AVATAR_IDS: readonly string[] = AVATAR_PRESETS

export const textLength = (s: string): number => Array.from(s).length

/** 单行文本清洗：折叠空白、去首尾空格（与云函数一致） */
export const normalizeLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

export interface ProfileForm {
  nickname: string
  avatar: string | null
  practices: string[]
  /** 输入框原文；空串表示不填 */
  years: string
  goal: string
  bio: string
}

export type ProfileField = keyof ProfileForm
export type ProfileErrors = Partial<Record<ProfileField, string>>

function lineError (label: string, raw: string, { min = 0, max }: { min?: number, max: number }): string | undefined {
  if (INVISIBLE_RE.test(raw.replace(/[\t\r\n]/g, ' '))) return `${label}含有不支持的字符`
  const n = textLength(normalizeLine(raw))
  if (min > 0 && n < min) return `${label}至少 ${min} 个字`
  if (n > max) return `${label}最多 ${max} 个字`
  return undefined
}

/** 昵称 2–16 字（档案表单必填；云函数对传入的昵称同样校验，提示文案一致） */
export function nicknameError (raw: string): string | undefined {
  const e = lineError('昵称', raw, TEXT_RULES.nickname)
  if (e) return e
  if (RESERVED_NICKNAME_WORDS.some(w => normalizeLine(raw).includes(w))) return '昵称不可使用该名称'
  return undefined
}

export function yearsError (raw: string): string | undefined {
  const s = raw.trim()
  if (s === '') return undefined
  const { min, max } = PROFILE_RULES.years
  const n = Number(s)
  if (!/^\d+$/.test(s) || !Number.isInteger(n) || n < min || n > max) return `练习年限需为 ${min}–${max} 的整数`
  return undefined
}

export function practicesError (ids: string[]): string | undefined {
  if (ids.some(id => !PRACTICE_IDS.includes(id))) return '练习方式只能从列表中选择'
  if (new Set(ids).size > PROFILE_RULES.practicesMax) return `练习方式最多选 ${PROFILE_RULES.practicesMax} 项`
  return undefined
}

export function avatarError (v: string | null): string | undefined {
  if (v === null) return undefined
  const m = /^preset:([a-z0-9-]{1,32})$/.exec(v)
  return m && AVATAR_IDS.includes(m[1]) ? undefined : '请选择预置头像'
}

/** 整表校验：返回各字段的第一条错误（没有错误为空对象） */
export function validateProfileForm (f: ProfileForm): ProfileErrors {
  const errors: ProfileErrors = {}
  const put = (k: ProfileField, e: string | undefined) => { if (e) errors[k] = e }
  put('nickname', nicknameError(f.nickname))
  put('avatar', avatarError(f.avatar))
  put('practices', practicesError(f.practices))
  put('years', yearsError(f.years))
  put('goal', lineError('当前目标', f.goal, TEXT_RULES.goal))
  put('bio', lineError('一句话介绍', f.bio, TEXT_RULES.bio))
  return errors
}

/** 校验 updateProfile 入参：只校验传了的字段（与云函数 parseUpdate 一致）；返回第一条错误 */
export function patchError (patch: ProfilePatch): string | undefined {
  if (patch.nickname !== undefined) { const e = nicknameError(patch.nickname); if (e) return e }
  if (patch.avatar !== undefined) { const e = avatarError(patch.avatar); if (e) return e }
  if (patch.practices !== undefined) { const e = practicesError(patch.practices); if (e) return e }
  if (patch.years !== undefined && patch.years !== null) { const e = yearsError(String(patch.years)); if (e) return e }
  if (patch.goal !== undefined) { const e = lineError('当前目标', patch.goal, TEXT_RULES.goal); if (e) return e }
  if (patch.bio !== undefined) { const e = lineError('一句话介绍', patch.bio, TEXT_RULES.bio); if (e) return e }
  return undefined
}

export function formFromProfile (p: Profile | null | undefined): ProfileForm {
  return {
    nickname: p?.nickname || '',
    avatar: p?.avatar || null,
    practices: p?.practices ? [...p.practices] : [],
    years: typeof p?.years === 'number' ? String(p.years) : '',
    goal: p?.goal || '',
    bio: p?.bio || ''
  }
}

/** 表单 → updateProfile 入参：只包含与原档案不同的字段（已清洗）；没有改动返回 null */
export function toPatch (f: ProfileForm, original: Profile | null | undefined): ProfilePatch | null {
  const base = formFromProfile(original)
  const patch: ProfilePatch = {}
  const nickname = normalizeLine(f.nickname)
  if (nickname !== normalizeLine(base.nickname)) patch.nickname = nickname
  if (f.avatar !== base.avatar) patch.avatar = f.avatar
  const practices = Array.from(new Set(f.practices))
  if (practices.join(',') !== base.practices.join(',')) patch.practices = practices
  const years = f.years.trim() === '' ? null : Number(f.years.trim())
  const baseYears = base.years === '' ? null : Number(base.years)
  if (years !== baseYears) patch.years = years
  const goal = normalizeLine(f.goal)
  if (goal !== normalizeLine(base.goal)) patch.goal = goal
  const bio = normalizeLine(f.bio)
  if (bio !== normalizeLine(base.bio)) patch.bio = bio
  return Object.keys(patch).length ? patch : null
}

/** 练习方式 id → 展示文案 */
export function practiceLabels (ids: string[] | undefined): string[] {
  return (ids || []).map(id => PRACTICES.find(p => p.id === id)?.label).filter((x): x is NonNullable<typeof x> => !!x)
}

/** 档案卡副标题：「正念 · 太极  练习 3 年」 */
export function profileMeta (p: Pick<Profile, 'practices' | 'years'> | null | undefined): string {
  if (!p) return ''
  const parts: string[] = []
  const labels = practiceLabels(p.practices)
  if (labels.length) parts.push(labels.join(' · '))
  if (typeof p.years === 'number') parts.push(p.years === 0 ? '刚开始练习' : `练习 ${p.years} 年`)
  return parts.join('  ')
}
