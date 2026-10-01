import { act, create } from 'react-test-renderer'
import Taro from '@tarojs/taro'
import { useRequest } from '@/hooks/useRequest'
import { invalidate } from '@/hooks/requestCache'
import { usePaged } from '@/hooks/usePaged'

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

function probe<T> (hook: () => T) {
  const out: { current: T } = {} as any
  function P () { out.current = hook(); return null }
  let r: any
  act(() => { r = create(<P />) })
  return { out, unmount: () => act(() => r.unmount()) }
}

beforeEach(() => { invalidate(); (Taro as any).__storage.clear() })

describe('useRequest', () => {
  it('TTL 内缓存命中，不重复请求；并发请求合并', async () => {
    const fetcher = jest.fn(() => Promise.resolve(42))
    const a = probe(() => useRequest('k1', fetcher))
    const b = probe(() => useRequest('k1', fetcher))
    expect(a.out.current.loading).toBe(true)
    await flush()
    expect(a.out.current.data).toBe(42)
    expect(b.out.current.data).toBe(42)
    const c = probe(() => useRequest('k1', fetcher))
    expect(c.out.current.data).toBe(42)
    expect(c.out.current.loading).toBe(false)
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refresh 强制请求', async () => {
    let n = 0
    const fetcher = jest.fn(() => Promise.resolve(++n))
    const a = probe(() => useRequest('k2', fetcher))
    await flush()
    await act(async () => { await a.out.current.refresh() })
    expect(a.out.current.data).toBe(2)
  })

  it('TTL 过期后重新请求', async () => {
    const fetcher = jest.fn(() => Promise.resolve(1))
    probe(() => useRequest('k3', fetcher, { ttl: 0 }))
    await flush()
    probe(() => useRequest('k3', fetcher, { ttl: 0 }))
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('persist：失败时用本地上次结果兜底并标记 stale', async () => {
    probe(() => useRequest('k4', () => Promise.resolve('cached'), { persist: true }))
    await flush()
    invalidate()
    const b = probe(() => useRequest('k4', () => Promise.reject(new Error('offline')), { persist: true }))
    await flush()
    expect(b.out.current.data).toBe('cached')
    expect(b.out.current.stale).toBe(true)
    expect(b.out.current.error).toBeTruthy()
  })

  it('key 为 null 时不请求', async () => {
    const fetcher = jest.fn(() => Promise.resolve(1))
    const a = probe(() => useRequest(null, fetcher))
    await flush()
    expect(fetcher).not.toHaveBeenCalled()
    expect(a.out.current.loading).toBe(false)
  })
})

describe('usePaged', () => {
  const items = Array.from({ length: 45 }, (_, i) => ({ _id: `a${i}` }))
  const fetchPage = (page: number) => Promise.resolve({
    // 故意让第 2 页与第 1 页重叠一条，验证去重
    list: items.slice(Math.max(0, (page - 1) * 20 - (page === 2 ? 1 : 0)), page * 20),
    hasMore: page * 20 < items.length
  })

  it('翻页去重、到底停止', async () => {
    const p = probe(() => usePaged('x', fetchPage))
    await flush()
    expect(p.out.current.list).toHaveLength(20)
    act(() => p.out.current.loadMore())
    await flush()
    act(() => p.out.current.loadMore())
    await flush()
    expect(p.out.current.list).toHaveLength(45)
    expect(new Set(p.out.current.list.map(x => x._id)).size).toBe(45)
    expect(p.out.current.hasMore).toBe(false)
    act(() => p.out.current.loadMore())
    await flush()
    expect(p.out.current.list).toHaveLength(45)
  })

  it('加载更多失败可重试', async () => {
    let fail = true
    const p = probe(() => usePaged('y', (page: number) => (page === 2 && fail ? Promise.reject(new Error('x')) : fetchPage(page))))
    await flush()
    act(() => p.out.current.loadMore())
    await flush()
    expect(p.out.current.moreError).toBeTruthy()
    fail = false
    act(() => p.out.current.loadMore())
    await flush()
    expect(p.out.current.list.length).toBe(40)
  })

  it('筛选变化时重置，丢弃过期结果', async () => {
    let resolveSlow: (v: any) => void = () => {}
    const slow = () => new Promise<any>(r => { resolveSlow = r })
    let key = 'k1'
    let fn: (p: number) => Promise<any> = slow
    const holder: any = {}
    function P () { holder.v = usePaged(key, fn); return null }
    let r: any
    act(() => { r = create(<P />) })
    key = 'k2'
    fn = (page: number) => Promise.resolve({ list: [{ _id: `k2-${page}` }], hasMore: false })
    act(() => r.update(<P />))
    await flush()
    resolveSlow({ list: [{ _id: 'stale' }], hasMore: true })
    await flush()
    expect(holder.v.list.map((x: any) => x._id)).toEqual(['k2-1'])
  })
})
