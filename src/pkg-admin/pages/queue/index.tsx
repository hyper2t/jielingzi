/**
 * 审核队列（FE-M2-02，PRD S3 / S4）：pkg-admin 分包；入口只对 role = mod / admin 显示（「我的」），
 * 云端 moderation.queue / decide 再校验（40301）——普通用户直接打开页面也只会看到「仅审核员可访问」。
 * 每条：内容摘要与状态、举报人数、原因分布、补充说明；处理：删除 / 恢复 / 驳回（折叠的恢复显示；机审待复核的显示为「通过」= 放行）/ 禁言 N 天 / 封禁，均二次确认。
 * 页面不显示任何作者或举报人标识；处理结果由云端写站内消息通知作者与举报人。
 */
import { useState } from 'react'
import Taro from '@tarojs/taro'
import { View, Text, Image } from '@tarojs/components'
import type { MediaQueueItem, ModDecision, ModQueueItem, ReportTarget } from '@/types/models'
import { Button, Screen, Sheet } from '@/components'
import { MUTE_DAY_OPTIONS, REPORT_REASONS } from '@/constants/moderation'
import { decide, decideMedia, getMediaQueue, getQueue } from '@/services/moderation'
import { errorCode, userFacingMessage } from '@/services/errors'
import { ERROR_CODES } from '@/services/cloud.types'
import { useRequest } from '@/hooks/useRequest'
import { useTrackPage } from '@/hooks/useTrackPage'
import { useUserStore } from '@/store/user'
import { tw } from '@/utils/tw'
import { showToast } from '@/components/Toast'

export const ADMIN_TITLE = '审核队列'
export const NO_PERMISSION = '仅审核员可访问'
export const QUEUE_EMPTY = '暂无待处理的举报'
export const QUEUE_KEY = 'admin:queue:open'
export const MEDIA_KEY = 'admin:media'
export const MEDIA_TITLE = '图片待审'

const STATUS_TEXT: Record<string, string> = { ok: '正常', pending: '待审', folded: '已折叠', removed: '已删除' }
const TYPE_TEXT: Record<string, string> = { topic: '话题', reply: '回复', user: '用户' }
const reasonLabel = (id: string) => REPORT_REASONS.find(r => r.id === id)?.label || id

const targetOf = (i: ModQueueItem): ReportTarget => ({ targetType: i.targetType, targetId: i.targetId, contentType: i.contentType })

const CONFIRM: Record<ModDecision, string> = {
  remove: '删除这条内容？作者会收到通知',
  restore: '恢复这条内容？',
  dismiss: '驳回举报？折叠的内容会恢复显示',
  mute: '禁言作者？期间不能发布内容',
  ban: '永久封禁作者？此操作影响较大，请确认'
}
/** 机审待复核（pending）的内容：「通过」= 放行，对他人展示 */
const PASS_CONFIRM = '通过这条待审内容？会对他人展示'
export const PASS_LABEL = '通过'

export default function AdminQueue () {
  useTrackPage('admin_queue')
  const role = useUserStore(s => s.account?.role)
  const allowed = role === 'mod' || role === 'admin'
  const q = useRequest(allowed ? QUEUE_KEY : null, () => getQueue('open'), { ttl: 0 })
  const mq = useRequest(allowed ? MEDIA_KEY : null, () => getMediaQueue(), { ttl: 0 })
  const media: MediaQueueItem[] = mq.data?.list || []

  const actMedia = async (item: MediaQueueItem, decision: 'pass' | 'reject') => {
    const res = await Taro.showModal({ title: '确认处理', content: decision === 'pass' ? '通过这张图片？会对他人展示' : '驳回并删除这张图片？上传者会收到通知' })
    if (!res || !res.confirm) return
    setBusy(`media:${item.mediaId}`)
    setError('')
    try {
      await decideMedia(item.mediaId, decision)
      showToast('已处理')
      await mq.refresh()
    } catch (e) {
      setError(userFacingMessage(e))
    } finally {
      setBusy('')
    }
  }
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [muteFor, setMuteFor] = useState<ModQueueItem | null>(null)
  const denied = !allowed || errorCode(q.error) === ERROR_CODES.FORBIDDEN

  const act = async (item: ModQueueItem, decision: ModDecision, days?: number) => {
    const content = decision === 'mute' && days
      ? `禁言作者 ${days} 天？期间不能发布内容`
      : decision === 'dismiss' && item.target?.status === 'pending' ? PASS_CONFIRM : CONFIRM[decision]
    const res = await Taro.showModal({ title: '确认处理', content })
    if (!res || !res.confirm) return
    setBusy(`${item.targetType}:${item.targetId}`)
    setError('')
    try {
      await decide(targetOf(item), decision, days ? { days } : {})
      showToast('已处理')
      await q.refresh()
    } catch (e) {
      setError(userFacingMessage(e))
    } finally {
      setBusy('')
    }
  }

  const list = q.data?.list || []
  const status = denied ? 'empty' : q.data === undefined && q.loading ? 'loading' : q.data === undefined && q.error ? 'error' : list.length || media.length ? 'ready' : 'empty'

  return (
    <Screen
      nav={{ title: ADMIN_TITLE, showBack: true }}
      status={status}
      emptyText={denied ? NO_PERMISSION : QUEUE_EMPTY}
      onRetry={() => { void q.refresh() }}
      overlay={(
        <Sheet
          open={!!muteFor}
          title='禁言时长'
          options={MUTE_DAY_OPTIONS.map(d => ({ value: d, label: `禁言 ${d} 天` }))}
          onSelect={(d: number) => { if (muteFor) void act(muteFor, 'mute', d) }}
          onClose={() => setMuteFor(null)}
        />
      )}
    >
      <View {...tw('flex flex-col px-page pt-3 pb-section')}>
        {!!error && <Text {...tw('font-body text-caption text-danger mb-3')}>{error}</Text>}
        {media.length > 0 && (
          <View {...tw('flex flex-col mb-3')}>
            <Text {...tw('font-body font-bold text-body text-ink mb-2')}>{`${MEDIA_TITLE}（${media.length}）`}</Text>
            {media.map(m => (
              <View key={m.mediaId} {...tw('flex flex-row items-center p-3 mb-2 rounded-md bg-paper-light')}>
                {m.url ? <Image src={m.url} mode='aspectFill' {...tw('w-16 h-16 rounded-md')} /> : <View {...tw('w-16 h-16 rounded-md bg-paper-dark')} />}
                <View {...tw('flex flex-col flex-1 ml-3')}>
                  <Text {...tw('font-body text-body text-ink')}>{`${m.purposeLabel} · ${m.status === 'review' ? '待人工复核' : '机审超时'}`}</Text>
                  <Text {...tw('font-body text-caption text-ink-faint')}>{m.provider === 'manual' ? '无法机审（App 上传或接口失败）' : '微信机审未返回结论'}</Text>
                  <View {...tw('flex flex-row')}>
                    <Button variant='text' disabled={!!busy} label={`通过图片 ${m.mediaId}`} onClick={() => { void actMedia(m, 'pass') }}>通过</Button>
                    <Button variant='text' disabled={!!busy} label={`驳回图片 ${m.mediaId}`} onClick={() => { void actMedia(m, 'reject') }}>驳回</Button>
                  </View>
                </View>
              </View>
            ))}
          </View>
        )}
        {list.map(item => {
          const key = `${item.targetType}:${item.targetId}`
          const st = item.target?.status || 'ok'
          const isUser = item.targetType === 'user'
          return (
            <View key={key} {...tw('flex flex-col p-4 mb-3 rounded-md bg-paper-light')}>
              <View {...tw('flex flex-row items-center justify-between')}>
                <Text {...tw('font-body font-bold text-body text-ink')}>{`${TYPE_TEXT[item.targetType]} · ${item.count} 人举报`}</Text>
                <Text {...tw('font-body text-caption', st === 'removed' ? 'text-danger' : 'text-ink-soft')}>{STATUS_TEXT[st] || st}</Text>
              </View>
              <Text {...tw('font-body text-body text-ink mt-2')} numberOfLines={3}>{item.target ? item.target.excerpt || '（无文字）' : '（内容已不存在）'}</Text>
              <Text {...tw('font-body text-caption text-ink-soft mt-2')}>
                {Object.entries(item.reasons).map(([r, n]) => `${reasonLabel(r)} ×${n}`).join('；')}
              </Text>
              {item.notes.map((n, i) => <Text key={i} {...tw('font-body text-caption text-ink-faint mt-1')}>{`“${n}”`}</Text>)}
              <View {...tw('flex flex-row flex-wrap mt-3')}>
                {!isUser && st !== 'removed' && <Button variant='text' disabled={!!busy} onClick={() => { void act(item, 'remove') }}>删除</Button>}
                {!isUser && st === 'removed' && <Button variant='text' disabled={!!busy} onClick={() => { void act(item, 'restore') }}>恢复</Button>}
                <Button variant='text' disabled={!!busy} onClick={() => { void act(item, 'dismiss') }}>{st === 'folded' ? '驳回并恢复' : st === 'pending' ? PASS_LABEL : '驳回'}</Button>
                <Button variant='text' disabled={!!busy} onClick={() => setMuteFor(item)}>禁言</Button>
                <Button variant='text' disabled={!!busy} onClick={() => { void act(item, 'ban') }}>封禁</Button>
              </View>
            </View>
          )
        })}
      </View>
    </Screen>
  )
}
