/**
 * Button：主按钮（高 52 朱砂底白字）/ 次按钮（高 44 墨色 2 设计稿 px 描边）/ 文字按钮。
 * - 热区：md ≥ 44pt，kid ≥ 56pt
 * - 按下态：小程序 / H5 用 hoverClass，RN 用 hoverStyle（同一份令牌类）
 * - 加载态：左侧图标替换为转圈（转圈动画仅小程序 / H5，见 app.scss .jl-spin）
 */
import { View, Text } from '@tarojs/components'
import type { ITouchEvent } from '@tarojs/components'
import { mergeTw, tw, TwProps } from '@/utils/tw'
import { a11yButton } from '@/utils/a11y'
import Icon, { IconName, IconTone } from '../Icon'

export type ButtonVariant = 'primary' | 'secondary' | 'text'
export type ButtonSize = 'md' | 'kid'

export interface ButtonProps extends TwProps {
  children?: string
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: IconName
  loading?: boolean
  disabled?: boolean
  block?: boolean
  /** 读屏文字，默认使用 children */
  label?: string
  onClick?: (e: ITouchEvent) => void
}

const BOX: Record<ButtonVariant, string> = {
  primary: 'bg-brand min-h-btn px-6',
  secondary: 'bg-paper-light border-2 border-solid border-ink min-h-touch px-5',
  text: 'min-h-touch px-2'
}
const PRESSED: Record<ButtonVariant, string> = {
  primary: 'bg-brand-dark',
  secondary: 'bg-paper-dark',
  text: 'bg-paper-dark'
}
const LABEL: Record<ButtonVariant, string> = {
  primary: 'text-paper-light',
  secondary: 'text-ink',
  text: 'text-brand-dark'
}
const ICON_TONE: Record<ButtonVariant, IconTone> = { primary: 'light', secondary: 'ink', text: 'brand' }

const spinProps: TwProps = process.env.TARO_ENV === 'rn' ? {} : { className: 'jl-spin' }

export default function Button (props: ButtonProps) {
  const {
    children, variant = 'primary', size = 'md', icon, loading = false, disabled = false,
    block = false, label, onClick, className, style
  } = props
  const inactive = disabled || loading
  const box = tw(
    'flex flex-row items-center justify-center rounded-full',
    disabled ? 'bg-paper-dark min-h-btn px-6' : BOX[variant],
    size === 'kid' && 'min-h-touch-kid',
    block ? 'w-full' : 'self-start'
  )
  const pressed = tw(PRESSED[variant])
  const tone: IconTone = disabled ? 'soft' : ICON_TONE[variant]

  return (
    <View
      {...mergeTw(box, { className, style })}
      hoverClass={inactive ? 'none' : pressed.className}
      hoverStyle={inactive ? undefined : pressed.style}
      onClick={e => { if (!inactive && onClick) onClick(e) }}
      {...a11yButton(label || children)}
    >
      {loading
        ? <Icon name='loader-circle' tone={tone} size='sm' {...mergeTw(tw(children ? 'mr-2' : ''), spinProps)} />
        : icon && <Icon name={icon} tone={tone} size='sm' {...tw(children ? 'mr-2' : '')} />}
      {children && (
        <Text {...tw('font-body font-bold text-kid-button', disabled ? 'text-ink-faint' : LABEL[variant])}>{children}</Text>
      )}
    </View>
  )
}
