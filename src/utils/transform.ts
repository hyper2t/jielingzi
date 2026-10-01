/**
 * 旋转等 transform 不走 Tailwind（依赖 CSS 变量，RN 不支持），用内联 style。
 * RN 版本见 transform.rn.ts。
 */
export function rotateStyle (deg: number): Record<string, string> {
  return { transform: `rotate(${deg}deg)` }
}
