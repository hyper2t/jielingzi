/**
 * useRequest（FE-06）：轻量请求 hook + 5 分钟内存缓存。服务端数据不进全局 store（02-frontend §5）。
 * - key 为 null 时不请求（依赖未就绪）
 * - 命中缓存时同步返回数据，不显示 loading、不重复请求
 * - persist：失败时用本地持久化的上次结果兜底，并标记 stale（配合 NetTip 显示弱网）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { cachedFetch, DEFAULT_TTL, peek, peekPersisted } from './requestCache'

export interface RequestState<T> {
  data: T | undefined
  error: unknown
  loading: boolean
  /** 当前数据来自本地兜底（请求失败） */
  stale: boolean
  refresh: () => Promise<void>
}

export interface UseRequestOptions {
  ttl?: number
  persist?: boolean
}

export function useRequest<T> (key: string | null, fetcher: () => Promise<T>, opts: UseRequestOptions = {}): RequestState<T> {
  const { ttl = DEFAULT_TTL, persist = false } = opts
  const initial = key ? peek<T>(key) : undefined
  const [state, setState] = useState<{ data?: T, error: unknown, loading: boolean, stale: boolean, key: string | null }>(
    { data: initial, error: null, loading: !!key && initial === undefined, stale: false, key }
  )
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const run = useCallback(async (force: boolean) => {
    if (!key) return
    const cached = force ? undefined : peek<T>(key)
    if (cached !== undefined) {
      setState({ data: cached, error: null, loading: false, stale: false, key })
      return
    }
    setState(s => ({ data: s.key === key ? s.data : undefined, error: null, loading: true, stale: false, key }))
    try {
      const data = await cachedFetch(key, () => fetcherRef.current(), { ttl, force, persist })
      if (alive.current) setState({ data, error: null, loading: false, stale: false, key })
    } catch (caught) {
      // Hermes：catch 参数被闭包（下面的 setState 更新函数）捕获后会变成未定义的全局变量
      // （ReferenceError: Property 'error' doesn't exist），先拷到局部常量
      const error = caught
      if (!alive.current) return
      const fallback = persist ? peekPersisted<T>(key) : undefined
      setState(s => ({
        data: fallback !== undefined ? fallback : (s.key === key ? s.data : undefined),
        error,
        loading: false,
        stale: fallback !== undefined,
        key
      }))
    }
  }, [key, ttl, persist])

  useEffect(() => { run(false) }, [run])

  const refresh = useCallback(() => run(true), [run])
  const sameKey = state.key === key
  return {
    data: sameKey ? state.data : (key ? peek<T>(key) : undefined),
    error: sameKey ? state.error : null,
    loading: sameKey ? state.loading : !!key && peek<T>(key) === undefined,
    stale: sameKey && state.stale,
    refresh
  }
}
