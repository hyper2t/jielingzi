/**
 * FE-M1-03 表单校验与后端一致：用例与 tests/cloudfunctions/m1.test.js「updateProfile 字段校验」同一张表
 * （同一份常量见 constants/__tests__/community.test.ts；提示文案与 cloudfunctions/community/profile.js 一致）。
 */
import { AVATAR_PRESETS } from '@/constants/community'
import {
  avatarError, formFromProfile, nicknameError, patchError, practiceLabels, practicesError, profileMeta, textLength, toPatch,
  validateProfileForm, yearsError
} from '@/features/profile/rules'
import type { Profile } from '@/types/models'

const PROFILE: Profile = {
  nickname: '林然', avatar: 'preset:leaf', practices: ['mindfulness', 'taichi'], years: 3, goal: '每天 20 分钟', bio: '在呼吸里找回自己',
  anonAlias: '竹影', badges: [], updatedAt: 1
}

describe('字段校验（与云函数同表）', () => {
  it.each([
    ['林', '昵称至少 2 个字'],
    ['一二三四五六七八九十一二三四五六七', '昵称最多 16 个字'],
    ['一二三四五六七八九十一二三四五六', undefined],
    ['🌿🌿', undefined],
    ['🌿', '昵称至少 2 个字'],
    ['结灵子官方', '昵称不可使用该名称'],
    ['管理员小王', '昵称不可使用该名称'],
    ['ab\u200bcd', '昵称含有不支持的字符'],
    ['  林 然  ', undefined],
    ['', '昵称至少 2 个字']
  ])('昵称 %j → %s', (v, expected) => {
    expect(nicknameError(v)).toBe(expected)
  })

  it('练习方式：只能取预置值、去重后 ≤ 5', () => {
    expect(practicesError(['meditation', 'buddhism'])).toBe('练习方式只能从列表中选择')
    expect(practicesError(['meditation', 'mindfulness', 'vipassana', 'taichi', 'zhanzhuang', 'yoga'])).toBe('练习方式最多选 5 项')
    expect(practicesError(['meditation', 'meditation'])).toBeUndefined()
    expect(practicesError([])).toBeUndefined()
  })

  it('练习年限：空为不填；0–80 整数', () => {
    for (const bad of ['-1', '81', '1.5', 'abc']) expect(yearsError(bad)).toBe('练习年限需为 0–80 的整数')
    for (const ok of ['', '0', '80', ' 3 ']) expect(yearsError(ok)).toBeUndefined()
  })

  it('头像：只能是预置头像或默认（null）', () => {
    expect(avatarError(null)).toBeUndefined()
    for (const id of AVATAR_PRESETS) expect(avatarError(`preset:${id}`)).toBeUndefined()
    expect(avatarError('cloud://env-1/a.png')).toBe('请选择预置头像')
    expect(avatarError('preset:nope')).toBe('请选择预置头像')
  })

  it('整表：介绍 ≤ 80、目标 ≤ 40（按码点计）', () => {
    const f = formFromProfile(PROFILE)
    expect(validateProfileForm(f)).toEqual({})
    expect(validateProfileForm({ ...f, bio: 'x'.repeat(81), goal: 'x'.repeat(41) })).toEqual({ bio: '一句话介绍最多 80 个字', goal: '当前目标最多 40 个字' })
    expect(validateProfileForm({ ...f, bio: '字'.repeat(80) })).toEqual({})
    expect(textLength('🌿a字')).toBe(3)
  })

  it('patchError：只校验传了的字段（与云函数 parseUpdate 一致）', () => {
    expect(patchError({ years: 3 })).toBeUndefined()
    expect(patchError({ years: null, avatar: null })).toBeUndefined()
    expect(patchError({ nickname: '林' })).toBe('昵称至少 2 个字')
    expect(patchError({ bio: 'x'.repeat(81) })).toBe('一句话介绍最多 80 个字')
  })
})

describe('表单 → 入参', () => {
  it('只提交改动的字段（已清洗）；没有改动返回 null', () => {
    const f = formFromProfile(PROFILE)
    expect(toPatch(f, PROFILE)).toBeNull()
    expect(toPatch({ ...f, nickname: '  林  然 ' }, PROFILE)).toEqual({ nickname: '林 然' })
    expect(toPatch({ ...f, years: '' }, PROFILE)).toEqual({ years: null })
    expect(toPatch({ ...f, avatar: null, practices: ['taichi', 'taichi'] }, PROFILE)).toEqual({ avatar: null, practices: ['taichi'] })
    expect(toPatch({ ...f, bio: '' }, PROFILE)).toEqual({ bio: '' })
  })

  it('首次填写（没有档案）：只带填了的字段', () => {
    const f = { ...formFromProfile(null), nickname: '小禾', practices: ['meditation'] }
    expect(toPatch(f, null)).toEqual({ nickname: '小禾', practices: ['meditation'] })
  })

  it('档案卡副标题', () => {
    expect(profileMeta(PROFILE)).toBe('正念 · 太极  练习 3 年')
    expect(profileMeta({ practices: [], years: 0 })).toBe('刚开始练习')
    expect(profileMeta(null)).toBe('')
    expect(practiceLabels(['qigong', 'nope'])).toEqual(['传统养生功法'])
  })
})
