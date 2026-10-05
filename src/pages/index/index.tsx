/**
 * 首页：话题流（FE-M3-01，PRD §7.1）。新的在前，下拉刷新、触底翻页；导航栏「✎ 发起话题」先过发布门禁
 * （同意 → 18+ →（App）登录 → 实名 → 读公约，FE-M1-02 / FE-M2-03），通过后进发帖页。
 * 读话题需要已同意（App 还需登录）且已确认 18+；未满足时不发任何云端请求，显示对应的引导空态。
 */
import { useEffect, useRef, useState } from 'react'
import Taro, { useDidShow, usePullDownRefresh, useReachBottom } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { ConsentSheet, FilterChips, Icon, PhoneSheet, Screen, TopicCard } from '@/components'
import CircleJoinGuide from '@/features/circle/CircleJoinGuide'
import { requirePhone } from '@/features/auth/gates'
import { ensureSignedIn, gateActionText, loginGate } from '@/features/auth/require-login'
import { CIRCLES_KEY, FEED_PAGE_SIZE, getFeedVersion, listCircles, listTopics } from '@/services/community'
import type { TopicCard as TopicCardData } from '@/services/community'
import { errorMessage, needsAdultConfirm } from '@/services/errors'
import { HAS_LOGIN, useUserStore } from '@/store/user'
import { usePaged } from '@/hooks/usePaged'
import { useRequest } from '@/hooks/useRequest'
import { useTrackPage } from '@/hooks/useTrackPage'
import { navigate } from '@/utils/router'
import { tw } from '@/utils/tw'
import { a11yButton } from '@/utils/a11y'

export const HOME_EMPTY = '还没有话题，来发起第一个吧'
export const NEW_TOPIC = '发起话题'
export const READ_REASON = '浏览话题'
export const NEED_ADULT_TEXT = '确认年满 18 周岁后可浏览话题'
export const LOAD_MORE_FAILED = '加载失败，点击重试'
export const FEED_END = '没有更多了'
export const HOME_ALL_CIRCLES = '全部'

/** 导航栏「✎」：通过发布门禁后进发帖页（未满足时就地引导，不会进入） */
export function onNewTopic (circleId?: string): void {
  if (requirePhone({ reason: NEW_TOPIC })) void navigate('topicNew', circleId ? { circleId } : {})
}

export default function Index () {
  useTrackPage('home')
  const consent = useUserStore(s => s.consent)
  const signedIn = useUserStore(s => s.auth.signedIn)
  const adult = useUserStore(s => s.adult)
  const gate = loginGate(consent, !HAS_LOGIN || signedIn)
  const needAdult = !gate && adult !== 'confirmed'
  const ready = !gate && !needAdult

  const circlesReq = useRequest(ready ? CIRCLES_KEY : null, listCircles)
  const circles = circlesReq.data || []
  const joinedCircles = circles.filter(circle => circle.joined)
  const [selectedCircle, setSelectedCircle] = useState(HOME_ALL_CIRCLES)
  const hasCircleFilter = joinedCircles.length > 1
  const filterValue = hasCircleFilter && joinedCircles.some(circle => circle.id === selectedCircle) ? selectedCircle : HOME_ALL_CIRCLES
  const activeCircleId = filterValue === HOME_ALL_CIRCLES ? undefined : filterValue
  const membershipKey = joinedCircles.map(circle => circle.id).sort().join(',')
  const canLoadFeed = ready && !!circlesReq.data && joinedCircles.length > 0
  const feed = usePaged<TopicCardData>(canLoadFeed ? `feed:home:${membershipKey}:${activeCircleId || HOME_ALL_CIRCLES}` : 'feed:off', page =>
    canLoadFeed ? listTopics(page, FEED_PAGE_SIZE, activeCircleId) : Promise.resolve({ list: [], hasMore: false })
  )

  // 下拉刷新（小程序 / H5）；刷新结束后收起
  const pulled = useRef(false)
  usePullDownRefresh(() => { pulled.current = true; void circlesReq.refresh(); feed.reload() })
  useEffect(() => {
    if (!circlesReq.loading && !feed.loading && pulled.current) { pulled.current = false; void Taro.stopPullDownRefresh() }
  }, [circlesReq.loading, feed.loading])
  // 触底翻页（小程序 / H5；RN 用 Screen 的 onReachBottom）
  useReachBottom(feed.loadMore)
  // 发布 / 删除后回到首页：话题流有变化就重新取数（RN 没有下拉刷新）
  const seen = useRef(getFeedVersion())
  useDidShow(() => {
    if (seen.current !== getFeedVersion()) {
      seen.current = getFeedVersion()
      void circlesReq.refresh()
      feed.reload()
    }
  })

  const empty = feed.list.length === 0
  // 本机认为已确认 18+、云端却返回 40303（换机 / 云端状态不一致）：同样引导去确认
  const adultBlocked = needAdult || (ready && (needsAdultConfirm(circlesReq.error) || needsAdultConfirm(feed.error)))
  const noJoinedCircles = ready && !!circlesReq.data && joinedCircles.length === 0
  const circlesLoading = ready && !circlesReq.data && circlesReq.loading
  const requestError = (!circlesReq.data && circlesReq.error) || (joinedCircles.length > 0 && feed.error)
  const status = !ready || adultBlocked ? 'empty'
    : circlesLoading ? 'loading'
      : requestError ? 'error'
        : noJoinedCircles ? 'ready'
          : feed.loading && empty ? 'loading'
            : feed.error && empty ? 'error'
              : empty ? 'empty' : 'ready'
  const emptyText = gate === 'login' ? '登录后可浏览话题' : gate ? '同意协议后可浏览话题' : adultBlocked ? NEED_ADULT_TEXT : HOME_EMPTY
  const emptyActionText = gate ? gateActionText(gate) : adultBlocked ? '去确认' : NEW_TOPIC
  const onEmptyAction = () => {
    if (gate) ensureSignedIn({ reason: READ_REASON })
    else if (adultBlocked) void navigate('adult', { reason: READ_REASON })
    else onNewTopic(activeCircleId)
  }

  const newTopic = (
    <View
      {...tw('flex flex-row items-center justify-center w-touch h-touch rounded-full')}
      hoverClass={tw('bg-paper-dark').className}
      onClick={() => onNewTopic(activeCircleId)}
      {...a11yButton(NEW_TOPIC)}
    >
      <Icon name='pencil' size='md' />
    </View>
  )

  return (
    <Screen
      tabPage
      nav={{ title: '结灵子', right: newTopic }}
      status={status}
      emptyText={emptyText}
      emptyActionText={emptyActionText}
      onEmptyAction={onEmptyAction}
      errorText={errorMessage((!circlesReq.data && circlesReq.error) || feed.error)}
      onRetry={() => { if (!circlesReq.data) void circlesReq.refresh(); else feed.reload() }}
      onReachBottom={feed.loadMore}
      overlay={<><ConsentSheet /><PhoneSheet /></>}
    >
      <View {...tw('flex flex-col px-page pt-4 pb-section')}>
        {noJoinedCircles
          ? <CircleJoinGuide circles={circles} />
          : <>
            {hasCircleFilter && (
              <FilterChips
                options={[{ value: HOME_ALL_CIRCLES, label: HOME_ALL_CIRCLES }, ...joinedCircles.map(circle => ({ value: circle.id, label: circle.name }))]}
                value={filterValue}
                onChange={setSelectedCircle}
                size='sm'
                scroll
                padded={false}
                name='圈子：'
                {...tw('mb-2')}
              />
            )}
            {feed.list.map(t => (
              <TopicCard key={t._id} topic={t} onClick={() => { void navigate('topic', { id: t.id }) }} />
            ))}
            {feed.loadingMore && <Text {...tw('font-body text-caption text-ink-faint text-center py-3')}>加载中…</Text>}
            {!!feed.moreError && (
              <View onClick={feed.loadMore} {...a11yButton(LOAD_MORE_FAILED)} {...tw('flex items-center justify-center min-h-touch')}>
                <Text {...tw('font-body text-caption text-brand-dark')}>{LOAD_MORE_FAILED}</Text>
              </View>
            )}
            {!feed.hasMore && !feed.loadingMore && !feed.moreError && <Text {...tw('font-body text-caption text-ink-faint text-center py-3')}>{FEED_END}</Text>}
          </>}
      </View>
    </Screen>
  )
}

