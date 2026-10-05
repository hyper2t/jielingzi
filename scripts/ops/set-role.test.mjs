import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { maskId, parseArgs, planRole, resolveAccountId } from './set-role.mjs'

const require = createRequire(import.meta.url)
const { createPhoneHasher } = require('../../cloudfunctions/_shared/phone.js')

test('set-role parseArgs：--account / --phone 二选一；role 只能是 user / mod / admin；--list 免其它参数', () => {
  assert.deepEqual(parseArgs(['--list']), { list: true, account: null, phone: null, latest: false, role: null, apply: false })
  assert.deepEqual(parseArgs(['--account', 'oA', '--role', 'mod']), { list: false, account: 'oA', phone: null, latest: false, role: 'mod', apply: false })
  assert.equal(parseArgs(['--latest', '--role', 'admin']).latest, true)
  assert.throws(() => parseArgs(['--latest', '--account', 'oA', '--role', 'admin']), /之一/)
  assert.equal(maskId('oAbcdefghijklmn1234'), 'oAbcde…1234')
  assert.equal(parseArgs(['--phone', '13800138000', '--role', 'admin', '--apply']).apply, true)
  assert.throws(() => parseArgs(['--role', 'mod']), /之一/)
  assert.throws(() => parseArgs(['--account', 'oA', '--phone', '13800138000', '--role', 'mod']), /之一/)
  assert.throws(() => parseArgs(['--account', 'oA', '--role', 'root']), /--role/)
  assert.throws(() => parseArgs(['--phone', '12345', '--role', 'mod']), /11 位/)
  assert.throws(() => parseArgs(['--nope']), /未知参数/)
})

test('set-role resolveAccountId：按手机号用与云函数相同的哈希查 phone: 别名；没配密钥 / 未绑定时报错', async () => {
  const hasher = createPhoneHasher({ PHONE_HASH_SECRET: 'test-phone-hash-secret-0123456789' })
  const links = { [`phone:${hasher('13800138000')}`]: { accountId: 'oA' } }
  const getLink = async (id) => links[id] || null
  assert.equal(await resolveAccountId({ account: 'oX' }, { hasher: null, getLink }), 'oX')
  assert.equal(await resolveAccountId({ phone: '13800138000' }, { hasher, getLink }), 'oA')
  await assert.rejects(resolveAccountId({ phone: '13800138001' }, { hasher, getLink }), /没有绑定/)
  await assert.rejects(resolveAccountId({ phone: '13800138000' }, { hasher: null, getLink }), /PHONE_HASH_SECRET/)
})

test('set-role planRole：显示旧值 → 新值；无变化不写；账号不存在报错', () => {
  assert.deepEqual(planRole({ role: 'user' }, 'mod'), { from: 'user', to: 'mod', changed: true })
  assert.deepEqual(planRole({}, 'user'), { from: 'user', to: 'user', changed: false })
  assert.deepEqual(planRole({ role: 'weird' }, 'admin'), { from: 'user', to: 'admin', changed: true })
  assert.throws(() => planRole(null, 'mod'), /账号不存在/)
})
