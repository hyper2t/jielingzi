/** 圈子详情（FE-M4-01）：非成员可读简介与公约，但只对成员加载圈内话题流。 */
import { useEffect, useRef } from 'react'
import Taro, { useDidShow, usePullDownRefresh, useReachBottom } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { Button, ConsentSheet, Empty, Screen, TopicCard } from '@/components'
import { useCircleAccess } from '@/features/circle/access'
import { usePaged } from '@/hooks/usePaged'
import { useRequest } from '@/hooks/useRequest'
import { circleKey, FEED_PAGE_SIZE, getCircle, listTopics } from '@/services/community'
import type { TopicCard as TopicCardData } from '@/services/community'
import { errorCode, needsAdultConfirm, errorMessage } from '@/services/errors'
import { ERROR_CODES } from '@/services/cloud.types'
import { back, navigate, parseParams } from '@/utils/router'
import { useTrackPage } from '@/hooks/useTrackPage'
import { a11yButton } from '@/utils/a11y'
import { tw } from '@/utils/tw'

export const CIRCLE_NOT_FOUND = '圈子不存在或已关闭'
export const CIRCLE_FEED_EMPTY = '这个圈子还没有话题'
export const CIRCLE_MEMBER_HINT = '加入圈子后即可浏览圈内话题，也可以与圈友交流练习经验。'

export default function CirclePage () {
  useTrackPage('circle')
  const id = parseParams<'circle'>(Taro.getCurrentInstance().router?.params).id || ''
  const access = useCircleAccess('浏览圈子')
  const req = useRequest(access.ready && id ? circleKey(id) : null, () => getCircle(id))
  const circle = req.data
  const feedKey = `circle-feed:${id}:${access.ready && circle?.joined ? 'member' : 'locked'}`
  const feed = usePaged<TopicCardData>(feedKey, page => circle?.joined
    ? listTopics(page, FEED_PAGE_SIZE, id)
    : Promise.resolve({ list: [], hasMore: false }))
  const shown = useRef(false)
  const pulled = useRef(false)

  useDidShow(() => {
    if (shown.current && access.ready && id) {
      void req.refresh()
      if (circle?.joined) feed.reload()
    }
    shown.current = true
  })
  useReachBottom(feed.loadMore)
  usePullDownRefresh(() => {
    if (circle?.joined) { pulled.current = true; feed.reload() }
  })
  useEffect(() => {
    if (!feed.loading && pulled.current) { pulled.current = false; void Taro.stopPullDownRefresh() }
  }, [feed.loading])

  const adultError = access.ready && needsAdultConfirm(req.error)
  const notFound = !id || errorCode(req.error) === ERROR_CODES.NOT_FOUND
  const blocked = !!access.gate || !access.adultOk || adultError
  const status = blocked ? 'empty'
    : req.loading && !circle ? 'loading'
      : req.error && !circle && !notFound ? 'error'
        : !circle ? 'empty' : 'ready'
  const emptyText = access.gate === 'login' ? '登录后可浏览圈子' : access.gate === 'consent' ? '同意协议后可浏览圈子' : adultError || !access.adultOk ? '确认年满 18 周岁后可浏览圈子' : CIRCLE_NOT_FOUND
  const emptyActionText = blocked ? access.actionText : '返回'
  const onEmptyAction = blocked ? access.onAction : () => { void back() }

  return (
    <Screen
      nav={{ title: circle?.name || '圈子' }}
      status={status}
      emptyText={emptyText}
      emptyActionText={emptyActionText}
      onEmptyAction={onEmptyAction}
      errorText={req.error ? errorMessage(req.error) : undefined}
      onRetry={() => { void req.refresh() }}
      onReachBottom={feed.loadMore}
      overlay={<ConsentSheet />}
    >
      {circle && (
        <View {...tw('flex flex-col px-page pt-4')}>
          <View {...tw('flex flex-col p-4 rounded-md bg-paper-light')}>
            <Text {...tw('font-title font-bold text-title text-ink')}>{circle.name}</Text>
            {!!circle.desc && <Text {...tw('font-body text-body text-ink-soft mt-2')}>{circle.desc}</Text>}
            <Text {...tw('font-body text-caption text-ink-faint mt-3')}>{`${circle.memberCount} 位成员 · ${circle.topicCount} 个话题`}</Text>
          </View>

          <Text {...tw('font-title font-bold text-subtitle text-ink mt-5 mb-2')}>圈子公约</Text>
          {circle.rules.length
            ? circle.rules.map((rule, i) => (
              <View key={`${i}-${rule}`} {...tw('flex flex-row mb-2')}>
                <Text {...tw('font-body text-body text-brand-dark mr-2')}>{`${i + 1}.`}</Text>
                <Text {...tw('flex-1 font-body text-body text-ink')}>{rule}</Text>
              </View>
            ))
            : <Text {...tw('font-body text-caption text-ink-faint')}>暂未设置圈子公约</Text>}

          {circle.joined
            ? <View {...tw('flex flex-row flex-wrap mt-4')}>
              <Button variant='secondary' onClick={() => { void navigate('invites', { circleId: circle.id }) }} {...tw('mr-2 mb-2')}>生成邀请码</Button>
              <Button variant='primary' icon='pencil' onClick={() => { void navigate('topicNew', { circleId: circle.id }) }} {...tw('mb-2')}>发起话题</Button>
            </View>
            : <View {...tw('flex flex-col mt-4 p-4 rounded-md bg-highlight')}>
              <Text {...tw('font-body text-body text-ink')}>{CIRCLE_MEMBER_HINT}</Text>
              <Button variant='primary' onClick={() => { void navigate('joinCircle', {}) }} {...tw('self-start mt-3')}>输入邀请码</Button>
            </View>}

          {circle.joined && (
            <View {...tw('flex flex-col mt-5')}>
              <>
              <Text {...tw('font-title font-bold text-subtitle text-ink mb-2')}>圈内话题</Text>
              {feed.loading && feed.list.length === 0 && <Text {...tw('font-body text-caption text-ink-faint py-4')}>加载中…</Text>}
              {feed.error && feed.list.length === 0 && (
                <View onClick={feed.reload} {...a11yButton('圈内话题加载失败，点击重试')} {...tw('flex items-center justify-center min-h-touch')}>
                  <Text {...tw('font-body text-caption text-brand-dark')}>圈内话题加载失败，点击重试</Text>
                </View>
              )}
              {!feed.loading && !feed.error && feed.list.length === 0 && <Empty compact text={CIRCLE_FEED_EMPTY} />}
              {feed.list.map(topic => (
                <TopicCard key={topic._id} topic={topic} onClick={() => { void navigate('topic', { id: topic.id }) }} />
              ))}
              {feed.loadingMore && <Text {...tw('font-body text-caption text-ink-faint text-center py-3')}>加载中…</Text>}
              {!!feed.moreError && (
                <View onClick={feed.loadMore} {...a11yButton('加载失败，点击重试')} {...tw('flex items-center justify-center min-h-touch')}>
                  <Text {...tw('font-body text-caption text-brand-dark')}>加载失败，点击重试</Text>
                </View>
              )}
              {!feed.loading && !feed.hasMore && feed.list.length > 0 && <Text {...tw('font-body text-caption text-ink-faint text-center py-3')}>没有更多了</Text>}
              </>
            </View>
          )}
        </View>
      )}
    </Screen>
  )
}
