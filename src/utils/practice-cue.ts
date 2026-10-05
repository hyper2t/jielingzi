/** 小程序 / H5 练习开始与结束提示音；音频缺失时静默降级，不影响计时。RN 使用 practice-cue.rn.ts。 */
import Taro from '@tarojs/taro'

const START_CUE = require('../assets/sounds/practice-start.wav')
const END_CUE = require('../assets/sounds/practice-end.wav')

export type PracticeCue = 'start' | 'end'

function source (asset: any): string {
  if (typeof asset === 'string') return asset
  if (typeof asset?.default === 'string') return asset.default
  if (typeof asset?.uri === 'string') return asset.uri
  return ''
}

export function playPracticeCue (cue: PracticeCue): void {
  const src = source(cue === 'start' ? START_CUE : END_CUE)
  if (!src) return
  try {
    const create = (Taro as any).createInnerAudioContext
    if (typeof create === 'function') {
      const audio = create()
      audio.src = src
      audio.onEnded?.(() => audio.destroy?.())
      audio.onError?.(() => audio.destroy?.())
      audio.play()
      return
    }
  } catch (e) {
    console.warn('[practice] 提示音播放失败', e)
  }
  try {
    if (typeof Audio !== 'undefined') {
      const audio = new Audio(src)
      void audio.play().catch(() => undefined)
    }
  } catch (e) {
    console.warn('[practice] 浏览器提示音播放失败', e)
  }
}
