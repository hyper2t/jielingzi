/**
 * 按 key 前缀存多条记录 + 一个最近使用索引，超出上限淘汰最久未用（play_progress 最多 100 个专辑）。
 * 与具体存储实现解耦：storage.ts / storage.rn.ts 各自注入读写原语。
 */
export interface StoragePrimitives {
  getItem<T>(key: string, fallback: T): T
  getItem<T>(key: string): T | undefined
  setItem<T>(key: string, value: T): boolean
  removeItem(key: string): void
}

export interface LRUStore<T> {
  get(id: string): T | undefined
  /** 写入并标记为最近使用；返回被淘汰的 id */
  set(id: string, value: T): string[]
  remove(id: string): void
  /** 最近使用在前 */
  keys(): string[]
  /** 最近使用的一条 */
  latest(): { id: string, value: T } | undefined
  clear(): void
}

export function createLRUWith<T> (s: StoragePrimitives, prefix: string, max: number): LRUStore<T> {
  const indexKey = `${prefix}__index`
  const readIndex = (): string[] => {
    const idx = s.getItem<string[]>(indexKey, [])
    return Array.isArray(idx) ? idx : []
  }
  const writeIndex = (idx: string[]) => s.setItem(indexKey, idx)

  return {
    get (id) {
      return s.getItem<T>(prefix + id)
    },
    set (id, value) {
      const idx = readIndex().filter(k => k !== id)
      idx.unshift(id)
      const evicted = idx.splice(max)
      evicted.forEach(k => s.removeItem(prefix + k))
      s.setItem(prefix + id, value)
      writeIndex(idx)
      return evicted
    },
    remove (id) {
      s.removeItem(prefix + id)
      writeIndex(readIndex().filter(k => k !== id))
    },
    keys () {
      return readIndex()
    },
    latest () {
      for (const id of readIndex()) {
        const value = s.getItem<T>(prefix + id)
        if (value !== undefined) return { id, value }
      }
      return undefined
    },
    clear () {
      readIndex().forEach(k => s.removeItem(prefix + k))
      s.removeItem(indexKey)
    }
  }
}
