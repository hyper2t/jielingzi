/**
 * 跨端 Tailwind 工具（小程序 / H5 版本）
 * 用法：<View {...tw('flex items-center p-4', active && 'bg-red-700')} />
 * RN 端会解析到 tw.rn.ts，返回 style 而非 className。
 * 注意：类名必须是完整的静态字符串，禁止 `text-${color}` 这类拼接。
 */
export type ClassValue = string | false | null | undefined

export interface TwProps {
  className?: string
  style?: any
}

export function cx (...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(' ')
}

export function tw (...classes: ClassValue[]): TwProps {
  return { className: cx(...classes) }
}

/**
 * 合并组件内部的 tw() 结果与调用方透传的 className / style。
 * 小程序 / H5 拼接 className；RN 版本合并 style 数组。
 */
export function mergeTw (base: TwProps, extra?: TwProps): TwProps {
  if (!extra) return base
  const className = cx(base.className, extra.className)
  const style = base.style && extra.style
    ? { ...base.style, ...extra.style }
    : (extra.style || base.style)
  return style ? { className, style } : { className }
}
