/**
 * 编辑练习档案（FE-M1-03，PRD P1 / P2 / §7.5）：头像（预置）、昵称、练习方式（多选）、练习年限、当前目标、一句话介绍。
 * - 校验与云函数一致（features/profile/rules.ts，同一份常量与提示文案）；保存时只提交改动的字段
 * - 需已同意（App 还需已登录）才取数；保存需已确认 18+（入口已用 ensureAdult 拦过；云端仍返回 40303 时再引导一次）
 * - 顶部预览「别人看到的你」：实名与匿名两种形态（AuthorBadge，FE-M1-04）；匿名代号首次保存后分配，之后不变
 * - 头像：M1 先提供预置头像；自定义上传随 M2 图片机审上线（未经机审的图片不展示）
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { View, Text, Input } from '@tarojs/components'
import { AuthorBadge, Avatar, Button, ConsentSheet, Icon, Screen, showToast } from '@/components'
import { AVATAR_PRESETS, PRACTICES, PROFILE_RULES, TEXT_RULES } from '@/constants/community'
import type { AvatarPreset } from '@/constants/community'
import { canUploadAvatar, getProfile, PROFILE_KEY, updateProfile, uploadAvatar } from '@/services/community'
import { needsAdultConfirm, userFacingMessage } from '@/services/errors'
import { useRequest } from '@/hooks/useRequest'
import { useTrackPage } from '@/hooks/useTrackPage'
import { formFromProfile, normalizeLine, ProfileErrors, ProfileField, ProfileForm, textLength, toPatch, validateProfileForm } from '@/features/profile/rules'
import { goLogin, loginGate } from '@/features/auth/require-login'
import { HAS_LOGIN, useUserStore } from '@/store/user'
import { track } from '@/utils/track'
import { back, navigate } from '@/utils/router'
import { tw } from '@/utils/tw'
import { a11yButton } from '@/utils/a11y'

export const EDIT_TITLE = '编辑档案'
export const SAVE_TEXT = '保存'
export const SAVED_TEXT = '已保存'
export const NO_CHANGE_TEXT = '没有修改'
export const ALIAS_PENDING = '首次保存后分配匿名代号，匿名发布时显示'
export const ALIAS_HINT = '匿名发布时显示，不会关联你的档案'
export const AVATAR_UPLOAD = '上传照片'
export const AVATAR_PENDING_HINT = '头像审核中，通过后对他人展示'
export const AVATAR_SUBMITTED = '已提交审核'

/** 预置头像的读屏名 */
const AVATAR_LABELS: Record<AvatarPreset, string> = {
  leaf: '叶', sprout: '新芽', mountain: '山', waves: '水波', moon: '月', sun: '日',
  cloud: '云', trees: '林', flower: '花', wind: '风', feather: '羽', bird: '鸟'
}

function Field ({ label, hint, error, children }: { label: string, hint?: string, error?: string, children: ReactNode }) {
  return (
    <View {...tw('flex flex-col mt-6')}>
      <View {...tw('flex flex-row items-center justify-between mb-2')}>
        <Text {...tw('font-body font-bold text-body text-ink')}>{label}</Text>
        {!!hint && <Text {...tw('font-body text-caption text-ink-faint')}>{hint}</Text>}
      </View>
      {children}
      {!!error && <Text {...tw('font-body text-caption text-danger mt-1')}>{error}</Text>}
    </View>
  )
}

const inputLabel = (label: string) => ({ ariaLabel: label, accessibilityLabel: label } as any)

export default function ProfileEdit () {
  useTrackPage('profile_edit')
  const consent = useUserStore(s => s.consent)
  const auth = useUserStore(s => s.auth)
  const gate = loginGate(consent, !HAS_LOGIN || auth.signedIn)
  const ready = !gate
  const { data, loading, error, refresh } = useRequest(ready ? PROFILE_KEY : null, getProfile)
  const [form, setForm] = useState<ProfileForm>(() => formFromProfile(data))
  const [touched, setTouched] = useState(false)
  const [errors, setErrors] = useState<ProfileErrors>({})
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const avatarPending = pending || data?.avatarPending || null

  const onUpload = async () => {
    if (uploading || saving) return
    setUploading(true)
    setErrors(e => ({ ...e, avatar: undefined }))
    try {
      const r = await uploadAvatar()
      if (!r) return
      setPending(r.profile.avatarPending || null)
      track('profile_save', { created: !data })
      showToast(AVATAR_SUBMITTED)
    } catch (e) {
      if (needsAdultConfirm(e)) void navigate('adult', { reason: '上传头像' })
      else { const msg = userFacingMessage(e); setErrors(er => ({ ...er, avatar: msg })) }
    } finally {
      setUploading(false)
    }
  }

  // 档案到达后填表（用户还没动过表单时）
  useEffect(() => {
    if (!touched && data !== undefined) setForm(formFromProfile(data))
  }, [data, touched])

  const set = <K extends ProfileField>(key: K, value: ProfileForm[K]) => {
    setTouched(true)
    setForm(f => ({ ...f, [key]: value }))
    setErrors(e => ({ ...e, [key]: undefined }))
    setFormError('')
  }

  const togglePractice = (id: string) => {
    const on = form.practices.includes(id)
    if (!on && form.practices.length >= PROFILE_RULES.practicesMax) {
      setErrors(e => ({ ...e, practices: `练习方式最多选 ${PROFILE_RULES.practicesMax} 项` }))
      return
    }
    set('practices', on ? form.practices.filter(x => x !== id) : [...form.practices, id])
  }

  const onSave = async () => {
    if (saving) return
    const errs = validateProfileForm(form)
    setErrors(errs)
    if (Object.keys(errs).length) return
    const patch = toPatch(form, data)
    if (!patch) {
      showToast(NO_CHANGE_TEXT)
      return
    }
    setSaving(true)
    setFormError('')
    try {
      await updateProfile(patch)
      track('profile_save', { created: !data })
      showToast(SAVED_TEXT)
      void back()
    } catch (e) {
      if (needsAdultConfirm(e)) void navigate('adult', { reason: '编辑档案' })
      else setFormError(userFacingMessage(e))
    } finally {
      setSaving(false)
    }
  }

  const status = !ready ? 'empty' : data === undefined && loading ? 'loading' : data === undefined && error ? 'error' : 'ready'
  const counter = (v: string, max: number) => `${textLength(normalizeLine(v))}/${max}`
  const years = form.years.trim() === '' ? null : Number(form.years)

  return (
    <Screen
      nav={{ title: EDIT_TITLE, showBack: true }}
      status={status}
      emptyText={gate === 'login' ? '登录后可编辑档案' : '同意协议后可编辑档案'}
      emptyActionText={gate === 'login' ? '去登录' : '去同意'}
      onEmptyAction={() => (gate === 'login' ? goLogin({ reason: '编辑档案', returnTo: 'profileEdit' }) : useUserStore.getState().openConsentSheet())}
      onRetry={() => { void refresh() }}
      overlay={<ConsentSheet />}
    >
      <View {...tw('flex flex-col px-page pt-4 pb-section')}>
        {/* 别人看到的你：实名 / 匿名两种形态 */}
        <View {...tw('flex flex-col p-4 rounded-md bg-paper-light')}>
          <Text {...tw('font-body text-caption text-ink-faint mb-2')}>别人看到的你</Text>
          <AuthorBadge author={{ name: normalizeLine(form.nickname), avatar: form.avatar, practices: form.practices, years: Number.isInteger(years) ? years : null, badges: data?.badges }} />
          <View {...tw('h-3')} />
          {data?.anonAlias
            ? <AuthorBadge author={{ name: data.anonAlias }} anon meta={ALIAS_HINT} size='sm' />
            : <Text {...tw('font-body text-caption text-ink-faint')}>{ALIAS_PENDING}</Text>}
        </View>

        <Field label='头像' hint={canUploadAvatar() ? '上传照片需审核，或选择预置头像' : '选择预置头像'} error={errors.avatar}>
          {!!avatarPending && (
            <View {...tw('flex flex-row items-center mb-2')}>
              <Avatar avatar={avatarPending} size='md' />
              <Text {...tw('font-body text-caption text-ink-soft ml-2')}>{AVATAR_PENDING_HINT}</Text>
            </View>
          )}
          <View {...tw('flex flex-row flex-wrap')}>
            {canUploadAvatar() && (
              <View
                {...tw('flex items-center justify-center w-12 h-12 mr-2 mb-2 rounded-full border-2 border-dashed border-ink-faint')}
                onClick={() => { void onUpload() }}
                {...a11yButton(uploading ? '正在上传' : AVATAR_UPLOAD)}
              >
                <Text {...tw('font-body text-caption text-ink-soft')}>{uploading ? '…' : '上传'}</Text>
              </View>
            )}
            {[null, ...AVATAR_PRESETS].map(id => {
              const value = id ? `preset:${id}` : null
              const on = form.avatar === value
              const label = id ? AVATAR_LABELS[id] : '默认头像'
              return (
                <View
                  key={id || 'default'}
                  {...tw('flex items-center justify-center p-1 mr-2 mb-2 rounded-full border-2 border-solid', on ? 'border-brand' : 'border-paper')}
                  onClick={() => set('avatar', value)}
                  {...a11yButton(`头像：${label}${on ? '，已选中' : ''}`)}
                >
                  <Avatar avatar={value} size='md' />
                </View>
              )
            })}
          </View>
        </Field>

        <Field label='昵称' hint={counter(form.nickname, TEXT_RULES.nickname.max)} error={errors.nickname}>
          <View {...tw('flex flex-row items-center min-h-touch-kid px-4 rounded-md bg-paper-light')}>
            <Input
              {...tw('flex-1 font-body text-body rn-input text-ink')}
              value={form.nickname}
              maxlength={32}
              placeholder={`${TEXT_RULES.nickname.min}–${TEXT_RULES.nickname.max} 个字`}
              disabled={saving}
              onInput={(e: any) => set('nickname', String(e?.detail?.value ?? ''))}
              {...inputLabel('昵称')}
            />
          </View>
        </Field>

        <Field label='练习方式' hint={`最多 ${PROFILE_RULES.practicesMax} 项 · 已选 ${form.practices.length}`} error={errors.practices}>
          <View {...tw('flex flex-row flex-wrap')}>
            {PRACTICES.map(p => {
              const on = form.practices.includes(p.id)
              return (
                <View
                  key={p.id}
                  {...tw('flex flex-row items-center justify-center min-h-touch mr-2')}
                  onClick={() => togglePractice(p.id)}
                  {...a11yButton(`练习方式：${p.label}${on ? '，已选中' : ''}`)}
                >
                  <View {...tw('flex flex-row items-center h-8 px-3 rounded-full border-2 border-solid', on ? 'bg-brand border-brand' : 'bg-paper-light border-paper-dark')}>
                    {on && <Icon name='check' tone='light' size='sm' {...tw('mr-1')} />}
                    <Text {...tw('font-body text-caption', on ? 'font-bold text-paper-light' : 'text-ink')}>{p.label}</Text>
                  </View>
                </View>
              )
            })}
          </View>
        </Field>

        <Field label='练习年限' hint='选填' error={errors.years}>
          <View {...tw('flex flex-row items-center min-h-touch-kid px-4 rounded-md bg-paper-light')}>
            <Input
              {...tw('flex-1 font-body text-body rn-input text-ink')}
              type='number'
              value={form.years}
              maxlength={2}
              placeholder={`${PROFILE_RULES.years.min}–${PROFILE_RULES.years.max}`}
              disabled={saving}
              onInput={(e: any) => set('years', String(e?.detail?.value ?? '').replace(/\D/g, '').slice(0, 2))}
              {...inputLabel('练习年限')}
            />
            <Text {...tw('font-body text-body text-ink-soft ml-2')}>年</Text>
          </View>
        </Field>

        <Field label='当前目标' hint={counter(form.goal, TEXT_RULES.goal.max)} error={errors.goal}>
          <View {...tw('flex flex-row items-center min-h-touch-kid px-4 rounded-md bg-paper-light')}>
            <Input
              {...tw('flex-1 font-body text-body rn-input text-ink')}
              value={form.goal}
              maxlength={60}
              placeholder='如：每天静坐 20 分钟（选填）'
              disabled={saving}
              onInput={(e: any) => set('goal', String(e?.detail?.value ?? ''))}
              {...inputLabel('当前目标')}
            />
          </View>
        </Field>

        <Field label='一句话介绍' hint={counter(form.bio, TEXT_RULES.bio.max)} error={errors.bio}>
          <View {...tw('flex flex-row items-center min-h-touch-kid px-4 rounded-md bg-paper-light')}>
            <Input
              {...tw('flex-1 font-body text-body rn-input text-ink')}
              value={form.bio}
              maxlength={120}
              placeholder='介绍一下你的练习（选填）'
              disabled={saving}
              onInput={(e: any) => set('bio', String(e?.detail?.value ?? ''))}
              {...inputLabel('一句话介绍')}
            />
          </View>
        </Field>

        {!!formError && <Text {...tw('font-body text-caption text-danger text-center mt-4')}>{formError}</Text>}
        <Button block size='kid' loading={saving} onClick={() => { void onSave() }} {...tw('mt-section')}>{SAVE_TEXT}</Button>
        <Text {...tw('font-body text-caption text-ink-faint text-center mt-2')}>档案内容需遵守社区公约</Text>
      </View>
    </Screen>
  )
}
