/**
 * 平台判断。process.env.TARO_ENV 在构建时替换为常量，未命中分支会被压缩器移除。
 */
export type Platform = 'weapp' | 'h5' | 'rn' | 'other'

export const platform: Platform =
  process.env.TARO_ENV === 'weapp' ? 'weapp'
    : process.env.TARO_ENV === 'h5' ? 'h5'
      : process.env.TARO_ENV === 'rn' ? 'rn'
        : 'other'

export const isWeapp = platform === 'weapp'
export const isH5 = platform === 'h5'
export const isRN = platform === 'rn'
export const isDev = process.env.NODE_ENV !== 'production'
