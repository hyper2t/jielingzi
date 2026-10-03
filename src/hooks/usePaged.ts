/**
 * usePaged：分页列表（触底加载、按 _id 去重、筛选变化时重置、并发保护）。FE-08 使用。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface PageResult<T> {
  list: T[]
  hasMore: boolean
}

export interface PagedState<T> {
  list: T[]
  /** 首屏加载中（显示骨架） */
  loading: boolean
  /** 加载更多中 */
  loadingMore: boolean
  hasMore: boolean
  error: unknown
  /** 加载更多失败（列表底部行内重试） */
  moreError: unknown
  loadMore: () => void
  reload: () => void
}

export function usePaged<T extends { _id: string }> (key: string, fetchPage: (page: number) => Promise<PageResult<T>>): PagedState<T> {
  const [list, setList] = useState<T[]>([])
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [moreError, setMoreError] = useState<unknown>(null)
  const fetchRef = useRef(fetchPage)
  fetchRef.current = fetchPage
  const token = useRef(0)
  const busy = useRef(false)

  const load = useCallback(async (next: number, reset: boolean) => {
    const my = reset ? ++token.current : token.current
    busy.current = true
    if (reset) { setLoading(true); setError(null) } else { setLoadingMore(true); setMoreError(null) }
    try {
      const res = await fetchRef.current(next)
      if (my !== token.current) return
      setList(prev => {
        const base = reset ? [] : prev
        const seen = new Set(base.map(x => x._id))
        return base.concat(res.list.filter(x => !seen.has(x._id) && seen.add(x._id)))
      })
      setPage(next)
      setHasMore(res.hasMore)
    } catch (e) {
      if (my !== token.current) return
      if (reset) { setError(e); setList([]) } else setMoreError(e)
    } finally {
      if (my === token.current) {
        busy.current = false
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [])

  useEffect(() => {
    setList([])
    setPage(0)
    setHasMore(true)
    setLoadingMore(false)
    setMoreError(null)
    load(1, true)
  }, [key, load])

  const loadMore = useCallback(() => {
    if (busy.current || !hasMore || error) return
    load(page + 1, false)
  }, [hasMore, error, page, load])

  const reload = useCallback(() => { load(1, true) }, [load])

  return { list, loading, loadingMore, hasMore, error, moreError, loadMore, reload }
}
