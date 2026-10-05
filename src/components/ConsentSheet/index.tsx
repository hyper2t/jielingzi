/**
 * ConsentSheet：协议同意弹层。
 * - consent 为 unknown 时自动显示（首次启动）；已拒绝的用户可从需要同步的入口、「我的」主动打开（userStore.openConsentSheet）
 * - 标题「请阅读并同意」，协议链接；「同意并开始」（主按钮）/「暂不同意」（文字按钮）
 * - 同意：写 guardianConsentAt 成功才关闭，失败提示可重试；成功后进入 18+ 确认（首次进入第 2 步，FE-M1-01）；拒绝：不写云端
 * 挂在入口页（首页、我的）；协议页不挂。
 */
import { useState } from 'react'
import { View, Text } from '@tarojs/components'
import { useUserStore } from '@/store/user'
import { agree, decline, continueFirstEntry } from '@/features/consent'
import { navigate } from '@/utils/router'
import { tw } from '@/utils/tw'
import { a11yButton } from '@/utils/a11y'
import Button from '../Button'
import { showToast } from '../Toast'

export const CONSENT_TITLE = '请阅读并同意'
/** TODO(business)：按实际收集的数据改写 */
export const CONSENT_BODY = '使用云端同步前，请阅读并同意以下协议。我们只保存提供服务所必需的数据。'

// 完整静态类名：RN 没有 fixed，用 absolute
const OVERLAY = process.env.TARO_ENV === 'rn' ? 'absolute inset-0' : 'fixed inset-0'

const LINKS = [
  { type: 'user', label: '《用户协议》' },
  { type: 'privacy', label: '《隐私政策》' },
  { type: 'rules', label: '《社区公约》' }
] as const

export default function ConsentSheet () {
  const consent = useUserStore(s => s.consent)
  const sheetOpen = useUserStore(s => s.sheetOpen)
  const reason = useUserStore(s => s.sheetReason)
  const [busy, setBusy] = useState(false)
  if (consent === 'agreed' || (consent === 'declined' && !sheetOpen)) return null

  const onAgree = async () => {
    if (busy) return
    setBusy(true)
    try {
      await agree()
      // 首次进入第 2 步：18+ 确认（PRD §7.6；已确认过的不再进入）
      continueFirstEntry()
    } catch (e) {
      showToast('提交失败请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <View {...tw(OVERLAY, 'z-50 flex flex-col justify-end bg-mask')} catchMove>
      <View {...tw('flex flex-col bg-paper-light rounded-t-lg px-page pt-3 pb-8')}>
        <View {...tw('self-center w-9 h-1 rounded-full bg-paper-dark mb-4')} />
        {!!reason && <Text {...tw('font-body text-caption text-brand-dark mb-2')}>{reason}</Text>}
        <Text {...tw('font-title font-bold text-title text-ink')}>{CONSENT_TITLE}</Text>
        <Text {...tw('font-body text-body text-ink-soft mt-3')}>
          {CONSENT_BODY}
        </Text>
        <View {...tw('flex flex-row flex-wrap mt-3')}>
          {LINKS.map(l => (
            <View
              key={l.type}
              {...tw('min-h-touch flex justify-center mr-2')}
              onClick={() => navigate('agreement', { type: l.type })}
              {...a11yButton(`查看${l.label}`)}
            >
              <Text {...tw('font-body text-body text-brand-dark')}>{l.label}</Text>
            </View>
          ))}
        </View>
        <Button block size='kid' loading={busy} onClick={onAgree} {...tw('mt-4')}>同意并开始</Button>
        <Button variant='text' block onClick={() => { if (!busy) decline() }} {...tw('mt-2')}>暂不同意</Button>
        <Text {...tw('font-body text-caption text-ink-faint text-center mt-2')}>暂不同意也可以浏览，数据只保存在本机</Text>
      </View>
    </View>
  )
}
