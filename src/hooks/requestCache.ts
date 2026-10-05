/**
 * 请求内存缓存（FE-06）：TTL 默认 5 分钟；同 key 并发请求合并为一次；可选持久化到本地用于离线兜底。
 */
import { getItem, setItem, STORAGE_KEYS } from '@/utils/storage'

export const DEFAULT_TTL = 5 * 60 * 1000

interface Entry<T> {
  data?: T
  expires: number
  promise?: Promise<T>
}

const cache = new Map<string, Entry<any>>()

export interface FetchOptions {
  ttl?: number
  /** 忽略缓存强制请求（下拉刷新 / 重试） */
  force?: boolean
  /** 成功结果写本地；请求失败时读本地兜底 */
  persist?: boolean
}

export function peek<T> (key: string): T | undefined {
  const e = cache.get(key)
  return e && e.expires > Date.now() ? e.data : undefined
}

export function peekPersisted<T> (key: string): T | undefined {
  return getItem<{ data: T }>(STORAGE_KEYS.requestPrefix + key)?.data
}

export function cachedFetch<T> (key: string, fetcher: () => Promise<T>, opts: FetchOptions = {}): Promise<T> {
  const ttl = opts.ttl ?? DEFAULT_TTL
  const now = Date.now()
  const hit = cache.get(key)
  if (!opts.force && hit) {
    if (hit.promise) return hit.promise
    if (hit.expires > now && hit.data !== undefined) return Promise.resolve(hit.data)
  }
  const promise = fetcher().then(data => {
    cache.set(key, { data, expires: Date.now() + ttl })
    if (opts.persist) setItem(STORAGE_KEYS.requestPrefix + key, { data, at: Date.now() })
    return data
  }, err => {
    const prev = cache.get(key)
    if (prev?.promise === promise) {
      if (prev.data !== undefined) cache.set(key, { data: prev.data, expires: prev.expires })
      else cache.delete(key)
    }
    throw err
  })
  cache.set(key, { ...(hit || { expires: 0 }), promise })
  return promise
}

/** 让以 prefix 开头的缓存失效（如收藏变化后 invalidate('me:favorites')） */
export function invalidate (prefix = ''): void {
  Array.from(cache.keys()).forEach(k => { if (k.startsWith(prefix)) cache.delete(k) })
}
