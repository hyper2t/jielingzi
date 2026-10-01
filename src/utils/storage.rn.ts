/**
 * RN 端本地存储：与 storage.ts 同一接口（getItem / setItem 同步），底层 AsyncStorage。
 *
 * taro-rn 的 getStorageSync / setStorageSync / removeStorageSync / clearStorageSync 都是 unsupportedApi（只打印警告），
 * 直接复用 storage.ts 会让同意状态、设置、本地进度全部丢失。这里用「内存镜像 + 写透」实现同步语义：
 * - 启动时 hydrateStorage() 把本 App 的全部 key（前缀 jl:）一次读进内存；app.ts 在 RN 上等它完成后再渲染页面并重读各 store
 * - 读：直接读内存镜像（返回深拷贝，与小程序 getStorageSync 每次返回新对象的语义一致）
 * - 写 / 删：先改内存，再异步写 AsyncStorage；失败只告警（同一 key 的写入按调用顺序串行，后写覆盖先写）
 * - 预热完成前的读取返回默认值并告警一次（正常流程不会发生：页面在预热后才挂载）
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createLRUWith, LRUStore } from './storage.lru'

export { STORAGE_KEYS } from './storage.keys'
export type { LRUStore } from './storage.lru'

/** AsyncStorage 是应用级共享空间，加前缀避免与原生模块 / 第三方库的 key 冲突，也便于 clearAll 只清自己的数据 */
export const KEY_PREFIX = 'jl:'

const cache = new Map<string, unknown>()
let hydrated = false
let hydrating: Promise<void> | null = null
let warnedNotHydrated = false
/** 尚未落盘的写入，供 flushStorage() 等待（切后台前调用可减少丢数据的窗口） */
let pending: Set<Promise<unknown>> = new Set()

function clone<T> (v: T): T {
  if (v === null || typeof v !== 'object') return v
  try {
    return JSON.parse(JSON.stringify(v)) as T
  } catch (e) {
    return v
  }
}

function trackWrite (p: Promise<unknown>, label: string, key: string) {
  const wrapped = p.catch(e => console.warn(`[storage] ${label}失败`, key, e))
  pending.add(wrapped)
  void wrapped.then(() => pending.delete(wrapped))
}

export function hydrateStorage (): Promise<void> {
  if (hydrated) return Promise.resolve()
  if (!hydrating) {
    hydrating = (async () => {
      const keys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(KEY_PREFIX))
      const pairs = keys.length ? await AsyncStorage.multiGet(keys) : []
      pairs.forEach(([k, raw]) => {
        if (raw === null || raw === undefined) return
        try {
          cache.set(k.slice(KEY_PREFIX.length), JSON.parse(raw))
        } catch (e) {
          console.warn('[storage] 本地数据损坏，已忽略', k)
        }
      })
      hydrated = true
    })()
    hydrating.catch(e => {
      console.warn('[storage] 预热失败，按空存储继续', e)
      hydrated = true
    })
  }
  // 预热失败也 resolve：本地数据缺失不应阻塞 App 启动
  return hydrating.catch(() => undefined)
}

export function isStorageHydrated (): boolean {
  return hydrated
}

/** 等待所有未完成的写入落盘 */
export function flushStorage (): Promise<void> {
  return Promise.all(Array.from(pending)).then(() => undefined)
}

export function getItem<T> (key: string, fallback: T): T
export function getItem<T> (key: string): T | undefined
export function getItem<T> (key: string, fallback?: T): T | undefined {
  if (!hydrated && !warnedNotHydrated) {
    warnedNotHydrated = true
    console.warn('[storage] 预热完成前读取', key)
  }
  const v = cache.get(key)
  if (v === '' || v === undefined || v === null) return fallback
  return clone(v as T)
}

export function setItem<T> (key: string, value: T): boolean {
  let raw: string
  try {
    raw = JSON.stringify(value)
  } catch (e) {
    console.warn('[storage] 写入失败（无法序列化）', key, e)
    return false
  }
  if (raw === undefined) {
    removeItem(key)
    return true
  }
  cache.set(key, clone(value))
  trackWrite(AsyncStorage.setItem(KEY_PREFIX + key, raw), '写入', key)
  return true
}

export function removeItem (key: string): void {
  cache.delete(key)
  trackWrite(AsyncStorage.removeItem(KEY_PREFIX + key), '删除', key)
}

/**
 * 清空本应用全部本地数据（FE-32）：只清 jl: 前缀，不动其他模块（如 track-player）的存储。
 * keep：例外保留的 key（「删除收听数据」保留登录态）。这里必须在删除阶段就排除，而不是删完再写回——
 * getAllKeys → multiRemove 是异步的，删完再 setItem 会被随后的 multiRemove 抹掉。
 */
export function clearAll (opts: { keep?: string[] } = {}): void {
  const keep = new Set(opts.keep || [])
  Array.from(cache.keys()).forEach(k => { if (!keep.has(k)) cache.delete(k) })
  const keepRaw = new Set(Array.from(keep).map(k => KEY_PREFIX + k))
  trackWrite(
    AsyncStorage.getAllKeys().then(keys => {
      const mine = keys.filter(k => k.startsWith(KEY_PREFIX) && !keepRaw.has(k))
      return mine.length ? AsyncStorage.multiRemove(mine) : undefined
    }),
    '清空', '*'
  )
}

export function createLRU<T> (prefix: string, max: number): LRUStore<T> {
  return createLRUWith<T>({ getItem, setItem, removeItem }, prefix, max)
}

/** 测试用：重置内存镜像与预热状态 */
export function __resetStorageForTest (): void {
  cache.clear()
  hydrated = false
  hydrating = null
  warnedNotHydrated = false
  pending = new Set()
}
