/**
 * 印章 Seal：朱砂方印，白字宋体竖排 2–4 字，旋转 -4°；纯装饰，读屏隐藏。
 * 旋转用内联 transform（Tailwind rotate 依赖 CSS 变量，RN 不支持）。
 */
import { View, Text } from '@tarojs/components'
import { mergeTw, tw, TwProps } from '@/utils/tw'
import { rotateStyle } from '@/utils/transform'
import { a11yHidden } from '@/utils/a11y'

export interface SealProps extends TwProps {
  text: string
  size?: 'sm' | 'md'
}

export default function Seal ({ text, size = 'md', className, style }: SealProps) {
  const chars = Array.from(text).slice(0, 4)
  const base = tw('flex flex-col items-center justify-center bg-brand rounded-seal', size === 'sm' ? 'px-1 py-1' : 'px-2 py-2')
  return (
    <View {...mergeTw(base, { className, style: { ...rotateStyle(-4), ...style } })} {...a11yHidden()}>
      {chars.map((ch, i) => (
        <Text key={i} {...tw('font-title font-bold text-paper-light', size === 'sm' ? 'text-caption' : 'text-subtitle')}>{ch}</Text>
      ))}
    </View>
  )
}
