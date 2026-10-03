/**
 * 话题详情（FE-M3-03，PRD T2 / T3 / §7.2）：正文 + 回复列表（时间正序）+ 底部回复栏。
 * - 简短回复（< 30 字）连续的合并成「展开 N 条简短回复」；自己发的、待审的不折叠
 * - 引用回复：点某条回复的「引用」，回复栏上方出现引用条；被引用的回复不可见时显示「引用的回复已不可见」
 * - 举报：话题 / 回复各有入口（先过 18+ 门禁，ReportSheet）；自己的内容只有「删除」（二次确认，软删除）
 * - 机审待复核的话题 / 回复只有作者看得到，标「审核中」；被多人举报折叠的内容保留位置、不显示正文
 * - 回复栏：实名（发布门禁）+ 匿名开关；额度用尽 / 机审拒绝给出明确提示；慢话题在冷静期内换成一句说明，不显示输入框（M6 D11）
 */
import { useState } from 'react'
import Taro from '@tarojs/taro'
import { View, Text, Textarea } from '@tarojs/components'
import { ANON_PREFIX, AuthorBadge, Button, ConsentSheet, Icon, PhoneSheet, ReportSheet, Screen, showToast, Toggle } from '@/components'
import { FEATURED_BADGE } from '@/components/TopicCard'
import { TEXT_RULES } from '@/constants/community'
import { ensureAdult, requirePhone } from '@/features/auth/gates'
import { goLogin, loginGate } from '@/features/auth/require-login'
import { clip, foldShortReplies, formatPostTime, isReplyLocked, publishError, slowReplyHint } from '@/features/topic/rules'
import { createReply, deleteMine, getTopic, listReplies, topicKey } from '@/services/community'
import type { ReplyItem } from '@/services/community'
import { ERROR_CODES } from '@/services/cloud.types'
import { errorCode, needsAdultConfirm, userFacingMessage } from '@/services/errors'
import { useRequest } from '@/hooks/useRequest'
import { usePaged } from '@/hooks/usePaged'
import { useTrackPage } from '@/hooks/useTrackPage'
import { HAS_LOGIN, useUserStore } from '@/store/user'
import type { ReportTarget } from '@/types/models'
import { track } from '@/utils/track'
import { back, navigate, parseParams } from '@/utils/router'
import { tw } from '@/utils/tw'
import { a11yButton } from '@/utils/a11y'

export const TOPIC_TITLE = '话题'
export const PENDING_NOTE = '审核中，通过后才会展示给其他人'
export const FOLDED_NOTE = '该内容因被多人举报已折叠，等待审核'
export const QUOTE_GONE = '引用的回复已不可见'
export const REPLY_PLACEHOLDER = '写下你的想法…'
export const SEND_TEXT = '发送'
export const REPLY_ANON_LABEL = '匿名回复'
export const REPLY_SENT = '已发布'
export const REPLY_PENDING = '已提交，审核通过后展示'
export const DELETED_TEXT = '已删除'
export const NOT_FOUND_TEXT = '话题不存在或已被删除'
export const REPORT_ACTION = '举报'
export const DELETE_ACTION = '删除'
export const QUOTE_ACTION = '引用'
/** 读屏标签：同一页有多个「举报」「删除」，各自说清对象 */
export const A11Y = {
  reportTopic: '举报该话题', deleteTopic: '删除我的话题', reportReply: '举报该回复', deleteReply: '删除我的回复',
  quote: (name: string) => `引用 ${name} 的回复`
}
export const foldLabel = (n: number) => `展开 ${n} 条简短回复`

const inputLabel = (label: string) => ({ ariaLabel: label, accessibilityLabel: label } as any)

/** 小号文字按钮（引用 / 举报 / 删除）：热区 ≥ 44；a11y 为读屏标签（默认同文字） */
function TextAction ({ label, a11y, onClick, danger = false }: { label: string, a11y?: string, onClick: () => void, danger?: boolean }) {
  return (
    <View onClick={onClick} {...a11yButton(a11y || label)} {...tw('flex items-center justify-center min-h-touch px-2')}>
      <Text {...tw('font-body text-caption', danger ? 'text-danger' : 'text-ink-soft')}>{label}</Text>
    </View>
  )
}

export default function Topic () {
  useTrackPage('topic')
  const id = parseParams<'topic'>(Taro.getCurrentInstance().router?.params).id || ''
  const consent = useUserStore(s => s.consent)
  const signedIn = useUserStore(s => s.auth.signedIn)
  const adult = useUserStore(s => s.adult)
  const gate = loginGate(consent, !HAS_LOGIN || signedIn)
  const needAdult = !gate && adult !== 'confirmed'
  const ready = !!id && !gate && !needAdult

  const topicReq = useRequest(ready ? topicKey(id) : null, () => getTopic(id))
  const topic = topicReq.data
  const repliesReady = ready && !!topic
  const replies = usePaged<ReplyItem>(`replies:${id}:${repliesReady ? 1 : 0}`, page =>
    repliesReady ? listReplies(id, page) : Promise.resolve({ list: [], total: 0, hasMore: false })
  )

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null)
  const [text, setText] = useState('')
  const [anon, setAnon] = useState(false)
  const [quote, setQuote] = useState<ReplyItem | null>(null)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')

  const notFound = errorCode(topicReq.error) === ERROR_CODES.NOT_FOUND
  const adultErr = needsAdultConfirm(topicReq.error)
  const status = !ready ? 'empty'
    : notFound || adultErr ? 'empty'
      : !topic && topicReq.loading ? 'loading'
        : !topic && topicReq.error ? 'error'
          : !topic ? 'empty' : 'ready'
  const needConfirm = needAdult || adultErr
  const emptyText = gate === 'login' ? '登录后可查看话题' : gate ? '同意协议后可查看话题' : needConfirm ? '确认年满 18 周岁后可查看话题' : NOT_FOUND_TEXT
  const emptyActionText = gate ? (gate === 'login' ? '去登录' : '去同意') : needConfirm ? '去确认' : '返回'
  const onEmptyAction = () => {
    if (gate === 'login') goLogin({ reason: '查看话题' })
    else if (gate) useUserStore.getState().openConsentSheet()
    else if (needConfirm) ensureAdult({ reason: '查看话题' })
    else void back()
  }

  const openReport = (target: ReportTarget) => {
    if (!ensureAdult({ reason: REPORT_ACTION })) return
    setReportTarget(target)
  }

  const confirmDelete = async (type: 'topic' | 'reply', targetId: string) => {
    const r = await Taro.showModal({ title: DELETE_ACTION, content: '删除后无法恢复，确定要删除吗？', confirmText: DELETE_ACTION, cancelText: '取消' })
    if (!r.confirm) return
    try {
      await deleteMine(type, targetId)
      showToast(DELETED_TEXT)
      if (type === 'topic') { void back(); return }
      if (quote?.id === targetId) setQuote(null)
      replies.reload()
      void topicReq.refresh()
    } catch (e) {
      if (needsAdultConfirm(e)) void navigate('adult', { reason: DELETE_ACTION })
      else showToast(userFacingMessage(e))
    }
  }

  const send = async () => {
    if (sending || !topic) return
    const body = text.trim()
    if (!body) return
    if (!requirePhone({ reason: '回复' })) return
    setSending(true)
    setSendError('')
    try {
      const r = await createReply({ topicId: topic.id, body: text, anon, ...(quote ? { quoteId: quote.id } : {}) })
      track('reply_create', { anon, quote: !!quote, status: r.status })
      setText('')
      setQuote(null)
      showToast(r.status === 'pending' ? REPLY_PENDING : REPLY_SENT)
      replies.reload()
      void topicReq.refresh()
    } catch (e) {
      if (needsAdultConfirm(e)) void navigate('adult', { reason: '回复' })
      else setSendError(publishError(e, 'reply'))
    } finally {
      setSending(false)
    }
  }

  const rows = foldShortReplies(replies.list, expanded)
  // 冷静期（M6 D11）：只锁回复，读与举报都照常；到点重新进页面即可回复（云端同样会再判一次）
  const locked = isReplyLocked(topic ?? {})
  const canReply = !!topic && !topic.pending && !topic.folded && !locked
  const topicCircle = topic?.circle

  const composer = status === 'ready' && canReply
    ? (
      <View {...tw('flex flex-col px-page py-2 bg-paper-light border-t border-solid border-paper-dark')}>
        {!!quote && (
          <View {...tw('flex flex-row items-center mb-2 pl-3 rounded-sm bg-paper')}>
            <Text {...tw('flex-1 font-body text-caption text-ink-soft')} numberOfLines={1}>
              {`引用 ${quote.author.anon ? ANON_PREFIX : ''}${quote.author.name}：${clip(quote.body || '', 30)}`}
            </Text>
            <View onClick={() => setQuote(null)} {...a11yButton('取消引用')} {...tw('flex items-center justify-center w-touch h-touch')}>
              <Icon name='x' size='sm' />
            </View>
          </View>
        )}
        {!!sendError && <Text {...tw('font-body text-caption text-danger mb-1')}>{sendError}</Text>}
        <View {...tw('flex flex-row items-end')}>
          <View {...tw('flex-1 px-3 py-2 rounded-md bg-paper')}>
            <Textarea
              {...tw('w-full font-body text-body text-ink')}
              value={text}
              maxlength={TEXT_RULES.reply.max}
              autoHeight
              placeholder={REPLY_PLACEHOLDER}
              disabled={sending}
              onInput={(e: any) => { setText(String(e?.detail?.value ?? '')); setSendError('') }}
              {...inputLabel('回复内容')}
            />
          </View>
          <Button loading={sending} disabled={!text.trim()} onClick={() => { void send() }} {...tw('ml-2')}>{SEND_TEXT}</Button>
        </View>
        <Toggle on={anon} label={REPLY_ANON_LABEL} onChange={setAnon} disabled={sending} />
      </View>
      )
    : undefined

  const lockedNotice = status === 'ready' && locked
    ? (
      <View {...tw('flex flex-row items-center px-page py-3 bg-paper-light border-t border-solid border-paper-dark')}>
        <Text {...tw('flex-1 font-body text-caption text-ink-soft')}>{slowReplyHint(topic?.slowUntil)}</Text>
      </View>
      )
    : undefined

  return (
    <Screen
      nav={{ title: TOPIC_TITLE, showBack: true }}
      status={status}
      emptyText={emptyText}
      emptyActionText={emptyActionText}
      onEmptyAction={onEmptyAction}
      onRetry={() => { void topicReq.refresh() }}
      onReachBottom={replies.loadMore}
      footer={composer || lockedNotice}
      overlay={
        <>
          <ConsentSheet />
          <PhoneSheet />
          <ReportSheet open={!!reportTarget} target={reportTarget} onClose={() => setReportTarget(null)} onDone={() => { void topicReq.refresh() }} />
        </>
      }
    >
      {topic && (
        <View {...tw('flex flex-col px-page pt-4 pb-section')}>
          {topic.pending && <Text {...tw('font-body text-caption text-ink-soft px-3 py-2 mb-3 rounded-sm bg-highlight')}>{PENDING_NOTE}</Text>}
          <Text {...tw('font-title font-bold text-title text-ink')}>{topic.title}</Text>
          <AuthorBadge author={topic.author} anon={topic.anon} meta={formatPostTime(topic.createdAt)} {...tw('mt-3')} />
          {topic.featured && <Text {...tw('self-start mt-3 px-2 rounded-sm bg-highlight font-body text-caption text-apricot-dark')}>{FEATURED_BADGE}</Text>}
          {!!topicCircle?.name && (
            <View
              onClick={() => { void navigate('circle', { id: topicCircle.id }) }}
              {...a11yButton(`圈子：${topicCircle.name}`)}
              {...tw('self-start mt-3 px-3 min-h-touch rounded-full bg-brand-light')}
            >
              <Text {...tw('font-body text-caption text-brand-dark')}>{topicCircle.name}</Text>
            </View>
          )}
          {topic.folded
            ? <Text {...tw('font-body text-body text-ink-faint mt-4')}>{FOLDED_NOTE}</Text>
            : <Text {...tw('font-body text-body text-ink mt-4')} selectable>{topic.body || ''}</Text>}
          {topic.tags.length > 0 && (
            <View {...tw('flex flex-row flex-wrap mt-1')}>
              {topic.tags.map(t => <Text key={t} {...tw('mr-2 mt-2 px-2 rounded-sm bg-brand-light font-body text-caption text-brand-dark')}>{`#${t}`}</Text>)}
            </View>
          )}
          <View {...tw('flex flex-row items-center justify-end mt-2')}>
            {topic.author.isSelf
              ? <TextAction label={DELETE_ACTION} a11y={A11Y.deleteTopic} danger onClick={() => { void confirmDelete('topic', topic.id) }} />
              : <TextAction label={REPORT_ACTION} a11y={A11Y.reportTopic} onClick={() => openReport({ targetType: 'topic', targetId: topic.id })} />}
          </View>

          <View {...tw('flex flex-row items-center mt-4 mb-2')}>
            <Text {...tw('font-title font-bold text-subtitle text-ink')}>{`回复 ${topic.replyCount}`}</Text>
          </View>

          {!!replies.error && replies.list.length === 0 && (
            <View onClick={replies.reload} {...a11yButton('回复加载失败，点击重试')} {...tw('flex items-center justify-center min-h-touch')}>
              <Text {...tw('font-body text-caption text-brand-dark')}>回复加载失败，点击重试</Text>
            </View>
          )}
          {!replies.loading && !replies.error && replies.list.length === 0 && (
            <Text {...tw('font-body text-caption text-ink-faint py-4')}>还没有回复，来说说你的想法</Text>
          )}

          {rows.map(row => {
            if (row.kind === 'fold') {
              return (
                <View
                  key={`fold-${row.id}`}
                  onClick={() => setExpanded(s => new Set(s).add(row.id))}
                  {...a11yButton(foldLabel(row.count))}
                  {...tw('flex items-center justify-center min-h-touch my-1 rounded-md bg-paper-dark')}
                >
                  <Text {...tw('font-body text-caption text-ink-soft')}>{foldLabel(row.count)}</Text>
                </View>
              )
            }
            const r = row.reply
            return (
              <View key={r.id} {...tw('flex flex-col py-3 border-b border-solid border-paper-dark')}>
                <AuthorBadge author={r.author} anon={r.anon} size='sm' meta={formatPostTime(r.createdAt)} />
                {r.pending && <Text {...tw('font-body text-caption text-ink-soft mt-2')}>{PENDING_NOTE}</Text>}
                {!!r.quote && (
                  <View {...tw('mt-2 px-3 py-2 rounded-sm bg-paper-light')}>
                    <Text {...tw('font-body text-caption text-ink-faint')} numberOfLines={2}>
                      {r.quote.unavailable ? QUOTE_GONE : `${r.quote.anon ? ANON_PREFIX : ''}${r.quote.authorName || ''}：${r.quote.excerpt || ''}`}
                    </Text>
                  </View>
                )}
                {r.folded
                  ? <Text {...tw('font-body text-caption text-ink-faint mt-2')}>{FOLDED_NOTE}</Text>
                  : <Text {...tw('font-body text-body text-ink mt-2')} selectable>{r.body || ''}</Text>}
                <View {...tw('flex flex-row items-center justify-end')}>
                  {canReply && !r.pending && !r.folded && <TextAction label={QUOTE_ACTION} a11y={A11Y.quote(r.author.name)} onClick={() => { setQuote(r); setSendError('') }} />}
                  {r.author.isSelf
                    ? <TextAction label={DELETE_ACTION} a11y={A11Y.deleteReply} danger onClick={() => { void confirmDelete('reply', r.id) }} />
                    : !r.pending && <TextAction label={REPORT_ACTION} a11y={A11Y.reportReply} onClick={() => openReport({ targetType: 'reply', targetId: r.id })} />}
                </View>
              </View>
            )
          })}
          {replies.loadingMore && <Text {...tw('font-body text-caption text-ink-faint text-center py-3')}>加载中…</Text>}
          {!!replies.moreError && (
            <View onClick={replies.loadMore} {...a11yButton('加载失败，点击重试')} {...tw('flex items-center justify-center min-h-touch')}>
              <Text {...tw('font-body text-caption text-brand-dark')}>加载失败，点击重试</Text>
            </View>
          )}
        </View>
      )}
    </Screen>
  )
}

