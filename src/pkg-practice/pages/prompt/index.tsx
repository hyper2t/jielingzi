/**
 * 每日一题作答页（FE-M6-01，PRD W3）：题目 → 作答（默认匿名、可切实名）→ 他人回答。
 * - 校验与云函数同口径（features/practice/prompt.ts），云端仍会再校验字数 / 门禁 / 额度
 * - 未作答时不请求 `listAnswers`（服务端也会返回 40301）；提交成功后再拉第一页
 * - 我的回答与「其他人的回答」都来自同一份列表结果：待复核（pending）只出现在我的那条上
 * - 列表加载失败不打断作答：保留提交结果，列表位置给出重试
 */
import { useCallback, useEffect, useState } from 'react'
import Taro from '@tarojs/taro'
import { Text, Textarea, View } from '@tarojs/components'
import { Button, ConsentSheet, PhoneSheet, Screen, showToast, Toggle } from '@/components'
import { PROMPT_RULES } from '@/constants/community'
import { requirePhone } from '@/features/auth/gates'
import { loginGate, goLogin } from '@/features/auth/require-login'
import {
  ANSWER_LABEL, ANON_HINT, ANON_LABEL, EMPTY_ANSWERS_TEXT, MORE_TEXT, PENDING_HINT, PROMPT_PAGE_TITLE,
  PENDING_TOAST, SUBMIT_TEXT, SUBMITTED_TOAST, answerAuthorText, answerCounter, promptError, validatePromptAnswer
} from '@/features/practice/prompt'
import { TODAY_PROMPT_KEY, answerPrompt, listAnswers, todayPrompt } from '@/services/practice'
import { needsAdultConfirm } from '@/services/errors'
import { useRequest } from '@/hooks/useRequest'
import { useTrackPage } from '@/hooks/useTrackPage'
import { HAS_LOGIN, useUserStore } from '@/store/user'
import { navigate, parseParams } from '@/utils/router'
import { track } from '@/utils/track'
import { tw } from '@/utils/tw'
import type { PromptAnswerItem } from '@/types/models'

export const PAGE_TITLE = PROMPT_PAGE_TITLE
export const QUESTION_LABEL = '今天的题目'
export const OTHERS_LABEL = '其他人的回答'
export const RETRY_TEXT = '重新加载'
export const LOAD_FAIL_TEXT = '回答列表加载失败'
export const LOAD_PENDING_TEXT = '已提交，正在等待审核结果'
export const PAGE_NOTE = '回答遵守社区公约；他人只看到匿名代号或昵称'

interface AnswerState {
  list: PromptAnswerItem[]
  mine: PromptAnswerItem | null
  hasMore: boolean
}

const EMPTY_STATE: AnswerState = { list: [], mine: null, hasMore: false }

export default function PromptAnswerPage () {
  useTrackPage('prompt_answer')
  const params = parseParams<'prompt'>(Taro.getCurrentInstance().router?.params)
  const consent = useUserStore(s => s.consent)
  const auth = useUserStore(s => s.auth)
  const adult = useUserStore(s => s.adult)
  const account = useUserStore(s => s.account)
  const gate = loginGate(consent, !HAS_LOGIN || auth.signedIn)
  const adultOk = adult === 'confirmed' || account?.adult === true
  const ready = !gate && adultOk

  const todayReq = useRequest(ready ? TODAY_PROMPT_KEY : null, todayPrompt)
  const cloud = todayReq.data?.prompt || null
  // 卡片跳转时带上 promptId / date；单独进入时回落到今日题目
  const prompt = params.promptId
    ? {
        id: params.promptId,
        date: params.date || (cloud ? cloud.date : ''),
        text: cloud && cloud.id === params.promptId ? cloud.text : ''
      }
    : cloud
  const promptId = prompt ? prompt.id : ''
  const answered = !!cloud && cloud.answered && (!params.promptId || cloud.id === params.promptId)

  const [text, setText] = useState('')
  const [anon, setAnon] = useState<boolean>(PROMPT_RULES.defaultAnon)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [state, setState] = useState<AnswerState>(EMPTY_STATE)
  const [page, setPage] = useState(0)
  const [listBusy, setListBusy] = useState(false)
  const [listError, setListError] = useState('')

  const load = useCallback(async (next: number) => {
    if (!promptId) return
    setListBusy(true)
    setListError('')
    try {
      const r = await listAnswers(promptId, next)
      setState(prev => ({
        list: next <= 1 ? r.list : [...prev.list, ...r.list],
        mine: r.mine || null,
        hasMore: r.hasMore
      }))
      setPage(next)
    } catch (e) {
      setListError(promptError(e))
    } finally {
      setListBusy(false)
    }
  }, [promptId])

  useEffect(() => {
    if (answered) void load(1)
    else setState(EMPTY_STATE)
  }, [answered, load])

  const counter = answerCounter(text)
  const onSubmit = async () => {
    if (busy || !promptId) return
    const invalid = validatePromptAnswer(text)
    if (invalid) { setError(invalid); return }
    if (!requirePhone({ reason: PAGE_TITLE })) return
    setBusy(true)
    setError('')
    try {
      const r = await answerPrompt({ promptId, text: text.trim(), anon })
      track('prompt_answer', { status: r.answer.status, anon })
      showToast(r.answer.status === 'pending' ? PENDING_TOAST : SUBMITTED_TOAST)
      setText('')
    } catch (e) {
      if (needsAdultConfirm(e)) void navigate('adult', { reason: PAGE_TITLE })
      else setError(promptError(e))
    } finally {
      setBusy(false)
      void todayReq.refresh()
    }
  }

  const showEmpty = !!gate || !adultOk
  const myAnswer = state.mine
  // 我的答案状态优先看列表结果（刷新中也不闪），还没拿到就回落到今日题目上的 myStatus
  const myStatus = myAnswer ? myAnswer.status : (cloud ? cloud.myStatus : null)
  const minePending = myStatus === 'pending'

  return (
    <Screen
      nav={{ title: PAGE_TITLE, showBack: true }}
      status={showEmpty ? 'empty' : !prompt ? 'loading' : 'ready'}
      emptyText={gate === 'login' ? '登录后可参与每日一题' : gate ? '同意协议后可参与每日一题' : '确认年满 18 周岁后可参与每日一题'}
      emptyActionText={gate ? (gate === 'login' ? '去登录' : '去同意') : '去确认'}
      onEmptyAction={() => {
        if (gate === 'login') goLogin({ reason: PAGE_TITLE })
        else if (gate) useUserStore.getState().openConsentSheet()
        else void navigate('adult', { reason: PAGE_TITLE })
      }}
      overlay={<><ConsentSheet /><PhoneSheet /></>}
    >
      <View {...tw('flex flex-col px-page pt-4 pb-section')}>
        <View {...tw('flex flex-col p-4 rounded-md bg-paper-light')}>
          <Text {...tw('font-body text-caption font-bold text-brand-dark')}>{QUESTION_LABEL}</Text>
          <Text {...tw('mt-2 font-body text-body text-ink')}>{prompt ? prompt.text : ''}</Text>
          {!!prompt && !!prompt.date && <Text {...tw('mt-2 font-body text-caption text-ink-faint')}>{prompt.date}</Text>}
        </View>

        {answered ? (
          <View {...tw('flex flex-col mt-6')}>
            <Text {...tw('font-body font-bold text-body text-ink')}>{ANSWER_LABEL}</Text>
            <View {...tw('flex flex-col mt-2 p-4 rounded-md bg-paper-light')}>
              <Text {...tw('font-body text-body text-ink')}>{myAnswer ? myAnswer.text : (minePending ? LOAD_PENDING_TEXT : '')}</Text>
              <Text {...tw('mt-2 font-body text-caption text-ink-faint')}>
                {myAnswer ? answerAuthorText(myAnswer) : ''}
                {minePending ? ` · ${PENDING_HINT}` : ''}
              </Text>
            </View>

            <View {...tw('flex flex-row items-center justify-between mt-6')}>
              <Text {...tw('font-body font-bold text-body text-ink')}>{OTHERS_LABEL}</Text>
              <Text {...tw('font-body text-caption text-ink-faint')}>{state.list.length ? `${state.list.length} 条` : ''}</Text>
            </View>
            {!!listError && <Text {...tw('font-body text-caption text-danger mt-1')}>{LOAD_FAIL_TEXT}：{listError}</Text>}
            {!listError && state.list.length === 0 && !listBusy && (
              <Text {...tw('font-body text-body text-ink-faint mt-2')}>{EMPTY_ANSWERS_TEXT}</Text>
            )}
            {state.list.map(item => (
              <View key={item.id} {...tw('flex flex-col mt-3 p-4 rounded-md bg-paper-light')}>
                <Text {...tw('font-body text-body text-ink')}>{item.text}</Text>
                <Text {...tw('mt-2 font-body text-caption text-ink-faint')}>{answerAuthorText(item)}</Text>
              </View>
            ))}
            {state.hasMore && (
              <Button block size='kid' label={MORE_TEXT} loading={listBusy} className='mt-4' onClick={() => { void load(page + 1) }}>{MORE_TEXT}</Button>
            )}
            {!!listError && (
              <Button block size='kid' label={RETRY_TEXT} className='mt-2' onClick={() => { void load(1) }}>{RETRY_TEXT}</Button>
            )}
          </View>
        ) : (
          <>
            <View {...tw('flex flex-col mt-6 p-4 rounded-md bg-paper-light')} style={{ minHeight: 200 }}>
              <Textarea
                {...tw('w-full font-body text-body text-ink')}
                value={text}
                maxlength={-1}
                autoHeight
                placeholder={`写下今天的回答，${PROMPT_RULES.answer.min}–${PROMPT_RULES.answer.max} 字`}
                disabled={busy}
                onInput={(e: any) => { setText(String(e && e.detail ? e.detail.value : '')); setError('') }}
                {...({ ariaLabel: ANSWER_LABEL, accessibilityLabel: ANSWER_LABEL } as any)}
              />
              <Text {...tw('mt-2 font-body text-caption text-ink-faint text-right')}>{counter.hint}</Text>
            </View>
            <View {...tw('flex flex-col mt-4 p-4 rounded-md bg-paper-light')}>
              <Toggle on={anon} label={ANON_LABEL} onChange={v => setAnon(v)} disabled={busy} />
              <Text {...tw('font-body text-caption text-ink-faint mt-1')}>{ANON_HINT}</Text>
            </View>
            {!!error && <Text {...tw('font-body text-caption text-danger text-center mt-4')}>{error}</Text>}
            <Button block size='kid' loading={busy} onClick={() => { void onSubmit() }} {...tw('mt-section')}>{SUBMIT_TEXT}</Button>
            <Text {...tw('font-body text-caption text-ink-faint text-center mt-2')}>{PAGE_NOTE}</Text>
          </>
        )}
      </View>
    </Screen>
  )
}
