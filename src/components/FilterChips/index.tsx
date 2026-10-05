/**
 * FilterChips：筛选胶囊（分类、年龄段）。选中 = 竹青底 + 白字 + 对勾（不只靠颜色，04-ui §6）。
 * - size sm：胶囊视觉高 32、字号 13、左右内边距 12（首页分龄、分类页筛选，2026-09-29 按用户要求缩小），但点击热区仍 ≥44（外层透明容器撑高，04-ui §6）；
 *   md：高 44（设置页）；kid：高 56（保留）
 * - scroll：单行横向滑动。微信 scroll-view（enhanced）里用 flex 容器做横向内容会被折行，所以这里用经典写法：
 *   scroll-view 设 white-space: nowrap，每个胶囊 inline-flex + vertical-align: middle，不放 flex 容器（RN 端改为 flex-row，见 utils/layout.ts HSCROLL）；
 *   padded 控制是否带页面左右边距（默认带）。
 *   非 scroll：flex 一行排列、可换行
 * 相邻热区间距 8（mr-2）。
 */
import { View, Text, ScrollView } from '@tarojs/components'
import { mergeTw, tw, TwProps } from '@/utils/tw'
import { HSCROLL } from '@/utils/layout'
import { a11yButton } from '@/utils/a11y'
import Icon from '../Icon'

export interface ChipOption<V extends string> {
  value: V
  label: string
}

export interface FilterChipsProps<V extends string> extends TwProps {
  options: Array<ChipOption<V>>
  value: V
  onChange: (v: V) => void
  size?: 'sm' | 'md' | 'kid'
  scroll?: boolean
  /** scroll 模式下内容区是否带 px-page（外层已有边距时传 false） */
  padded?: boolean
  /** 读屏前缀，如「年龄」 */
  name?: string
}

const SIZE_BOX = { sm: 'h-8 px-3', md: 'min-h-touch px-4', kid: 'min-h-touch-kid px-4' } as const
const SIZE_TEXT = { sm: 'text-caption', md: 'text-body', kid: 'text-kid-button' } as const

export default function FilterChips<V extends string> (props: FilterChipsProps<V>) {
  const { options, value, onChange, size = 'md', scroll = false, padded = true, name = '', className, style } = props
  const chips = options.map(o => {
    const on = o.value === value
    return (
      // 外层：热区（≥44，透明）；内层：胶囊视觉
      <View
        key={o.value}
        {...tw(
          scroll ? HSCROLL.item : 'flex',
          scroll && 'whitespace-nowrap',
          'flex-row items-center justify-center min-h-touch mr-2'
        )}
        onClick={() => { if (!on) onChange(o.value) }}
        {...a11yButton(`${name}${o.label}${on ? '，已选中' : ''}`)}
      >
        <View
          {...tw(
            'flex flex-row items-center justify-center rounded-full border-2 border-solid',
            SIZE_BOX[size],
            on ? 'bg-brand border-brand' : 'bg-paper-light border-paper-dark'
          )}
          hoverClass={on ? 'none' : tw('bg-paper-dark').className}
        >
          {on && <Icon name='check' tone='light' size='sm' {...tw('mr-1')} />}
          <Text {...tw('font-body whitespace-nowrap', SIZE_TEXT[size], on ? 'font-bold text-paper-light' : 'text-ink')}>{o.label}</Text>
        </View>
      </View>
    )
  })
  if (scroll) {
    return (
      <ScrollView
        scrollX
        enhanced
        showScrollbar={false}
        {...mergeTw(tw(HSCROLL.outer), { className, style })}
      >
        <View {...tw(HSCROLL.inner, padded && 'pl-page')}>
          {chips}
          {/* 末尾留白：最后一个胶囊滚到头时不贴边（inline 内容的右 padding 会被 scroll-view 吃掉，用占位代替） */}
          <View {...tw(HSCROLL.tail, padded ? 'w-3' : 'w-2')} />
        </View>
      </ScrollView>
    )
  }
  return <View {...mergeTw(tw('flex flex-row flex-wrap'), { className, style })}>{chips}</View>
}
