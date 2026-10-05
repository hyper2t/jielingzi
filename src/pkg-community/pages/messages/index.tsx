/**
 * 消息页（FE-M6-03，m6-plan D13 / D16）：站内消息列表 + 点开即已读 + 全部标为已读。
 * 契约见 docs/api/practice.md「站内消息与每日提醒」。
 *
 * - 正文由云端写好（固定说明，不含他人内容原文），前端只补类型标签与时间；能不能点开只看 refType / refId。
 * - 已读只在**云端确认之后**才改本地状态：失败时前端不替云端装已读，否则下次进来又亮一次，等于骗人。
 * - 门禁未过（未同意 / App 未登录 / 未确认 18+）不发请求（服务端同样 40303），页面给对应的去处理入口。
 * - 从话题页 / 作答页返回时刷新一次：那条链路可能已经把某条消息点成已读了。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDidShow } from '@tarojs/taro'
import { Text, View } from '@tarojs/components'
import { Button, ConsentSheet, PhoneSheet, Screen, showToast } from '@/components'
import { goLogin, loginGate } from '@/features/auth/require-login'
import {
  EMPTY_TEXT,
  GATE_TEXT,
  LOAD_FAIL_TEXT,
  MARK_ALL_TEXT,
  MARKED_TEXT,
  MARKING_TEXT,
  MORE_TEXT,
  NOTIFICATIONS_TITLE,
  UNREAD_TAG,
  isUnread,
  markLocalRead,
  mergeNotifications,
  notificationTag,
  notificationTarget,
  notificationTime,
  unreadLabel,
} from '@/features/notify/rules'
import { HAS_LOGIN, useUserStore } from '@/store/user'
import { listNotifications, markNotificationsRead } from '@/services/practice'
import { userFacingMessage } from '@/services/errors'
import { navigate } from '@/utils/router'
import { a11yButton } from '@/utils/a11y'
import { tw } from '@/utils/tw'
import { useTrackPage } from '@/hooks/useTrackPage'
import type { AppNotification } from '@/types/models'

export const PAGE_TITLE = NOTIFICATIONS_TITLE
export const LOGIN_TEXT = '登录后可查看消息'
export const CONSENT_TEXT = '同意协议后可查看消息'
export const LOAD_MORE_TEXT = MORE_TEXT

export default function MessagesPage() {
  useTrackPage('messages')
  const consent = useUserStore(s => s.consent)
  const auth = useUserStore(s => s.auth)
  const adult = useUserStore(s => s.adult)
  const account = useUserStore(s => s.account)
  const gate = loginGate(consent, !HAS_LOGIN || auth.signedIn)
  const adultOk = adult === 'confirmed' || account?.adult === true
  const ready = !gate && adultOk

  const [list, setList] = useState<AppNotification[]>([])
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const shown = useRef(false)

  const load = useCallback(async (next: number) => {
    setLoading(true)
    setError('')
    try {
      const r = await listNotifications(next)
      setList(prev => (next <= 1 ? r.list : mergeNotifications(prev, r.list)))
      setUnread(r.unread)
      setHasMore(r.hasMore)
      setPage(next)
    } catch (e) {
      setError(userFacingMessage(e) || LOAD_FAIL_TEXT)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (ready) void load(1)
  }, [ready, load])

  useDidShow(() => {
    if (shown.current && ready) void load(1)
    shown.current = true
  })

  const markAll = async () => {
    if (busy || unread === 0) return
    setBusy(true)
    try {
      const r = await markNotificationsRead()
      setList(prev => markLocalRead(prev))
      setUnread(r.unread)
      showToast(MARKED_TEXT)
    } catch (e) {
      setError(userFacingMessage(e) || LOAD_FAIL_TEXT)
    } finally {
      setBusy(false)
    }
  }

  const open = async (n: AppNotification) => {
    const target = notificationTarget(n)
    if (isUnread(n)) {
      try {
        const r = await markNotificationsRead([n.id])
        setList(prev => markLocalRead(prev, [n.id]))
        setUnread(r.unread)
      } catch (e) {
        // 标记失败不挡跳转：这条仍是未读，下次进来照常亮，前端不假装已读
      }
    }
    if (target?.route === 'topic') void navigate('topic', target.params)
    else if (target) void navigate('prompt', target.params)
  }

  const gated = !!gate || !adultOk
  const status = gated ? 'empty' : loading && !list.length ? 'loading' : !list.length && !!error ? 'error' : !list.length ? 'empty' : 'ready'
  const emptyText = gate === 'login' ? LOGIN_TEXT : gate ? CONSENT_TEXT : !adultOk ? GATE_TEXT : EMPTY_TEXT

  const rightAction =
    !gated && unread > 0 ? (
      <View
        {...tw('flex items-center justify-center min-h-touch px-2 rounded-full')}
        hoverClass={tw('bg-paper-dark').className}
        onClick={() => {
          void markAll()
        }}
        {...a11yButton(MARK_ALL_TEXT)}
      >
        <Text {...tw('font-body text-caption text-ink-soft')}>{busy ? MARKING_TEXT : MARK_ALL_TEXT}</Text>
      </View>
    ) : undefined

  const row = (n: AppNotification) => {
    const clickable = !!notificationTarget(n)
    const body = (
      <View {...tw('flex flex-col p-4 rounded-md bg-paper-light')}>
        <View {...tw('flex flex-row items-center')}>
          <Text {...tw('font-body text-caption font-bold text-brand-dark')}>{notificationTag(n.type)}</Text>
          {!!notificationTime(n.createdAt) && <Text {...tw('ml-2 font-body text-caption text-ink-faint')}>{notificationTime(n.createdAt)}</Text>}
          {isUnread(n) && <Text {...tw('ml-auto font-body text-caption text-brand-dark')}>{UNREAD_TAG}</Text>}
        </View>
        <Text {...tw('mt-2 font-body text-body text-ink')}>{n.text}</Text>
      </View>
    )
    if (!clickable) return body
    return (
      <View
        hoverClass={tw('bg-paper-dark').className}
        onClick={() => {
          void open(n)
        }}
        {...a11yButton(`${notificationTag(n.type)}，${n.text}`)}
      >
        {body}
      </View>
    )
  }

  return (
    <Screen
      nav={{ title: PAGE_TITLE, showBack: true, right: rightAction }}
      status={status}
      emptyText={emptyText}
      emptyActionText={gate === 'login' ? '去登录' : gate ? '去同意' : !adultOk ? '去确认' : undefined}
      onEmptyAction={() => {
        if (gate === 'login') goLogin({ reason: PAGE_TITLE })
        else if (gate) useUserStore.getState().openConsentSheet()
        else if (!adultOk) void navigate('adult', { reason: PAGE_TITLE })
      }}
      errorText={error || LOAD_FAIL_TEXT}
      onRetry={() => {
        void load(1)
      }}
      overlay={
        <>
          <ConsentSheet />
          <PhoneSheet />
        </>
      }
    >
      <View {...tw('flex flex-col px-page pt-4 pb-section')}>
        <Text {...tw('mb-3 font-body text-caption text-ink-faint')}>{unreadLabel(unread)}</Text>
        {list.map(n => (
          <View key={n.id} {...tw('mb-2')}>
            {row(n)}
          </View>
        ))}
        {hasMore && (
          <Button
            variant='text'
            label={LOAD_MORE_TEXT}
            onClick={() => {
              void load(page + 1)
            }}
            className='self-center'
          >
            {loading ? '···' : LOAD_MORE_TEXT}
          </Button>
        )}
      </View>
    </Screen>
  )
}
