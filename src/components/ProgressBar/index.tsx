/**
 * ProgressBar（FE-14，04-ui §3 播放控件）：上方当前时间 / 总时长，下方进度条（轨道 paper-dark、已播 brand、拖柄 24）。
 * 使用原生 Slider（四端可用、自带读屏与热区）；拖动中 onDrag 回传拖动值（毫秒），供高亮实时跳句，松手 onSeek。
 */
import { useState } from 'react'
import { View, Text, Slider } from '@tarojs/components'
import { formatClock } from '@/utils/format'
import { mergeTw, tw, TwProps } from '@/utils/tw'

export interface ProgressBarProps extends TwProps {
  position: number
  duration: number
  disabled?: boolean
  onDrag?: (ms: number | null) => void
  onSeek: (ms: number) => void
}

const BAMBOO = '#5E7D4F'
const TRACK = '#EDE2C8'

export default function ProgressBar ({ position, duration, disabled, onDrag, onSeek, className, style }: ProgressBarProps) {
  const [drag, setDrag] = useState<number | null>(null)
  const max = Math.max(1, Math.round(duration))
  const shown = drag ?? Math.min(position, max)
  return (
    <View {...mergeTw(tw('flex flex-col'), { className, style })}>
      <View {...tw('flex flex-row justify-between px-1')}>
        <Text {...tw('font-body text-caption text-ink-soft')}>{formatClock(shown)}</Text>
        <Text {...tw('font-body text-caption text-ink-soft')}>{formatClock(duration)}</Text>
      </View>
      <Slider
        min={0}
        max={max}
        step={100}
        value={Math.round(shown)}
        disabled={disabled || duration <= 0}
        activeColor={BAMBOO}
        backgroundColor={TRACK}
        blockColor={BAMBOO}
        blockSize={24}
        ariaLabel={`播放进度 ${formatClock(shown)}，共 ${formatClock(duration)}`}
        onChanging={(e: any) => { const v = Number(e.detail.value); setDrag(v); onDrag?.(v) }}
        onChange={(e: any) => { const v = Number(e.detail.value); setDrag(null); onDrag?.(null); onSeek(v) }}
      />
    </View>
  )
}
