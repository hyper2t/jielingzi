/**
 * BE-22 用量检查（只读）：解析 `tcb env usage --json`，输出按模块的用量 / 资源点报表与 70% 预警。
 *
 *   node scripts/ops/usage.ts                      # 调 tcb CLI 实时查询
 *   node scripts/ops/usage.ts --file usage.json    # 解析已保存的 JSON
 *   选项：--quota 40000（资源点额度，个人版）--warn 70 --critical 90 --json
 *
 * 退出码：0 正常，2 达到预警线（≥warn），3 达到严重线（≥critical），1 执行失败 —— 可接入定时任务。
 * 个人版按资源点计费，CLI 不返回各模块免费上限，因此预警以「资源点消耗占额度」为主指标（03-backend §6）；
 * 另按本周期日均消耗推算周期末用量，推算超额也会预警。
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 默认取环境变量 TARO_APP_CLOUD_ENV_ID（可用 --env 覆盖） */
export const DEFAULT_ENV = process.env.TARO_APP_CLOUD_ENV_ID || ''
export const DEFAULT_QUOTA = 40000

export interface MetricRow {
  resource: string
  metric: string
  unit: string
  value: number
  credits: number
}

export interface UsageReport {
  envId: string
  cycle: { start: string, end: string, elapsedDays: number, totalDays: number }
  quota: number
  used: number
  percent: number
  projected: number
  projectedPercent: number
  level: 'ok' | 'warn' | 'critical'
  rows: MetricRow[]
  /** 按天资源点合计（最近在后） */
  daily: Array<{ date: string, credits: number }>
}

const DAY = 86400000
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d

/** CLI 输出前有登录提示等非 JSON 行：取第一个 { 到最后一个 } */
export function extractJson (text: string): any {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b < a) throw new Error('输出中没有 JSON')
  return JSON.parse(text.slice(a, b + 1))
}

export function parseCycle (text: string): { start: string, end: string } | null {
  const m = /billing cycle:\s*(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/i.exec(text)
  return m ? { start: m[1], end: m[2] } : null
}

export interface BuildOptions {
  quota?: number
  warn?: number
  critical?: number
  now?: number
  cycle?: { start: string, end: string } | null
}

export function buildReport (json: any, o: BuildOptions = {}): UsageReport {
  const quota = o.quota ?? DEFAULT_QUOTA
  const warn = o.warn ?? 70
  const critical = o.critical ?? 90
  const usages: any[] = json?.data?.Usages ?? json?.Usages ?? []
  const u = usages[0] ?? {}
  const rows: MetricRow[] = []
  const daily = new Map<string, number>()
  for (const m of u.MetricUsageDetail ?? []) {
    rows.push({ resource: String(m.ResourceType ?? ''), metric: String(m.MetricName ?? ''), unit: String(m.Unit ?? ''), value: Number(m.Value ?? 0), credits: Number(m.CreditsValue ?? 0) })
    for (const d of m.ValueDetailList ?? []) {
      const date = String(d.CalcTime ?? '').slice(0, 10)
      if (date) daily.set(date, (daily.get(date) ?? 0) + Number(d.CreditsValue ?? 0))
    }
  }
  rows.sort((a, b) => b.credits - a.credits || a.resource.localeCompare(b.resource))
  const used = Number(u.CreditsValue ?? rows.reduce((s, r) => s + r.credits, 0))
  const now = o.now ?? Date.now()
  const cycle = o.cycle ?? null
  let elapsedDays = 0
  let totalDays = 0
  if (cycle) {
    const start = Date.parse(`${cycle.start}T00:00:00+08:00`)
    const end = Date.parse(`${cycle.end}T00:00:00+08:00`)
    totalDays = Math.max(1, Math.round((end - start) / DAY))
    elapsedDays = Math.min(totalDays, Math.max(1, Math.ceil((now - start) / DAY)))
  }
  const projected = cycle ? used / elapsedDays * totalDays : used
  const percent = quota > 0 ? used / quota * 100 : 0
  const projectedPercent = quota > 0 ? projected / quota * 100 : 0
  const level = percent >= critical ? 'critical' : (percent >= warn || projectedPercent >= 100) ? 'warn' : 'ok'
  return {
    envId: String(u.EnvId ?? ''),
    cycle: { start: cycle?.start ?? '', end: cycle?.end ?? '', elapsedDays, totalDays },
    quota,
    used: round(used),
    percent: round(percent),
    projected: round(projected),
    projectedPercent: round(projectedPercent),
    level,
    rows,
    daily: Array.from(daily.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([date, credits]) => ({ date, credits: round(credits) }))
  }
}

const LEVEL_TEXT = { ok: '正常', warn: '⚠ 预警', critical: '✖ 严重' } as const

export function formatReport (r: UsageReport): string {
  const lines: string[] = []
  lines.push(`环境 ${r.envId}｜周期 ${r.cycle.start || '?'} ~ ${r.cycle.end || '?'}（第 ${r.cycle.elapsedDays}/${r.cycle.totalDays} 天）`)
  lines.push(`资源点 ${r.used} / ${r.quota}（${r.percent}%）｜按日均推算周期末 ${r.projected}（${r.projectedPercent}%）｜${LEVEL_TEXT[r.level]}`)
  lines.push('')
  lines.push('模块       指标                     用量            资源点')
  for (const x of r.rows) {
    lines.push(`${x.resource.padEnd(10)} ${x.metric.padEnd(24)} ${`${round(x.value)} ${x.unit}`.padEnd(15)} ${x.credits}`)
  }
  if (r.daily.length) {
    lines.push('')
    lines.push('按天资源点：' + r.daily.map(d => `${d.date.slice(5)} ${d.credits}`).join('，'))
  }
  if (r.level !== 'ok') {
    lines.push('')
    lines.push('处理：查看上表资源点最高的模块；CDN 流量高 → 核对音频码率 / 缓存命中；数据库读高 → 核对首页缓存与分页；见 docs/ops/backup.md §预警处理')
  }
  return lines.join('\n')
}

function arg (argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

function main (argv: string[]) {
  const file = arg(argv, 'file')
  const env = arg(argv, 'env') ?? DEFAULT_ENV
  let text: string
  if (file) {
    text = readFileSync(file, 'utf8')
  } else {
    if (!/^[\w-]+$/.test(env)) throw new Error(`环境 ID 不合法：${env}`)
    text = execSync(`tcb env usage -e ${env} --json`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  }
  const report = buildReport(extractJson(text), {
    quota: Number(arg(argv, 'quota') ?? DEFAULT_QUOTA),
    warn: Number(arg(argv, 'warn') ?? 70),
    critical: Number(arg(argv, 'critical') ?? 90),
    cycle: parseCycle(text)
  })
  console.log(argv.includes('--json') ? JSON.stringify(report, null, 2) : formatReport(report))
  process.exitCode = report.level === 'critical' ? 3 : report.level === 'warn' ? 2 : 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2))
  } catch (e) {
    console.error('用量查询失败：', (e as Error).message)
    process.exitCode = 1
  }
}
