'use strict'
/**
 * 内存版 @cloudbase/node-sdk database() 子集，用于本地单测：
 * where(等值 / command.in) / orderBy / skip / limit / field / get / count / add / update / remove /
 * doc(id).get|update|remove，支持点号路径更新与唯一索引模拟。calls 记录每次操作，便于断言查询条件。
 * remove 返回 { deleted }、update 返回 { updated }，与 SDK 一致。
 */
let seq = 0

function getPath(o, p) {
  return p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o)
}
/** 等值或 { $in: [...] }（db.command.in 的替身） */
function matches(d, where) {
  return Object.entries(where).every(([k, v]) => {
    const actual = getPath(d, k)
    if (v && typeof v === 'object' && Array.isArray(v.$in)) return v.$in.includes(actual)
    return actual === v
  })
}
/** db.command.inc(n) 的替身：{ $inc: n } */
function applyPatch(d, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && typeof v.$inc === 'number') setPath(d, k, (Number(getPath(d, k)) || 0) + v.$inc)
    else setPath(d, k, clone(v))
  }
}
function setPath(o, p, v) {
  const ks = p.split('.')
  let cur = o
  ks.slice(0, -1).forEach((k) => {
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {}
    cur = cur[k]
  })
  cur[ks[ks.length - 1]] = v
}
const clone = (x) => JSON.parse(JSON.stringify(x))

/**
 * @param {{ data?: object, unique?: object, strictCollections?: boolean }} [opts]
 *   strictCollections=true 模拟云端「集合不存在则任何操作都报 DATABASE_COLLECTION_NOT_EXIST」（add 也不会自动建集合），
 *   只有 data 里预置的或 db.createCollection() 建过的集合可用。
 */
function createFakeDb({ data = {}, unique = {}, strictCollections = false } = {}) {
  const store = {}
  for (const [name, docs] of Object.entries(data)) store[name] = docs.map((d) => ({ _id: d._id || `id${++seq}`, ...clone(d) }))
  const calls = []
  const missing = (name) => Object.assign(new Error(`[ResourceNotFound] Db or Table not exist: ${name}`), { code: 'DATABASE_COLLECTION_NOT_EXIST' })

  function query(name, state = { where: {}, order: [], skip: 0, limit: 100, field: null }) {
    const rows = () => {
      if (strictCollections && !store[name]) throw missing(name)
      return (store[name] = store[name] || [])
    }
    const filtered = () => rows().filter((d) => matches(d, state.where))
    const next = (patch) => query(name, { ...state, ...patch })
    return {
      where: (w) => next({ where: { ...state.where, ...w } }),
      orderBy: (k, dir) => next({ order: [...state.order, [k, dir]] }),
      skip: (n) => next({ skip: n }),
      limit: (n) => next({ limit: n }),
      field: (f) => next({ field: f }),
      async get() {
        calls.push({ op: 'get', collection: name, ...clone(state) })
        let list = filtered()
        for (const [k, dir] of [...state.order].reverse()) {
          list = [...list].sort((a, b) => (getPath(a, k) > getPath(b, k) ? 1 : getPath(a, k) < getPath(b, k) ? -1 : 0) * (dir === 'desc' ? -1 : 1))
        }
        list = list.slice(state.skip, state.skip + state.limit).map(clone)
        if (state.field) {
          const keep = Object.keys(state.field).filter((k) => state.field[k])
          list = list.map((d) => Object.fromEntries(Object.entries(d).filter(([k]) => keep.includes(k))))
        }
        return { data: list }
      },
      async count() {
        calls.push({ op: 'count', collection: name, where: clone(state.where) })
        return { total: filtered().length }
      },
      async add(doc) {
        // unique[name] 的每一项是字段名或字段名数组（复合唯一索引）
        for (const key of unique[name] || []) {
          const keys = Array.isArray(key) ? key : [key]
          if (rows().some((d) => keys.every((k) => getPath(d, k) === getPath(doc, k)))) throw Object.assign(new Error('E11000 duplicate key error'), { code: 'DATABASE_DUPLICATE_WRITE' })
        }
        // 自定义 _id（account_links 用别名当 _id）：重复即冲突，与云端行为一致
        if (typeof doc._id === 'string' && rows().some((d) => d._id === doc._id)) throw Object.assign(new Error('document with _id already exists'), { code: 'DATABASE_DUPLICATE_WRITE' })
        const _id = typeof doc._id === 'string' ? doc._id : `id${++seq}`
        rows().push({ ...clone(doc), _id })
        calls.push({ op: 'add', collection: name })
        return { id: _id }
      },
      async update(patch) {
        calls.push({ op: 'update', collection: name, where: clone(state.where), patch: clone(patch) })
        const list = filtered()
        for (const d of list) applyPatch(d, patch)
        return { updated: list.length }
      },
      async remove() {
        calls.push({ op: 'remove', collection: name, where: clone(state.where) })
        const before = rows().length
        store[name] = rows().filter((d) => !matches(d, state.where))
        return { deleted: before - store[name].length }
      },
      doc(id) {
        return {
          async get() {
            calls.push({ op: 'doc.get', collection: name, id })
            const d = rows().find((x) => x._id === id)
            return { data: d ? [clone(d)] : [] }
          },
          async update(patch) {
            calls.push({ op: 'doc.update', collection: name, id, patch: clone(patch) })
            const d = rows().find((x) => x._id === id)
            if (!d) return { updated: 0 }
            applyPatch(d, patch)
            return { updated: 1 }
          },
          async remove() {
            calls.push({ op: 'doc.remove', collection: name, id })
            const before = rows().length
            store[name] = rows().filter((x) => x._id !== id)
            return { deleted: before - store[name].length }
          },
        }
      },
    }
  }

  const command = { in: (values) => ({ $in: [...values] }), inc: (n) => ({ $inc: n }) }
  async function createCollection(name) {
    calls.push({ op: 'createCollection', collection: name })
    if (store[name]) throw Object.assign(new Error('[ResourceUnavailable.ResourceExist] Table exist.'), { code: 'DATABASE_COLLECTION_ALREADY_EXIST' })
    store[name] = []
    return { requestId: 'fake', message: 'success' }
  }
  return { collection: (name) => query(name), createCollection, command, store, calls }
}

module.exports = { createFakeDb }
