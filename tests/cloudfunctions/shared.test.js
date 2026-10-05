'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const S = require('../../cloudfunctions/_shared')

test('ok / fail 统一结构', () => {
  assert.deepEqual(S.ok({ a: 1 }), { code: 0, data: { a: 1 }, msg: 'ok' })
  assert.deepEqual(S.fail(S.CODES.NOT_FOUND), { code: 40401, data: null, msg: '不存在' })
  assert.equal(new S.AppError(40001).message, '参数错误')
  assert.deepEqual(Object.values(S.CODES), [0, 40001, 40101, 40301, 40302, 40303, 40304, 40305, 40401, 40901, 42901, 50000, 50201])
  assert.equal(S.upstream().code, 50201)
  assert.equal(S.conflict('x').message, 'x')
})

test('validate：类型、范围、枚举、默认值、未知字段', () => {
  const schema = { id: { type: 'id' }, n: { type: 'int', min: 1, max: 5, default: 2 }, e: { type: 'enum', values: ['a', 1], optional: true } }
  assert.deepEqual(S.validate({ id: ' ab_1 ' }, schema), { id: 'ab_1', n: 2 })
  assert.deepEqual(S.validate({ id: 'x', n: 5, e: 1 }, schema), { id: 'x', n: 5, e: 1 })
  const bad = [{}, { id: 'a b' }, { id: 'x', n: 0 }, { id: 'x', n: 1.5 }, { id: 'x', n: '3' }, { id: 'x', e: 'b' }, { id: 'x', extra: 1 }, { id: 'x'.repeat(65) }]
  for (const input of bad) {
    assert.throws(() => S.validate(input, schema), (e) => e instanceof S.AppError && e.code === 40001, JSON.stringify(input))
  }
  assert.deepEqual(S.validate({ extra: 1 }, {}, { allowUnknown: true }), {})
  assert.deepEqual(S.validate(undefined, S.pageSchema()), { page: 1, size: 20 })
  assert.throws(() => S.validate({ size: 51 }, S.pageSchema()), /不能大于 50/)
})

test('resolveIdentity：小程序 openId 优先，自定义登录 customUserId 次之，再用 uid，都没有则为空', () => {
  const auth = (info) => ({ getUserInfo: () => info })
  const pick = ({ openid, source, appId }) => ({ openid, source, appId })
  assert.deepEqual(pick(S.resolveIdentity(auth({ openId: 'o1', uid: 'u1', appId: 'wx1' }))), { openid: 'o1', source: 'weapp', appId: 'wx1' })
  assert.deepEqual(pick(S.resolveIdentity(auth({ openId: '', uid: 'u1' }))), { openid: 'u1', source: 'web', appId: null })
  assert.deepEqual(pick(S.resolveIdentity(auth({ uid: 'u1', customUserId: 'acc1' }))), { openid: 'acc1', source: 'custom', appId: null })
  // raw 保留各平台原始字段；小程序绑定开放平台后 context.environment 里带 WX_UNIONID
  const withUnion = S.resolveIdentity(auth({ openId: 'o1', appId: 'wx1' }), { environment: JSON.stringify({ WX_OPENID: 'o1', WX_UNIONID: 'un1' }) })
  assert.deepEqual(withUnion.raw, { openId: 'o1', uid: null, customUserId: null, appId: 'wx1', unionId: 'un1', loginType: null, isAnonymous: false, publishableKey: false })
  assert.equal(S.resolveIdentity(auth({ uid: 'u9' }), { environment: JSON.stringify({ LOGINTYPE: 'CUSTOM' }) }).raw.loginType, 'CUSTOM')
  assert.equal(S.resolveIdentity(auth({ openId: 'o1' }), { environment: '{bad json' }).raw.unionId, null)
  assert.equal(S.resolveIdentity(auth({ uid: 'anon' })).raw.publishableKey, true)
  assert.equal(S.resolveIdentity(auth({ uid: 'u2', isAnonymous: true })).raw.isAnonymous, true)
  assert.equal(S.resolveIdentity(auth({})).openid, null)
  // Publishable Key 直接调用：uid 是字面量 'anon'（公钥的 sub），不是用户，必须视为无身份
  assert.equal(S.resolveIdentity(auth({ uid: 'anon' })).openid, null)
  assert.equal(S.resolveIdentity(auth({ uid: S.PUBLISHABLE_KEY_UID })).source, null)
  assert.equal(S.resolveIdentity({ getUserInfo: () => { throw new Error('x') } }).openid, null)
  assert.equal(S.resolveIdentity(null).openid, null)
  assert.throws(() => S.requireOpenid({ openid: null }), (e) => e.code === 40101)
  assert.equal(S.requireOpenid({ openid: 'o1' }), 'o1')
})

test('createMain：分发、剥离保留字段、错误码、异常兜底', async () => {
  const errors = []
  const main = S.createMain({
    actions: {
      echo: async (p, ctx) => ({ p, who: ctx.who }),
      boom: async () => { throw new Error('secret detail') },
      nf: async () => { throw S.notFound() },
      nothing: async () => undefined,
    },
    createContext: () => ({ who: 'ctx' }),
    logger: { error: (...a) => errors.push(a) },
  })
  assert.deepEqual(await main({ action: 'echo', a: 1, userInfo: { openId: 'fake' } }), { code: 0, data: { p: { a: 1 }, who: 'ctx' }, msg: 'ok' })
  assert.equal((await main({ action: 'nope' })).code, 40001)
  assert.equal((await main({})).code, 40001)
  assert.equal((await main({ action: 'toString' })).code, 40001)
  assert.equal((await main({ action: 'nf' })).code, 40401)
  assert.deepEqual(await main({ action: 'nothing' }), { code: 0, data: null, msg: 'ok' })
  const r = await main({ action: 'boom' })
  assert.deepEqual(r, { code: 50000, data: null, msg: '服务异常' })
  assert.equal(errors.length, 1)
})

test('isDuplicateKeyError', () => {
  assert.ok(S.isDuplicateKeyError(new Error('E11000 duplicate key')))
  assert.ok(S.isDuplicateKeyError({ code: 'DATABASE_DUPLICATE_WRITE' }))
  assert.ok(!S.isDuplicateKeyError(new Error('timeout')))
})
