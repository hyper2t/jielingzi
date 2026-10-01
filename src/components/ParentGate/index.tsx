/**
 * ParentGate（FE-20，04-ui §3）：全屏弹层「请家长完成验证」，两位数加法 + 自绘 3×4 数字键盘（每键 64）。
 * 答错提示并换新题（不显示答案）；连错 3 次冷却 30s（倒计时）。用于家长中心入口、休息页解锁。
 */
import { useEffect, useState } from 'react'
import { View, Text } from '@tarojs/components'
import { checkAnswer, cooldownLeft, newQuestion, Question } from '@/features/parent/gate'
import { tw } from '@/utils/tw'
import { a11yButton } from '@/utils/a11y'
import Icon from '../Icon'

const OVERLAY = process.env.TARO_ENV === 'rn' ? 'absolute inset-0' : 'fixed inset-0'

export const GATE_TITLE = '请完成验证'
export const GATE_WRONG = '答错了，换一题再试'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'] as const

export interface ParentGateProps {
  open: boolean
  onPass: () => void
  onClose?: () => void
  /** 休息页等不允许关闭 */
  closable?: boolean
}

export default function ParentGate ({ open, onPass, onClose, closable = true }: ParentGateProps) {
  const [q, setQ] = useState<Question>(() => newQuestion())
  const [input, setInput] = useState('')
  const [hint, setHint] = useState('')
  const [left, setLeft] = useState(cooldownLeft())

  useEffect(() => {
    if (!open) return
    setQ(prev => newQuestion(Math.random, prev))
    setInput('')
    setHint('')
    setLeft(cooldownLeft())
  }, [open])

  const cooling = left > 0
  useEffect(() => {
    if (!cooling) return
    const id = setInterval(() => setLeft(cooldownLeft()), 1000)
    return () => clearInterval(id)
  }, [cooling])

  if (!open) return null

  const press = (k: typeof KEYS[number]) => {
    if (cooling) return
    if (k === 'del') { setInput(input.slice(0, -1)); return }
    if (k === 'ok') {
      if (!input) return
      const r = checkAnswer(q, Number(input))
      if (r === 'ok') { onPass(); return }
      setInput('')
      setQ(newQuestion(Math.random, q))
      if (r === 'cooldown') { setHint(''); setLeft(cooldownLeft()) } else setHint(GATE_WRONG)
      return
    }
    if (input.length < 3) setInput(input + k)
  }

  return (
    <View {...tw(OVERLAY, 'z-50 flex flex-col bg-paper px-page pt-12 pb-8')} catchMove>
      <View {...tw('flex flex-row items-center justify-between')}>
        <Text {...tw('font-title font-bold text-title text-ink')}>{GATE_TITLE}</Text>
        {closable && (
          <View {...tw('w-touch h-touch flex items-center justify-center')} onClick={onClose} {...a11yButton('关闭')}>
            <Icon name='x' size='md' />
          </View>
        )}
      </View>
      <View {...tw('flex flex-col items-center mt-8')}>
        {cooling
          ? <Text {...tw('font-body text-subtitle text-brand-dark')}>{`错误次数过多，请 ${Math.ceil(left / 1000)} 秒后再试`}</Text>
          : <Text {...tw('font-title font-bold text-display text-ink')}>{`${q.a} + ${q.b} = ?`}</Text>}
        <View {...tw('min-h-touch flex items-center justify-center mt-4 px-6 rounded-md bg-paper-light')}>
          <Text {...tw('font-title text-title text-ink')}>{input || ' '}</Text>
        </View>
        <Text {...tw('font-body text-caption text-brand-dark mt-2 min-h-[1.25rem]')}>{hint}</Text>
      </View>
      <View {...tw('flex flex-row flex-wrap justify-center mt-4')}>
        {KEYS.map(k => (
          <View
            key={k}
            {...tw('w-16 h-16 m-2 rounded-full flex items-center justify-center', k === 'ok' ? 'bg-brand' : 'bg-paper-light', cooling ? 'opacity-50' : '')}
            onClick={() => press(k)}
            {...a11yButton(k === 'del' ? '删除' : k === 'ok' ? '确定' : k)}
          >
            <Text {...tw('font-title text-title', k === 'ok' ? 'text-paper-light' : 'text-ink')}>{k === 'del' ? '⌫' : k === 'ok' ? '确定' : k}</Text>
          </View>
        ))}
      </View>
    </View>
  )
}
