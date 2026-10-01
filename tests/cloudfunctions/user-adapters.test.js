'use strict'
/** user 函数的外部适配器：微信 code 换取、自定义登录票据、身份认证 HTTP API（全部可注入假实现，不发网络请求） */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createWechatClient, cleanEnv } = require('../../cloudfunctions/user/wechat')
const { loadCredentials, normalizePem, createTicketIssuer, TICKET_EXPIRE_MS, TICKET_REFRESH_MS } = require('../../cloudfunctions/user/custom-login')
const { createAuthApi } = require('../../cloudfunctions/user/auth-api')

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----'
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const jsonRes = (status, body) => ({ status, json: async () => body })

test('cleanEnv：空串 / 未替换的 {{env.X}} 模板视为未配置', () => {
  assert.equal(cleanEnv(undefined), null)
  assert.equal(cleanEnv('  '), null)
  assert.equal(cleanEnv('{{env.WX_APP_ID}}'), null)
  assert.equal(cleanEnv(' wx123 '), 'wx123')
})

test('createWechatClient：未配置返回 null；成功 / errcode / 无 unionid / 网络错误', async () => {
  assert.equal(createWechatClient({}), null)
  assert.equal(createWechatClient({ WX_APP_ID: 'wx1', WX_APP_SECRET: '{{env.WX_APP_SECRET}}' }, async () => {}), null)
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.includes('code=bad')) return jsonRes(200, { errcode: 40029, errmsg: 'invalid code' })
    if (url.includes('code=noun')) return jsonRes(200, { openid: 'oX', access_token: 'should-not-be-kept' })
    if (url.includes('code=boom')) throw new Error('ECONNRESET')
    return jsonRes(200, { openid: 'oX', unionid: 'unX', access_token: 'at', scope: 'snsapi_userinfo' })
  }
  const wx = createWechatClient({ WX_APP_ID: 'wx1', WX_APP_SECRET: 's&e=c' }, fetchImpl)
  assert.equal(wx.appId, 'wx1')
  assert.deepEqual(await wx.exchangeCode('c/1'), { openid: 'oX', unionid: 'unX' })
  assert.equal(calls[0], 'https://api.weixin.qq.com/sns/oauth2/access_token?appid=wx1&secret=s%26e%3Dc&code=c%2F1&grant_type=authorization_code')
  await assert.rejects(wx.exchangeCode('bad'), (e) => e.code === 50201 && /40029/.test(e.message))
  assert.deepEqual(await wx.exchangeCode('noun'), { openid: 'oX', unionid: null })
  await assert.rejects(wx.exchangeCode('boom'), (e) => e.code === 50201)
})

test('loadCredentials：JSON / base64 JSON / PEM+KEY_ID 三种形态；PEM 缺 KEY_ID 为 null', () => {
  const json = JSON.stringify({ private_key_id: 'kid1', private_key: PEM, env_id: 'env-1' })
  assert.deepEqual(loadCredentials({ TCB_CUSTOM_LOGIN_JSON: json }), { private_key_id: 'kid1', private_key: PEM, env_id: 'env-1' })
  assert.deepEqual(loadCredentials({ TCB_CUSTOM_LOGIN_JSON: b64(json) }), { private_key_id: 'kid1', private_key: PEM, env_id: 'env-1' })
  assert.deepEqual(loadCredentials({ TCB_CUSTOM_LOGIN_JSON: b64(PEM + '\n'), TCB_CUSTOM_LOGIN_KEY_ID: 'kid2' }), { private_key_id: 'kid2', private_key: PEM })
  assert.deepEqual(loadCredentials({ TCB_CUSTOM_LOGIN_JSON: PEM, TCB_CUSTOM_LOGIN_KEY_ID: 'kid2' }), { private_key_id: 'kid2', private_key: PEM })
  assert.equal(loadCredentials({ TCB_CUSTOM_LOGIN_JSON: b64(PEM) }), null, '只有 PEM 没有私钥 ID → 未配置')
  // 从 JSON 里手抄出来的 PEM：字面量 \n（两个字符）与 CRLF 都还原成换行
  const escaped = '-----BEGIN RSA PRIVATE KEY-----\nMIIB\\nQUJD\r\n-----END RSA PRIVATE KEY-----\\n'
  assert.equal(normalizePem(escaped), '-----BEGIN RSA PRIVATE KEY-----\nMIIB\nQUJD\n-----END RSA PRIVATE KEY-----')
  assert.equal(loadCredentials({ TCB_CUSTOM_LOGIN_JSON: b64(escaped), TCB_CUSTOM_LOGIN_KEY_ID: 'kid2' }).private_key, normalizePem(escaped))
  assert.equal(loadCredentials({ TCB_CUSTOM_LOGIN_JSON: JSON.stringify({ private_key_id: 'k', private_key: escaped }) }).private_key, normalizePem(escaped))
  assert.equal(loadCredentials({ TCB_CUSTOM_LOGIN_JSON: JSON.stringify({ private_key: PEM }) }), null)
  assert.equal(loadCredentials({}), null)
  assert.equal(loadCredentials({ TCB_CUSTOM_LOGIN_JSON: '{{env.CLOUDBASE_CUSTOM_LOGIN_JSON}}' }), null)
})

test('createTicketIssuer：懒初始化 node-sdk，一次 init，票据参数 refresh / expire', () => {
  assert.equal(createTicketIssuer({}, {}), null)
  const inits = []
  const tickets = []
  const sdk = {
    SYMBOL_CURRENT_ENV: Symbol('cur'),
    init(opts) {
      inits.push(opts)
      return { auth: () => ({ createTicket: (uid, o) => { tickets.push([uid, o]); return `${opts.credentials.private_key_id}/@@/jwt-${uid}` } }) }
    },
  }
  const env = { TCB_CUSTOM_LOGIN_JSON: b64(PEM), TCB_CUSTOM_LOGIN_KEY_ID: 'kid9', TCB_ENV: 'env-9' }
  const issuer = createTicketIssuer(env, sdk)
  assert.equal(issuer.createTicket('acc-1', 1000), 'kid9/@@/jwt-acc-1')
  assert.equal(issuer.createTicket('acc-2', 2000), 'kid9/@@/jwt-acc-2')
  assert.equal(inits.length, 1)
  assert.equal(inits[0].env, 'env-9')
  assert.deepEqual(inits[0].credentials, { private_key_id: 'kid9', private_key: PEM, env_id: 'env-9' })
  assert.deepEqual(tickets[0], ['acc-1', { refresh: TICKET_REFRESH_MS, expire: 1000 + TICKET_EXPIRE_MS }])
  assert.equal(TICKET_EXPIRE_MS, 30 * 24 * 60 * 60 * 1000)
  // 没有 TCB_ENV 时用 SYMBOL_CURRENT_ENV
  const issuer2 = createTicketIssuer({ TCB_CUSTOM_LOGIN_JSON: b64(PEM), TCB_CUSTOM_LOGIN_KEY_ID: 'kid9' }, sdk)
  issuer2.createTicket('acc-3')
  assert.equal(inits[1].env, sdk.SYMBOL_CURRENT_ENV)
})

test('createAuthApi.userMe：200 且有 sub 才算有效（手机号会话带回 phone）；401 / 网络错误 / 缺环境 → null', async () => {
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://env-9.api.tcloudbasegateway.com/auth/v1/user/me')
    const token = init.headers.Authorization.replace('Bearer ', '')
    if (token === 'good') return jsonRes(200, { sub: 'uid-1', name: 'x' })
    if (token === 'phone') return jsonRes(200, { sub: 'uid-2', phone_number: '+86 13800000001' })
    if (token === 'boom') throw new Error('timeout')
    return jsonRes(401, { error: 'unauthorized' })
  }
  const api = createAuthApi({ TCB_ENV: 'env-9' }, fetchImpl)
  assert.deepEqual(await api.userMe('good'), { sub: 'uid-1', phone: null })
  assert.deepEqual(await api.userMe('phone'), { sub: 'uid-2', phone: '+86 13800000001' })
  assert.equal(await api.userMe('bad'), null)
  assert.equal(await api.userMe('boom'), null)
  assert.equal(await api.userMe(''), null)
  assert.equal(await createAuthApi({}, fetchImpl).userMe('good'), null)
  assert.equal(createAuthApi({ TCB_ENV: 'env-9' }, null), null)
})
