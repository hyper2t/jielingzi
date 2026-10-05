/**
 * 云端写入拦截：
 * - 未同意时拦截所有云端写入，请求不会发出（CONSENT_REQUIRED）。例外：user.consent 本身（同意动作）。
 * - App 端未登录时同样拦截（LOGIN_REQUIRED），页面据此跳登录页（features/auth/require-login.ts）。小程序 / H5 恒为已登录。
 * 云端读私有数据在未满足时也跳过（不会有数据，且省配额），见 services/me.ts。
 */
import { isConsented, isSignedIn } from '@/store/user'
import { CloudError, ERROR_CODES, FnAction, FnName } from './cloud.types'

/** 会写云端的函数 action（按 docs/api） */
export const WRITE_ACTIONS: { [N in FnName]?: Array<FnAction<N>> } = {
  user: ['login', 'confirmAdult', 'updateSettings', 'bindWechat', 'bindApple', 'linkPhoneSession', 'bindPhoneWeapp', 'deleteAccount'],
  community: ['updateProfile', 'setAvatar', 'createInvite', 'redeemInvite', 'createTopic', 'createReply', 'deleteMine'],
  moderation: ['report', 'decide', 'decideMedia', 'markFeatured'],
  practice: ['checkin', 'answerPrompt', 'markNotificationsRead']
  // 业务云函数的写 action 加在这里
}

export function isWriteAction (name: FnName, action: string): boolean {
  return ((WRITE_ACTIONS[name] || []) as string[]).includes(action)
}

export function assertCanWrite (): void {
  if (!isConsented()) throw new CloudError(ERROR_CODES.CONSENT_REQUIRED, '需同意协议后可用')
  if (!isSignedIn()) throw new CloudError(ERROR_CODES.LOGIN_REQUIRED, '请先登录')
}
