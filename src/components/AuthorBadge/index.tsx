/**
 * AuthorBadge：内容作者身份（FE-M1-04，PRD P2 / §7.2 / §8.3），M3 话题卡片、话题详情、回复列表复用。
 * - 实名：档案头像 + 昵称（+「资深练习者」等标识）+ 副信息（练习方式 · 年限 · 时间）
 * - 匿名（anon，话题级开关）：匿名头像 +「匿名·<代号>」，不显示任何档案信息
 * - 作者已注销：默认头像 +「已注销用户」
 * - 本人发布：名字后加「我」（匿名内容也只有本人能看到这个标签——isSelf 由接口按调用者计算）
 * 数据只来自接口返回的 author 对象（永远不含 authorUid，见 types/models.ts AuthorView）。
 */
import { View, Text } from '@tarojs/components'
import type { AuthorView } from '@/types/models'
import { profileMeta } from '@/features/profile/rules'
import { mergeTw, tw, TwProps } from '@/utils/tw'
import { a11yLabel } from '@/utils/a11y'
import Avatar from '../Avatar'

export const ANON_PREFIX = '匿名·'
export const DELETED_NAME = '已注销用户'
export const FALLBACK_NAME = '练习者'
export const SELF_TAG = '我'
/** profiles.badges → 展示文案（PRD v0.2「资深练习者标识」） */
export const BADGE_LABELS: Record<string, string> = { senior: '资深练习者' }

export interface AuthorBadgeProps extends TwProps {
  author: AuthorView
  /** 匿名形态；默认取 author.anon */
  anon?: boolean
  /** 追加在副信息末尾，如「10-01」 */
  meta?: string
  size?: 'sm' | 'md'
}

/** 展示名：已注销 →「已注销用户」；匿名 →「匿名·代号」；否则昵称（空时「练习者」） */
export function authorName (a: AuthorView, anon: boolean = !!a.anon): string {
  if (a.deleted) return DELETED_NAME
  const name = (a.name || '').trim() || FALLBACK_NAME
  return anon ? `${ANON_PREFIX}${name}` : name
}

export default function AuthorBadge ({ author, anon = !!author.anon, meta, size = 'md', className, style }: AuthorBadgeProps) {
  const name = authorName(author, anon)
  const showProfile = !anon && !author.deleted
  const sub = [showProfile ? profileMeta({ practices: author.practices || [], years: author.years ?? null }) : '', meta || '']
    .filter(Boolean)
    .join(' · ')
  const badges = showProfile ? (author.badges || []).map(b => BADGE_LABELS[b]).filter(Boolean) : []
  const label = `${name}${author.isSelf ? '（我）' : ''}${badges.length ? `，${badges.join('，')}` : ''}${sub ? `，${sub}` : ''}`
  return (
    <View {...mergeTw(tw('flex flex-row items-center'), { className, style })} {...a11yLabel(label)}>
      <Avatar avatar={showProfile ? author.avatar : null} anon={anon && !author.deleted} size={size === 'sm' ? 'sm' : 'md'} />
      <View {...tw('flex flex-col flex-1 ml-2')}>
        <View {...tw('flex flex-row items-center')}>
          <Text {...tw('font-body font-bold text-ink', size === 'sm' ? 'text-caption' : 'text-body')} numberOfLines={1}>{name}</Text>
          {author.isSelf && <Text {...tw('ml-1 px-1 rounded-sm bg-brand-light font-body text-caption text-brand-dark')}>{SELF_TAG}</Text>}
          {badges.map(b => (
            <Text key={b} {...tw('ml-1 px-1 rounded-sm bg-highlight font-body text-caption text-apricot-dark')}>{b}</Text>
          ))}
        </View>
        {!!sub && <Text {...tw('font-body text-caption text-ink-faint')} numberOfLines={1}>{sub}</Text>}
      </View>
    </View>
  )
}
