/**
 * 设置页「账号」区（FE-L04，决策 L9；只在 App 端渲染，HAS_LOGIN 为 false 时父页面不挂载）。
 * 已登录：登录方式、已关联的登录方式、绑定手机号（微信账号）、退出登录、注销账号（二次确认 + 输入「注销」）。
 * 未登录（会话在页面停留期间过期）：提示 + 登录。
 * 「绑定微信」按钮只在微信 SDK 可用时显示（features/auth/wechat.rn.ts）：拉起微信授权 → user.bindWechat({ code })；对方微信已有账号时合并（merged）。
 * 「绑定 Apple ID」只在 iOS 可用时显示（features/auth/apple.rn.ts）：Apple 授权 → user.bindApple。关联了 Apple ID 的账号注销前会再走一次 Apple 授权（撤销授权用）。
 */
import { useEffect, useState } from 'react'
import Taro from '@tarojs/taro'
import { View, Text, Input } from '@tarojs/components'
import { Button, showToast } from '@/components'
import { authMethodText, useUserStore } from '@/store/user'
import { confirmWordOk, DELETE_ACCOUNT_CONFIRM, DELETE_ACCOUNT_WORD, deleteAccount, signOut } from '@/features/auth/account'
import { bindApple, bindWechat } from '@/features/auth/session'
import { errorCode, isAuthCancelled } from '@/services/errors'
import { ERROR_CODES } from '@/services/cloud.types'
import { goLogin } from '@/features/auth/require-login'
import { isWechatLoginAvailable } from '@/features/auth/wechat'
import { isAppleLoginAvailable } from '@/features/auth/apple'
import AppleSignInButton from '@/features/auth/AppleSignInButton'
import { back, navigate } from '@/utils/router'
import { tw } from '@/utils/tw'

export const SIGN_OUT_CONFIRM = '退出后数据不再云端同步；这台设备上的记录会保留。'
export const ACCOUNT_NOTE = '退出登录或注销账号后，需要重新登录才能同步'

function Row ({ label, value }: { label: string, value: string }) {
  return (
    <View {...tw('flex flex-row items-center justify-between min-h-touch')}>
      <Text {...tw('font-body text-body text-ink-soft')}>{label}</Text>
      <Text {...tw('font-body text-body text-ink')}>{value}</Text>
    </View>
  )
}

export default function AccountSection () {
  const auth = useUserStore(s => s.auth)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [word, setWord] = useState('')
  const [wechatOk, setWechatOk] = useState(false)
  const [appleOk, setAppleOk] = useState(false)

  useEffect(() => {
    let alive = true
    isWechatLoginAvailable().then(ok => { if (alive) setWechatOk(ok) }).catch(() => undefined)
    isAppleLoginAvailable().then(ok => { if (alive) setAppleOk(ok) }).catch(() => undefined)
    return () => { alive = false }
  }, [])

  if (!auth.signedIn) {
    return (
      <View {...tw('flex flex-col')}>
        <Text {...tw('font-body text-body text-ink-soft mb-2')}>未登录：数据不会同步到云端</Text>
        <Button variant='secondary' onClick={() => goLogin({ reason: '设置' })}>去登录</Button>
      </View>
    )
  }

  const ids = auth.identities || { mp: false, wechat: false, phone: auth.method === 'phone' }
  const linked = [ids.phone && '手机号', ids.wechat && '微信', ids.apple && 'Apple ID', ids.mp && '小程序'].filter(Boolean).join('、') || authMethodText(auth)
  const canBindPhone = !ids.phone && auth.method !== 'phone'
  const canBindWechat = wechatOk && !ids.wechat && auth.method !== 'wechat'
  const canBindApple = appleOk && !ids.apple && auth.method !== 'apple'

  const onSignOut = async () => {
    const r = await Taro.showModal({ title: '退出登录', content: SIGN_OUT_CONFIRM, confirmText: '退出' })
    if (!r.confirm || busy) return
    setBusy(true)
    try {
      await signOut()
      showToast('已退出登录')
      void back()
    } catch (e) {
      showToast('退出失败请重试')
    } finally {
      setBusy(false)
    }
  }

  const onBindWechat = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await bindWechat()
      showToast(r.merged ? '已绑定并合并' : '已绑定微信')
    } catch (e) {
      if (isAuthCancelled(e)) return
      showToast(errorCode(e) === ERROR_CODES.AUTH_DENIED ? '微信授权被拒绝' : '绑定失败请重试')
    } finally {
      setBusy(false)
    }
  }

  const onBindApple = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await bindApple()
      showToast(r.merged ? '已绑定并合并' : '已绑定 Apple ID')
    } catch (e) {
      if (isAuthCancelled(e)) return
      showToast('绑定失败请重试')
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async () => {
    if (!confirmWordOk(word) || busy) return
    setBusy(true)
    try {
      await deleteAccount()
      showToast('账号已注销')
    } catch (e) {
      showToast(isAuthCancelled(e) ? '已取消注销' : '注销失败请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <View {...tw('flex flex-col')}>
      <Row label='登录方式' value={authMethodText(auth)} />
      <Row label='已关联' value={linked} />
      {canBindPhone && <Button variant='secondary' disabled={busy} onClick={() => navigate('login', { mode: 'bind' })} {...tw('mt-2')}>绑定手机号</Button>}
      {canBindWechat && <Button variant='secondary' disabled={busy} onClick={() => { void onBindWechat() }} {...tw('mt-2')}>绑定微信</Button>}
      {canBindApple && <View {...tw('mt-2')}><AppleSignInButton type='continue' disabled={busy} onPress={() => { void onBindApple() }} /></View>}
      <Button variant='secondary' loading={busy && !deleting} disabled={busy} onClick={() => { void onSignOut() }} {...tw('mt-3')}>退出登录</Button>
      {!deleting && (
        <Button variant='text' disabled={busy} onClick={() => { setDeleting(true); setWord('') }} {...tw('mt-2 self-start')} label='注销账号'>注销账号</Button>
      )}
      {deleting && (
        <View {...tw('flex flex-col mt-3 px-4 py-3 rounded-md bg-paper-light')}>
          <Text {...tw('font-title font-bold text-subtitle text-brand-dark')}>注销账号</Text>
          <Text {...tw('font-body text-caption text-ink-soft mt-1')}>{DELETE_ACCOUNT_CONFIRM}</Text>
          <View {...tw('flex flex-row items-center min-h-touch px-3 mt-3 rounded-md bg-paper')}>
            <Input
              {...tw('flex-1 font-body text-body text-ink')}
              value={word}
              maxlength={4}
              placeholder={`请输入「${DELETE_ACCOUNT_WORD}」以确认`}
              onInput={(e: any) => setWord(String(e?.detail?.value ?? ''))}
              {...({ ariaLabel: '确认词', accessibilityLabel: '确认词' } as any)}
            />
          </View>
          <View {...tw('flex flex-row items-center mt-3')}>
            <Button variant='secondary' disabled={busy} onClick={() => { setDeleting(false); setWord('') }} {...tw('mr-3')}>取消</Button>
            <Button loading={busy} disabled={!confirmWordOk(word) || busy} onClick={() => { void onDelete() }}>确认注销</Button>
          </View>
        </View>
      )}
    </View>
  )
}
