/**
 * RN 端：本地存储是异步预热的（utils/storage.rn.ts），而各 store 在模块加载时就读过一次本地值（那时还是空的）。
 * app.ts 等 hydrateStorage() 完成后调用这里，把同意状态 / 登录态 / 设置按真实本地值重置一次。
 * 小程序 / H5 存储同步，调用与否结果相同（读到的就是当前值）。新增需要持久化的 store 时在这里补一行。
 */
import { readLocalSettings, useSettingsStore } from './settings'
import { readAccount, readAdult, readAuth, readConsent, useUserStore } from './user'

export function rehydrateStores (): void {
  useUserStore.setState({ consent: readConsent(), auth: readAuth(), adult: readAdult(), account: readAccount() })
  useSettingsStore.setState(readLocalSettings())
}
