/**
 * 查看 / 局部更新云函数环境变量（只改指定键，其余键原样保留）。
 *
 * 为什么需要它：`tcb fn deploy` / `tcb fn config update` 会用 cloudbaserc.json 的 envVariables 整体覆盖函数环境变量，
 * `{{env.KEY}}` 在本地 .env 缺该键时被替换成空串 —— 例如本地没有 CLOUDBASE_CUSTOM_LOGIN_JSON 时，
 * 一次部署就会把线上 user 函数的 TCB_CUSTOM_LOGIN_JSON 清空，微信 / Apple 登录全部 50201。
 * 本脚本直接调 SCF API：先 GetFunction 读出现有变量，再只替换 --set 指定的键，UpdateFunctionConfiguration 写回。
 *
 *   node scripts/ops/function-env.mjs user                                   # 列出变量（值脱敏；*_APP_ID 明文）
 *   node scripts/ops/function-env.mjs user --set WX_APP_ID,WX_APP_SECRET     # 预览：从 .env 取这些键的值
 *   node scripts/ops/function-env.mjs user --set WX_APP_ID,WX_APP_SECRET --apply
 *   node scripts/ops/function-env.mjs user --set TCB_CUSTOM_LOGIN_JSON=CLOUDBASE_CUSTOM_LOGIN_JSON --apply
 *                                                                           # 函数变量名 = .env 变量名
 *
 * 需要 .env 的 CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY；环境 ID 取 TARO_APP_CLOUD_ENV_ID，缺省用 cloudbaserc.json 的 envId；
 * 地域取 TCB_REGION，缺省 ap-shanghai。不打印任何 secret 值。
 */
import { createHash, createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeRegion, resolveEnvId } from '../lib/env-id.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function loadEnv (root = ROOT) {
  const out = {}
  const f = join(root, '.env')
  if (existsSync(f)) {
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
  return { ...out, ...process.env }
}

/** 值脱敏：AppID 类（公开）明文，其余只显示长度 */
export function mask (key, value) {
  if (!value) return '<empty>'
  if (/_APP_ID$|^APPLE_(TEAM_ID|KEY_ID|CLIENT_ID|BUNDLE_ID)$/.test(key)) return value
  return `<set, len ${value.length}>`
}

/** 解析 --set 'A,B=C'：函数变量 A 取 .env 的 A；函数变量 B 取 .env 的 C */
export function parseSet (spec) {
  return String(spec || '').split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const [fnKey, envKey] = s.split('=')
    return { fnKey, envKey: envKey || fnKey }
  })
}

/** 合并：保留原有顺序与未指定的键，指定键覆盖或追加 */
export function mergeVariables (current, updates) {
  const out = current.map(v => ({ Key: v.Key, Value: v.Value }))
  for (const [Key, Value] of Object.entries(updates)) {
    const hit = out.find(v => v.Key === Key)
    if (hit) hit.Value = Value
    else out.push({ Key, Value })
  }
  return out
}

function sha256 (s) { return createHash('sha256').update(s).digest('hex') }
function hmac (key, s) { return createHmac('sha256', key).update(s).digest() }

/** 腾讯云 API 3.0（TC3-HMAC-SHA256）最小实现 */
async function callScf ({ secretId, secretKey, region, action, payload }) {
  const host = 'scf.tencentcloudapi.com'
  const service = 'scf'
  const body = JSON.stringify(payload)
  const ts = Math.floor(Date.now() / 1000)
  const date = new Date(ts * 1000).toISOString().slice(0, 10)
  const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${host}\n\ncontent-type;host\n${sha256(body)}`
  const scope = `${date}/${service}/tc3_request`
  const toSign = `TC3-HMAC-SHA256\n${ts}\n${scope}\n${sha256(canonical)}`
  const kSigning = hmac(hmac(hmac(`TC3${secretKey}`, date), service), 'tc3_request')
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex')
  const res = await fetch(`https://${host}/`, {
    method: 'POST',
    headers: {
      Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
      'Content-Type': 'application/json; charset=utf-8',
      Host: host,
      'X-TC-Action': action,
      'X-TC-Version': '2018-04-16',
      'X-TC-Timestamp': String(ts),
      'X-TC-Region': region
    },
    body
  })
  const json = await res.json()
  const r = json.Response || {}
  if (r.Error) throw new Error(`${action} 失败：${r.Error.Code} ${r.Error.Message}`)
  return r
}

async function main () {
  const args = process.argv.slice(2)
  const name = args.find(a => !a.startsWith('--'))
  const setIdx = args.indexOf('--set')
  const updatesSpec = setIdx >= 0 ? parseSet(args[setIdx + 1]) : []
  const apply = args.includes('--apply')
  if (!name) throw new Error('用法：node scripts/ops/function-env.mjs <函数名> [--set KEY[,FN_KEY=ENV_KEY]] [--apply]')

  const env = loadEnv()
  const secretId = env.CLOUDBASE_SECRET_ID
  const secretKey = env.CLOUDBASE_SECRET_KEY
  if (!secretId || !secretKey) throw new Error('.env 缺少 CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY')
  let envId = env.TARO_APP_CLOUD_ENV_ID
  if (!envId) envId = resolveEnvId(JSON.parse(readFileSync(join(ROOT, 'cloudbaserc.json'), 'utf8')).envId, env)
  const region = normalizeRegion(env.TCB_REGION)
  const base = { secretId, secretKey, region }

  const fn = await callScf({ ...base, action: 'GetFunction', payload: { FunctionName: name, Namespace: envId } })
  const current = (fn.Environment && fn.Environment.Variables) || []
  console.log(`函数 ${envId}/${name}（${region}）当前环境变量：`)
  for (const v of current) console.log(`  ${v.Key} = ${mask(v.Key, v.Value)}`)
  if (!updatesSpec.length) return

  const updates = {}
  for (const { fnKey, envKey } of updatesSpec) {
    const value = env[envKey]
    if (!value) throw new Error(`.env 里 ${envKey} 为空，拒绝把 ${fnKey} 覆盖成空值`)
    updates[fnKey] = value
  }
  const merged = mergeVariables(current, updates)
  console.log(`\n将更新：`)
  for (const [k, v] of Object.entries(updates)) console.log(`  ${k} = ${mask(k, v)}`)
  if (!apply) {
    console.log('\n（预览模式，未写入；确认后加 --apply）')
    return
  }
  await callScf({ ...base, action: 'UpdateFunctionConfiguration', payload: { FunctionName: name, Namespace: envId, Environment: { Variables: merged } } })
  console.log('\n✓ 已写入。函数配置更新需数秒生效。')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`✗ ${e.message}`)
    process.exit(1)
  })
}
