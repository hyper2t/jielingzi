/**
 * Sheet：底部选项弹层（04-ui §3）。paper-light，顶部圆角 lg，拖拽条 36×4；选项行高 56，选中项右侧对勾 + 朱砂文字。
 * 用于定时（本集结束 / 15 / 30 分钟 / 关闭）、倍速（0.75 / 1 / 1.25）。点遮罩关闭。
 */
import { View, Text } from '@tarojs/components'
import { tw } from '@/utils/tw'
import { a11yButton } from '@/utils/a11y'
import Icon from '../Icon'

const OVERLAY = process.env.TARO_ENV === 'rn' ? 'absolute inset-0' : 'fixed inset-0'

export interface SheetOption<T> { value: T, label: string }

export interface SheetProps<T> {
  open: boolean
  title: string
  options: Array<SheetOption<T>>
  value?: T
  onSelect: (v: T) => void
  onClose: () => void
}

export default function Sheet<T extends string | number> ({ open, title, options, value, onSelect, onClose }: SheetProps<T>) {
  if (!open) return null
  return (
    <View {...tw(OVERLAY, 'z-50 flex flex-col justify-end bg-mask')} onClick={onClose} catchMove>
      <View {...tw('flex flex-col bg-paper-light rounded-t-lg px-page pt-3 pb-8')} onClick={(e: any) => e?.stopPropagation?.()}>
        <View {...tw('self-center w-9 h-1 rounded-full bg-paper-dark mb-3')} />
        <Text {...tw('font-title font-bold text-subtitle text-ink mb-2')}>{title}</Text>
        {options.map(o => {
          const on = o.value === value
          return (
            <View
              key={String(o.value)}
              {...tw('flex flex-row items-center justify-between min-h-touch-kid')}
              onClick={() => { onSelect(o.value); onClose() }}
              {...a11yButton(`${o.label}${on ? '，已选中' : ''}`)}
            >
              <Text {...tw('font-body text-body', on ? 'text-brand-dark font-bold' : 'text-ink')}>{o.label}</Text>
              {on && <Icon name='check' tone='brand' size='md' />}
            </View>
          )
        })}
      </View>
    </View>
  )
}
