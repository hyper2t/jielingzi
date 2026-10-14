/** 输入邀请码加入圈子（FE-M4-01）：分享预填只填入，不会自动兑换。 */
import { useEffect, useState } from 'react'
import Taro from '@tarojs/taro'
import { View, Text, Input } from '@tarojs/components'
import { Button, ConsentSheet, PhoneSheet, Screen, showToast } from '@/components'
import { formatInviteCode, normalizeInviteCode } from '@/features/circle/rules'
import { requirePhone } from '@/features/auth/gates'
import { redeemInvite } from '@/services/community'
import { CloudError, ERROR_CODES } from '@/services/cloud.types'
import { errorCode, userFacingMessage } from '@/services/errors'
import { parseParams, navigate } from '@/utils/router'
import { useTrackPage } from '@/hooks/useTrackPage'
import { tw } from '@/utils/tw'

export const JOIN_TITLE = '加入圈子'
export const JOIN_ACTION = '确认加入'
export const INVITE_INVALID_TEXT = '邀请码无效、已被使用或已过期'
export const INVITE_ALREADY_MEMBER = '你已在这个圈子里'
export const INVITE_LIMIT_TEXT = '今天兑换尝试已达上限，请明天再试'
export const INVITE_HELP = '邀请码为 8 位，输入时会自动整理格式；每个码只能使用一次。'

export default function JoinCircle () {
  useTrackPage('join-circle')
  const codeParam = parseParams<'joinCircle'>(Taro.getCurrentInstance().router?.params).code || ''
  const [code, setCode] = useState(() => formatInviteCode(codeParam))
  const [error, setError] = useState('')
  const [joining, setJoining] = useState(false)

  useEffect(() => {
    setCode(formatInviteCode(codeParam))
    setError('')
  }, [codeParam])

  const submit = async () => {
    if (joining) return
    let normalized: string
    try {
      normalized = normalizeInviteCode(code)
    } catch (e) {
      setError(userFacingMessage(e))
      return
    }
    if (!requirePhone({ reason: '加入圈子' })) return
    setJoining(true)
    setError('')
    try {
      const result = await redeemInvite(normalized)
      showToast('已加入圈子')
      void navigate('circle', { id: result.circle.id })
    } catch (e) {
      const code = errorCode(e)
      if (code === ERROR_CODES.NOT_FOUND) setError(INVITE_INVALID_TEXT)
      else if (code === ERROR_CODES.CONFLICT) setError(e instanceof CloudError ? e.message : INVITE_ALREADY_MEMBER)
      else if (code === ERROR_CODES.TOO_MANY) setError(INVITE_LIMIT_TEXT)
      else setError(userFacingMessage(e))
    } finally {
      setJoining(false)
    }
  }

  return (
    <Screen nav={{ title: JOIN_TITLE, showBack: true }} overlay={<><ConsentSheet /><PhoneSheet /></>}>
      <View {...tw('flex flex-col px-page pt-5')}>
        <Text {...tw('font-title font-bold text-title text-ink')}>输入邀请码</Text>
        <Text {...tw('font-body text-body text-ink-soft mt-2')}>{INVITE_HELP}</Text>

        <View {...tw('flex flex-row items-center min-h-touch-kid px-4 mt-5 rounded-md bg-paper-light')}>
          <Input
            {...tw('flex-1 font-body text-subtitle rn-input text-ink')}
            value={code}
            maxlength={15}
            placeholder='例如 ABCD 2345'
            disabled={joining}
            onInput={(e: any) => { setCode(formatInviteCode(String(e?.detail?.value ?? ''))); setError('') }}
            ariaLabel='邀请码'
          />
        </View>
        {!!error && <Text {...tw('font-body text-caption text-danger mt-2')}>{error}</Text>}
        <Button variant='primary' block loading={joining} onClick={() => { void submit() }} {...tw('mt-4')}>{JOIN_ACTION}</Button>
        <Text {...tw('font-body text-caption text-ink-faint mt-4')}>加入后可查看圈子话题；邀请码不会公开你的账号信息。</Text>
      </View>
    </Screen>
  )
}
