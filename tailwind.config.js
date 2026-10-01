/**
 * Tailwind 设计令牌（小程序 / H5 / RN 三端共用）
 * - 小程序、H5：tailwindcss + weapp-tailwindcss 编译为 CSS
 * - RN：twrnc 在运行时读取本文件生成 style（见 src/utils/tw.rn.ts）
 * 令牌来源：docs/mvp/04-ui-design.md §2 / §7（设计令牌唯一来源，页面禁止写死色值）
 */
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 品牌色板见 docs/prd/README.md §2（竹青 / 宣纸 / 墨 / 淡墨 / 朱砂）
        paper: { DEFAULT: '#F7F8F2', light: '#FDFDFA', dark: '#ECEEE4' },
        ink: { DEFAULT: '#2F3A33', soft: '#5B665F', faint: '#8A948D' },
        /** 竹青：主色（Logo、主按钮、强调、选中态） */
        brand: { DEFAULT: '#578A6B', dark: '#456F55', light: '#E3ECE5' },
        /** 朱砂：警示（错误、举报、删除），少量使用 */
        danger: { DEFAULT: '#C2553F', dark: '#A4432F' },
        apricot: { DEFAULT: '#E8B04B', dark: '#8A5A12' },
        highlight: '#F1F4E4',
        mask: 'rgba(47,58,51,0.45)'
      },
      fontFamily: {
        // 远程子集由 src/utils/font.ts 加载，失败回落系统衬线
        title: ['"Source Han Serif SC"', 'serif'],
        body: ['"LXGW WenKai"', 'serif']
      },
      fontSize: {
        display: ['1.75rem', { lineHeight: '2.25rem' }], // 28/36
        title: ['1.375rem', { lineHeight: '1.875rem' }], // 22/30
        subtitle: ['1.125rem', { lineHeight: '1.625rem' }], // 18/26
        body: ['1rem', { lineHeight: '1.625rem' }], // 16/26
        caption: ['0.8125rem', { lineHeight: '1.25rem' }], // 13/20
        'kid-hanzi': ['1.5rem', { lineHeight: '2.125rem' }], // 24/34
        'kid-hanzi-lg': ['1.75rem', { lineHeight: '2.5rem' }], // 28/40
        'kid-pinyin': ['0.875rem', { lineHeight: '1.125rem' }], // 14/18
        'kid-pinyin-lg': ['1rem', { lineHeight: '1.25rem' }], // 16/20
        'kid-button': ['1.125rem', { lineHeight: '1.5rem' }] // 18/24
      },
      borderRadius: { sm: '0.5rem', md: '1rem', lg: '1.5rem', seal: '0.25rem' },
      // RN 端 twrnc 不支持字符串阴影，tw.rn.ts 中映射为 shadow* + elevation
      // 注：04-ui 中的 `paper` 阴影落地为 shadow-card，避免与颜色 paper 生成的 shadow-paper（阴影色）冲突
      boxShadow: {
        card: '0 2px 8px rgba(47,58,51,0.08)',
        float: '0 6px 20px rgba(47,58,51,0.14)'
      },
      spacing: {
        page: '1.25rem', // 20 页面左右边距
        section: '2rem', // 32 区块间距
        touch: '2.75rem', // 44 最小热区
        btn: '3.25rem', // 52 主按钮高
        'touch-kid': '3.5rem', // 56 儿童主操作热区
        nav: '2.75rem' // 44 导航栏内容高
      },
      // row：目录项 EpisodeItem 高 ≥ 64（04-ui §3）
      minHeight: { touch: '2.75rem', 'touch-kid': '3.5rem', btn: '3.25rem', row: '4rem' },
      minWidth: { touch: '2.75rem', 'touch-kid': '3.5rem' },
      // 仅小程序 / H5；RN 动效走 Animated
      transitionDuration: { fast: '150ms', base: '250ms', slow: '400ms' }
    }
  },
  plugins: [],
  corePlugins: {
    // 小程序没有浏览器默认样式，且 preflight 会覆盖 Taro 组件默认样式
    preflight: false,
    // 关闭 *-opacity 变量：颜色类输出为纯色值，减小 wxss 体积、避免 CSS 变量（与 RN 行为一致）
    backgroundOpacity: false,
    textOpacity: false,
    borderOpacity: false,
    placeholderOpacity: false,
    divideOpacity: false
  }
}
