/**
 * 跨端 Tailwind 工具（RN 版本）
 * 基于 twrnc，读取与小程序 / H5 相同的 tailwind.config.js，返回 RN style 对象。
 *
 * twrnc 只认 RN 有对应样式的工具类，网页专用类会在运行时 console.warn，而且每次渲染都警告（Metro 日志刷屏）。
 * 所以类名先逐个规范化，再交给 twrnc：
 * - 改写：inline-flex→flex、fixed→absolute、truncate→overflow-hidden、[Nem]/[Nrem]→[N×16px]、[Nvw]/[Nvh]→窗口尺寸
 * - 映射：shadow-card / shadow-float → iOS shadow* + Android elevation；w-screen / h-screen 等 → 窗口宽高
 * - 丢弃：block / inline* / whitespace-* / transition / cursor / hover: 等纯网页概念（RN 下本来就无效，丢掉不改变布局）
 * - 字体：见下方 RN_FONT_FAMILY
 * - 结果按类名串缓存：同一组类只解析一次，渲染热路径零开销；真正未知的类 twrnc 也只会警告一次
 * 覆盖面由 src/utils/__tests__/tw.rn.test.ts 兜底：扫描全部已用类，任何一个触发 twrnc 警告即失败。
 */
import { Dimensions, Platform } from 'react-native'
import { create } from 'twrnc'
import type { ClassValue, TwProps } from './tw'

// eslint-disable-next-line import/no-commonjs -- tailwind.config.js 为 CJS，twrnc 需在运行时读取
const config = require('../../tailwind.config.js')

/**
 * RN 端字体。
 * 网页端 font-title / font-body 由 utils/font.ts 远程加载子集，失败回落系统衬线；RN 只能用安装包里有的字体：
 * iOS 引用没打包的 fontFamily 会直接报错 "Unrecognized font family"，Android 静默回落。
 * - 默认（Taro Playground、未打包字体的安装包）：iOS 用 System（PingFang SC）；Android 标题用系统 serif 族
 *   （Android 8+ 命中 Noto Serif CJK，即思源宋体），正文 sans-serif
 * - TARO_APP_RN_FONTS=bundled：安装包已把 assets/fonts 里的字体打进去（react-native-asset），按 PostScript 名引用；
 *   打包步骤与文件命名见 docs/ops/rn-dev-client.md「字体」
 */
const RN_FONT_FAMILY = process.env.TARO_APP_RN_FONTS === 'bundled'
  ? { title: ['SourceHanSerifSC-Heavy'], body: ['LXGWWenKai-Regular'] }
  : Platform.OS === 'ios'
    ? { title: ['System'], body: ['System'] }
    : { title: ['serif'], body: ['sans-serif'] }

// twrnc 只读 theme，去掉它无法解析的扩展，防止启动时警告
const rnConfig = {
  ...config,
  theme: {
    ...config.theme,
    extend: {
      ...config.theme.extend,
      fontFamily: RN_FONT_FAMILY,
      boxShadow: undefined,
      transitionDuration: undefined
    }
  }
}

const twrnc = create(rnConfig)

const RN_SHADOWS: Record<string, object> = {
  'shadow-card': {
    shadowColor: '#2B2A28',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2
  },
  'shadow-float': {
    shadowColor: '#2B2A28',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.14,
    shadowRadius: 20,
    elevation: 6
  }
}

interface WindowSize { width: number, height: number }

function windowSize (): WindowSize {
  // 测试环境的 react-native mock 可能没有 Dimensions
  const win = Dimensions && typeof Dimensions.get === 'function' ? Dimensions.get('window') : undefined
  return win || { width: 375, height: 812 }
}

/**
 * 视口尺寸类：twrnc 把 *-screen 解析成 100vh / 100vw，没有 useDeviceContext() 就警告并丢弃。
 * 这里直接读 Dimensions。min-h-screen 例外：RN 页面根节点由导航容器撑满（flex-1），
 * 再写 minHeight = 窗口高会把底部（MiniPlayer 等）顶到 TabBar 之下，所以丢弃。
 */
const SCREEN_SIZE: Record<string, (w: WindowSize) => object> = {
  'w-screen': w => ({ width: w.width }),
  'h-screen': w => ({ height: w.height }),
  'min-w-screen': w => ({ minWidth: w.width }),
  'max-w-screen': w => ({ maxWidth: w.width }),
  'max-h-screen': w => ({ maxHeight: w.height }),
  'min-h-screen': () => ({})
}

/** 网页专用写法 → RN 等价写法 */
const RENAME: Record<string, string> = {
  'inline-flex': 'flex',
  fixed: 'absolute', // RN 没有 fixed；页面根节点铺满时 absolute 等价
  truncate: 'overflow-hidden', // 单行省略还需 Text numberOfLines={1}
  'overflow-auto': 'overflow-scroll'
}

/**
 * 纯网页概念：RN 没有对应属性，丢弃即可（View 默认就是 flex 布局、Text 不会因容器折行等）。
 * 响应式 / 状态 / 暗色前缀在 RN 端也不生效（twrnc 需要 useDeviceContext，且 04-ui 只有浅色主题）。
 */
const DROP = new RegExp('^(' + [
  'block', 'inline', 'inline-block', 'grid', 'contents', 'flow-root', 'table.*', 'list-item', 'static', 'sticky', 'isolate',
  'whitespace-.*', 'break-.*', 'text-ellipsis', 'text-clip', 'antialiased', 'subpixel-antialiased', 'sr-only', 'not-sr-only',
  'filter', 'backdrop-.*', 'transform', 'transition.*', 'duration-.*', 'delay-.*', 'ease-.*', 'animate-.*', 'will-change-.*',
  'cursor-.*', 'select-.*', 'pointer-events-.*', 'outline.*', 'appearance-.*', 'scroll-.*', 'snap-.*', 'touch-.*',
  'overflow-[xy]-.*', 'object-.*', 'float-.*', 'clear-.*', 'columns-.*', 'box-decoration-.*',
  'bg-gradient-.*', 'from-.*', 'via-.*', 'to-.*', 'ring.*', 'divide-.*', 'space-[xy]-.*',
  'placeholder-.*', 'caret-.*', 'accent-.*', 'list-.*', 'decoration-.*', 'underline-offset-.*',
  '(hover|focus|focus-visible|focus-within|active|visited|disabled|first|last|odd|even|group-hover|peer-[a-z-]+|before|after' +
  '|placeholder|selection|marker|file|dark|motion-safe|motion-reduce|print|portrait|landscape|sm|md|lg|xl|2xl):.*'
].join('|') + ')$')

/** 任意值里的 em / rem / vw / vh 换算成 px（twrnc 只认 px 与无单位数字） */
const UNIT_RE = /\[(-?\d*\.?\d+)(r?em|v[wh])\]/

function convertUnit (token: string): string {
  const m = UNIT_RE.exec(token)
  if (!m) return token
  const n = parseFloat(m[1])
  const win = windowSize()
  const px = m[2] === 'vw' ? win.width * n / 100
    : m[2] === 'vh' ? win.height * n / 100
      : n * 16
  return token.replace(UNIT_RE, `[${Math.round(px * 100) / 100}px]`)
}

/**
 * 单行 Input 专用（只在 RN 端生效，小程序 / H5 没有这个类、不受影响）：
 * iOS TextInput 的 lineHeight 大于字号时文字与 placeholder 下沉，等于字号又会裁掉霞鹜文楷的上半部，
 * 所以直接去掉行高、去掉上下内边距，交给原生按字体度量垂直居中。用法：tw('flex-1 font-body text-body rn-input text-ink')
 */
const RN_INPUT = { lineHeight: undefined, paddingTop: 0, paddingBottom: 0, paddingVertical: 0 }

const cache = new Map<string, object>()
const CACHE_LIMIT = 4000

function has<T> (table: Record<string, T>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key)
}

function resolve (classes: string): object {
  const hit = cache.get(classes)
  if (hit) return hit
  const extras: object[] = []
  const rest: string[] = []
  classes.split(/\s+/).forEach(raw => {
    let c = raw.charAt(0) === '!' ? raw.slice(1) : raw
    if (!c) return
    if (c === 'rn-input') { extras.push(RN_INPUT); return }
    if (has(RN_SHADOWS, c)) { extras.push(RN_SHADOWS[c]); return }
    if (has(SCREEN_SIZE, c)) { extras.push(SCREEN_SIZE[c](windowSize())); return }
    if (has(RENAME, c)) c = RENAME[c]
    if (DROP.test(c)) return
    rest.push(convertUnit(c))
  })
  const style = Object.assign({}, rest.length ? twrnc.style(rest.join(' ')) : {}, ...extras)
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(classes, style)
  return style
}

export type { ClassValue, TwProps }

export function cx (...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(' ')
}

export function tw (...classes: ClassValue[]): TwProps {
  return { style: resolve(cx(...classes)) }
}

export function mergeTw (base: TwProps, extra?: TwProps): TwProps {
  if (!extra || !extra.style) return base
  return { style: { ...base.style, ...extra.style } }
}
