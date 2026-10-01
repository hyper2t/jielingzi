/**
 * 家长登录页（FE-L02，App 专用；app.config.ts 只在 RN 注册，docs/mvp/prompts/rn-login.md §7.2）。
 * 流程：家长验证（ParentGate，5 分钟内免重复）→ 协议勾选（默认不勾，未勾禁用按钮）→ 手机号 + 验证码（+86 固定、11 位、60s 倒计时、6 位自动提交）
 *      → 登录成功：user.login（上报本机同意时间）→ 补传本机进度 → 回跳（returnTo 时 redirect，否则返回上一页）。
 * 「微信登录」按钮只在 SDK 可用时显示（features/auth/wechat.rn.ts：已配置 AppID、家长已同意、本机装了微信）；探测在同意后才做（决策 L8）。
 * 「通过 Apple 登录」（NA-L04，iOS 13+，审核指南 4.8）同理只在 features/auth/apple.rn.ts 判定可用时显示，用 Apple 官方样式按钮。
 * mode=bind：给已登录（微信）账号绑定手机号（features/auth/session.ts bindPhone），流程相同，成功后返回家长中心。
 * 倒计时按截止时间戳计算（切后台再回来仍正确）。手机号只发给 CloudBase 身份认证服务；本机只留脱敏显示串。
 */
import { useEffect, useRef, useState } from 'react'
import Taro from '@tarojs/taro'
import { View, Text, Input } from '@tarojs/components'
import { Button, ConsentSheet, Icon, ParentGate, Screen, showToast } from '@/components'
import type { VerificationInfo } from '@/services/cloud.types'
import { ERROR_CODES } from '@/services/cloud.types'
import { authErrorMessage, errorCode, isAuthCancelled } from '@/services/errors'
import { authMethodText, maskPhone, useUserStore } from '@/store/user'
import { bindPhone, sendCode, signInWithApple, signInWithCode, signInWithWechat } from '@/features/auth/session'
import { isWechatLoginAvailable } from '@/features/auth/wechat'
import { isAppleLoginAvailable } from '@/features/auth/apple'
import AppleSignInButton from '@/features/auth/AppleSignInButton'
import { gateFresh, markGatePassed } from '@/features/parent/gate'
import { useTrackPage } from '@/hooks/useTrackPage'
import { back, navigate, parseParams, redirect, RouteName } from '@/utils/router'
import { a11yButton } from '@/utils/a11y'
import { tw } from '@/utils/tw'

export const LOGIN_TITLE = '登录'
export const BIND_TITLE = '绑定手机号'
export const LOGIN_INTRO = '登录后，数据和设置会同步到云端，换手机不丢，小程序与 App 互通。'
export const BIND_INTRO = '绑定后可以用手机号登录同一账号；该手机号已经有账号时，两个账号的数据会合并。'
export const AGREE_HINT = '请先勾选同意协议'
export const PHONE_HINT = '请输入 11 位手机号'
export const SEND_TEXT = '获取验证码'
export const RESEND_TEXT = '重新发送'
export const CODE_LEN = 6
export const COUNTDOWN_SEC = 60
export const PHONE_RE = /^1\d{10}$/

const LINKS = [
  { type: 'user', label: '《用户协议》' },
  { type: 'privacy', label: '《隐私政策》' }
] as const

interface Params { reason?: string, returnTo?: string, mode?: string }

function useParams (): Params {
  let raw: Record<string, string | undefined> = {}
  try {
    raw = Taro.getCurrentInstance()?.router?.params || {}
  } catch (e) {
    raw = {}
  }
  return parseParams<'login'>(raw) as Params
}

const digitsOnly = (v: unknown, max: number) => String(v ?? '').replace(/\D/g, '').slice(0, max)

export default function Login () {
  useTrackPage('login')
  const { reason, returnTo, mode } = useParams()
  const bind = mode === 'bind'
  const consent = useUserStore(s => s.consent)
  const auth = useUserStore(s => s.auth)

  const [gateOpen, setGateOpen] = useState(() => !gateFresh())
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [verification, setVerification] = useState<VerificationInfo | null>(null)
  const [deadline, setDeadline] = useState(0)
  const [left, setLeft] = useState(0)
  const [sending, setSending] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [hint, setHint] = useState('')
  const [wechatOk, setWechatOk] = useState(false)
  const [appleOk, setAppleOk] = useState(false)
  const done = useRef(false)

  // 已拒绝协议的家长直接进到登录页：先请其同意（unknown 时 ConsentSheet 自己会显示）
  useEffect(() => {
    if (consent === 'declined') useUserStore.getState().openConsentSheet('登录需同意协议后可用')
  }, [consent])

  // 微信能力探测会 registerApp：只在家长已同意后进行
  useEffect(() => {
    if (consent !== 'agreed') { setWechatOk(false); setAppleOk(false); return }
    let alive = true
    isWechatLoginAvailable().then(ok => { if (alive) setWechatOk(ok) }).catch(() => undefined)
    isAppleLoginAvailable().then(ok => { if (alive) setAppleOk(ok) }).catch(() => undefined)
    return () => { alive = false }
  }, [consent])

  // 倒计时：按截止时间戳算，切后台再回来也准确
  useEffect(() => {
    if (!deadline) { setLeft(0); return }
    const tick = () => setLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [deadline])

  const finish = () => {
    if (done.current) return
    done.current = true
    if (returnTo) void (redirect as (name: RouteName) => Promise<unknown>)(returnTo as RouteName)
    else void back()
  }

  // 登录态已存在（如别处已登录 / 登录成功）：不是绑定流程就直接回跳
  useEffect(() => {
    if (!bind && auth.signedIn) finish()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.signedIn, bind])

  const phoneOk = PHONE_RE.test(phone)
  const ready = consent === 'agreed' && agreed
  const canSend = ready && phoneOk && left === 0 && !sending && !submitting
  const canSubmit = ready && phoneOk && !!verification && code.length === CODE_LEN && !submitting

  const onSend = async () => {
    if (!agreed) { setHint(AGREE_HINT); return }
    if (!phoneOk) { setHint(PHONE_HINT); return }
    if (!canSend) return
    setSending(true)
    setHint('')
    try {
      const v = await sendCode(phone)
      setVerification(v)
      setCode('')
      setDeadline(Date.now() + COUNTDOWN_SEC * 1000)
      setHint(`验证码已发送至 ${maskPhone(phone)}`)
    } catch (e) {
      setHint(authErrorMessage(e))
      // 发送过于频繁：同样进入 60s 倒计时，避免家长连点
      if (errorCode(e) === ERROR_CODES.TOO_MANY) setDeadline(Date.now() + COUNTDOWN_SEC * 1000)
    } finally {
      setSending(false)
    }
  }

  const onSubmit = async () => {
    if (!verification || submitting) return
    if (!agreed) { setHint(AGREE_HINT); return }
    setSubmitting(true)
    setHint('')
    try {
      const input = { phone, verificationId: verification.verificationId, code, isUser: verification.isUser }
      if (bind) {
        const r = await bindPhone(input)
        showToast(r.merged ? '已绑定并合并' : '已绑定手机号')
        void back()
      } else {
        await signInWithCode(input)
        showToast('登录成功')
        finish()
      }
    } catch (e) {
      setHint(authErrorMessage(e))
      if (errorCode(e) === ERROR_CODES.AUTH_CODE_INVALID) setCode('')
    } finally {
      setSubmitting(false)
    }
  }

  // 6 位填满自动提交
  useEffect(() => {
    if (canSubmit) void onSubmit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  const onWechat = async () => {
    if (!agreed) { setHint(AGREE_HINT); return }
    if (submitting) return
    setSubmitting(true)
    setHint('')
    try {
      await signInWithWechat()
      showToast('登录成功')
      finish()
    } catch (e) {
      // 家长自己取消：静默收起，不当错误提示
      setHint(isAuthCancelled(e) ? '' : authErrorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  const sendLabel = left > 0 ? `${RESEND_TEXT}(${left}s)` : verification ? RESEND_TEXT : SEND_TEXT

  const onApple = async () => {
    if (!agreed) { setHint(AGREE_HINT); return }
    if (submitting) return
    setSubmitting(true)
    setHint('')
    try {
      await signInWithApple()
      showToast('登录成功')
      finish()
    } catch (e) {
      setHint(isAuthCancelled(e) ? '' : authErrorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  const title = bind ? BIND_TITLE : LOGIN_TITLE

  return (
    <Screen
      nav={{ title, showBack: true }}
      overlay={(
        <>
          <ConsentSheet />
          <ParentGate open={gateOpen} onPass={() => { markGatePassed(); setGateOpen(false) }} onClose={() => { void back() }} />
        </>
      )}
    >
      <View {...tw('flex flex-col px-page py-4')}>
        {!!reason && (
          <View {...tw('flex flex-row items-center px-4 py-2 rounded-md bg-highlight mb-3')}>
            <Text {...tw('font-body text-caption text-ink')}>{`${reason}需登录后可用`}</Text>
          </View>
        )}
        <Text {...tw('font-title font-bold text-title text-ink')}>{title}</Text>
        <Text {...tw('font-body text-body text-ink-soft mt-2')}>{bind ? BIND_INTRO : LOGIN_INTRO}</Text>
        {bind && <Text {...tw('font-body text-caption text-ink-faint mt-1')}>{`当前登录方式：${authMethodText(auth)}`}</Text>}

        {/* 手机号 */}
        <View {...tw('flex flex-row items-center min-h-touch-kid px-4 mt-6 rounded-md bg-paper-light')}>
          <Text {...tw('font-body text-body text-ink mr-2')}>+86</Text>
          <Input
            {...tw('flex-1 font-body text-body text-ink')}
            type='number'
            maxlength={11}
            value={phone}
            placeholder='请输入手机号'
            disabled={submitting}
            onInput={(e: any) => { setPhone(digitsOnly(e?.detail?.value, 11)); setHint('') }}
            {...({ ariaLabel: '手机号', accessibilityLabel: '手机号' } as any)}
          />
        </View>

        {/* 验证码 + 获取按钮 */}
        <View {...tw('flex flex-row items-center min-h-touch-kid pl-4 pr-1 mt-3 rounded-md bg-paper-light')}>
          <Input
            {...tw('flex-1 font-body text-body text-ink')}
            type='number'
            maxlength={CODE_LEN}
            value={code}
            placeholder={`${CODE_LEN} 位验证码`}
            disabled={submitting || !verification}
            onInput={(e: any) => { setCode(digitsOnly(e?.detail?.value, CODE_LEN)); setHint('') }}
            {...({ ariaLabel: '验证码', accessibilityLabel: '验证码' } as any)}
          />
          {/* 倒计时中禁用；未勾选 / 手机号不对时保持可点，点了给出提示（不会发短信） */}
          <Button
            variant='text'
            loading={sending}
            disabled={left > 0 || sending || submitting}
            label={left > 0 ? `${left} 秒后可重新发送` : sendLabel}
            onClick={() => { void onSend() }}
          >
            {sendLabel}
          </Button>
        </View>

        <Text {...tw('font-body text-caption mt-2 min-h-[1.25rem]', /失败|不正确|频繁|请先|请输入|暂不|已过期|不太好|开小差/.test(hint) ? 'text-brand-dark' : 'text-ink-soft')}>{hint}</Text>

        <Button block size='kid' loading={submitting} disabled={!canSubmit} onClick={() => { void onSubmit() }} {...tw('mt-4')}>
          {bind ? '绑定' : '登录'}
        </Button>

        {wechatOk && !bind && (
          <Button block variant='secondary' disabled={submitting} onClick={() => { void onWechat() }} {...tw('mt-3')}>微信登录</Button>
        )}

        {appleOk && !bind && (
          <View {...tw('mt-3')}>
            <AppleSignInButton disabled={submitting} onPress={() => { void onApple() }} />
          </View>
        )}

        {/* 协议勾选：默认不勾选 */}
        <View {...tw('flex flex-row items-start mt-6')}>
          <View
            {...tw('w-6 h-6 rounded-full border-2 border-solid items-center justify-center mr-2 mt-0.5', agreed ? 'bg-brand border-brand' : 'bg-paper-light border-ink')}
            onClick={() => { setAgreed(!agreed); setHint('') }}
            {...a11yButton(agreed ? '已同意协议，点击取消' : '同意协议')}
          >
            {agreed && <Icon name='check' tone='light' size='sm' />}
          </View>
          <View {...tw('flex-1 flex flex-row flex-wrap items-center')}>
            <Text {...tw('font-body text-caption text-ink-soft')}>我已阅读并同意</Text>
            {LINKS.map(l => (
              <View key={l.type} {...tw('min-h-touch flex justify-center')} onClick={() => navigate('agreement', { type: l.type })} {...a11yButton(`查看${l.label}`)}>
                <Text {...tw('font-body text-caption text-brand-dark')}>{l.label}</Text>
              </View>
            ))}
          </View>
        </View>
        <Text {...tw('font-body text-caption text-ink-faint mt-3')}>手机号仅用于登录验证，由腾讯云开发身份认证服务校验，我们不保存手机号。</Text>
      </View>
    </Screen>
  )
}
