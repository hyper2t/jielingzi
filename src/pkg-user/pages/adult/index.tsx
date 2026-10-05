/**
 * 18+ 确认页（FE-M1-01，PRD A3 / C5 / §7.6 第 2 步）：「结灵子仅面向年满 18 周岁的用户」+ [我已年满 18 周岁] / [退出]。
 * - 确认：小程序 / H5 写云端 user.confirmAdult；App 登录前只记本机（登录时随 user.login 上报）→ 回到 returnTo 或上一页
 * - 退出：本机记为 declined，只能浏览公开内容；随时可从「我的」或发布入口回到这里重新确认（拒绝路径可回退）
 * 首次进入：同意协议后由 ConsentSheet 跳到这里；之后由 ensureAdult / requirePhone 按需进入。
 */
import { useState } from 'react'
import Taro from '@tarojs/taro'
import { View, Text, Image } from '@tarojs/components'
import { Button, ConsentSheet, Screen, showToast } from '@/components'
import { confirmAdult, declineAdult } from '@/services/me'
import { isConsentRequired, userFacingMessage } from '@/services/errors'
import { useUserStore } from '@/store/user'
import { useTrackPage } from '@/hooks/useTrackPage'
import { track } from '@/utils/track'
import { back, parseParams, redirect, RouteName } from '@/utils/router'
import { tw } from '@/utils/tw'
import { a11yHidden } from '@/utils/a11y'
import mark from '@/assets/brand/mark.png'

export const ADULT_TITLE = '年龄确认'
export const ADULT_BODY = '结灵子仅面向年满 18 周岁的用户。'
export const ADULT_CONFIRM = '我已年满 18 周岁'
export const ADULT_EXIT = '退出'
export const ADULT_EXIT_HINT = '退出后只能浏览公开内容，可随时在「我的」重新确认'
export const ADULT_DONE = '已确认'

interface Params { reason?: string, returnTo?: string }

function useParams (): Params {
  let raw: Record<string, string | undefined> = {}
  try {
    raw = Taro.getCurrentInstance()?.router?.params || {}
  } catch (e) {
    raw = {}
  }
  return parseParams<'adult'>(raw) as Params
}

export default function AdultConfirm () {
  useTrackPage('adult')
  const { reason, returnTo } = useParams()
  const adult = useUserStore(s => s.adult)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const leave = () => {
    if (returnTo) void (redirect as (name: RouteName) => Promise<unknown>)(returnTo as RouteName)
    else void back()
  }

  const onConfirm = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await confirmAdult()
      track('adult_confirm', { result: 'confirmed' })
      showToast(ADULT_DONE)
      leave()
    } catch (e) {
      // 还没同意协议（直接进入本页的情况）：先打开同意弹层，同意后再点确认
      if (isConsentRequired(e)) useUserStore.getState().openConsentSheet('确认年龄前需同意协议')
      else setError(userFacingMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const onExit = () => {
    if (busy) return
    declineAdult()
    track('adult_confirm', { result: 'declined' })
    void back()
  }

  return (
    <Screen nav={{ title: ADULT_TITLE, showBack: true }} overlay={<ConsentSheet />}>
      <View {...tw('flex flex-col items-center px-page pt-section')}>
        <Image src={mark} mode='aspectFit' {...tw('w-20 h-20')} {...a11yHidden()} />
        <Text {...tw('font-title font-bold text-title text-ink mt-6')}>{ADULT_TITLE}</Text>
        <Text {...tw('font-body text-body text-ink-soft text-center mt-3')}>{ADULT_BODY}</Text>
        {!!reason && <Text {...tw('font-body text-caption text-brand-dark text-center mt-2')}>{`${reason}前请先确认年龄`}</Text>}
        {adult === 'declined' && <Text {...tw('font-body text-caption text-ink-faint text-center mt-2')}>你之前选择了退出，确认后即可参与交流</Text>}
      </View>
      <View {...tw('flex flex-col px-page mt-section')}>
        <Button block size='kid' loading={busy} onClick={() => { void onConfirm() }}>{ADULT_CONFIRM}</Button>
        <Button variant='text' block onClick={onExit} {...tw('mt-2')}>{ADULT_EXIT}</Button>
        <Text {...tw('font-body text-caption text-ink-faint text-center mt-2')}>{ADULT_EXIT_HINT}</Text>
        {!!error && <Text {...tw('font-body text-caption text-danger text-center mt-3')}>{error}</Text>}
      </View>
    </Screen>
  )
}
