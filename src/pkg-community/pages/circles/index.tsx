/** 圈子目录（FE-M4-01）：我的圈子与其他开放官方圈子；非成员可从这里输入邀请码。 */
import { useRef } from 'react'
import { useDidShow } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { Button, ConsentSheet, Screen } from '@/components'
import { useCircleAccess } from '@/features/circle/access'
import { useRequest } from '@/hooks/useRequest'
import { CIRCLES_KEY, listCircles } from '@/services/community'
import type { Circle } from '@/types/models'
import { needsAdultConfirm } from '@/services/errors'
import { navigate } from '@/utils/router'
import { useTrackPage } from '@/hooks/useTrackPage'
import { a11yButton } from '@/utils/a11y'
import { tw } from '@/utils/tw'

export const CIRCLES_TITLE = '圈子'
export const MY_CIRCLES_TITLE = '我的圈子'
export const OTHER_CIRCLES_TITLE = '其他官方圈子'
export const JOIN_WITH_CODE = '输入邀请码'
export const NO_MY_CIRCLES = '还没有加入圈子，输入邀请码后即可浏览圈内话题'
export const NO_OPEN_CIRCLES = '暂时没有开放的圈子'

function CircleRow ({ circle, onOpen, onJoin }: { circle: Circle, onOpen: () => void, onJoin: () => void }) {
  return (
    <View {...tw('flex flex-col p-4 mb-3 rounded-md bg-paper-light')}>
      <View onClick={onOpen} {...tw('flex flex-col')} {...a11yButton(`查看圈子：${circle.name}`)}>
        <View {...tw('flex flex-row items-center justify-between')}>
          <Text {...tw('font-title font-bold text-subtitle text-ink')}>{circle.name}</Text>
          {circle.joined && <Text {...tw('font-body text-caption text-brand-dark')}>已加入</Text>}
        </View>
        {!!circle.desc && <Text {...tw('font-body text-body text-ink-soft mt-2')} numberOfLines={3}>{circle.desc}</Text>}
        <Text {...tw('font-body text-caption text-ink-faint mt-2')}>{`${circle.memberCount} 位成员 · ${circle.topicCount} 个话题`}</Text>
      </View>
      {!circle.joined && <Button variant='secondary' onClick={onJoin} {...tw('self-start mt-3')}>{JOIN_WITH_CODE}</Button>}
    </View>
  )
}

export default function Circles () {
  useTrackPage('circles')
  const access = useCircleAccess('浏览圈子')
  const req = useRequest(access.ready ? CIRCLES_KEY : null, listCircles)
  const shown = useRef(false)
  useDidShow(() => {
    if (shown.current && access.ready) void req.refresh()
    shown.current = true
  })

  const adultError = access.ready && needsAdultConfirm(req.error)
  const blocked = !!access.gate || !access.adultOk || adultError
  const status = blocked ? 'empty' : req.loading && req.data === undefined ? 'loading' : req.error && req.data === undefined ? 'error' : 'ready'
  const emptyText = access.gate === 'login' ? '登录后可浏览圈子' : access.gate === 'consent' ? '同意协议后可浏览圈子' : '确认年满 18 周岁后可浏览圈子'
  const all = req.data || []
  const mine = all.filter(c => c.joined)
  const others = all.filter(c => !c.joined)
  const openJoin = () => { void navigate('joinCircle', {}) }

  return (
    <Screen
      nav={{ title: CIRCLES_TITLE }}
      status={status}
      emptyText={emptyText}
      emptyActionText={access.actionText}
      onEmptyAction={access.onAction}
      onRetry={() => { void req.refresh() }}
      overlay={<ConsentSheet />}
    >
      <View {...tw('flex flex-col px-page pt-4')}>
        <Text {...tw('font-title font-bold text-title text-ink mb-3')}>{MY_CIRCLES_TITLE}</Text>
        {mine.length
          ? mine.map(circle => <CircleRow key={circle.id} circle={circle} onOpen={() => { void navigate('circle', { id: circle.id }) }} onJoin={openJoin} />)
          : <Text {...tw('font-body text-caption text-ink-faint mb-4')}>{NO_MY_CIRCLES}</Text>}

        <Text {...tw('font-title font-bold text-title text-ink mt-4 mb-3')}>{OTHER_CIRCLES_TITLE}</Text>
        {others.length
          ? others.map(circle => <CircleRow key={circle.id} circle={circle} onOpen={() => { void navigate('circle', { id: circle.id }) }} onJoin={openJoin} />)
          : all.length > 0
            ? <Text {...tw('font-body text-caption text-ink-faint mb-4')}>你已加入全部开放圈子</Text>
            : <Text {...tw('font-body text-caption text-ink-faint mb-4')}>{NO_OPEN_CIRCLES}</Text>}

        <Button variant='secondary' onClick={openJoin} {...tw('self-start mt-2 mb-6')}>{JOIN_WITH_CODE}</Button>
      </View>
    </Screen>
  )
}
