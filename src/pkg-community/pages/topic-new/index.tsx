/**
 * 发起话题（FE-M3-02，PRD T1）：标题（5–40 字）、正文（有效字数 ≥ 50，不含空白）、标签（最多 3 个，选填）、匿名开关。
 * - 校验与云函数一致（features/topic/rules.ts，同一份常量与提示文案）；发布前过发布门禁（实名 + 读过公约），云端仍会再校验
 * - 本地草稿：输入即存本机（STORAGE_KEYS.topicDraft），下次进来恢复；发布成功后删除
 * - 匿名：别人只看到「匿名·代号」，不显示头像与档案（预览见顶部「别人看到的你」）
 * - 机审：拒绝 → 提示修改（不占当日额度）；待复核 → 进入详情，顶部标明「审核中」
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import Taro, { useDidShow } from '@tarojs/taro'
import { View, Text, Input, Textarea } from '@tarojs/components'
import { AuthorBadge, Button, ConsentSheet, PhoneSheet, Screen, Sheet, showToast, Toggle } from '@/components'
import { TEXT_RULES, TOPIC_RULES } from '@/constants/community'
import { ensureAdult, requirePhone } from '@/features/auth/gates'
import CircleJoinGuide from '@/features/circle/CircleJoinGuide'
import { loginGate, goLogin } from '@/features/auth/require-login'
import { normalizeLine, textLength } from '@/features/profile/rules'
import {
  bodyCounter, clearDraft, EMPTY_TOPIC_FORM, isEmptyForm, loadDraft, parseTags, publishError, saveDraft, toTopicInput, TopicErrors, TopicField, TopicForm, validateTopicForm
} from '@/features/topic/rules'
import { CIRCLES_KEY, createTopic, getProfile, listCircles, PROFILE_KEY } from '@/services/community'
import { errorMessage, needsAdultConfirm } from '@/services/errors'
import { useRequest } from '@/hooks/useRequest'
import { useTrackPage } from '@/hooks/useTrackPage'
import { HAS_LOGIN, useUserStore } from '@/store/user'
import { track } from '@/utils/track'
import { navigate, parseParams, redirect } from '@/utils/router'
import { tw } from '@/utils/tw'
import { a11yButton } from '@/utils/a11y'

export const NEW_TOPIC_TITLE = '发起话题'
export const PUBLISH_TEXT = '发布'
export const PUBLISHED_TEXT = '已发布'
export const PENDING_TEXT = '已提交，审核通过后展示'
export const DRAFT_RESTORED = '已恢复上次未发布的草稿'
export const DRAFT_CLEAR = '清除草稿'
export const ANON_LABEL = '匿名发布'
export const ANON_HINT = '别人只看到匿名代号，不显示头像和档案；你仍可删除自己的话题'
export const NEED_ADULT_TOPIC_TEXT = '确认年满 18 周岁后可发起话题'
export const CIRCLE_REQUIRED_TEXT = '请选择发布到的圈子'

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

export default function TopicNew () {
  useTrackPage('topic_new')
  const initialCircleId = parseParams<'topicNew'>(Taro.getCurrentInstance().router?.params).circleId
  const consent = useUserStore(s => s.consent)
  const auth = useUserStore(s => s.auth)
  const adult = useUserStore(s => s.adult)
  const account = useUserStore(s => s.account)
  const gate = loginGate(consent, !HAS_LOGIN || auth.signedIn)
  const adultOk = adult === 'confirmed' || account?.adult === true
  const ready = !gate && adultOk
  const circlesReq = useRequest(ready ? CIRCLES_KEY : null, listCircles)
  const circles = circlesReq.data || []
  const joinedCircles = circles.filter(circle => circle.joined)
  const profile = useRequest(ready && !!circlesReq.data && joinedCircles.length > 0 ? PROFILE_KEY : null, getProfile)

  const [form, setForm] = useState<TopicForm>(() => ({ ...EMPTY_TOPIC_FORM, circleId: initialCircleId }))
  const [restored, setRestored] = useState(false)
  const [errors, setErrors] = useState<TopicErrors>({})
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const [circleSheetOpen, setCircleSheetOpen] = useState(false)
  const shown = useRef(false)

  useDidShow(() => {
    if (shown.current && ready) void circlesReq.refresh()
    shown.current = true
  })

  // 进入时恢复草稿（只恢复一次，用户开始输入前）
  useEffect(() => {
    const d = loadDraft()
    if (d) { setForm({ circleId: d.circleId || initialCircleId, title: d.title, body: d.body, tags: d.tags, anon: d.anon }); setRestored(true) }
  }, [])

  useEffect(() => {
    if (!circlesReq.data) return
    setForm(prev => {
      const preferred = prev.circleId || initialCircleId
      const chosen = joinedCircles.length === 1
        ? joinedCircles[0].id
        : joinedCircles.find(circle => circle.id === preferred)?.id || joinedCircles[0]?.id
      if (chosen === prev.circleId) return prev
      const next = { ...prev, circleId: chosen }
      saveDraft(next)
      return next
    })
  }, [circlesReq.data])

  const set = <K extends keyof TopicForm>(key: K, value: TopicForm[K]) => {
    const next = { ...form, [key]: value }
    setForm(next)
    saveDraft(next)
    if (key !== 'anon' && key !== 'circleId') setErrors(e => ({ ...e, [key as TopicField]: undefined }))
    setFormError('')
  }

  const discardDraft = () => {
    clearDraft()
    const preferred = joinedCircles.find(circle => circle.id === initialCircleId)?.id || joinedCircles[0]?.id
    setForm({ ...EMPTY_TOPIC_FORM, circleId: preferred })
    setErrors({})
    setRestored(false)
  }

  const onSubmit = async () => {
    if (busy) return
    const selectedCircle = joinedCircles.find(circle => circle.id === form.circleId) || joinedCircles[0]
    if (!selectedCircle) { setFormError(CIRCLE_REQUIRED_TEXT); return }
    const submitForm = { ...form, circleId: selectedCircle.id }
    const errs = validateTopicForm(submitForm)
    setErrors(errs)
    if (Object.keys(errs).length) return
    if (!requirePhone({ reason: NEW_TOPIC_TITLE })) return
    setBusy(true)
    setFormError('')
    try {
      const r = await createTopic(toTopicInput(submitForm))
      clearDraft()
      track('topic_create', { anon: form.anon, status: r.status })
      showToast(r.status === 'pending' ? PENDING_TEXT : PUBLISHED_TEXT)
      void redirect('topic', { id: r.topic.id })
    } catch (e) {
      if (needsAdultConfirm(e)) void navigate('adult', { reason: NEW_TOPIC_TITLE })
      else setFormError(publishError(e, 'topic'))
    } finally {
      setBusy(false)
    }
  }

  const alias = profile.data?.anonAlias || '匿名用户'
  const nickname = (profile.data?.nickname || '').trim() || alias
  const body = bodyCounter(form.body)
  const tags = parseTags(form.tags)
  const currentCircle = joinedCircles.find(circle => circle.id === form.circleId) || joinedCircles[0]

  return (
    <Screen
      nav={{ title: NEW_TOPIC_TITLE, showBack: true }}
      status={!ready || (ready && needsAdultConfirm(circlesReq.error)) ? 'empty' : circlesReq.loading && !circlesReq.data ? 'loading' : circlesReq.error && !circlesReq.data ? 'error' : 'ready'}
      emptyText={gate === 'login' ? '登录后可发起话题' : gate ? '同意协议后可发起话题' : NEED_ADULT_TOPIC_TEXT}
      emptyActionText={gate ? (gate === 'login' ? '去登录' : '去同意') : '去确认'}
      onEmptyAction={() => {
        if (gate === 'login') goLogin({ reason: NEW_TOPIC_TITLE })
        else if (gate) useUserStore.getState().openConsentSheet()
        else if (needsAdultConfirm(circlesReq.error)) void navigate('adult', { reason: NEW_TOPIC_TITLE })
        else ensureAdult({ reason: NEW_TOPIC_TITLE })
      }}
      errorText={errorMessage(circlesReq.error)}
      onRetry={() => { void circlesReq.refresh() }}
      overlay={
        <>
          <ConsentSheet />
          <PhoneSheet />
          <Sheet
            open={circleSheetOpen}
            title='选择话题所属圈子'
            options={joinedCircles.map(circle => ({ value: circle.id, label: circle.name }))}
            value={currentCircle?.id}
            onSelect={circleId => set('circleId', circleId)}
            onClose={() => setCircleSheetOpen(false)}
          />
        </>
      }
    >
      <View {...tw('flex flex-col px-page pt-4 pb-section')}>
        {restored && !isEmptyForm(form) && (
          <View {...tw('flex flex-row items-center justify-between px-4 py-2 rounded-md bg-highlight')}>
            <Text {...tw('flex-1 font-body text-caption text-ink-soft')}>{DRAFT_RESTORED}</Text>
            <View onClick={discardDraft} {...a11yButton(DRAFT_CLEAR)} {...tw('flex items-center justify-center min-h-touch px-2')}>
              <Text {...tw('font-body text-caption text-brand-dark')}>{DRAFT_CLEAR}</Text>
            </View>
          </View>
        )}

        {joinedCircles.length === 0
          ? <CircleJoinGuide circles={circles} />
          : <>
            {joinedCircles.length === 1
              ? <Field label='发布到'><Text {...tw('font-body text-body text-ink px-4 py-3 rounded-md bg-paper-light')}>{joinedCircles[0].name}</Text></Field>
              : <Field label='发布到' hint='选择话题所属圈子'>
                <View
                  onClick={() => setCircleSheetOpen(true)}
                  {...a11yButton(`发布到：${currentCircle?.name || '请选择'}`)}
                  {...tw('flex flex-row items-center justify-between min-h-touch-kid px-4 rounded-md bg-paper-light')}
                >
                  <Text {...tw('font-body text-body text-ink')}>{currentCircle?.name || '请选择'}</Text>
                  <Text {...tw('font-body text-caption text-brand-dark')}>更改</Text>
                </View>
              </Field>}

        <Field label='标题' hint={`${textLength(normalizeLine(form.title))}/${TEXT_RULES.topicTitle.max}`} error={errors.title}>
          <View {...tw('flex flex-row items-center min-h-touch-kid px-4 rounded-md bg-paper-light')}>
            <Input
              {...tw('flex-1 font-body text-body text-ink')}
              value={form.title}
              maxlength={TEXT_RULES.topicTitle.max * 2}
              placeholder={`${TEXT_RULES.topicTitle.min}–${TEXT_RULES.topicTitle.max} 个字，说清你想聊什么`}
              disabled={busy}
              onInput={(e: any) => set('title', String(e?.detail?.value ?? ''))}
              {...inputLabel('标题')}
            />
          </View>
        </Field>

        <Field label='正文' hint={body.hint} error={errors.body}>
          <View {...tw('flex flex-col p-4 rounded-md bg-paper-light')} style={{ minHeight: 220 }}>
            <Textarea
              {...tw('w-full font-body text-body text-ink')}
              value={form.body}
              maxlength={-1}
              autoHeight
              placeholder={`至少 ${TEXT_RULES.topicBody.min} 字（不含空格），聊聊你的练习经验或困惑`}
              disabled={busy}
              onInput={(e: any) => set('body', String(e?.detail?.value ?? ''))}
              {...inputLabel('正文')}
            />
          </View>
        </Field>

        <Field label='标签' hint={`选填 · 最多 ${TOPIC_RULES.tagsMax} 个 · 已填 ${tags.length}`} error={errors.tags}>
          <View {...tw('flex flex-row items-center min-h-touch-kid px-4 rounded-md bg-paper-light')}>
            <Input
              {...tw('flex-1 font-body text-body text-ink')}
              value={form.tags}
              maxlength={60}
              placeholder='用空格分隔，如：冥想 呼吸'
              disabled={busy}
              onInput={(e: any) => set('tags', String(e?.detail?.value ?? ''))}
              {...inputLabel('标签')}
            />
          </View>
        </Field>

        <View {...tw('flex flex-col mt-6 p-4 rounded-md bg-paper-light')}>
          <Text {...tw('font-body text-caption text-ink-faint mb-2')}>别人看到的你</Text>
          <AuthorBadge
            author={form.anon
              ? { name: alias }
              : { name: nickname, avatar: profile.data?.avatar, practices: profile.data?.practices, years: profile.data?.years, badges: profile.data?.badges }}
            anon={form.anon}
          />
          <Toggle on={form.anon} label={ANON_LABEL} onChange={v => set('anon', v)} disabled={busy} {...tw('mt-2')} />
          <Text {...tw('font-body text-caption text-ink-faint')}>{ANON_HINT}</Text>
        </View>

        {!!formError && <Text {...tw('font-body text-caption text-danger text-center mt-4')}>{formError}</Text>}
        <Button block size='kid' loading={busy} onClick={() => { void onSubmit() }} {...tw('mt-section')}>{PUBLISH_TEXT}</Button>
        <Text {...tw('font-body text-caption text-ink-faint text-center mt-2')}>话题需遵守社区公约；发布后可在详情页删除</Text>
          </>}
      </View>
    </Screen>
  )
}
