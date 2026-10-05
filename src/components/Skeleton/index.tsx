/**
 * Skeleton：paper-dark 色块 + 墨晕扫光（扫光仅小程序 / H5，见 app.scss .jl-skeleton；
 * 系统"减少动态效果"时静止；RN 端为静态色块）。读屏隐藏。
 */
import { View } from '@tarojs/components'
import { mergeTw, tw, TwProps } from '@/utils/tw'
import { a11yHidden } from '@/utils/a11y'

export type SkeletonVariant = 'text' | 'list' | 'card' | 'reader'

export interface SkeletonProps extends TwProps {
  variant?: SkeletonVariant
  rows?: number
}

const shimmer: TwProps = process.env.TARO_ENV === 'rn' ? {} : { className: 'jl-skeleton' }

function Block ({ cls }: { cls: string }) {
  return <View {...mergeTw(tw('bg-paper-dark', cls), shimmer)} />
}

export default function Skeleton ({ variant = 'text', rows = 3, className, style }: SkeletonProps) {
  const items = Array.from({ length: Math.max(1, rows) })
  return (
    <View {...mergeTw(tw('flex flex-col px-page'), { className, style })} {...a11yHidden()}>
      {variant === 'text' && items.map((_, i) => (
        <Block key={i} cls={i === items.length - 1 ? 'h-4 w-2/3 rounded-sm mb-3' : 'h-4 w-full rounded-sm mb-3'} />
      ))}
      {variant === 'list' && items.map((_, i) => (
        <View key={i} {...tw('flex flex-row items-center mb-4')}>
          <Block cls='w-[4.5rem] h-24 rounded-md mr-3' />
          <View {...tw('flex flex-col flex-1')}>
            <Block cls='h-5 w-2/3 rounded-sm mb-2' />
            <Block cls='h-4 w-full rounded-sm mb-2' />
            <Block cls='h-4 w-1/3 rounded-sm' />
          </View>
        </View>
      ))}
      {variant === 'card' && (
        <View {...tw('flex flex-row')}>
          {items.map((_, i) => (
            <View key={i} {...tw('flex flex-col mr-4', i % 2 === 1 && 'mt-4')}>
              <Block cls='w-[9.75rem] h-[13rem] rounded-md mb-2' />
              <Block cls='h-4 w-24 rounded-sm' />
            </View>
          ))}
        </View>
      )}
      {variant === 'reader' && items.map((_, i) => (
        <View key={i} {...tw('flex flex-col mb-4')}>
          <Block cls='h-3 w-3/4 rounded-sm mb-2' />
          <Block cls='h-7 w-full rounded-sm' />
        </View>
      ))}
    </View>
  )
}
