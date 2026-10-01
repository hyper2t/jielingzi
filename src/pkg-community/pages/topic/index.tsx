/**
 * 话题详情（占位，FE-M0-01）。M3 实现：正文 + 回复列表（短回复折叠）+ 引用 + 举报。布局见 docs/prd/README.md §7.2。
 */
import { Empty, Screen } from '@/components'
import { useTrackPage } from '@/hooks/useTrackPage'

export const TOPIC_PLACEHOLDER = '话题详情即将开放'

export default function Topic () {
  useTrackPage('topic')
  return (
    <Screen nav={{ title: '话题', showBack: true }}>
      <Empty text={TOPIC_PLACEHOLDER} />
    </Screen>
  )
}
