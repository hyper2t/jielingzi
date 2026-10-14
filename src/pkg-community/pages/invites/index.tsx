/** 我的邀请码（FE-M4-01）：为已加入的开放圈子签发一次性邀请码，并按端分享或复制。 */
import { useRef, useState } from 'react'
import Taro, { useDidShow, useShareAppMessage } from '@tarojs/taro'
import { Button as NativeButton, View, Text } from '@tarojs/components'
import { Button, ConsentSheet, Empty, PhoneSheet, Screen, showToast } from '@/components'
import { useCircleAccess } from '@/features/circle/access'
import { formatInviteCode } from '@/features/circle/rules'
import { useRequest } from '@/hooks/useRequest'
import { CIRCLES_KEY, INVITES_KEY, createInvite, listCircles, listInvites } from '@/services/community'
import type { Invite } from '@/types/models'
import { requirePhone } from '@/features/auth/gates'
import { errorMessage, needsAdultConfirm } from '@/services/errors'
import { buildUrl, parseParams } from '@/utils/router'
import { useTrackPage } from '@/hooks/useTrackPage'
import { tw } from '@/utils/tw'

// Taro RN 没有实现 useShareAppMessage（导入为 undefined，调用即 TypeError: undefined is not a function）；
// App 端分享走「复制邀请文案」，这里退化为空 hook。模块级常量，调用顺序不变，符合 hooks 规则。
const useShareHook: typeof useShareAppMessage = typeof useShareAppMessage === 'function' ? useShareAppMessage : () => {}

export const INVITES_TITLE = '我的邀请码'
export const INVITE_TTL_HINT = '每个邀请码 7 天内有效，成功加入后立即失效。'
export const NO_INVITES_HINT = '生成的邀请码会显示在这里'
export const NO_MEMBER_CIRCLES = '加入圈子后，才能为圈友签发邀请码'
export const INVITE_QUOTA_EMPTY = '邀请名额已用完，过期未使用的邀请码会返还名额'
export const INVITE_STATUS_TEXT = { active: '可使用', used: '已使用', expired: '已过期' } as const
const IS_WEAPP = process.env.TARO_ENV === 'weapp'

export function inviteCopyText (invite: Invite): string {
  return `「${invite.circle.name}」邀请码 ${formatInviteCode(invite.code)}，7 天内有效。在结灵子「我的 → 邀请码」里输入。`
}

export function inviteSharePayload (invite: Invite) {
  return {
    title: `邀请你加入「${invite.circle.name}」`,
    path: buildUrl('joinCircle', { code: invite.code })
  }
}

export async function copyInviteToClipboard (invite: Invite): Promise<void> {
  try {
    await Taro.setClipboardData({ data: inviteCopyText(invite) })
    showToast('已复制')
  } catch {
    showToast('复制失败')
  }
}

export default function Invites () {
  useTrackPage('invites')
  const circleId = parseParams<'invites'>(Taro.getCurrentInstance().router?.params).circleId || ''
  const access = useCircleAccess('查看邀请码')
  const circlesReq = useRequest(access.ready ? CIRCLES_KEY : null, listCircles)
  const invitesReq = useRequest(access.ready ? INVITES_KEY : null, listInvites)
  const [creatingId, setCreatingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const shown = useRef(false)

  useDidShow(() => {
    if (shown.current && access.ready) {
      void circlesReq.refresh()
      void invitesReq.refresh()
    }
    shown.current = true
  })

  useShareHook((res: any) => {
    const all = invitesReq.data?.list || []
    const requestedCode = String(res?.target?.dataset?.code || '')
    const invite = all.find(item => item.code === requestedCode && item.status === 'active') || all.find(item => item.status === 'active')
    return invite
      ? inviteSharePayload(invite)
      : { title: '邀请你加入结灵子', path: buildUrl('joinCircle') }
  })

  const adultError = access.ready && (needsAdultConfirm(circlesReq.error) || needsAdultConfirm(invitesReq.error))
  const blocked = !!access.gate || !access.adultOk || adultError
  const requestLoading = circlesReq.loading || invitesReq.loading
  const requestError = (!circlesReq.data && circlesReq.error) || (!invitesReq.data && invitesReq.error)
  const status = blocked ? 'empty' : requestLoading ? 'loading' : requestError ? 'error' : 'ready'
  const emptyText = access.gate === 'login' ? '登录后可查看邀请码' : access.gate === 'consent' ? '同意协议后可查看邀请码' : '确认年满 18 周岁后可查看邀请码'
  const circles = circlesReq.data || []
  const mine = circles.filter(circle => circle.joined)
  const targets = circleId ? mine.filter(circle => circle.id === circleId) : mine
  const inviteList = invitesReq.data?.list || []
  const quota = invitesReq.data?.quota

  const createFor = async (targetId: string) => {
    if (creatingId) return
    if (quota !== undefined && quota < 1) { setActionError(INVITE_QUOTA_EMPTY); return }
    if (!requirePhone({ reason: '创建邀请码' })) return
    setCreatingId(targetId)
    setActionError('')
    try {
      await createInvite(targetId)
      await Promise.all([invitesReq.refresh(), circlesReq.refresh()])
      showToast('已生成')
    } catch (e) {
      setActionError(errorMessage(e))
    } finally {
      setCreatingId(null)
    }
  }

  return (
    <Screen
      nav={{ title: INVITES_TITLE, showBack: true }}
      status={status}
      emptyText={emptyText}
      emptyActionText={access.actionText}
      onEmptyAction={access.onAction}
      errorText={requestError ? errorMessage(requestError) : undefined}
      onRetry={() => { void Promise.all([circlesReq.refresh(), invitesReq.refresh()]) }}
      overlay={<><ConsentSheet /><PhoneSheet /></>}
    >
      <View {...tw('flex flex-col px-page pt-4')}>
        <View {...tw('flex flex-col p-4 rounded-md bg-paper-light')}>
          <Text {...tw('font-title font-bold text-subtitle text-ink')}>{quota === undefined ? '邀请名额' : `剩余 ${quota} 个邀请码`}</Text>
          <Text {...tw('font-body text-caption text-ink-soft mt-2')}>{INVITE_TTL_HINT}</Text>
          {quota === 0 && <Text {...tw('font-body text-caption text-ink-faint mt-2')}>{INVITE_QUOTA_EMPTY}</Text>}
        </View>

        <Text {...tw('font-title font-bold text-subtitle text-ink mt-5 mb-3')}>为已加入的圈子生成</Text>
        {targets.length
          ? targets.map(circle => (
            <View key={circle.id} {...tw('flex flex-row items-center justify-between p-3 mb-2 rounded-md bg-paper-light')}>
              <View {...tw('flex flex-col flex-1 mr-3')}>
                <Text {...tw('font-body font-bold text-body text-ink')}>{circle.name}</Text>
                <Text {...tw('font-body text-caption text-ink-faint mt-1')}>仅限该圈子成员兑换</Text>
              </View>
              <Button
                variant='secondary'
                disabled={quota === 0 || !!creatingId}
                loading={creatingId === circle.id}
                onClick={() => { void createFor(circle.id) }}
              >生成邀请码</Button>
            </View>
          ))
          : circleId
            ? <Text {...tw('font-body text-caption text-ink-faint')}>当前圈子尚未加入，不能为它生成邀请码</Text>
            : <View {...tw('flex flex-col items-start')}>
              <Text {...tw('font-body text-caption text-ink-faint mb-2')}>{NO_MEMBER_CIRCLES}</Text>
              <Button variant='secondary' onClick={() => { void Taro.navigateTo({ url: buildUrl('circles') }) }}>浏览圈子</Button>
            </View>}
        {!!actionError && <Text {...tw('font-body text-caption text-danger mt-2')}>{actionError}</Text>}

        <Text {...tw('font-title font-bold text-subtitle text-ink mt-5 mb-3')}>已生成的邀请码</Text>
        {inviteList.length
          ? inviteList.map(invite => (
            <View key={invite.code} {...tw('flex flex-col p-4 mb-3 rounded-md bg-paper-light')}>
              <View {...tw('flex flex-row items-center justify-between')}>
                <Text {...tw('font-title font-bold text-subtitle text-ink')} selectable>{formatInviteCode(invite.code)}</Text>
                <Text {...tw('font-body text-caption', invite.status === 'active' ? 'text-brand-dark' : 'text-ink-faint')}>{INVITE_STATUS_TEXT[invite.status]}</Text>
              </View>
              <Text {...tw('font-body text-caption text-ink-soft mt-2')}>{invite.circle.name}</Text>
              {invite.status === 'active' && (
                <View {...tw('flex flex-row mt-3')}>
                  {IS_WEAPP
                    ? <NativeButton
                      openType='share'
                      data-code={invite.code}
                      plain
                      {...tw('flex items-center justify-center min-h-touch px-4 mr-2 rounded-full bg-paper border-2 border-solid border-ink')}
                    ><Text {...tw('font-body font-bold text-caption text-ink')}>分享</Text></NativeButton>
                    : <Button variant='secondary' onClick={() => { void copyInviteToClipboard(invite) }} {...tw('mr-2')}>复制邀请文案</Button>}
                </View>
              )}
            </View>
          ))
          : <Empty compact text={NO_INVITES_HINT} />}
      </View>
    </Screen>
  )
}
