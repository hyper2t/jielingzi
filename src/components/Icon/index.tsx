/**
 * Icon：Lucide 线性图标 PNG@3x（小程序不支持内联 SVG）。
 * 图标与颜色由 tools/gen-icons.js 生成，颜色为设计令牌名；缺失的颜色回落 ink。
 * 装饰图标不传 label（读屏隐藏）；可点击图标请放在 Button / 可点击容器里并给容器 label。
 */
import { Image } from '@tarojs/components'
import { ICONS, IconName } from '@/assets/icons'
import { mergeTw, tw, TwProps } from '@/utils/tw'
import { a11yLabel } from '@/utils/a11y'

export type { IconName }
export type IconTone = 'ink' | 'soft' | 'brand' | 'light' | 'apricot' | 'brand'
export type IconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

// 完整静态类名，禁止拼接
const SIZE: Record<IconSize, string> = {
  xs: 'w-3 h-3', // 12
  sm: 'w-4 h-4', // 16
  md: 'w-6 h-6', // 24
  lg: 'w-7 h-7', // 28
  xl: 'w-8 h-8' // 32
}

export interface IconProps extends TwProps {
  name: IconName
  tone?: IconTone
  size?: IconSize
  label?: string
}

export function iconSrc (name: IconName, tone: IconTone = 'ink'): string {
  const set = ICONS[name] as Record<string, string>
  return set[tone] || set.ink
}

export default function Icon ({ name, tone = 'ink', size = 'md', label, className, style }: IconProps) {
  return (
    <Image
      src={iconSrc(name, tone)}
      mode='aspectFit'
      {...mergeTw(tw(SIZE[size]), { className, style })}
      {...a11yLabel(label)}
    />
  )
}
