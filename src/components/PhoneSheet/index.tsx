/**
 * PhoneSheet：小程序手机号验证弹层（FE-M1-02，PRD A2 / C4「发布内容前必须绑定手机号」）。
 * 微信要求手机号授权必须由用户点击 <button open-type="getPhoneNumber"> 触发，所以 requirePhone() 只负责打开这里。
 * - 授权成功拿到一次性 code → user.bindPhoneWeapp（云端换号码、只存哈希）→ 关闭弹层并提示
 * - 用户拒绝 / code 失效 / 号码已绑定其他账号 → 留在弹层，显示原因，可重试
 * 只在小程序打开（App 走「绑定手机号」页，H5 只提示）；挂在有发布入口的页面 overlay 上。
 * 隐私：小程序《用户隐私保护指引》须声明「手机号」（docs/ops/compliance-checklist.md）。
 */
import { useState } from 'react'
import { View, Text, Button as NativeButton } from '@tarojs/components'
import { useUserStore } from '@/store/user'
import { bindPhoneWeapp } from '@/services/me'
import { userFacingMessage } from '@/services/errors'
import { track } from '@/utils/track'
import { mergeTw, tw, TwProps } from '@/utils/tw'
import { a11yButton } from '@/utils/a11y'
import Button from '../Button'
import { showToast } from '../Toast'

export const PHONE_TITLE = '验证手机号'
export const PHONE_BODY = '根据相关规定，发布内容前需要完成手机号验证。号码只用于实名校验，加密保存，不会展示给任何人；发布时仍可选择匿名。'
export const PHONE_ACTION = '微信手机号快捷验证'
export const PHONE_DENIED = '需要授权手机号才能发布，可稍后再试'
export const PHONE_DONE = '验证成功'

const OVERLAY = process.env.TARO_ENV === 'rn' ? 'absolute inset-0' : 'fixed inset-0'
/** 原生 button 的默认边框 / 背景 / 行高重置（app.scss .jl-native-btn）；RN 不引用 */
const nativeBtnReset: TwProps = process.env.TARO_ENV === 'rn' ? {} : { className: 'jl-native-btn' }

export default function PhoneSheet () {
  const open = useUserStore(s => s.phoneSheetOpen)
  const reason = useUserStore(s => s.phoneSheetReason)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!open) return null

  const close = () => {
    if (busy) return
    setError('')
    useUserStore.getState().closePhoneSheet()
  }

  const onGetPhoneNumber = async (e: any) => {
    const code: string | undefined = e?.detail?.code
    if (!code) {
      // 用户点了拒绝，或基础库过低没有 code
      setError(PHONE_DENIED)
      return
    }
    setBusy(true)
    setError('')
    try {
      const r = await bindPhoneWeapp(code)
      track('bind_phone', { merged: r.merged })
      useUserStore.getState().closePhoneSheet()
      showToast(PHONE_DONE)
    } catch (err) {
      setError(userFacingMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View {...tw(OVERLAY, 'z-50 flex flex-col justify-end bg-mask')} onClick={close} catchMove>
      <View {...tw('flex flex-col bg-paper-light rounded-t-lg px-page pt-3 pb-8')} onClick={(ev: any) => ev?.stopPropagation?.()}>
        <View {...tw('self-center w-9 h-1 rounded-full bg-paper-dark mb-4')} />
        {!!reason && <Text {...tw('font-body text-caption text-brand-dark mb-2')}>{`${reason}前请先验证手机号`}</Text>}
        <Text {...tw('font-title font-bold text-title text-ink')}>{PHONE_TITLE}</Text>
        <Text {...tw('font-body text-body text-ink-soft mt-3')}>{PHONE_BODY}</Text>
        {/* 微信原生按钮（open-type 只在原生 button 上生效）；样式与主按钮一致 */}
        <NativeButton
          openType='getPhoneNumber'
          onGetPhoneNumber={onGetPhoneNumber}
          disabled={busy}
          loading={busy}
          {...mergeTw(tw('flex flex-row items-center justify-center w-full min-h-touch-kid mt-5 rounded-full bg-brand font-body font-bold text-kid-button text-paper-light'), nativeBtnReset)}
          {...a11yButton(PHONE_ACTION)}
        >
          {PHONE_ACTION}
        </NativeButton>
        {!!error && <Text {...tw('font-body text-caption text-danger text-center mt-3')}>{error}</Text>}
        <Button variant='text' block onClick={close} {...tw('mt-2')}>暂不验证</Button>
      </View>
    </View>
  )
}
