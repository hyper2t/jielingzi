/**
 * RN 端存储（storage.rn.ts）：AsyncStorage 替身验证预热、同步读写语义、写透、前缀隔离与 LRU 复用。
 */
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>()
  return {
    __esModule: true,
    __store: store,
    default: {
      getAllKeys: jest.fn(async () => Array.from(store.keys())),
      multiGet: jest.fn(async (keys: string[]) => keys.map(k => [k, store.has(k) ? store.get(k) : null])),
      // 真机上写入是异步落盘：这里推迟一个微任务再写入 Map，才能验证「写后立刻可读」靠的是内存态而不是替身的同步副作用
      setItem: jest.fn(async (k: string, v: string) => { await Promise.resolve(); store.set(k, v) }),
      removeItem: jest.fn(async (k: string) => { await Promise.resolve(); store.delete(k) }),
      multiRemove: jest.fn(async (keys: string[]) => { await Promise.resolve(); keys.forEach(k => store.delete(k)) })
    }
  }
}, { virtual: true })

import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  clearAll, createLRU, flushStorage, getItem, hydrateStorage, isStorageHydrated, KEY_PREFIX, removeItem, setItem, __resetStorageForTest
} from '../storage.rn'

const backing: Map<string, string> = (jest.requireMock('@react-native-async-storage/async-storage') as any).__store
const AS = AsyncStorage as any

beforeEach(() => {
  backing.clear()
  __resetStorageForTest()
  Object.values(AS).forEach((v: any) => { if (v && typeof v.mockClear === 'function') v.mockClear() })
})

describe('storage.rn：预热', () => {
  it('只加载 jl: 前缀的 key，损坏的 JSON 忽略；预热是幂等的', async () => {
    backing.set(`${KEY_PREFIX}consent`, JSON.stringify('agreed'))
    backing.set(`${KEY_PREFIX}settings`, JSON.stringify({ ageGroup: '6-8' }))
    backing.set(`${KEY_PREFIX}broken`, '{not json')
    backing.set('@track-player/queue', JSON.stringify([1]))
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(isStorageHydrated()).toBe(false)
    await Promise.all([hydrateStorage(), hydrateStorage()])
    expect(AS.getAllKeys).toHaveBeenCalledTimes(1)
    expect(AS.multiGet).toHaveBeenCalledWith([`${KEY_PREFIX}consent`, `${KEY_PREFIX}settings`, `${KEY_PREFIX}broken`])
    expect(isStorageHydrated()).toBe(true)
    expect(getItem('consent')).toBe('agreed')
    expect(getItem('settings')).toEqual({ ageGroup: '6-8' })
    expect(getItem('broken', 'fb')).toBe('fb')
    expect(getItem('queue')).toBeUndefined()
    expect(warn).toHaveBeenCalledWith('[storage] 本地数据损坏，已忽略', `${KEY_PREFIX}broken`)
    warn.mockRestore()
  })

  it('预热完成前读取返回默认值并只告警一次', async () => {
    backing.set(`${KEY_PREFIX}x`, '1')
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(getItem('x', 0)).toBe(0)
    expect(getItem('y', 'd')).toBe('d')
    expect(warn).toHaveBeenCalledTimes(1)
    await hydrateStorage()
    expect(getItem('x', 0)).toBe(1)
    warn.mockRestore()
  })

  it('AsyncStorage 读取失败：按空存储继续，不阻塞启动', async () => {
    AS.getAllKeys.mockImplementationOnce(async () => { throw new Error('disk') })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(hydrateStorage()).resolves.toBeUndefined()
    expect(isStorageHydrated()).toBe(true)
    expect(getItem('x', 'fb')).toBe('fb')
    warn.mockRestore()
  })
})

describe('storage.rn：读写', () => {
  beforeEach(() => hydrateStorage())

  it('写后立刻可读（同步语义），并异步写透到 AsyncStorage', async () => {
    expect(setItem('settings', { a: 1 })).toBe(true)
    expect(getItem('settings')).toEqual({ a: 1 })
    expect(backing.has(`${KEY_PREFIX}settings`)).toBe(false)
    await flushStorage()
    expect(backing.get(`${KEY_PREFIX}settings`)).toBe(JSON.stringify({ a: 1 }))
  })

  it('返回的是拷贝：改返回值不影响存储', () => {
    setItem('obj', { list: [1] })
    const v = getItem<{ list: number[] }>('obj')!
    v.list.push(2)
    expect(getItem('obj')).toEqual({ list: [1] })
  })

  it('空字符串 / undefined 视为无值；removeItem 删内存与磁盘', async () => {
    setItem('s', '')
    expect(getItem('s', 'fb')).toBe('fb')
    setItem('u', undefined)
    expect(getItem('u', 'fb')).toBe('fb')
    setItem('k', 1)
    removeItem('k')
    expect(getItem('k')).toBeUndefined()
    await flushStorage()
    expect(backing.has(`${KEY_PREFIX}k`)).toBe(false)
  })

  it('写入失败只告警，不影响内存态', async () => {
    AS.setItem.mockImplementationOnce(async () => { throw new Error('full') })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(setItem('x', 1)).toBe(true)
    await flushStorage()
    expect(getItem('x')).toBe(1)
    expect(warn).toHaveBeenCalledWith('[storage] 写入失败', 'x', expect.any(Error))
    const circular: any = {}
    circular.self = circular
    expect(setItem('c', circular)).toBe(false)
    warn.mockRestore()
  })

  it('clearAll 只清本 App 前缀的 key', async () => {
    backing.set('@track-player/queue', '[]')
    setItem('a', 1)
    setItem('b', 2)
    await flushStorage()
    clearAll()
    expect(getItem('a')).toBeUndefined()
    await flushStorage()
    expect(Array.from(backing.keys())).toEqual(['@track-player/queue'])
  })

  it('createLRU 复用同一套原语', async () => {
    const lru = createLRU<number>('p:', 2)
    lru.set('a', 1)
    lru.set('b', 2)
    expect(lru.set('c', 3)).toEqual(['a'])
    expect(lru.keys()).toEqual(['c', 'b'])
    expect(getItem('p:a')).toBeUndefined()
    await flushStorage()
    expect(backing.get(`${KEY_PREFIX}p:c`)).toBe('3')
  })
})
