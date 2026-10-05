import Taro from '@tarojs/taro'
import { clearAll, createLRU, getItem, setItem } from '@/utils/storage'

beforeEach(() => (Taro as any).__storage.clear())

describe('storage', () => {
  it('读写与默认值', () => {
    expect(getItem('x', 1)).toBe(1)
    setItem('x', { a: 1 })
    expect(getItem('x')).toEqual({ a: 1 })
  })

  it('读写异常不抛出', () => {
    ;(Taro.getStorageSync as jest.Mock).mockImplementationOnce(() => { throw new Error('boom') })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    expect(getItem('x', 'fb')).toBe('fb')
    ;(Taro.setStorageSync as jest.Mock).mockImplementationOnce(() => { throw new Error('full') })
    expect(setItem('x', 1)).toBe(false)
    warn.mockRestore()
  })

  it('clearAll 清空', () => {
    setItem('a', 1)
    clearAll()
    expect(getItem('a')).toBeUndefined()
  })
})

describe('createLRU', () => {
  it('超过上限淘汰最久未使用，并删除对应 key', () => {
    const lru = createLRU<number>('p:', 3)
    lru.set('a', 1); lru.set('b', 2); lru.set('c', 3)
    lru.get('a')
    lru.set('a', 10) // a 变为最新
    const evicted = lru.set('d', 4)
    expect(evicted).toEqual(['b'])
    expect(lru.keys()).toEqual(['d', 'a', 'c'])
    expect(getItem('p:b')).toBeUndefined()
    expect(lru.get('a')).toBe(10)
  })

  it('latest / remove / clear', () => {
    const lru = createLRU<string>('q:', 100)
    expect(lru.latest()).toBeUndefined()
    lru.set('x', 'X'); lru.set('y', 'Y')
    expect(lru.latest()).toEqual({ id: 'y', value: 'Y' })
    lru.remove('y')
    expect(lru.latest()).toEqual({ id: 'x', value: 'X' })
    lru.clear()
    expect(lru.keys()).toEqual([])
    expect(getItem('q:x')).toBeUndefined()
  })

  it('100 个专辑上限', () => {
    const lru = createLRU<number>('play_progress:', 100)
    for (let i = 0; i < 105; i++) lru.set(`al${i}`, i)
    expect(lru.keys()).toHaveLength(100)
    expect(lru.get('al0')).toBeUndefined()
    expect(lru.get('al104')).toBe(104)
  })
})
