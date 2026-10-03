/**
 * 每日一题录题与巡检（OPS-M6-01，PRD W3）。**默认只预览，加 --apply 才写库**。
 *
 *   node scripts/ops/daily-prompt.mjs set --date 2026-10-05 --text "今天的题目？" [--apply]
 *   node scripts/ops/daily-prompt.mjs set --from-file scripts/ops/daily-prompt.seed.json [--apply]   # 批量，整批校验通过才写
 *   node scripts/ops/daily-prompt.mjs list [--from 2026-10-03] [--days 14]                            # 只读
 *   node scripts/ops/daily-prompt.mjs close --date 2026-10-05 [--apply]                                # 下架当日题目
 *   node scripts/ops/daily-prompt.mjs audit [--from 2026-10-01] [--days 30]                            # 只读体检
 *
 * 规则不另写一套：题目长度取 `PROMPT_RULES.textMax`、归日取 `cnDate()`（北京时间），
 * 与 `cloudfunctions/practice/service.js` 的 `todayPrompt`（`where({ date, status: 'ok' }).limit(1)`）同一口径。
 * `set` 只改正文，**不会把已 close 的日子悄悄放出来**（要重开必须显式加 `--reopen`）。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { openDb, runMain } from '../lib/ops-db.mjs'

const require = createRequire(import.meta.url)
const { PROMPT_RULES, cnDate } = require('../../cloudfunctions/_shared/config.js')
const { isCollectionMissingError } = require('../../cloudfunctions/_shared/db.js')

const PROMPTS = 'daily_prompts'
const ANSWERS = 'prompt_answers'
const STATUSES = ['ok', 'closed']
const CN_OFFSET = 8 * 3600e3
/** 太短的题目没有可答性：录入侧的软规矩（云函数不校验题目本身） */
export const MIN_TEXT = 4
export const MAX_TEXT = PROMPT_RULES.textMax
const PAGE = 1000
const MAX_PAGES = 20

/* ---------------- 入参 ---------------- */

/** 只接受 YYYY-MM-DD 且必须是真实存在的日期（拒绝 2026-02-30 这类） */
export function checkDate (value, flag) {
  const s = String(value == null ? '' : value).trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) throw new Error(`${flag} 格式为 YYYY-MM-DD`)
  const [y, mo, d] = m.slice(1).map(Number)
  if (mo < 1 || mo > 12 || d < 1 || d > 31) throw new Error(`${flag} 不是有效日期：${s}`)
  const back = new Date(Date.UTC(y, mo - 1, d))
  if (back.getUTCMonth() + 1 !== mo || back.getUTCDate() !== d) throw new Error(`${flag} 不是有效日期：${s}`)
  return s
}

/** 题目正文：折成单行（换行与连续空白 → 空格）+ 码点计数 4–120 */
export function checkText (value, tag = '题目') {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  const chars = Array.from(text).length
  if (chars < MIN_TEXT) throw new Error(`${tag}太短：${chars} 字，至少 ${MIN_TEXT} 字`)
  if (chars > MAX_TEXT) throw new Error(`${tag}超长：${chars} 字，最多 ${MAX_TEXT} 字`)
  return text
}

export function parseArgs (argv) {
  const opts = { mode: null, date: null, text: null, fromFile: null, from: null, days: null, reopen: false, apply: false }
  const modes = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === 'set' || a === 'list' || a === 'close' || a === 'audit') { modes.push(a); continue }
    if (a === '--date') { opts.date = checkDate(argv[++i], '--date'); continue }
    if (a === '--from') { opts.from = checkDate(argv[++i], '--from'); continue }
    if (a === '--text') { const v = argv[++i]; opts.text = v == null ? '' : String(v); continue }
    if (a === '--from-file') { opts.fromFile = argv[++i] || null; continue }
    if (a === '--days') {
      const v = argv[++i]
      if (!/^\d+$/.test(String(v)) || Number(v) < 1 || Number(v) > 90) throw new Error('--days 需为 1–90 的整数')
      opts.days = Number(v)
      continue
    }
    if (a === '--reopen') { opts.reopen = true; continue }
    if (a === '--apply') { opts.apply = true; continue }
    throw new Error(`未知参数：${a}`)
  }
  if (modes.length !== 1) throw new Error('需要且只能指定一个子命令：set / list / close / audit')
  opts.mode = modes[0]
  if (opts.reopen && opts.mode !== 'set') throw new Error('--reopen 只用于 set')
  if (opts.mode === 'set') {
    if (opts.fromFile !== null) {
      if (opts.date !== null || opts.text !== null) throw new Error('用 --from-file 批量录入时不要同时给 --date / --text')
    } else {
      if (!opts.date) throw new Error('set 需要 --date YYYY-MM-DD（或改用 --from-file 批量）')
      if (opts.text === null) throw new Error('set 需要 --text（或改用 --from-file 批量）')
      opts.text = checkText(opts.text)
    }
  } else if (opts.mode === 'close') {
    if (!opts.date) throw new Error('close 需要 --date YYYY-MM-DD')
    if (opts.text !== null || opts.fromFile !== null || opts.from !== null || opts.days !== null) throw new Error('close 只接受 --date [--apply]')
  } else {
    if (opts.date !== null || opts.text !== null || opts.fromFile !== null) throw new Error(`${opts.mode} 是只读的，不接受 --date / --text / --from-file`)
    if (opts.days === null) opts.days = opts.mode === 'list' ? 14 : 30
    if (opts.mode === 'list' && opts.from === null) opts.from = cnDate(Date.now())
    if (opts.mode === 'audit') {
      const today = cnDate(Date.now())
      opts.from = opts.from || `${today.slice(0, 8)}01`
    }
  }
  return opts
}

/* ---------------- 日期窗口 ---------------- */

export function shiftDate (date, delta) {
  const [y, m, d] = date.split('-').map(Number)
  return cnDate(Date.UTC(y, m - 1, d + delta) + CN_OFFSET)
}
/** [from, from + days) 的日期串数组 */
export function dateRange (from, days) {
  return Array.from({ length: days }, (_, i) => shiftDate(from, i))
}

/* ---------------- 种子文件 ---------------- */

/** 解析并整批校验 seed：`{ prompts: [ { date, text, note? } ] }`；同一天出现两次直接报错 */
export function parseSeed (raw) {
  let json
  try {
    json = JSON.parse(raw)
  } catch (e) {
    throw new Error(`种子文件不是合法 JSON：${e.message}`)
  }
  const list = json && json.prompts
  if (!Array.isArray(list) || !list.length) throw new Error('种子文件需要非空的 prompts 数组')
  const seen = new Map()
  return list.map((row, i) => {
    const at = `第 ${i + 1} 条`
    if (!row || typeof row !== 'object') throw new Error(`${at} 不是对象`)
    const date = checkDate(row.date, `${at} 的 date`)
    if (seen.has(date)) throw new Error(`种子文件里 ${date} 出现了两次（第 ${seen.get(date) + 1} 条与第 ${i + 1} 条）`)
    seen.set(date, i)
    return { date, text: checkText(row.text, `${at} 的 text`), note: row.note == null ? null : checkText(row.note, `${at} 的 note`) }
  })
}
export const readSeed = (file) => parseSeed(readFileSync(file, 'utf8'))

/* ---------------- 写库计划（纯函数，便于单测） ---------------- */

/** existing = 该日已有文档（窗口里同一天可能有多条，audit 会单独报） */
export function planSet (existing, { date, text, note = null, now, reopen = false }) {
  const base = { date, text, action: null, id: null, patch: null, doc: null, note: '' }
  if (!existing) {
    const doc = { date, text, status: 'ok', createdAt: now, updatedAt: now }
    if (note) doc.note = note
    return { ...base, action: 'create', doc, note: '新建（当天就会出现）' }
  }
  if (existing.status === 'closed' && !reopen) {
    return { ...base, action: 'refused', id: existing._id, note: `该日已 close（${existing._id}）；确认要重开请加 --reopen` }
  }
  const patch = {}
  if ((existing.text || '') !== text) patch.text = text
  if (existing.status !== 'ok') patch.status = 'ok'
  if (note && existing.note !== note) patch.note = note
  if (!Object.keys(patch).length) return { ...base, action: 'unchanged', id: existing._id, note: '正文与状态都一致，无需改动' }
  patch.updatedAt = now
  const what = [patch.text ? '改正文' : null, patch.status ? '重新开放' : null, patch.note ? '改备注' : null].filter(Boolean).join(' + ')
  return { ...base, action: 'update', id: existing._id, patch, from: existing.text || '', to: text, note: what }
}

export function planClose (existing, { date, now }) {
  if (!existing) return { date, action: 'missing', id: null, patch: null, note: '该日没有题目' }
  if (existing.status === 'closed') return { date, action: 'unchanged', id: existing._id, patch: null, note: `已是 closed（${existing._id}）` }
  return { date, action: 'close', id: existing._id, patch: { status: 'closed', updatedAt: now }, note: `下架 ${existing._id}（正文保留，便于日后复盘）` }
}

/* ---------------- 读 ---------------- */

async function scan (db, name, where = {}) {
  const out = []
  for (let page = 0; page < MAX_PAGES; page++) {
    let res
    try {
      res = await db.collection(name).where(where).skip(page * PAGE).limit(PAGE).get()
    } catch (e) {
      if (isCollectionMissingError(e)) return out
      throw e
    }
    const data = (res && res.data) || []
    out.push(...data)
    if (data.length < PAGE) break
  }
  return out
}

async function countAnswers (db, promptId, status) {
  const where = status ? { promptId, status } : { promptId }
  try {
    const res = await db.collection(ANSWERS).where(where).count()
    return (res && res.total) || 0
  } catch (e) {
    if (isCollectionMissingError(e)) return 0
    throw e
  }
}

/** todayPrompt 的取法：date + status=ok，limit 1，不排序 */
const pickOk = (rows) => rows.filter((r) => r.status === 'ok')[0] || null

/** 指定日期的全部题目（含 closed），按 _id 稳定排序，便于逐日对照 */
export async function promptsByDate (db, dates) {
  const rows = dates.length ? await scan(db, PROMPTS, { date: db.command.in(dates) }) : []
  const byDate = new Map()
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, [])
    byDate.get(r.date).push(r)
  }
  for (const list of byDate.values()) list.sort((a, b) => String(a._id).localeCompare(String(b._id)))
  return byDate
}

export async function buildList (db, { from, days, now = Date.now() }) {
  const dates = dateRange(from, days)
  const byDate = await promptsByDate(db, dates)
  const today = cnDate(now)
  const rows = []
  for (const date of dates) {
    const all = byDate.get(date) || []
    const prompt = pickOk(all)
    const answers = prompt ? await countAnswers(db, prompt._id) : 0
    const visible = prompt ? await countAnswers(db, prompt._id, 'ok') : 0
    rows.push({
      date, today: date === today, docs: all.length,
      status: prompt ? 'ok' : (all.length ? 'closed' : 'none'),
      text: prompt ? prompt.text : (all[0] ? all[0].text : ''),
      answers, visible, pending: answers - visible,
    })
  }
  return { from, days, rows }
}

export async function buildAudit (db, { from, days, now = Date.now() }) {
  const dates = dateRange(from, days)
  const byDate = await promptsByDate(db, dates)
  const issues = []
  const stats = { published: 0, closedOnly: 0, missing: 0, answered: 0, unanswered: 0, answers: 0, visible: 0, gaps: [] }
  const byId = new Map()
  for (const date of dates) {
    const all = byDate.get(date) || []
    for (const r of all) byId.set(r._id, r)
    if (all.length > 1) {
      issues.push({ level: 'error', date, kind: 'duplicate', note: `同一天 ${all.length} 条（${all.map((r) => `${r._id}:${r.status}`).join('、')}）——uniq_date 本该拦住；且 todayPrompt 取「status=ok 的第一条」不排序，多条时命中哪条不确定` })
    }
    for (const r of all) {
      if (!STATUSES.includes(r.status)) issues.push({ level: 'error', date, kind: 'status', note: `${r._id} 的 status = ${JSON.stringify(r.status)}，只允许 ${STATUSES.join(' / ')}` })
      const chars = Array.from(String(r.text || '')).length
      if (!chars) issues.push({ level: 'error', date, kind: 'length', note: `${r._id} 正文是空的` })
      else if (chars > MAX_TEXT) issues.push({ level: 'error', date, kind: 'length', note: `${r._id} 正文 ${chars} 字，超过 ${MAX_TEXT}` })
      if (/(?:\r|\n|\s{2,})/.test(String(r.text || ''))) issues.push({ level: 'warn', date, kind: 'whitespace', note: `${r._id} 正文含换行或连续空格，卡片按单行显示会挤在一起` })
    }
    const prompt = pickOk(all)
    if (!prompt) {
      if (all.length) {
        stats.closedOnly += 1
        issues.push({ level: 'info', date, kind: 'closed', note: `该日 ${all.length} 条都是 closed：不会出现题目（前端隐藏卡片，不算故障）` })
      } else stats.missing += 1
      continue
    }
    stats.published += 1
    const answers = await countAnswers(db, prompt._id)
    const visible = await countAnswers(db, prompt._id, 'ok')
    stats.answers += answers
    stats.visible += visible
    if (answers) stats.answered += 1
    else stats.unanswered += 1
    if (answers > 0 && visible === 0) issues.push({ level: 'warn', date, kind: 'all-hidden', note: `${prompt._id} 有 ${answers} 条作答但可见 0 条（都卡在待复核 / 已处理，看看机审是不是出问题了）` })
  }
  const orphans = (await scan(db, ANSWERS, { date: db.command.in(dates) })).filter((a) => !byId.has(a.promptId))
  if (orphans.length) {
    issues.push({ level: 'error', date: `${from}…`, kind: 'orphan', note: `${orphans.length} 条作答找不到对应题目（如 ${orphans.slice(0, 3).map((a) => a._id).join('、')}）：题目被删或答案 date 与题目不一致，需人工核对` })
  }
  let run = 0
  for (const date of dates) {
    if (pickOk(byDate.get(date) || [])) { run = 0; continue }
    run += 1
    if (run === 1) stats.gaps.push(date)
  }
  return { from, days, issues, stats, today: cnDate(now) }
}

/* ---------------- 写 ---------------- */

/** 一批 set 计划：apply=false 时只算不写 */
export async function applySet (db, plans, { apply = false } = {}) {
  for (const p of plans) {
    if (!apply || p.action === 'unchanged' || p.action === 'refused') continue
    if (p.action === 'create') await db.collection(PROMPTS).add(p.doc)
    else await db.collection(PROMPTS).doc(p.id).update(p.patch)
  }
  return plans
}

export async function applyClose (db, plan, { apply = false } = {}) {
  // 写出去的就是 planClose 算出的那份 patch：脚本预览里显示的字段 = 真正落库的字段
  if (apply && plan.action === 'close') await db.collection(PROMPTS).doc(plan.id).update(plan.patch)
  return plan
}

/* ---------------- 命令行 ---------------- */

const yes = (b) => (b ? '今天' : '')
const clip = (s) => {
  const chars = Array.from(String(s || ''))
  return chars.length ? (chars.length > 24 ? `${chars.slice(0, 24).join('')}…` : chars.join('')) : '（无）'
}
const describe = (p, apply) => `${p.date} ${p.action}：${p.note}${p.action === 'update' ? `（${clip(p.from)} → ${clip(p.to)}）` : ''}${apply && (p.action === 'create' || p.action === 'update' || p.action === 'close') ? '（已写入）' : ''}`

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  const db = openDb()
  const now = Date.now()

  if (opts.mode === 'list') {
    const r = await buildList(db, { from: opts.from, days: opts.days, now })
    console.log(`每日一题（北京时间，起 ${r.from}，共 ${r.days} 天）`)
    console.log('日期\t今日\t条数\t状态\t作答\t可见\t待复核\t题目')
    for (const x of r.rows) console.log(`${x.date}\t${yes(x.today)}\t${x.docs}\t${x.status}\t${x.answers}\t${x.visible}\t${x.pending}\t${clip(x.text)}`)
    return
  }

  if (opts.mode === 'audit') {
    const r = await buildAudit(db, { from: opts.from, days: opts.days, now })
    const s = r.stats
    console.log(`每日一题体检（${r.from} 起 ${r.days} 天，今天 ${r.today}）`)
    console.log(`有题 ${s.published} 天 · 全 closed ${s.closedOnly} 天 · 没题 ${s.missing} 天 · 作答 ${s.answers} 条（可见 ${s.visible}）· 零作答 ${s.unanswered} 题 · 有人答 ${s.answered} 题`)
    if (s.gaps.length) console.log(`连续没题的起点：${s.gaps.join('、')}`)
    for (const i of r.issues) console.log(`[${i.level}] ${i.date} ${i.kind}：${i.note}`)
    if (!r.issues.length) console.log('没问题 ✓')
    return
  }

  const existingOf = async (date) => (await promptsByDate(db, [date])).get(date)?.[0] || null

  if (opts.mode === 'close') {
    const plan = await applyClose(db, planClose(await existingOf(opts.date), { date: opts.date, now }), { apply: opts.apply })
    if (plan.action === 'missing') throw new Error(`${opts.date} 没有题目，不必下架`)
    console.log(describe({ ...plan, date: opts.date }, opts.apply))
    if (!opts.apply && plan.action === 'close') console.log('预览模式：加 --apply 写入')
    return
  }

  const rows = opts.fromFile ? readSeed(opts.fromFile) : [{ date: opts.date, text: opts.text, note: null }]
  const plans = []
  for (const row of rows) plans.push(planSet(await existingOf(row.date), { date: row.date, text: row.text, note: row.note, now, reopen: opts.reopen }))
  const refused = plans.filter((p) => p.action === 'refused')
  if (refused.length) {
    plans.forEach((p) => console.log(describe(p, false)))
    throw new Error(`有 ${refused.length} 个日期已 close，整批不写（确认要重开再加 --reopen）`)
  }
  const written = await applySet(db, plans, { apply: opts.apply })
  for (const p of written) console.log(describe(p, opts.apply))
  const changed = written.filter((p) => p.action === 'create' || p.action === 'update').length
  console.log(`共 ${written.length} 条：需改动 ${changed} · 未变 ${written.length - changed}`)
  if (!opts.apply && changed) console.log('预览模式：加 --apply 写入')
}

runMain(import.meta, 'daily-prompt', main)
