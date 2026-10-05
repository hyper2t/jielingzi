/**
 * ReportSheet：举报弹层（FE-M2-01，PRD S2）。话题 / 回复 / 用户卡片通用——M3 起各卡片「⋯ → 举报」打开它。
 * - 原因单选（constants/moderation.ts REPORT_REASONS，与云函数一致）+ 补充说明（选填，≤ 200 字）
 * - 打开前由调用方用 ensureAdult 拦截（需同意协议、确认 18+）；云端仍会校验
 * - 同一人重复举报：云端只计一次，这里提示「已经举报过」；举报人身份不会告诉被举报人
 * - 举报用户时 target 传他发布的内容（targetType: 'user' + contentType + targetId），前端拿不到也不需要任何 uid
 */
import { useState } from 'react'
import { View, Text, Input } from '@tarojs/components'
import type { ReportTarget } from '@/types/models'
import { REPORT_NOTE_MAX, REPORT_REASONS, ReportReasonId } from '@/constants/moderation'
import { report } from '@/services/moderation'
import { userFacingMessage } from '@/services/errors'
import { textLength } from '@/features/profile/rules'
import { tw } from '@/utils/tw'
import { a11yButton } from '@/utils/a11y'
import Button from '../Button'
import Icon from '../Icon'
import { showToast } from '../Toast'

export const REPORT_TITLE = '举报'
export const REPORT_SUBMIT = '提交举报'
export const REPORT_PICK = '请选择举报原因'
export const REPORT_DONE = '已收到举报'
export const REPORT_DUP = '已经举报过'

const OVERLAY = process.env.TARO_ENV === 'rn' ? 'absolute inset-0' : 'fixed inset-0'
const TITLE_OF: Record<ReportTarget['targetType'], string> = { topic: '举报话题', reply: '举报回复', user: '举报用户' }

export interface ReportSheetProps {
  open: boolean
  target: ReportTarget | null
  onClose: () => void
  /** 提交成功（含重复举报）后回调 */
  onDone?: (r: { duplicate: boolean, folded: boolean }) => void
}

export default function ReportSheet ({ open, target, onClose, onDone }: ReportSheetProps) {
  const [reason, setReason] = useState<ReportReasonId | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!open || !target) return null

  const close = () => {
    if (busy) return
    setReason(null)
    setNote('')
    setError('')
    onClose()
  }

  const submit = async () => {
    if (busy) return
    if (!reason) {
      setError(REPORT_PICK)
      return
    }
    setBusy(true)
    setError('')
    try {
      const r = await report(target, reason, note)
      showToast(r.duplicate ? REPORT_DUP : REPORT_DONE)
      onDone?.({ duplicate: r.duplicate, folded: r.folded })
      setBusy(false)
      close()
    } catch (e) {
      setError(userFacingMessage(e))
      setBusy(false)
    }
  }

  return (
    <View {...tw(OVERLAY, 'z-50 flex flex-col justify-end bg-mask')} onClick={close} catchMove>
      <View {...tw('flex flex-col bg-paper-light rounded-t-lg px-page pt-3 pb-8')} onClick={(e: any) => e?.stopPropagation?.()}>
        <View {...tw('self-center w-9 h-1 rounded-full bg-paper-dark mb-3')} />
        <Text {...tw('font-title font-bold text-subtitle text-ink')}>{TITLE_OF[target.targetType] || REPORT_TITLE}</Text>
        <Text {...tw('font-body text-caption text-ink-faint mt-1 mb-2')}>审核员会在 24 小时内处理，结果会通过站内消息告诉你</Text>
        {REPORT_REASONS.map(r => {
          const on = r.id === reason
          return (
            <View
              key={r.id}
              {...tw('flex flex-row items-center justify-between min-h-touch')}
              onClick={() => { setReason(r.id); setError('') }}
              {...a11yButton(`${r.label}${on ? '，已选中' : ''}`)}
            >
              <Text {...tw('font-body text-body', on ? 'text-brand-dark font-bold' : 'text-ink')}>{r.label}</Text>
              {on && <Icon name='check' tone='brand' size='md' />}
            </View>
          )
        })}
        <View {...tw('flex flex-row items-center min-h-touch-kid px-4 mt-2 rounded-md bg-paper')}>
          <Input
            {...tw('flex-1 font-body text-body text-ink')}
            value={note}
            maxlength={REPORT_NOTE_MAX}
            placeholder='补充说明（选填）'
            disabled={busy}
            onInput={(e: any) => setNote(String(e?.detail?.value ?? ''))}
            {...({ ariaLabel: '补充说明', accessibilityLabel: '补充说明' } as any)}
          />
          <Text {...tw('font-body text-caption text-ink-faint ml-2')}>{`${textLength(note)}/${REPORT_NOTE_MAX}`}</Text>
        </View>
        {!!error && <Text {...tw('font-body text-caption text-danger text-center mt-3')}>{error}</Text>}
        <Button block size='kid' loading={busy} onClick={() => { void submit() }} {...tw('mt-4')}>{REPORT_SUBMIT}</Button>
        <Button variant='text' block onClick={close} {...tw('mt-2')}>取消</Button>
      </View>
    </View>
  )
}
