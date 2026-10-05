/**
 * BE-22 数据库备份 / 还原（线上唯一环境，开发与生产共用）。
 *
 *   node scripts/ops/backup.ts export                         # 只读：全量导出 COLLECTIONS 中的集合 → backups/full/<时间>/
 *   node scripts/ops/backup.ts verify  --dir <备份目录>        # 只读：校验 manifest 与各文件条数、_id 唯一
 *   node scripts/ops/backup.ts restore --dir <备份目录> --collection users [--to users_restore_drill] [--yes]
 *       默认演练：还原到 `<集合>_restore_drill`（新集合），不指定 --yes 只打印计划不写入
 *       还原到正式集合必须 --to <正式名> --overwrite --yes，且会先自动导出该集合当前数据
 *
 * 需要 .env 中 CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY（与导入脚本相同），依赖 @cloudbase/node-sdk。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { resolveEnvId } from '../lib/env-id.mjs'

/** 备份范围 = 集合登记表（cloudfunctions/_shared/collections.js）的全部集合；新增集合只改登记表 */
const { COLLECTION_NAMES } = createRequire(import.meta.url)('../../cloudfunctions/_shared/collections.js') as { COLLECTION_NAMES: string[] }
export const COLLECTIONS: readonly string[] = Object.freeze([...COLLECTION_NAMES])
export const DRILL_SUFFIX = '_restore_drill'
const PAGE = 1000

export type Doc = Record<string, unknown> & { _id: string }

export interface BackupStore {
  list (collection: string, skip: number, limit: number): Promise<Doc[]>
  exists (collection: string): Promise<boolean>
  create (collection: string): Promise<void>
  set (collection: string, doc: Doc): Promise<void>
}

export interface Manifest {
  envId: string
  exportedAt: string
  collections: Record<string, number>
}

export function stamp (ts: number): string {
  return new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

export async function dumpCollection (store: BackupStore, c: string): Promise<Doc[]> {
  if (!(await store.exists(c))) return []
  const out: Doc[] = []
  for (let skip = 0; ; skip += PAGE) {
    const page = await store.list(c, skip, PAGE)
    out.push(...page)
    if (page.length < PAGE) return out
  }
}

export async function exportAll (store: BackupStore, o: { dir: string, envId: string, now?: number, collections?: readonly string[], log?: (s: string) => void }): Promise<{ dir: string, manifest: Manifest }> {
  const log = o.log ?? (() => {})
  const at = o.now ?? Date.now()
  const dir = join(o.dir, stamp(at))
  mkdirSync(dir, { recursive: true })
  const manifest: Manifest = { envId: o.envId, exportedAt: new Date(at).toISOString(), collections: {} }
  for (const c of o.collections ?? COLLECTIONS) {
    const docs = await dumpCollection(store, c)
    writeFileSync(join(dir, `${c}.json`), JSON.stringify(docs, null, 2))
    manifest.collections[c] = docs.length
    log(`导出 ${c}：${docs.length} 条`)
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return { dir, manifest }
}

export function readBackup (dir: string, c: string): Doc[] {
  const f = join(dir, `${c}.json`)
  if (!existsSync(f)) throw new Error(`备份中没有 ${c}.json`)
  const docs = JSON.parse(readFileSync(f, 'utf8'))
  if (!Array.isArray(docs)) throw new Error(`${c}.json 不是数组`)
  return docs
}

export function verifyBackup (dir: string): { ok: boolean, problems: string[], manifest: Manifest } {
  const manifest: Manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  const problems: string[] = []
  for (const [c, n] of Object.entries(manifest.collections)) {
    try {
      const docs = readBackup(dir, c)
      if (docs.length !== n) problems.push(`${c}：manifest ${n} 条，文件 ${docs.length} 条`)
      const ids = new Set<string>()
      for (const d of docs) {
        if (!d || typeof d._id !== 'string' || !d._id) problems.push(`${c}：存在缺少 _id 的文档`)
        else if (ids.has(d._id)) problems.push(`${c}：_id 重复 ${d._id}`)
        else ids.add(d._id)
      }
    } catch (e) {
      problems.push((e as Error).message)
    }
  }
  return { ok: problems.length === 0, problems, manifest }
}

export interface RestorePlan {
  collection: string
  target: string
  docs: number
  createTarget: boolean
  isLive: boolean
}

export async function planRestore (store: BackupStore, o: { dir: string, collection: string, to?: string, overwrite?: boolean }): Promise<RestorePlan> {
  if (!(COLLECTIONS as readonly string[]).includes(o.collection)) throw new Error(`未知集合 ${o.collection}`)
  const target = o.to ?? `${o.collection}${DRILL_SUFFIX}`
  const isLive = (COLLECTIONS as readonly string[]).includes(target)
  if (isLive && !o.overwrite) throw new Error(`目标 ${target} 是正式集合：演练请用默认目标；确需覆盖须加 --overwrite`)
  const docs = readBackup(o.dir, o.collection)
  const exists = await store.exists(target)
  if (!isLive && exists && (await store.list(target, 0, 1)).length) throw new Error(`演练目标 ${target} 已有数据：请换一个 --to 名称或先在控制台清空`)
  return { collection: o.collection, target, docs: docs.length, createTarget: !exists, isLive }
}

/** 按 _id set（幂等，可重复执行）；覆盖正式集合前先导出其当前数据 */
export async function restore (store: BackupStore, plan: RestorePlan, o: { dir: string, backupDir: string, envId: string, now?: number, log?: (s: string) => void }): Promise<{ written: number, preBackup?: string }> {
  const log = o.log ?? (() => {})
  let preBackup: string | undefined
  if (plan.isLive) {
    const r = await exportAll(store, { dir: o.backupDir, envId: o.envId, now: o.now, collections: [plan.target], log })
    preBackup = r.dir
    log(`覆盖前已备份 ${plan.target} → ${preBackup}`)
  }
  if (plan.createTarget) {
    await store.create(plan.target)
    log(`创建集合 ${plan.target}`)
  }
  const docs = readBackup(o.dir, plan.collection)
  for (const d of docs) await store.set(plan.target, d)
  log(`写入 ${plan.target}：${docs.length} 条`)
  return { written: docs.length, preBackup }
}

/** 还原后逐条比对（演练验收） */
export async function compareRestore (store: BackupStore, dir: string, collection: string, target: string): Promise<{ ok: boolean, missing: string[], diff: string[] }> {
  const want = readBackup(dir, collection)
  const got = new Map((await dumpCollection(store, target)).map(d => [d._id, d]))
  const missing: string[] = []
  const diff: string[] = []
  for (const d of want) {
    const g = got.get(d._id)
    if (!g) missing.push(d._id)
    else if (stable(g) !== stable(d)) diff.push(d._id)
  }
  return { ok: !missing.length && !diff.length && got.size === want.length, missing, diff }
}

function stable (v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(',')}}`
  return JSON.stringify(v)
}

export function memoryStore (seed: Record<string, Doc[]> = {}): BackupStore & { data: Map<string, Map<string, Doc>> } {
  const data = new Map<string, Map<string, Doc>>()
  for (const [c, docs] of Object.entries(seed)) data.set(c, new Map(docs.map(d => [d._id, structuredClone(d)])))
  return {
    data,
    async list (c, skip, limit) { return Array.from(data.get(c)?.values() ?? []).slice(skip, skip + limit).map(d => structuredClone(d)) },
    async exists (c) { return data.has(c) },
    async create (c) { if (!data.has(c)) data.set(c, new Map()) },
    async set (c, d) {
      if (!data.has(c)) throw new Error(`集合不存在 ${c}`)
      data.get(c)!.set(d._id, structuredClone(d))
    }
  }
}

// ---------- CLI ----------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function loadEnv (): Record<string, string> {
  const out: Record<string, string> = {}
  const f = join(ROOT, '.env')
  if (existsSync(f)) {
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
  }
  return { ...out, ...(process.env as Record<string, string>) }
}

async function cloudStore (): Promise<{ store: BackupStore, envId: string }> {
  const env = loadEnv()
  const tcb = (await import('@cloudbase/node-sdk')).default as any
  const rc = JSON.parse(readFileSync(join(ROOT, 'cloudbaserc.json'), 'utf8'))
  if (!env.CLOUDBASE_SECRET_ID || !env.CLOUDBASE_SECRET_KEY) throw new Error('.env 缺少 CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY')
  // cloudbaserc.json 的 envId 是 tcb CLI 模板（{{env.TARO_APP_CLOUD_ENV_ID}}），需替换成真实环境 ID
  const envId = resolveEnvId(rc.envId, env)
  const db = tcb.init({ env: envId, secretId: env.CLOUDBASE_SECRET_ID, secretKey: env.CLOUDBASE_SECRET_KEY }).database()
  const notExist = (e: any) => /not.?exist|DATABASE_COLLECTION_NOT_EXIST/i.test(String(e?.code ?? '') + String(e?.message ?? ''))
  return {
    envId,
    store: {
      async list (c, skip, limit) { return (await db.collection(c).skip(skip).limit(limit).get()).data },
      async exists (c) {
        try { await db.collection(c).limit(1).get(); return true } catch (e) { if (notExist(e)) return false; throw e }
      },
      async create (c) { await db.createCollection(c) },
      async set (c, d) { const { _id, ...rest } = d; await db.collection(c).doc(_id).set(rest) }
    }
  }
}

function arg (argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

async function main (argv: string[]) {
  const cmd = argv[0]
  const log = (s: string) => console.log(s)
  const backupDir = join(ROOT, 'backups', 'full')
  if (cmd === 'verify') {
    const r = verifyBackup(resolve(arg(argv, 'dir')!))
    console.log(r.ok ? `校验通过：${JSON.stringify(r.manifest.collections)}` : `校验失败：\n${r.problems.join('\n')}`)
    process.exitCode = r.ok ? 0 : 1
    return
  }
  const { store, envId } = await cloudStore()
  if (cmd === 'export') {
    const r = await exportAll(store, { dir: backupDir, envId, log })
    console.log(`完成：${r.dir}`)
  } else if (cmd === 'restore') {
    const dir = resolve(arg(argv, 'dir')!)
    const plan = await planRestore(store, { dir, collection: arg(argv, 'collection')!, to: arg(argv, 'to'), overwrite: argv.includes('--overwrite') })
    console.log(`计划：${plan.collection}（${plan.docs} 条）→ ${plan.target}${plan.createTarget ? '（新建集合）' : ''}${plan.isLive ? '【正式集合，将先备份再覆盖】' : ''}`)
    if (!argv.includes('--yes')) { console.log('未加 --yes：只打印计划，未写入'); return }
    await restore(store, plan, { dir, backupDir, envId, log })
    const cmp = await compareRestore(store, dir, plan.collection, plan.target)
    console.log(cmp.ok ? '比对通过：还原数据与备份一致' : `比对失败：缺 ${cmp.missing.length}，不一致 ${cmp.diff.length}`)
    process.exitCode = cmp.ok ? 0 : 1
  } else {
    console.log('用法：backup.ts export | verify --dir <目录> | restore --dir <目录> --collection <集合> [--to <目标>] [--overwrite] [--yes]')
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(e => { console.error((e as Error).message); process.exitCode = 1 })
}
