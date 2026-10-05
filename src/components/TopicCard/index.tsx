/**
 * TopicCard：话题流里的卡片（FE-M3-01，PRD §7.1）。作者（AuthorBadge，匿名已脱敏）+ 发帖时间、标题、摘要、标签、回复数。
 * 精选话题带「精选」标；自己还在审核中的话题带「审核中」（只有本人看得到）；慢话题在冷静期内带「慢话题 · N 小时冷静期」标。数据只来自接口返回的摘要，不含正文。
 */
import { View, Text } from '@tarojs/components'
import type { TopicSummary } from '@/types/models'
import { formatPostTime, isReplyLocked, SLOW_LOCK_LABEL } from '@/features/topic/rules'
import { mergeTw, tw, TwProps } from '@/utils/tw'
import { a11yButton } from '@/utils/a11y'
import AuthorBadge from '../AuthorBadge'

export const FEATURED_BADGE = '精选'
export const PENDING_BADGE = '审核中 · 仅你可见'

export interface TopicCardProps extends TwProps {
  topic: TopicSummary
  /** 当前时间（毫秒，测试用；默认 Date.now()） */
  now?: number
  onClick?: () => void
}

export default function TopicCard ({ topic, now, onClick, className, style }: TopicCardProps) {
  const locked = isReplyLocked(topic, now ?? Date.now())
  return (
    <View
      {...mergeTw(tw('flex flex-col p-4 mb-3 rounded-md bg-paper-light shadow-card'), { className, style })}
      onClick={onClick}
      {...a11yButton(`话题：${topic.title}，${topic.replyCount} 条回复${topic.circle?.name ? `，${topic.circle.name}` : ''}${locked ? '，冷静期中' : ''}`)}
    >
      <AuthorBadge author={topic.author} anon={topic.anon} size='sm' meta={formatPostTime(topic.createdAt, now)} />
      {!!topic.circle?.name && <Text {...tw('self-start mt-3 px-2 rounded-full bg-brand-light font-body text-caption text-brand-dark')}>{topic.circle.name}</Text>}
      <Text {...tw('font-title font-bold text-subtitle text-ink mt-3')} numberOfLines={2}>{topic.title}</Text>
      {!!topic.excerpt && <Text {...tw('font-body text-body text-ink-soft mt-1')} numberOfLines={3}>{topic.excerpt}</Text>}
      {topic.tags.length > 0 && (
        <View {...tw('flex flex-row flex-wrap')}>
          {topic.tags.map(t => (
            <Text key={t} {...tw('mr-2 mt-2 px-2 rounded-sm bg-brand-light font-body text-caption text-brand-dark')}>{`#${t}`}</Text>
          ))}
        </View>
      )}
      <View {...tw('flex flex-row items-center mt-3')}>
        {topic.featured && <Text {...tw('mr-2 px-2 rounded-sm bg-highlight font-body text-caption text-apricot-dark')}>{FEATURED_BADGE}</Text>}
        {locked && <Text {...tw('mr-2 px-2 rounded-sm bg-paper-dark font-body text-caption text-ink-soft')}>{SLOW_LOCK_LABEL}</Text>}
        {topic.pending && <Text {...tw('mr-2 px-2 rounded-sm bg-paper-dark font-body text-caption text-ink-soft')}>{PENDING_BADGE}</Text>}
        <View {...tw('flex-1')} />
        <Text {...tw('font-body text-caption text-ink-faint')}>{`${topic.replyCount} 条回复`}</Text>
      </View>
    </View>
  )
}
