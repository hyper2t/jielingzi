'use strict'
/** 通过 Apple 登录（BE-L09）：identityToken 校验适配器 + user.appleLogin / bindApple / deleteAccount 撤销（全部假网络） */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { generateKeyPairSync, createHash, sign, verify } = require('node:crypto')
const S = require('../../cloudfunctions/_shared')
const { createAppleClient, appleAccountId, normalizeP8, JWKS_URL, TOKEN_URL, REVOKE_URL } = require('../../cloudfunctions/user/apple')
const { setup, links } = require('./userHarness')

const NOW = 1790000000000
const BUNDLE = 'com.jielingzi.app'
const SUB = '001234.0a1b2c3d4e5f60718293a4b5c6d7e8f9.0123'
const RAW_NONCE = 'raw-nonce-0123456789abcdef'
const sha256 = (s) => createHash('sha256').update(s).digest('hex')

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
const rsaOther = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'kid-1', alg: 'RS256', use: 'sig' }
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const P8 = ec.privateKey.export({ format: 'pem', type: 'pkcs8' })

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function makeToken({ claims = {}, header = {}, key = rsa.privateKey } = {}) {
  const h = b64u({ alg: 'RS256', kid: 'kid-1', ...header })
  const p = b64u({ iss: 'https://appleid.apple.com', aud: BUNDLE, sub: SUB, iat: NOW / 1000, exp: NOW / 1000 + 600, nonce: sha256(RAW_NONCE), nonce_supported: true, email: 'x@privaterelay.appleid.com', ...claims })
  const sig = sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')
  return `${h}.${p}.${sig}`
}

function fakeFetch({ keys = [jwk], token = { status: 200, body: { refresh_token: 'rt-1' } }, revoke = 200 } = {}) {
  const calls = []
  const fn = async (url, init = {}) => {
    calls.push({ url, init })
    if (url === JWKS_URL) return { status: 200, json: async () => ({ keys: typeof keys === 'function' ? keys(calls) : keys }) }
    if (url === TOKEN_URL) return { status: token.status, json: async () => token.body }
    if (url === REVOKE_URL) return { status: revoke, json: async () => ({}) }
    throw new Error('unexpected ' + url)
  }
  fn.calls = calls
  return fn
}

const client = (env = {}, fetchImpl = fakeFetch()) => createAppleClient(env, { fetchImpl, now: () => NOW })

// ---------- 适配器 ----------

test('appleAccountId：ap_ + sha1(sub) 前 24 位，满足 customUserId 规则', () => {
  const id = appleAccountId(SUB)
  assert.equal(id, 'ap_' + createHash('sha1').update(SUB).digest('hex').slice(0, 24))
  assert.equal(id.length, 27)
  assert.ok(S.CUSTOM_ID_RE.test(id))
})

test('verifyIdentityToken：合法 token 只返回 sub（不带 email）；JWKS 进程内缓存', async () => {
  const f = fakeFetch()
  const apple = client({}, f)
  assert.equal(apple.bundleId, BUNDLE)
  assert.equal(apple.canRevoke, false)
  assert.deepEqual(await apple.verifyIdentityToken(makeToken(), { nonce: RAW_NONCE }), { sub: SUB })
  await apple.verifyIdentityToken(makeToken(), { nonce: RAW_NONCE })
  assert.equal(f.calls.filter((c) => c.url === JWKS_URL).length, 1)
  // aud 为数组也接受；自定义 Bundle ID
  const custom = client({ APPLE_BUNDLE_ID: 'com.example.x' })
  assert.deepEqual(await custom.verifyIdentityToken(makeToken({ claims: { aud: ['com.example.x'] } }), { nonce: RAW_NONCE }), { sub: SUB })
})

test('verifyIdentityToken：签名 / iss / aud / exp / nonce / alg / 格式 任一不对都是 40101', async () => {
  const apple = client()
  const bad = async (token, nonce = RAW_NONCE) => assert.rejects(apple.verifyIdentityToken(token, { nonce }), (e) => e.code === 40101)
  await bad(makeToken({ key: rsaOther.privateKey }))
  await bad(makeToken({ claims: { iss: 'https://evil.example.com' } }))
  await bad(makeToken({ claims: { aud: 'com.other.app' } }))
  await bad(makeToken({ claims: { exp: NOW / 1000 - 3600 } }))
  await bad(makeToken({ claims: { nonce: sha256('other') } }))
  await bad(makeToken(), 'wrong-nonce-000')
  await bad(makeToken({ claims: { nonce: undefined } }))
  await bad(makeToken({ header: { alg: 'HS256' } }))
  await bad(makeToken({ claims: { sub: '' } }))
  await bad('not.a.jwt.at.all')
  await bad('a.b')
  // exp 在 60 s 容差内仍通过
  assert.deepEqual(await apple.verifyIdentityToken(makeToken({ claims: { exp: NOW / 1000 - 30 } }), { nonce: RAW_NONCE }), { sub: SUB })
})

test('verifyIdentityToken：kid 未命中时强制刷新 JWKS 一次（Apple 轮换密钥）；JWKS 拉取失败 → 50201', async () => {
  let round = 0
  const f = fakeFetch({ keys: () => (++round === 1 ? [{ ...jwk, kid: 'old' }] : [jwk]) })
  const apple = client({}, f)
  assert.deepEqual(await apple.verifyIdentityToken(makeToken(), { nonce: RAW_NONCE }), { sub: SUB })
  assert.equal(f.calls.filter((c) => c.url === JWKS_URL).length, 2)

  const down = createAppleClient({}, { fetchImpl: async () => { throw new Error('ECONNRESET') }, now: () => NOW })
  await assert.rejects(down.verifyIdentityToken(makeToken(), { nonce: RAW_NONCE }), (e) => e.code === 50201)
})

test('normalizeP8：PEM / base64 PEM / 字面量 \\n；未配置或 {{env.X}} 为 null', () => {
  assert.equal(normalizeP8(P8), P8.trim())
  assert.equal(normalizeP8(Buffer.from(P8).toString('base64')), P8.trim())
  assert.equal(normalizeP8(P8.replace(/\n/g, '\\n')), P8.trim())
  assert.equal(normalizeP8(''), null)
  assert.equal(normalizeP8('{{env.APPLE_PRIVATE_KEY}}'), null)
  assert.equal(normalizeP8('bm90IGEga2V5'), null)
})

test('revokeByAuthorizationCode：未配置密钥 → null；code 换 refresh_token 再 revoke，client_secret 为 ES256 JWT', async () => {
  assert.equal(await client().revokeByAuthorizationCode('code-1'), null)
  const f = fakeFetch()
  const env = { APPLE_TEAM_ID: 'AB12CD34EF', APPLE_KEY_ID: 'KEY1234567', APPLE_PRIVATE_KEY: Buffer.from(P8).toString('base64') }
  const apple = client(env, f)
  assert.equal(apple.canRevoke, true)
  assert.equal(await apple.revokeByAuthorizationCode('code-1', { error() {} }), true)
  const [tokenCall, revokeCall] = f.calls
  assert.equal(tokenCall.url, TOKEN_URL)
  const form = new URLSearchParams(tokenCall.init.body)
  assert.equal(form.get('grant_type'), 'authorization_code')
  assert.equal(form.get('code'), 'code-1')
  assert.equal(form.get('client_id'), BUNDLE)
  const [h, p, s] = form.get('client_secret').split('.')
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' })
  const payload = JSON.parse(Buffer.from(p, 'base64url'))
  assert.equal(payload.iss, 'AB12CD34EF')
  assert.equal(payload.sub, BUNDLE)
  assert.equal(payload.aud, 'https://appleid.apple.com')
  assert.equal(payload.exp - payload.iat, 300)
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')))
  const rf = new URLSearchParams(revokeCall.init.body)
  assert.equal(revokeCall.url, REVOKE_URL)
  assert.equal(rf.get('token'), 'rt-1')
  assert.equal(rf.get('token_type_hint'), 'refresh_token')

  // 换 token 失败 / revoke 非 200 → false，不抛错；日志不含 code
  const logs = []
  const logger = { error: (m) => logs.push(m) }
  assert.equal(await client(env, fakeFetch({ token: { status: 400, body: { error: 'invalid_grant' } } })).revokeByAuthorizationCode('code-2', logger), false)
  assert.equal(await client(env, fakeFetch({ revoke: 400 })).revokeByAuthorizationCode('code-3', logger), false)
  assert.ok(logs.length === 2 && !logs.some((l) => l.includes('code-')))
})

// ---------- user 动作 ----------

const fakeTicket = (accountId) => `kid/@@/ticket-for-${accountId}`
const APPLE_ID = appleAccountId(SUB)
const fakeApple = (revokeResult = true) => ({
  bundleId: BUNDLE,
  canRevoke: true,
  revoked: [],
  async verifyIdentityToken(token, { nonce }) {
    if (token.startsWith('bad')) throw S.unauthorized('Apple 登录凭证无效，请重试')
    if (!nonce) throw S.unauthorized('x')
    const m = /^tok-(\S+)$/.exec(token)
    return { sub: m ? m[1] : SUB }
  },
  async revokeByAuthorizationCode(code) { this.revoked.push(code); return revokeResult },
})
const TOKEN = 'tok-' + SUB

test('appleLogin：首登建号（accountId = ap_…），写 acc/apple/pending 别名并签票据；再次登录复用', async () => {
  const { db, as } = setup({ apple: fakeApple(), createTicket: fakeTicket })
  const pk = as({ uid: 'anon' })
  const r = await pk({ action: 'appleLogin', identityToken: TOKEN, nonce: RAW_NONCE })
  assert.equal(r.code, 0, JSON.stringify(r))
  assert.deepEqual(Object.keys(r.data).sort(), ['accountId', 'isNew', 'linkToken', 'ticket'])
  assert.equal(r.data.accountId, APPLE_ID)
  assert.equal(r.data.isNew, true)
  assert.equal(r.data.ticket, `kid/@@/ticket-for-${APPLE_ID}`)
  assert.deepEqual(links(db), [`acc:${APPLE_ID}>${APPLE_ID}`, `apple:${SUB}>${APPLE_ID}`, `pending:${r.data.linkToken}>${APPLE_ID}`])
  assert.equal(db.store.users.length, 1)

  // 票据会话 + linkToken → login 返回 identities.apple
  const session = as({ uid: 'uid-apple-0001' })
  const login = await session({ action: 'login', platform: 'app', linkToken: r.data.linkToken })
  assert.equal(login.code, 0, JSON.stringify(login))
  assert.equal(login.data.accountId, APPLE_ID)
  assert.deepEqual(login.data.identities, { mp: false, wechat: false, phone: false, apple: true })

  const r2 = await pk({ action: 'appleLogin', identityToken: TOKEN, nonce: RAW_NONCE })
  assert.equal(r2.data.isNew, false)
  assert.equal(r2.data.accountId, APPLE_ID)
  assert.equal(db.store.users.length, 1)
})

test('appleLogin：参数错误 40001；凭证无效 40101；未配置 Apple / 自定义登录 50201；均不建号', async () => {
  const { db, as } = setup({ apple: fakeApple(), createTicket: fakeTicket })
  const pk = as({ uid: 'anon' })
  assert.equal((await pk({ action: 'appleLogin' })).code, 40001)
  assert.equal((await pk({ action: 'appleLogin', identityToken: TOKEN })).code, 40001)
  assert.equal((await pk({ action: 'appleLogin', identityToken: 'short', nonce: RAW_NONCE })).code, 40001)
  assert.equal((await pk({ action: 'appleLogin', identityToken: TOKEN, nonce: RAW_NONCE, email: 'x' })).code, 40001)
  assert.equal((await pk({ action: 'appleLogin', identityToken: 'bad-token-0123456789abc', nonce: RAW_NONCE })).code, 40101)
  assert.equal((db.store.users || []).length, 0)
  assert.equal((db.store.account_links || []).length, 0)
  const { as: noApple } = setup({ createTicket: fakeTicket })
  assert.equal((await noApple({ uid: 'anon' })({ action: 'appleLogin', identityToken: TOKEN, nonce: RAW_NONCE })).code, 50201)
  const { as: noTicket } = setup({ apple: fakeApple() })
  assert.equal((await noTicket({ uid: 'anon' })({ action: 'appleLogin', identityToken: TOKEN, nonce: RAW_NONCE })).code, 50201)
})

test('bindApple：手机号账号绑定 Apple；该 Apple ID 已有账号 → 并入当前账号；重复绑定幂等', async () => {
  const { db, as } = setup({ apple: fakeApple(), createTicket: fakeTicket })
  // 先用 Apple 登录建出一个账号
  const { data } = await as({ uid: 'anon' })({ action: 'appleLogin', identityToken: TOKEN, nonce: RAW_NONCE })
  await as({ uid: 'uid-apple-0001' })({ action: 'login', platform: 'app', linkToken: data.linkToken })
  // 手机号账号
  const phone = as({ uid: 'uid-phone-0001' })
  const pl = await phone({ action: 'login', platform: 'app' })
  assert.equal(pl.data.accountId, 'uid-phone-0001')
  const r = await phone({ action: 'bindApple', identityToken: TOKEN, nonce: RAW_NONCE })
  assert.equal(r.code, 0, JSON.stringify(r))
  assert.equal(r.data.merged, true)
  assert.ok(db.store.account_links.some((l) => l._id === `apple:${SUB}` && l.accountId === 'uid-phone-0001'))
  // 合并后 Apple 会话也解析到手机号账号
  assert.equal((await as({ uid: 'uid-apple-0001' })({ action: 'login' })).data.accountId, 'uid-phone-0001')
  assert.equal((await phone({ action: 'bindApple', identityToken: TOKEN, nonce: RAW_NONCE })).data.merged, false)
  // 未登录不能绑定
  assert.equal((await as(null)({ action: 'bindApple', identityToken: TOKEN, nonce: RAW_NONCE })).code, 40101)
})

test('deleteAccount：带 appleAuthorizationCode 时删数据后撤销 Apple 授权；不带时响应不变；撤销失败不影响注销', async () => {
  const apple = fakeApple()
  const { db, as } = setup({ apple, createTicket: fakeTicket })
  const { data } = await as({ uid: 'anon' })({ action: 'appleLogin', identityToken: TOKEN, nonce: RAW_NONCE })
  const session = as({ uid: 'uid-apple-0001' })
  await session({ action: 'login', platform: 'app', linkToken: data.linkToken })
  assert.equal((await session({ action: 'deleteAccount', confirm: 'DELETE', appleAuthorizationCode: 'x' })).code, 40001)
  const r = await session({ action: 'deleteAccount', confirm: 'DELETE', appleAuthorizationCode: 'auth-code-0001' })
  assert.equal(r.code, 0, JSON.stringify(r))
  assert.equal(r.data.appleRevoked, true)
  assert.deepEqual(apple.revoked, ['auth-code-0001'])
  assert.equal((db.store.account_links || []).length, 0)

  const plain = await as({ uid: 'uid-phone-0009' })({ action: 'deleteAccount', confirm: 'DELETE' })
  assert.ok(!('appleRevoked' in plain.data))

  const failing = fakeApple(false)
  const s2 = setup({ apple: failing, createTicket: fakeTicket })
  const r2 = await s2.as({ uid: 'uid-phone-0010' })({ action: 'deleteAccount', confirm: 'DELETE', appleAuthorizationCode: 'auth-code-0002' })
  assert.equal(r2.code, 0)
  assert.equal(r2.data.appleRevoked, false)
})
