/** RN 使用 Taro-RN 随包提供的 expo-av 播放短提示音，不启动后台音频服务。 */
import { Audio } from 'expo-av'
import type { PracticeCue } from './practice-cue'

const CUES = {
  start: require('../assets/sounds/practice-start.wav'),
  end: require('../assets/sounds/practice-end.wav')
}

export function playPracticeCue (cue: PracticeCue): void {
  void Audio.Sound.createAsync(CUES[cue], { shouldPlay: true, volume: 0.55 })
    .then(({ sound }) => {
      sound.setOnPlaybackStatusUpdate(status => {
        if (status.isLoaded && status.didJustFinish) void sound.unloadAsync()
      })
    })
    .catch(e => console.warn('[practice] RN 提示音播放失败', e))
}
