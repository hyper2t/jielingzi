/** 未入圈时的圈子介绍与加入入口（首页 / 发话题页共用）。 */
import { View, Text } from '@tarojs/components'
import { Button } from '@/components'
import type { Circle } from '@/types/models'
import { navigate } from '@/utils/router'
import { tw } from '@/utils/tw'

export const CIRCLE_JOIN_GUIDE_TITLE = '先加入一个圈子'
export const CIRCLE_JOIN_GUIDE_TEXT = '结灵子是邀请制社区。加入后即可浏览圈内话题并参与交流；未加入的圈子内容不会出现在首页。'
export const CIRCLE_JOIN_ACTION = '输入邀请码'
export const CIRCLE_DIRECTORY_ACTION = '浏览圈子'
export const NO_OPEN_CIRCLES_TEXT = '目前没有开放的圈子，可以稍后再来。'

export default function CircleJoinGuide ({ circles }: { circles: Circle[] }) {
  return (
    <View {...tw('flex flex-col p-4 rounded-md bg-paper-light')}>
      <Text {...tw('font-title font-bold text-subtitle text-ink')}>{CIRCLE_JOIN_GUIDE_TITLE}</Text>
      <Text {...tw('font-body text-caption text-ink-soft mt-2')}>{CIRCLE_JOIN_GUIDE_TEXT}</Text>
      {circles.length
        ? circles.map(circle => (
          <View key={circle.id} {...tw('flex flex-col p-3 mt-3 rounded-md bg-paper')}>
            <Text {...tw('font-body font-bold text-body text-ink')}>{circle.name}</Text>
            {!!circle.desc && <Text {...tw('font-body text-caption text-ink-soft mt-1')}>{circle.desc}</Text>}
          </View>
        ))
        : <Text {...tw('font-body text-caption text-ink-faint mt-3')}>{NO_OPEN_CIRCLES_TEXT}</Text>}
      <Button block onClick={() => { void navigate('joinCircle') }} {...tw('mt-4')}>{CIRCLE_JOIN_ACTION}</Button>
      <Button variant='secondary' block onClick={() => { void navigate('circles') }} {...tw('mt-2')}>{CIRCLE_DIRECTORY_ACTION}</Button>
    </View>
  )
}
