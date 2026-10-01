/**
 * 本地存储（FE-04）：统一包 Taro.getStorageSync / setStorageSync（小程序 / H5）。
 * - RN 端 taro-rn 不支持同步存储 API（getStorageSync 等为 unsupportedApi），由 storage.rn.ts 用 AsyncStorage + 内存镜像实现同一接口
 * - 所有 key 集中在 STORAGE_KEYS（storage.keys.ts），便于 FE-32「删除收听数据」一次清空
 * - createLRU：按 key 前缀存多条记录 + 一个最近使用索引，超出上限淘汰最久未用（play_progress 最多 100 个专辑）
 * - 读写异常（存储满、JSON 损坏）不抛出，只返回默认值并告警
 */
import Taro from '@tarojs/taro'
import { createLRUWith, LRUStore } from './storage.lru'

export { STORAGE_KEYS } from './storage.keys'
export type { LRUStore } from './storage.lru'

export function getItem<T> (key: string, fallback: T): T
export function getItem<T> (key: string): T | undefined
export function getItem<T> (key: string, fallback?: T): T | undefined {
  try {
    const v = Taro.getStorageSync(key)
    if (v === '' || v === undefined || v === null) return fallback
    return v as T
  } catch (e) {
    console.warn('[storage] 读取失败', key, e)
    return fallback
  }
}

export function setItem<T> (key: string, value: T): boolean {
  try {
    Taro.setStorageSync(key, value)
    return true
  } catch (e) {
    console.warn('[storage] 写入失败', key, e)
    return false
  }
}

export function removeItem (key: string): void {
  try {
    Taro.removeStorageSync(key)
  } catch (e) {
    console.warn('[storage] 删除失败', key, e)
  }
}

/** 清空本应用全部本地数据（FE-32）。keep：例外保留的 key（App 端「删除收听数据」保留登录态；小程序同步存储，删后写回即可） */
export function clearAll (opts: { keep?: string[] } = {}): void {
  const kept = (opts.keep || []).map(k => [k, getItem<unknown>(k)] as const).filter(([, v]) => v !== undefined)
  try {
    Taro.clearStorageSync()
  } catch (e) {
    console.warn('[storage] 清空失败', e)
  }
  kept.forEach(([k, v]) => setItem(k, v))
}

/** 小程序 / H5 的存储本身是同步的，无需预热；RN 端见 storage.rn.ts */
export function hydrateStorage (): Promise<void> {
  return Promise.resolve()
}

export function isStorageHydrated (): boolean {
  return true
}

export function createLRU<T> (prefix: string, max: number): LRUStore<T> {
  return createLRUWith<T>({ getItem, setItem, removeItem }, prefix, max)
}
