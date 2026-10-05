import { Component, PropsWithChildren } from 'react'
import Taro from '@tarojs/taro'
import { getClient } from './services/client'
import { refreshRemoteSettings } from './services/me'
import { rehydrateStores } from './store/hydrate'
import { loadFonts } from './utils/font'
import { hydrateStorage } from './utils/storage'
import { track } from './utils/track'
import './styles/tailwind.css'
import './app.scss'

const isRN = process.env.TARO_ENV === 'rn'

/**
 * 启动顺序：
 * 1. 本地存储预热（RN 为 AsyncStorage 异步读入内存，小程序 / H5 立即完成）→ 各 store 重读本地值
 * 2. 数据源初始化（默认 mock，TARO_APP_DATA_SOURCE=cloud 时为 CloudBase，见 services/client.ts）；
 *    RN 端 init 只读本地会话、不发网络请求（FE-RN-03：同意前不得有任何带身份的请求）
 * 3. 已同意的用户：把云端保存的设置拉回本地，换机、重装、清缓存后不丢；未同意不发请求
 */
const bootstrap = hydrateStorage()
  .catch(e => console.warn('[storage] 预热失败', e))
  .then(() => {
    rehydrateStores()
    getClient().init().catch(e => console.error('[cloud] init 失败', e))
    void refreshRemoteSettings()
  })
// 字体不阻塞渲染；失败降级系统字体
loadFonts()

interface AppState {
  /** RN：存储预热完成前不渲染页面，避免页面用空的同意状态 / 设置先渲染一帧再跳变 */
  ready: boolean
}

class App extends Component<PropsWithChildren, AppState> {
  state: AppState = { ready: !isRN }

  componentDidMount () {
    void bootstrap.then(() => {
      if (isRN) this.setState({ ready: true })
      let scene: number | undefined
      try {
        if (process.env.TARO_ENV === 'weapp') scene = Taro.getLaunchOptionsSync().scene
      } catch (e) {
        scene = undefined
      }
      track('app_open', scene === undefined ? {} : { scene })
    })
  }

  // this.props.children 是将要会渲染的页面
  render () {
    if (!this.state.ready) return null
    return this.props.children
  }
}
export default App
