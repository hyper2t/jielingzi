/** 「通过 Apple 登录」按钮：小程序 / H5 不渲染。RN 实现见 AppleSignInButton.rn.tsx（Apple 官方样式按钮） */
export interface AppleSignInButtonProps {
  /** 'signIn' = 通过 Apple 登录；'continue' = 通过 Apple 继续（绑定） */
  type?: 'signIn' | 'continue'
  disabled?: boolean
  onPress: () => void
}

export default function AppleSignInButton (_: AppleSignInButtonProps) {
  return null
}
