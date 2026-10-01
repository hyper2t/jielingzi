/**
 * Avatar：圆形头像（M1 练习档案）。
 * - avatar = 'preset:<id>' → 预置头像（src/assets/avatars，tools/gen-icons.js 生成）
 * - 空 / 未知值 → 默认头像；anon → 匿名头像（匿名发布不暴露个人头像，PRD §8.3）
 * 自定义上传头像随 M2 图片机审上线，届时在 avatarSrc 里加 cloud:// 分支。
 * 装饰性图片：读屏由外层（AuthorBadge / 档案卡）读名字。
 */
import { Image } from '@tarojs/components'
import { AVATARS, AVATAR_ANON, AVATAR_DEFAULT, AvatarId } from '@/assets/avatars'
import { mergeTw, tw, TwProps } from '@/utils/tw'
import { a11yHidden } from '@/utils/a11y'

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl'

// 完整静态类名，禁止拼接
const SIZE: Record<AvatarSize, string> = {
  sm: 'w-8 h-8', // 32
  md: 'w-10 h-10', // 40
  lg: 'w-14 h-14', // 56
  xl: 'w-16 h-16' // 64
}

export interface AvatarProps extends TwProps {
  avatar?: string | null
  anon?: boolean
  size?: AvatarSize
}

/** 预置头像 id；不是预置头像时 null */
export function presetId (avatar: string | null | undefined): AvatarId | null {
  const m = typeof avatar === 'string' ? /^preset:([a-z0-9-]{1,32})$/.exec(avatar) : null
  const id = m ? m[1] : ''
  return Object.prototype.hasOwnProperty.call(AVATARS, id) ? id as AvatarId : null
}

export function avatarSrc (avatar: string | null | undefined, anon = false): string {
  if (anon) return AVATAR_ANON
  const id = presetId(avatar)
  return id ? AVATARS[id] : AVATAR_DEFAULT
}

export default function Avatar ({ avatar, anon = false, size = 'md', className, style }: AvatarProps) {
  return (
    <Image
      src={avatarSrc(avatar, anon)}
      mode='aspectFill'
      {...mergeTw(tw('rounded-full', SIZE[size]), { className, style })}
      {...a11yHidden()}
    />
  )
}
