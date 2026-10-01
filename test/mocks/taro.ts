/** 测试替身：只实现被用到的 Taro API */
import { useEffect, useRef } from 'react'

const listeners: Array<(res: { isConnected: boolean }) => void> = []
const store = new Map<string, unknown>()
const showHandlers = new Set<() => void>()
const bottomHandlers = new Set<() => void>()

export function useDidShow (cb: () => void) {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    const h = () => ref.current()
    showHandlers.add(h)
    h()
    return () => { showHandlers.delete(h) }
  }, [])
}

export function useReachBottom (cb: () => void) {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    const h = () => ref.current()
    bottomHandlers.add(h)
    return () => { bottomHandlers.delete(h) }
  }, [])
}

const Taro: any = {
  showToast: jest.fn(() => Promise.resolve()),
  showModal: jest.fn(() => Promise.resolve({ confirm: true })),
  __routerParams: {} as Record<string, string>,
  getCurrentInstance: jest.fn(() => ({ router: { params: Taro.__routerParams } })),
  hideToast: jest.fn(() => Promise.resolve()),
  navigateTo: jest.fn(() => Promise.resolve()),
  redirectTo: jest.fn(() => Promise.resolve()),
  switchTab: jest.fn(() => Promise.resolve()),
  reLaunch: jest.fn(() => Promise.resolve()),
  navigateBack: jest.fn(() => Promise.resolve()),
  getCurrentPages: jest.fn(() => [{}]),
  getSystemInfoSync: jest.fn(() => ({ statusBarHeight: 20, windowWidth: 375 })),
  getMenuButtonBoundingClientRect: jest.fn(() => ({ top: 24, height: 32, left: 281 })),
  getNetworkType: jest.fn(() => Promise.resolve({ networkType: 'wifi' })),
  onNetworkStatusChange: jest.fn((cb: any) => { listeners.push(cb) }),
  offNetworkStatusChange: jest.fn(),
  loadFontFace: jest.fn((opt: any) => opt.success && opt.success()),
  getLaunchOptionsSync: jest.fn(() => ({ scene: 1001 })),
  reportEvent: jest.fn(),
  getStorageSync: jest.fn((k: string) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : '')),
  setStorageSync: jest.fn((k: string, v: unknown) => { store.set(k, JSON.parse(JSON.stringify(v))) }),
  removeStorageSync: jest.fn((k: string) => { store.delete(k) }),
  clearStorageSync: jest.fn(() => { store.clear() }),
  useDidShow,
  useReachBottom,
  __emitNetwork (isConnected: boolean) { listeners.forEach(cb => cb({ isConnected })) },
  __emitShow () { showHandlers.forEach(h => h()) },
  __emitReachBottom () { bottomHandlers.forEach(h => h()) },
  __storage: store,
  cloud: undefined
}

export default Taro
