import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { COLLECTION_RULES, FUNCTION_RULE, createTcbApi, validateFunctionRule } from './security-rules.mjs'
import { normalizeRegion, resolveEnvId } from '../lib/env-id.mjs'

test('内置规则本身合法：业务函数需登录，其余拒绝；全部集合只允许云函数读写', () => {
  assert.deepEqual(validateFunctionRule(FUNCTION_RULE), FUNCTION_RULE)
  for (const fn of ['user', 'community', 'moderation', 'practice']) assert.equal(FUNCTION_RULE[fn].invoke, 'auth != null')
  assert.equal(FUNCTION_RULE['*'].invoke, false)
  const names = Object.keys(COLLECTION_RULES)
  for (const n of ['users', 'account_links', 'account_merges', 'profiles', 'topics', 'replies', 'reports', 'rate_limits']) assert.ok(names.includes(n), n)
  for (const rule of Object.values(COLLECTION_RULES)) assert.deepEqual(rule, { read: false, write: false })
})

test('cloudbaserc.json 注册的函数与 FUNCTION_RULE 一致', async () => {
  const { readFileSync } = await import('node:fs')
  const rc = JSON.parse(readFileSync(new URL('../../cloudbaserc.json', import.meta.url), 'utf8'))
  const fns = rc.functions.map((f) => f.name).sort()
  assert.deepEqual(fns, Object.keys(FUNCTION_RULE).filter((k) => k !== '*').sort())
})

test('validateFunctionRule 拒绝平台不支持的写法', () => {
  assert.throws(() => validateFunctionRule({ me: { invoke: true } }), /通配/)
  assert.throws(() => validateFunctionRule({ '*': { read: true } }), /invoke/)
  assert.throws(() => validateFunctionRule({ '*': { invoke: 'auth.uid != null' } }), /不被平台支持/)
  assert.throws(() => validateFunctionRule({ '*': { invoke: true, extra: 1 } }), /只支持 invoke/)
  assert.throws(() => validateFunctionRule([]), /对象/)
})

test('createTcbApi：TC3 签名头、动作头与错误映射', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (JSON.parse(init.body).EnvId === 'bad') return { json: async () => ({ Response: { Error: { Code: 'AuthFailure', Message: 'nope' }, RequestId: 'r1' } }) }
    return { json: async () => ({ Response: { AclTag: 'CUSTOM', Rule: '{"*":{"invoke":true}}', RequestId: 'r2' } }) }
  }
  const api = createTcbApi({ secretId: 'AKIDtest', secretKey: 'secret', region: 'ap-shanghai', fetchImpl })
  const r = await api('DescribeSecurityRule', { EnvId: 'env-1', ResourceType: 'FUNCTION' })
  assert.equal(r.AclTag, 'CUSTOM')
  const { url, init } = calls[0]
  assert.equal(url, 'https://tcb.tencentcloudapi.com')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers['X-TC-Action'], 'DescribeSecurityRule')
  assert.equal(init.headers['X-TC-Version'], '2018-06-08')
  assert.equal(init.headers['X-TC-Region'], 'ap-shanghai')
  assert.match(init.headers['X-TC-Timestamp'], /^\d{10}$/)
  assert.match(
    init.headers.Authorization,
    /^TC3-HMAC-SHA256 Credential=AKIDtest\/\d{4}-\d{2}-\d{2}\/tcb\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/,
  )
  assert.deepEqual(JSON.parse(init.body), { EnvId: 'env-1', ResourceType: 'FUNCTION' })
  await assert.rejects(api('DescribeSecurityRule', { EnvId: 'bad' }), /AuthFailure nope（RequestId r1）/)
})

test('resolveEnvId：cloudbaserc.json 的 {{env.X}} 模板替换为 .env 变量；字面量原样；缺失时报错提示变量名', () => {
  const rc = JSON.parse(readFileSync(new URL('../../cloudbaserc.json', import.meta.url), 'utf8'))
  assert.match(rc.envId, /\{\{\s*env\.TARO_APP_CLOUD_ENV_ID\s*\}\}/)
  assert.equal(resolveEnvId(rc.envId, { TARO_APP_CLOUD_ENV_ID: ' env-1a2b ' }), 'env-1a2b')
  assert.equal(resolveEnvId('{{ env.MY_ENV }}', { MY_ENV: 'env-x' }), 'env-x')
  assert.equal(resolveEnvId('env-literal', {}), 'env-literal')
  assert.throws(() => resolveEnvId(rc.envId, {}), /TARO_APP_CLOUD_ENV_ID/)
  assert.throws(() => resolveEnvId('', { TARO_APP_CLOUD_ENV_ID: 'x' }), /TARO_APP_CLOUD_ENV_ID/)
  assert.throws(() => resolveEnvId('{{env.TARO_APP_CLOUD_ENV_ID}}', { TARO_APP_CLOUD_ENV_ID: '{{oops}}' }), /环境 ID/)
})

test('normalizeRegion：ap-* 原样；cn-<城市> 误填映射为 ap-<城市>；空 / 非法回落 ap-shanghai', () => {
  assert.equal(normalizeRegion('ap-guangzhou'), 'ap-guangzhou')
  assert.equal(normalizeRegion(' AP-Singapore '), 'ap-singapore')
  assert.equal(normalizeRegion('cn-shanghai'), 'ap-shanghai')
  assert.equal(normalizeRegion(''), 'ap-shanghai')
  assert.equal(normalizeRegion(undefined), 'ap-shanghai')
  assert.equal(normalizeRegion('shanghai'), 'ap-shanghai')
})
