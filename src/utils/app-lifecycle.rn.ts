/**
 * RN 端 App 前后台切换（FE-RN-05）：taro-rn 没有 Taro.onAppShow / onAppHide，用 react-native AppState 实现。
 * active → show；background / inactive → hide（iOS 下拉通知栏、来电等 inactive 也算切后台：进度先记下总没错）。
 * 同一状态重复通知只触发一次。
 */
import { AppState, AppStateStatus } from 'react-native'

export type LifecycleCallback = () => void

const showHandlers = new Set<LifecycleCallback>()
const hideHandlers = new Set<LifecycleCallback>()
let bound = false
let foreground = AppState.currentState !== 'background' && AppState.currentState !== 'inactive'

function run (set: Set<LifecycleCallback>) {
  Array.from(set).forEach(cb => {
    try {
      cb()
    } catch (e) {
      console.error('[lifecycle] 回调失败', e)
    }
  })
}

function onChange (next: AppStateStatus) {
  const active = next === 'active'
  if (active === foreground) return
  foreground = active
  run(active ? showHandlers : hideHandlers)
}

function bind () {
  if (bound) return
  bound = true
  AppState.addEventListener('change', onChange)
}

export function onAppShow (cb: LifecycleCallback): () => void {
  bind()
  showHandlers.add(cb)
  return () => { showHandlers.delete(cb) }
}

export function onAppHide (cb: LifecycleCallback): () => void {
  bind()
  hideHandlers.add(cb)
  return () => { hideHandlers.delete(cb) }
}

/** 测试用 */
export function __emitAppStateForTest (next: AppStateStatus): void {
  onChange(next)
}
