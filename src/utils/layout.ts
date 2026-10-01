/**
 * 跨端布局常量（类名必须是完整静态字符串，供 Tailwind 扫描）。
 *
 * HSCROLL：scroll-view 里横排一行（分龄胶囊、家长中心的横滑卡片）。
 * - 小程序 / H5：微信 enhanced scroll-view 里的 flex 容器会折行，所以用经典写法：
 *   容器 white-space: nowrap，子项 inline-flex + vertical-align: middle，末尾放一个 inline-block 占位当右边距
 * - RN：没有 inline 概念（block / inline-flex / whitespace-nowrap 在 twrnc 下是未知类），
 *   横向 ScrollView 里直接放 flex-row 容器即可，占位符只需要宽度
 *   注意：RN ScrollView 默认样式自带 flexGrow: 1 / flexShrink: 1，而 Screen 内容区（Body.rn.tsx）的
 *   contentContainerStyle 是 flexGrow: 1。内容不满一屏时（如分类页筛选无结果），横滑行会被拉高去分剩余空间，
 *   胶囊垂直居中后与上下内容隔出大片空白。所以 outer 必须 grow-0 shrink-0，高度只由内容决定；
 *   需要横向占满剩余宽度的调用方（如分类页年龄行）再传 flex-1 覆盖即可。
 */
import { isRN } from './platform'

export const HSCROLL = isRN
  ? {
      /** ScrollView 自身 */
      outer: 'w-full grow-0 shrink-0',
      /** ScrollView 内的唯一子节点（内容容器） */
      inner: 'flex flex-row items-center',
      /** 每个子项 */
      item: 'flex',
      /** 末尾占位（调用方再加 w-2 / w-3） */
      tail: ''
    }
  : {
      outer: 'block w-full whitespace-nowrap',
      inner: 'block whitespace-nowrap',
      item: 'inline-flex align-middle',
      tail: 'inline-block align-middle'
    }
