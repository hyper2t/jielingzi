import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { normalizeExisting, planIndexes, toCreateIndex } from './ensure-indexes.mjs'

const require = createRequire(import.meta.url)
const { COLLECTIONS, indexDefs } = require('../../cloudfunctions/_shared/collections.js')

test('索引登记：名称在集合内唯一、字段方向合法；detach 集合没有含 _openid 的唯一索引（否则第二个注销会撞索引）', () => {
  const defs = indexDefs()
  assert.ok(defs.length >= 15)
  for (const c of COLLECTIONS) {
    const names = (c.indexes || []).map((i) => i.name)
    assert.equal(new Set(names).size, names.length, c.name)
    for (const i of c.indexes || []) {
      assert.ok(i.keys.length >= 1, `${c.name}.${i.name}`)
      for (const [field, dir] of i.keys) assert.ok(typeof field === 'string' && [1, -1].includes(dir), `${c.name}.${i.name}.${field}`)
      if (c.owned && c.owned.onDelete === 'detach' && i.unique) assert.ok(!i.keys.some(([f]) => f === '_openid'), `${c.name}.${i.name}`)
    }
  }
  const find = (col, name) => defs.find((d) => d.collection === col && d.name === name)
  assert.equal(find('users', 'uniq_openid').unique, true)
  assert.equal(find('profiles', 'uniq_anonAlias').unique, true)
  assert.equal(find('reports', 'idx_reporter_target').unique, false)
  assert.ok(find('rate_limits', 'idx_expireAt') && find('mod_logs', 'idx_expireAt'))
})

test('planIndexes：按字段 + 方向比对；缺的创建，同构的跳过（不管名字），唯一性不一致或同名异构只报告', () => {
  const wanted = [
    { name: 'uniq_openid', keys: [['_openid', 1]], unique: true },
    { name: 'idx_time', keys: [['state', 1], ['createdAt', -1]] },
    { name: 'idx_x', keys: [['x', 1]] },
    { name: 'idx_y', keys: [['y', 1]], unique: true }
  ]
  const existing = normalizeExisting([
    { Name: '_id_', Keys: [{ Name: '_id', Direction: '1' }], Unique: true },
    { Name: 'console_made', Keys: [{ Name: 'state', Direction: '1' }, { Name: 'createdAt', Direction: '-1' }], Unique: false },
    { Name: 'idx_x', Keys: [{ Name: 'other', Direction: '1' }], Unique: false },
    { Name: 'y_plain', Keys: [{ Name: 'y', Direction: '1' }], Unique: 'false' }
  ])
  const plan = planIndexes(wanted, existing)
  assert.deepEqual(plan.missing.map((m) => m.name), ['uniq_openid'])
  assert.deepEqual(plan.present, ['idx_time'])
  assert.deepEqual(plan.conflicts.map((c) => c.name), ['idx_x', 'idx_y'])
  // 同字段非唯一 → 期望唯一：可修复（集合为空时 --fix-unique 删旧建新）；同名异构不可自动修复
  assert.deepEqual(plan.conflicts.map((c) => [c.name, !!c.fixable, c.existing || null]), [['idx_x', false, null], ['idx_y', true, 'y_plain']])
})

test('toCreateIndex：UpdateTable 的 CreateIndex 结构（方向为字符串）', () => {
  assert.deepEqual(toCreateIndex({ name: 'idx', keys: [['a', 1], ['b', -1]], unique: true }), {
    IndexName: 'idx',
    MgoKeySchema: { MgoIndexKeys: [{ Name: 'a', Direction: '1' }, { Name: 'b', Direction: '-1' }], MgoIsUnique: true }
  })
})
