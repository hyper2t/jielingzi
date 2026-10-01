/**
 * 「通过 Apple 登录」按钮（RN / iOS）：用库自带的 ASAuthorizationAppleIDButton，满足 Apple 人机界面指南的样式要求
 * （自绘按钮容易被审核以 4.8 / HIG 驳回）。原生模块缺失时退回普通按钮文案，保证页面不崩。
 */
import { View } from '@tarojs/components'
import { Button } from '@/components'
import type { AppleSignInButtonProps } from './AppleSignInButton'

let NativeButton: any
function loadButton () {
  if (NativeButton !== undefined) return NativeButton
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@invertase/react-native-apple-authentication')
    NativeButton = mod && mod.AppleButton ? mod.AppleButton : null
  } catch (e) {
    NativeButton = null
  }
  return NativeButton
}

export default function AppleSignInButton ({ type = 'signIn', disabled, onPress }: AppleSignInButtonProps) {
  const AB = loadButton()
  if (!AB) {
    return <Button block variant='secondary' disabled={disabled} onClick={onPress}>{type === 'continue' ? '绑定 Apple ID' : '通过 Apple 登录'}</Button>
  }
  return (
    <View style={{ opacity: disabled ? 0.5 : 1, width: '100%' }}>
      <AB
        buttonStyle={AB.Style.BLACK}
        buttonType={type === 'continue' ? AB.Type.CONTINUE : AB.Type.SIGN_IN}
        cornerRadius={12}
        style={{ width: '100%', height: 48 }}
        onPress={() => { if (!disabled) onPress() }}
        accessibilityLabel={type === 'continue' ? '通过 Apple 绑定' : '通过 Apple 登录'}
      />
    </View>
  )
}
