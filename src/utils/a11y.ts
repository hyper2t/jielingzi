/**
 * 无障碍属性（小程序 aria-*，RN accessibility*）。Taro 类型未声明，统一在这里收口。
 */
export function a11yButton (label?: string): Record<string, unknown> {
  if (!label) return {}
  return { ariaLabel: label, ariaRole: 'button', accessibilityLabel: label, accessibilityRole: 'button' }
}

export function a11yHidden (): Record<string, unknown> {
  return { ariaHidden: true, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' }
}

export function a11yLabel (label?: string): Record<string, unknown> {
  if (!label) return a11yHidden()
  return { ariaLabel: label, accessibilityLabel: label }
}
