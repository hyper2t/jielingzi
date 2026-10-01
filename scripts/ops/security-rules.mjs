/**
 * 安全规则（BE-RN-04 / BE-L01）：查看 / 写入「云函数安全规则」与账号层集合（account_links、account_merges）的数据库规则。
 * 控制台入口不好找（云开发平台 → 云函数 → 列表右上「权限控制」），这里直接走云开发 OpenAPI，不依赖控制台。
 *
 *   node scripts/ops/security-rules.mjs                 # 只读：打印当前云函数规则 + 各集合规则
 *   node scripts/ops/security-rules.mjs --apply         # 写入下面 FUNCTION_RULE / COLLECTION_RULES（写前打印旧规则，便于回滚）
 *   node scripts/ops/security-rules.mjs --apply --functions-rule '{"*":{"invoke":"auth != null"}}'   # 回滚 / 自定义
 *   node scripts/ops/security-rules.mjs --apply --skip-db                                             # 只改云函数规则
 *
 * 规则取值只允许 true / false / "auth != null" / "auth.loginType != 'ANONYMOUS' && auth != null"（平台限制，见
 * https://docs.cloudbase.net/cloud-function/security-rules）；规则只约束客户端调用（callFunction / HTTP API），
 * 管理端密钥、定时触发不受影响。
 * 需要 .env 中 CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY（与导入脚本相同）。接口：tcb 2018-06-08 的
 * DescribeSecurityRule / ModifySecurityRule（ResourceType=FUNCTION）与 DescribeSafeRule / ModifySafeRule（集合）。
 */
import { createHash, createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { fetchWithEnvProxy } from '../lib/fetch-proxy.mjs'
import { resolveEnvId } from '../lib/env-id.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 目标云函数规则：身份类函数要求已登录（Publishable Key / 匿名登录也算），其余一律拒绝。
 * TODO(business)：业务的公开读函数（同意前也要能看的内容）设为 { invoke: true }，并加入 src/services/cloud.rn.ts 的 PUBLIC_FUNCTIONS；
 * 业务的私有函数设为 { invoke: 'auth != null' }。
 */
export const FUNCTION_RULE = {
  user: { invoke: 'auth != null' },
  community: { invoke: 'auth != null' },
  moderation: { invoke: 'auth != null' },
  practice: { invoke: 'auth != null' },
  '*': { invoke: false },
}

/** 全部集合（cloudfunctions/_shared/collections.js）：只允许云函数（管理端）读写，客户端一律拒绝 */
const registry = createRequire(import.meta.url)('../../cloudfunctions/_shared/collections.js')
export const PRIVATE_RULE = registry.PRIVATE_RULE
export const COLLECTION_RULES = registry.collectionRules()

const ALLOWED_VALUES = new Set([true, false, 'auth != null', "auth.loginType != 'ANONYMOUS' && auth != null"])

/** 云函数规则的静态校验：必须有 "*"，每项只能是 { invoke: 允许的取值 } */
export function validateFunctionRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('规则必须是对象')
  if (!('*' in rule)) throw new Error('规则必须包含通配 "*"')
  for (const [name, cfg] of Object.entries(rule)) {
    if (!cfg || typeof cfg !== 'object' || !('invoke' in cfg)) throw new Error(`函数 ${name} 缺少 invoke`)
    const extra = Object.keys(cfg).filter((k) => k !== 'invoke')
    if (extra.length) throw new Error(`函数 ${name} 只支持 invoke，多出：${extra.join(',')}`)
    if (!ALLOWED_VALUES.has(cfg.invoke)) throw new Error(`函数 ${name} 的 invoke 取值不被平台支持：${JSON.stringify(cfg.invoke)}`)
  }
  return rule
}

function loadEnv() {
  const out = {}
  const f = join(ROOT, '.env')
  if (existsSync(f)) {
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
  // 与 ensure-collections / backup 一致：进程环境变量（CI）优先于 .env
  return { ...out, ...process.env }
}

function parseArgs(argv) {
  const opts = { apply: false, skipDb: false, functionsRule: null, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') opts.apply = true
    else if (a === '--skip-db') opts.skipDb = true
    else if (a === '--json') opts.json = true
    else if (a === '--functions-rule') opts.functionsRule = JSON.parse(argv[++i])
    else if (a.startsWith('--functions-rule=')) opts.functionsRule = JSON.parse(a.slice('--functions-rule='.length))
    else throw new Error(`未知参数：${a}`)
  }
  return opts
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const hmac = (key, s, enc) => createHmac('sha256', key).update(s, 'utf8').digest(enc)

/** 腾讯云 API TC3-HMAC-SHA256 签名调用（tcb / 2018-06-08），不依赖 SDK */
export function createTcbApi({ secretId, secretKey, region = 'ap-shanghai', fetchImpl = fetchWithEnvProxy }) {
  const host = 'tcb.tencentcloudapi.com'
  const service = 'tcb'
  const version = '2018-06-08'
  return async function call(action, params) {
    const payload = JSON.stringify(params)
    const timestamp = Math.floor(Date.now() / 1000)
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
    const signedHeaders = 'content-type;host;x-tc-action'
    const canonicalRequest = [
      'POST', '/', '',
      `content-type:application/json; charset=utf-8`, `host:${host}`, `x-tc-action:${action.toLowerCase()}`, '',
      signedHeaders, sha256(payload),
    ].join('\n')
    const scope = `${date}/${service}/tc3_request`
    const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), scope, sha256(canonicalRequest)].join('\n')
    const kDate = hmac(`TC3${secretKey}`, date)
    const kService = hmac(kDate, service)
    const kSigning = hmac(kService, 'tc3_request')
    const signature = hmac(kSigning, stringToSign, 'hex')
    const res = await fetchImpl(`https://${host}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Host: host,
        'X-TC-Action': action,
        'X-TC-Version': version,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Region': region,
        Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      body: payload,
    })
    const body = await res.json().catch(() => ({}))
    const r = body.Response || {}
    if (r.Error) throw new Error(`${action} 失败：${r.Error.Code} ${r.Error.Message}（RequestId ${r.RequestId}）`)
    return r
  }
}

function parseRule(raw) {
  if (raw == null || raw === '') return null
  try { return JSON.parse(raw) } catch { return raw }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const env = loadEnv()
  const rc = JSON.parse(readFileSync(join(ROOT, 'cloudbaserc.json'), 'utf8'))
  if (!env.CLOUDBASE_SECRET_ID || !env.CLOUDBASE_SECRET_KEY) throw new Error('.env 缺少 CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY')
  const api = createTcbApi({ secretId: env.CLOUDBASE_SECRET_ID, secretKey: env.CLOUDBASE_SECRET_KEY, region: env.TARO_APP_CLOUD_REGION || 'ap-shanghai' })
  // cloudbaserc.json 的 envId 是 tcb CLI 模板（{{env.TARO_APP_CLOUD_ENV_ID}}），直接用会把模板原文当环境 ID
  const EnvId = resolveEnvId(rc.envId, env)
  const out = { envId: EnvId }

  const fnBefore = await api('DescribeSecurityRule', { EnvId, ResourceType: 'FUNCTION' })
  out.functions = { aclTag: fnBefore.AclTag, rule: parseRule(fnBefore.Rule) }

  if (!opts.skipDb) {
    out.collections = {}
    for (const name of Object.keys(COLLECTION_RULES)) {
      try {
        const before = await api('DescribeSafeRule', { EnvId, CollectionName: name })
        out.collections[name] = { aclTag: before.AclTag, rule: parseRule(before.Rule) }
      } catch (e) {
        // 集合还不存在时 Describe 会失败；ModifySafeRule 仍可写（规则先于集合生效）
        out.collections[name] = { error: e.message, hint: '集合可能还不存在（首次写入时由云函数自动创建）' }
      }
    }
  }

  if (opts.apply) {
    const target = validateFunctionRule(opts.functionsRule || FUNCTION_RULE)
    console.log('[security-rules] 云函数规则 写入前：', JSON.stringify(out.functions))
    await api('ModifySecurityRule', { EnvId, ResourceType: 'FUNCTION', AclTag: 'CUSTOM', Rule: JSON.stringify(target) })
    const fnAfter = await api('DescribeSecurityRule', { EnvId, ResourceType: 'FUNCTION' })
    out.functions = { before: out.functions, after: { aclTag: fnAfter.AclTag, rule: parseRule(fnAfter.Rule) } }
    if (!opts.skipDb) {
      for (const [name, rule] of Object.entries(COLLECTION_RULES)) {
        console.log(`[security-rules] 集合 ${name} 写入前：`, JSON.stringify(out.collections[name]))
        try {
          await api('ModifySafeRule', { EnvId, CollectionName: name, AclTag: 'CUSTOM', Rule: JSON.stringify(rule) })
          const after = await api('DescribeSafeRule', { EnvId, CollectionName: name })
          out.collections[name] = { before: out.collections[name], after: { aclTag: after.AclTag, rule: parseRule(after.Rule) } }
        } catch (e) {
          out.collections[name] = { before: out.collections[name], error: e.message }
        }
      }
    }
  }

  console.log(opts.json ? JSON.stringify(out) : JSON.stringify(out, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('[security-rules] 失败：', e.message || e)
    process.exit(1)
  })
}
