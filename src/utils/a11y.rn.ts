/**
 * 无障碍属性（RN 实现）：只输出 RN 的 accessibility* 属性；aria-* 是小程序专用，RN 上不挂（同名 API 见 a11y.ts）。
 */
export function a11yButton (label?: string): Record<string, unknown> {
  if (!label) return {}
  return { accessible: true, accessibilityLabel: label, accessibilityRole: 'button' }
}

export function a11yHidden (): Record<string, unknown> {
  return { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' }
}

export function a11yLabel (label?: string): Record<string, unknown> {
  if (!label) return a11yHidden()
  return { accessible: true, accessibilityLabel: label }
}
