/**
 * App 前后台切换（FE-RN-05）：小程序 / H5 包 Taro.onAppShow / onAppHide；RN 见 app-lifecycle.rn.ts（AppState）。
 * 回调在切换时触发；返回取消函数。测试环境 Taro 替身没有这两个 API 时静默不注册（与旧实现一致）。
 */
import Taro from '@tarojs/taro'

export type LifecycleCallback = () => void

function register (name: 'onAppShow' | 'onAppHide', cb: LifecycleCallback): () => void {
  const t = Taro as any
  if (typeof t[name] !== 'function') return () => undefined
  const handler = () => cb()
  t[name](handler)
  const off = name === 'onAppShow' ? t.offAppShow : t.offAppHide
  return () => { if (typeof off === 'function') off(handler) }
}

/** 回到前台 */
export function onAppShow (cb: LifecycleCallback): () => void {
  return register('onAppShow', cb)
}

/** 切到后台 */
export function onAppHide (cb: LifecycleCallback): () => void {
  return register('onAppHide', cb)
}
