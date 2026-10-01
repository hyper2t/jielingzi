/**
 * PostCSS 配置（仅作用于小程序 / H5 的 webpack 构建；RN 端样式不读取本文件）
 * - 小程序：rem → rpx 由 weapp-tailwindcss 的 rem2rpx 处理（见 config/index.ts）
 * - H5：Tailwind 的 rem 先按 1rem = 32px（750 设计稿）转为 px，再由 Taro pxtransform 统一转 rem，
 *   使 H5 与小程序在同一屏宽下视觉尺寸一致
 */
const isH5 = process.env.TARO_ENV === 'h5'

module.exports = {
  plugins: {
    tailwindcss: {},
    ...(isH5
      ? {
        'postcss-rem-to-responsive-pixel': {
          rootValue: 32,
          propList: ['*'],
          transformUnit: 'px'
        }
      }
      : {}),
    autoprefixer: {}
  }
}
