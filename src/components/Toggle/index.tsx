/**
 * Toggle：开关行（如「匿名发布」）。整行可点，读屏读作「<标签>，已开启 / 已关闭」。
 * 小程序 / H5 / RN 共用（不用原生 Switch，避免三端样式不一致）。
 */
import { View, Text } from '@tarojs/components'
import { mergeTw, tw, TwProps } from '@/utils/tw'

export interface ToggleProps extends TwProps {
  on: boolean
  label: string
  onChange: (on: boolean) => void
  disabled?: boolean
}

export default function Toggle ({ on, label, onChange, disabled = false, className, style }: ToggleProps) {
  const a11y = `${label}，${on ? '已开启' : '已关闭'}`
  return (
    <View
      {...mergeTw(tw('flex flex-row items-center min-h-touch'), { className, style })}
      onClick={() => { if (!disabled) onChange(!on) }}
      {...{ ariaLabel: a11y, ariaRole: 'switch', accessibilityLabel: a11y, accessibilityRole: 'switch', accessibilityState: { checked: on, disabled } } as any}
    >
      <View {...tw('w-10 h-6 mr-2 rounded-full', on ? 'bg-brand' : 'bg-paper-dark')}>
        <View {...tw('w-5 h-5 mt-[2px] rounded-full bg-paper-light', on ? 'ml-[18px]' : 'ml-[2px]')} />
      </View>
      <Text {...tw('font-body text-body', on ? 'text-ink font-bold' : 'text-ink')}>{label}</Text>
    </View>
  )
}
