/**
 * 建索引（OPS，docs/ops/collections.md §3）：索引清单的唯一来源是 cloudfunctions/_shared/collections.js 的 indexes。
 *
 *   node scripts/ops/ensure-indexes.mjs            # 只检查：列出每个集合缺哪些索引 / 有没有冲突
 *   node scripts/ops/ensure-indexes.mjs --apply    # 创建缺失的索引（幂等；不删除任何已有索引）
 *   node scripts/ops/ensure-indexes.mjs --apply --fix-unique
 *       # 另外处理「同字段已有非唯一索引、期望唯一」的冲突（如平台自动建的 _openid_1）：**只在集合为空时**删旧建新
 *
 * 走云开发 OpenAPI（tcb 2018-06-08）：DescribeEnvs 取默认数据库实例 → DescribeTable 读现有索引 → UpdateTable { CreateIndexes } 补齐。
 * 按「字段 + 方向」比对已有索引（控制台建过的同构索引不会重复建）；唯一性不一致的只报告不处理（需人工删旧建新）。
 * 平台 API 只支持普通 / 唯一 / 稀疏索引，不支持 TTL：expireAt 上建的是普通索引，过期清理见 §3 说明。
 * 需要 .env：TARO_APP_CLOUD_ENV_ID、CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY（地域取 TCB_REGION / TARO_APP_CLOUD_REGION，cn-* 自动映射为 ap-*）。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTcbApi } from './security-rules.mjs'
import { normalizeRegion, resolveEnvId } from '../lib/env-id.mjs'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const { indexDefs } = require('../../cloudfunctions/_shared/collections.js')

const keySig = (keys) => keys.map(([name, dir]) => `${name}:${String(dir)}`).join(',')

/** 平台返回的索引 → { name, sig, unique } */
export function normalizeExisting (indexes) {
  return (indexes || []).map((i) => ({
    name: i.Name,
    sig: keySig((i.Keys || []).map((k) => [k.Name, k.Direction])),
    unique: i.Unique === true || i.Unique === 'true'
  }))
}

/**
 * 对比期望与现有索引。
 * @returns {{ missing: any[], present: string[], conflicts: Array<{ name: string, reason: string, existing?: string, fixable?: boolean, want?: any }> }}
 */
export function planIndexes (wanted, existing) {
  const missing = []
  const present = []
  const conflicts = []
  for (const w of wanted) {
    const sig = keySig(w.keys)
    const same = existing.find((e) => e.sig === sig)
    if (!same) {
      if (existing.some((e) => e.name === w.name)) conflicts.push({ name: w.name, reason: '同名索引的字段不同' })
      else missing.push(w)
    } else if (same.unique !== !!w.unique) {
      // 同字段的非唯一索引 → 期望唯一：可在集合为空时删旧建新（--fix-unique）；反过来（唯一 → 非唯一）不自动处理
      conflicts.push({ name: w.name, reason: `已有索引 ${same.name} 唯一性为 ${same.unique}，期望 ${!!w.unique}`, existing: same.name, fixable: !same.unique && !!w.unique, want: w })
    } else {
      present.push(w.name)
    }
  }
  return { missing, present, conflicts }
}

/** 期望索引 → UpdateTable 的 CreateIndex */
export function toCreateIndex (w) {
  return {
    IndexName: w.name,
    MgoKeySchema: {
      MgoIndexKeys: w.keys.map(([name, dir]) => ({ Name: name, Direction: String(dir) })),
      MgoIsUnique: !!w.unique
    }
  }
}

function loadEnv () {
  const out = {}
  const f = join(ROOT, '.env')
  if (existsSync(f)) {
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
  return { ...out, ...process.env }
}

async function main () {
  const apply = process.argv.includes('--apply')
  const fixUnique = process.argv.includes('--fix-unique')
  const env = loadEnv()
  if (!env.CLOUDBASE_SECRET_ID || !env.CLOUDBASE_SECRET_KEY) throw new Error('.env 缺少 CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY')
  const rc = JSON.parse(readFileSync(join(ROOT, 'cloudbaserc.json'), 'utf8'))
  const EnvId = resolveEnvId(rc.envId, env)
  const api = createTcbApi({ secretId: env.CLOUDBASE_SECRET_ID, secretKey: env.CLOUDBASE_SECRET_KEY, region: normalizeRegion(env.TCB_REGION || env.TARO_APP_CLOUD_REGION) })
  const envs = await api('DescribeEnvs', { EnvId })
  const dbInstance = envs.EnvList && envs.EnvList[0] && envs.EnvList[0].Databases && envs.EnvList[0].Databases[0] && envs.EnvList[0].Databases[0].InstanceId
  if (!dbInstance) throw new Error('DescribeEnvs 没有返回数据库实例')
  const MongoConnector = { DatabaseName: dbInstance, InstanceId: 'flexdb' }
  // --fix-unique 只在集合为空时删旧建新：用 node-sdk 数文档
  let db = null
  const countDocs = async (name) => {
    if (!db) {
      const tcb = require('@cloudbase/node-sdk')
      db = tcb.init({ env: EnvId, secretId: env.CLOUDBASE_SECRET_ID, secretKey: env.CLOUDBASE_SECRET_KEY }).database()
    }
    return (await db.collection(name).count()).total
  }

  const byCollection = new Map()
  for (const d of indexDefs()) byCollection.set(d.collection, [...(byCollection.get(d.collection) || []), d])
  const summary = { created: 0, present: 0, conflicts: 0 }
  for (const [TableName, wanted] of byCollection) {
    const table = await api('DescribeTable', { EnvId, MongoConnector, TableName })
    const plan = planIndexes(wanted, normalizeExisting(table.Indexes))
    summary.present += plan.present.length
    for (const c of plan.conflicts) {
      if (apply && fixUnique && c.fixable) {
        const n = await countDocs(TableName)
        if (n === 0) {
          await api('UpdateTable', { EnvId, MongoConnector, TableName, DropIndexes: [{ IndexName: c.existing }] })
          console.log(`~ ${TableName}：集合为空，已删除非唯一索引 ${c.existing}，改建唯一索引 ${c.name}`)
          plan.missing.push(c.want)
          summary.replaced = (summary.replaced || 0) + 1
          continue
        }
        console.log(`! ${TableName}.${c.name}：集合有 ${n} 条数据，不自动删旧建新（需先确认没有重复再人工处理）`)
      } else {
        console.log(`! ${TableName}.${c.name}：${c.reason}（${c.fixable ? '集合为空时可加 --fix-unique 处理' : '需人工处理'}）`)
      }
      summary.conflicts++
    }
    if (!plan.missing.length) {
      console.log(`✓ ${TableName}：${plan.present.join(', ') || '（无）'}`)
      continue
    }
    console.log(`${apply ? '+' : '-'} ${TableName}：缺 ${plan.missing.map((m) => `${m.name}${m.unique ? '（唯一）' : ''}`).join(', ')}`)
    if (apply) {
      // 平台要求创建与删除分开调用；一次传多个 CreateIndex
      await api('UpdateTable', { EnvId, MongoConnector, TableName, CreateIndexes: plan.missing.map(toCreateIndex) })
      summary.created += plan.missing.length
    }
  }
  console.log(JSON.stringify({ apply, ...summary }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('[ensure-indexes] 失败：', e.message || e)
    process.exit(1)
  })
}
