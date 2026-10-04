/**
 * 我的（Tab，PRD §7.5）：导航栏右侧「设置」（App 端需先登录）→ 未同意提示条 / App 登录卡片 → 18+ 提示条 → 档案卡（FE-M1-03）
 * → 圈子 / 话题等业务区块（M3 / M4）→ 协议页脚（用户协议 · 隐私政策 · 社区公约）。
 * 未同意 / App 端未登录时不发任何云端请求；档案取数：useRequest(ready ? PROFILE_KEY : null, getProfile)。
 */
import { useEffect, useRef } from 'react'
import { useDidShow } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import type { Profile } from '@/types/models'
import { Avatar, Button, ConsentSheet, Empty, Icon, Screen, Skeleton } from '@/components'
import { authMethodText, HAS_LOGIN, useUserStore } from '@/store/user'
import { ensureSignedIn, loginGate } from '@/features/auth/require-login'
import { ensureAdult } from '@/features/auth/gates'
import { profileMeta } from '@/features/profile/rules'
import { getProfile, listInvites, INVITES_KEY, PROFILE_KEY } from '@/services/community'
import { NOTIFICATIONS_KEY, notificationsUnread } from '@/services/practice'
import { NOTIFICATIONS_TITLE, unreadLabel } from '@/features/notify/rules'
import { syncTabBadge } from '@/features/notify/badge'
import { useRequest } from '@/hooks/useRequest'
import { navigate } from '@/utils/router'
import { a11yButton } from '@/utils/a11y'
import { tw } from '@/utils/tw'

/** H5 仅自测，CloudBase 匿名登录，身份与小程序不互通 */
const IS_H5 = process.env.TARO_ENV === 'h5'
export const H5_NOTICE = 'H5 自测版：匿名身份，数据不与小程序互通'
const PLATFORM_NOTICE = IS_H5 ? H5_NOTICE : ''
export const CONSENT_HINT = '同意协议后可使用云端同步'
/** App 端登录卡片 */
export const LOGIN_CARD_TEXT = '登录后数据云端同步，小程序与 App 互通'
export const LOGIN_ACTION = '登录'
export const MINE_PLACEHOLDER = '我的话题列表即将开放'
/** 已同意但还没确认 18+ */
export const ADULT_HINT = '确认年满 18 周岁后可参与交流'
export const PROFILE_SETUP = '完善练习档案'
export const PROFILE_SETUP_HINT = '设置昵称与练习方式，让同好认识你'
/** 审核入口（仅 mod / admin） */
export const ADMIN_ENTRY = '审核队列'

/** note：右侧的灰色补充说明（如「2 条未读」）；有未读时改主色，扫一眼就能看出哪条要处理 */
function MineEntry ({ label, note, onClick, className = '' }: { label: string, note?: string, onClick: () => void, className?: string }) {
  return (
    <View
      {...tw('flex flex-row items-center justify-between min-h-touch px-4 rounded-md bg-paper-light', className)}
      hoverClass={tw('bg-paper-dark').className}
      onClick={onClick}
      {...a11yButton(note ? `${label}，${note}` : label)}
    >
      <Text {...tw('font-body text-body text-ink')}>{label}</Text>
      {!!note && <Text {...tw(`font-body text-caption ${note.includes('0 条') ? 'text-ink-faint' : 'text-brand-dark'} mr-2`)}>{note}</Text>}
      <Icon name='chevron-right' tone='soft' size='sm' />
    </View>
  )
}

const AGREEMENTS = [
  { type: 'user', text: '用户协议' },
  { type: 'privacy', text: '隐私政策' },
  { type: 'rules', text: '社区公约' }
] as const

/** 档案卡（FE-M1-03）：头像 + 昵称 + 练习方式 · 年限 + 一句话介绍；点击编辑（编辑前需确认 18+） */
export function ProfileCard ({ profile, loading, onEdit }: { profile: Profile | null | undefined, loading: boolean, onEdit: () => void }) {
  if (loading && profile === undefined) {
    return <View {...tw('mx-page mt-3 p-4 rounded-md bg-paper-light')}><Skeleton rows={2} /></View>
  }
  const named = !!profile?.nickname
  const meta = profileMeta(profile)
  return (
    <View
      {...tw('flex flex-row items-center mx-page mt-3 p-4 rounded-md bg-paper-light')}
      hoverClass={tw('bg-paper-dark').className}
      onClick={onEdit}
      {...a11yButton(named ? `${profile!.nickname}，编辑档案` : PROFILE_SETUP)}
    >
      <Avatar avatar={profile?.avatar} size='lg' />
      <View {...tw('flex flex-col flex-1 ml-3')}>
        <Text {...tw('font-title font-bold text-subtitle text-ink')} numberOfLines={1}>{named ? profile!.nickname : PROFILE_SETUP}</Text>
        {!!meta && <Text {...tw('font-body text-caption text-ink-soft mt-1')} numberOfLines={1}>{meta}</Text>}
        {!!profile?.bio && <Text {...tw('font-body text-caption text-ink-faint mt-1')} numberOfLines={2}>{`“${profile.bio}”`}</Text>}
        {!named && <Text {...tw('font-body text-caption text-ink-faint mt-1')}>{PROFILE_SETUP_HINT}</Text>}
      </View>
      <Text {...tw('font-body text-caption text-ink-soft ml-2')}>编辑</Text>
      <Icon name='chevron-right' tone='soft' size='sm' />
    </View>
  )
}

/** App 端登录卡片：未登录 → 文案 + 登录；已登录 → 方式与脱敏手机号 */
function LoginCard ({ signedIn, text }: { signedIn: boolean, text: string }) {
  if (!signedIn) {
    return (
      <View {...tw('flex flex-row items-center mx-page mt-3 pl-4 pr-1 py-1 rounded-md bg-highlight')}>
        <Text {...tw('flex-1 font-body text-caption text-ink')}>{LOGIN_CARD_TEXT}</Text>
        <Button variant='text' onClick={() => { ensureSignedIn() }} label={LOGIN_ACTION}>{LOGIN_ACTION}</Button>
      </View>
    )
  }
  return (
    <View {...tw('flex flex-row items-center mx-page mt-3 px-4 py-2 rounded-md bg-paper-light')}>
      <Icon name='check' tone='brand' size='sm' {...tw('mr-2')} />
      <Text {...tw('flex-1 font-body text-caption text-ink-soft')}>{`已登录 · ${text}`}</Text>
    </View>
  )
}

export default function Mine () {
  const consent = useUserStore(s => s.consent)
  const auth = useUserStore(s => s.auth)
  const adult = useUserStore(s => s.adult)
  const account = useUserStore(s => s.account)
  const agreed = consent === 'agreed'
  const signedIn = !HAS_LOGIN || auth.signedIn
  const adultOk = adult === 'confirmed' || account?.adult === true
  /** 缺哪一道门：'consent' | 'login' | null；null 才读云端（业务区块用） */
  const ready = !loginGate(consent, signedIn)
  const profile = useRequest(ready ? PROFILE_KEY : null, getProfile)
  const inviteSummary = useRequest(ready && adultOk ? INVITES_KEY : null, listInvites)
  /** 未读数：与消息页共用 key，标记已读后一起失效（这里只取一页一条，成本与打开消息页同级） */
  const notes = useRequest(ready && adultOk ? NOTIFICATIONS_KEY : null, notificationsUnread)
  const unread = notes.data || 0
  const shown = useRef(false)
  useEffect(() => {
    // 小程序原生角标；H5 / RN 里是空操作（页面内的未读数才是保证送达的展示）
    void syncTabBadge(unread)
  }, [unread])
  useDidShow(() => {
    if (shown.current && ready && adultOk) {
      void inviteSummary.refresh()
      void notes.refresh()
    }
    shown.current = true
  })
  const editProfile = () => { if (ensureAdult({ reason: '编辑档案', returnTo: 'profileEdit' })) void navigate('profileEdit') }

  const settingsEntry = (
    <View
      {...tw('flex flex-row items-center min-h-touch px-2 rounded-full')}
      hoverClass={tw('bg-paper-dark').className}
      onClick={() => { if (ensureSignedIn({ reason: '设置', returnTo: 'settings' })) navigate('settings') }}
      {...a11yButton('设置')}
    >
      <Text {...tw('font-body text-caption text-ink-soft')}>设置</Text>
    </View>
  )

  return (
    <Screen tabPage nav={{ title: '我的', right: settingsEntry }} overlay={<ConsentSheet />}>
      {!agreed && (
        <View {...tw('flex flex-row items-center mx-page mt-3 pl-4 pr-1 py-1 rounded-md bg-highlight')}>
          <Text {...tw('flex-1 font-body text-caption text-ink')}>{CONSENT_HINT}</Text>
          <Button variant='text' onClick={() => useUserStore.getState().openConsentSheet()} label='去同意'>去同意</Button>
        </View>
      )}
      {HAS_LOGIN && agreed && <LoginCard signedIn={auth.signedIn} text={authMethodText(auth)} />}
      {agreed && !adultOk && (
        <View {...tw('flex flex-row items-center mx-page mt-3 pl-4 pr-1 py-1 rounded-md bg-highlight')}>
          <Text {...tw('flex-1 font-body text-caption text-ink')}>{ADULT_HINT}</Text>
          <Button variant='text' onClick={() => { void navigate('adult', {}) }} label='去确认'>去确认</Button>
        </View>
      )}
      {!!PLATFORM_NOTICE && <Text {...tw('font-body text-caption text-ink-faint mx-page mt-3')}>{PLATFORM_NOTICE}</Text>}

      {ready && <ProfileCard profile={profile.data} loading={profile.loading} onEdit={editProfile} />}
      {/* 审核入口（FE-M2-02）：只对 mod / admin 显示；云端再校验 */}
      {ready && (account?.role === 'mod' || account?.role === 'admin') && (
        <View
          {...tw('flex flex-row items-center justify-between min-h-touch mx-page mt-3 px-4 rounded-md bg-paper-light')}
          hoverClass={tw('bg-paper-dark').className}
          onClick={() => { void navigate('adminQueue') }}
          {...a11yButton(ADMIN_ENTRY)}
        >
          <Text {...tw('font-body text-body text-ink')}>{ADMIN_ENTRY}</Text>
          <Icon name='chevron-right' tone='soft' size='sm' />
        </View>
      )}

      {/* 圈子 / 话题 / 邀请码 / 消息（M3、M4、M6）；ready 为 false 时只读本机数据 */}
      {ready && <View {...tw('flex flex-col mx-page mt-3')}>
        <MineEntry label='我的圈子' onClick={() => { void navigate('circles') }} className='mb-2' />
        <MineEntry
          label={NOTIFICATIONS_TITLE}
          note={notes.data === undefined ? undefined : unreadLabel(unread)}
          onClick={() => { void navigate('messages') }}
          className='mb-2'
        />
        <MineEntry
          label={inviteSummary.data ? `邀请码（剩余 ${inviteSummary.data.quota}）` : '邀请码'}
          onClick={() => { void navigate('invites') }}
        />
      </View>}
      <Empty compact text={ready ? MINE_PLACEHOLDER : CONSENT_HINT} />

      {/* 撑开剩余高度：内容不足一屏时页脚贴底（tabBar 之上） */}
      <View {...tw('flex-1')} />
      <View {...tw('flex flex-row items-center justify-center flex-wrap px-page pt-section pb-4')}>
        {AGREEMENTS.map((a, i) => (
          <View key={a.type} {...tw('flex flex-row items-center')}>
            {i > 0 && <Text {...tw('font-body text-caption text-ink-faint mx-1')}>·</Text>}
            <View
              {...tw('flex items-center justify-center min-h-touch px-1')}
              onClick={() => navigate('agreement', { type: a.type })}
              {...a11yButton(`查看${a.text}`)}
            >
              <Text {...tw('font-body text-caption text-ink-soft')}>{a.text}</Text>
            </View>
          </View>
        ))}
      </View>
    </Screen>
  )
}
