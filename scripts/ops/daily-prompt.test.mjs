/**
 * OPS-M6-01：`daily-prompt.mjs` 的入参解析、写库计划、只读预览、巡检统计。
 * 验收点（docs/prd/m6-plan.md 第 5 节）：参数解析、预览不写、--apply 幂等 upsert、
 * close 后 todayPrompt 不再返回、audit 对同日多条与未作答的统计。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import {
  MAX_TEXT, MIN_TEXT, applyClose, applySet, buildAudit, buildList, checkDate, checkText, dateRange,
  parseArgs, parseSeed, planClose, planSet, promptsByDate, shiftDate,
} from './daily-prompt.mjs'

const require = createRequire(import.meta.url)
const S = require('../../cloudfunctions/_shared')
const { createFakeDb } = require('../../tests/cloudfunctions/fakeDb.js')
const practice = require('../../cloudfunctions/practice/service.js')
const { PROMPT_RULES, cnDate } = require('../../cloudfunctions/_shared/config.js')

const NOW = Date.UTC(2026, 9, 3, 4, 0, 0) // 北京时间 2026-10-03 12:00
const TODAY = '2026-10-03'
const Q = '今天你想放下的一件小事是什么？'
const silent = { info() {}, error() {} }

const promptDoc = (id, date, o = {}) => ({ _id: id, date, text: Q, status: 'ok', createdAt: NOW - 1000, ...o })
const answerDoc = (id, promptId, o = {}) => ({ _id: id, promptId, date: TODAY, _openid: 'oA', text: '想把睡前刷手机换成十分钟静坐', anon: true, status: 'ok', createdAt: NOW, ...o })

/** 只读用例都用它：跑完对比 store，确认脚本没偷偷写库 */
const snapshot = (db) => JSON.stringify(db.store)

/* ---------------- 入参 ---------------- */

test('parseArgs：子命令必选且唯一；set 要 --date + --text 或改走 --from-file；未知参数报错', () => {
  const s = parseArgs(['set', '--date', '2026-10-05', '--text', '今天想放下什么？'])
  assert.deepEqual([s.mode, s.date, s.text, s.apply, s.reopen], ['set', '2026-10-05', '今天想放下什么？', false, false])
  assert.equal(parseArgs(['set', '--from-file', 'a.json', '--apply']).fromFile, 'a.json')
  assert.throws(() => parseArgs([]), /一个子命令/)
  assert.throws(() => parseArgs(['set', 'list', '--date', '2026-10-05', '--text', '题']), /一个子命令/)
  assert.throws(() => parseArgs(['set', '--text', '只有正文没有日期']), /--date/)
  assert.throws(() => parseArgs(['set', '--date', '2026-10-05']), /--text/)
  assert.throws(() => parseArgs(['set', '--date', '2026-10-05', '--text', '题', '--from-file', 'a.json']), /不要同时给/)
  assert.throws(() => parseArgs(['close', '--date', '2026-10-05', '--text', '题']), /只接受 --date/)
  assert.throws(() => parseArgs(['list', '--date', '2026-10-05']), /只读的/)
  assert.throws(() => parseArgs(['audit', '--reopen']), /只用于 set/)
  assert.throws(() => parseArgs(['set', '--date', '2026-10-05', '--text', '题', '--nope']), /未知参数/)
})

test('checkDate：只收 YYYY-MM-DD 且要真实存在；--days 1–90；list / audit 的默认窗口', () => {
  assert.equal(checkDate('2026-10-05', '--date'), '2026-10-05')
  assert.throws(() => checkDate('2026-02-30', '--date'), /不是有效日期/)
  assert.throws(() => checkDate('2026-13-01', '--date'), /不是有效日期/)
  assert.throws(() => checkDate('2026-10-5', '--date'), /格式/)
  assert.throws(() => parseArgs(['list', '--days', '0']), /1–90/)
  assert.throws(() => parseArgs(['list', '--days', '91']), /1–90/)
  assert.throws(() => parseArgs(['list', '--days', 'x']), /1–90/)
  assert.equal(parseArgs(['list']).days, 14)
  assert.equal(parseArgs(['list']).from, cnDate(Date.now()), 'list 默认从今天（北京时间）起')
  assert.equal(parseArgs(['audit']).days, 30)
  assert.equal(parseArgs(['audit']).from, `${cnDate(Date.now()).slice(0, 8)}01`, 'audit 默认从本月 1 日起')
  assert.equal(cnDate(NOW), TODAY, '先看一眼时钟假设')
})

test('checkText：折成单行、码点计数、4–120 字（与 PROMPT_RULES.textMax 同值）', () => {
  assert.equal(checkText('  今天\n想 放下   什么？ '), '今天 想 放下 什么？')
  assert.equal(MAX_TEXT, PROMPT_RULES.textMax)
  assert.equal(Array.from(checkText('字'.repeat(MAX_TEXT))).length, MAX_TEXT, '按码点算长度')
  assert.throws(() => checkText('三个字'), new RegExp(`至少 ${MIN_TEXT}`))
  assert.throws(() => checkText('字'.repeat(MAX_TEXT + 1)), /超长/)
  assert.throws(() => checkText('   '), /太短/)
  assert.equal(Array.from(checkText('🙏'.repeat(MIN_TEXT))).length, MIN_TEXT, '按码点算：4 个 emoji 就是 4 字')
  assert.throws(() => checkText('🙏'.repeat(3)), /太短/, 'UTF-16 长度 6 也不算够 4 字')
})

test('shiftDate / dateRange：跨月跨年都对，窗口是 [from, from+days)', () => {
  assert.equal(shiftDate('2026-10-31', 1), '2026-11-01')
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01')
  assert.equal(shiftDate('2026-10-03', -3), '2026-09-30')
  assert.deepEqual(dateRange('2026-10-30', 3), ['2026-10-30', '2026-10-31', '2026-11-01'])
  assert.deepEqual(dateRange('2026-10-03', 0), [])
})

/* ---------------- 种子文件 ---------------- */

test('parseSeed：要非空 prompts 数组，日期重复 / 正文超长当场拒绝', () => {
  assert.deepEqual(parseSeed('{"prompts":[{"date":"2026-10-03","text":"想放下什么？"}]}'), [{ date: '2026-10-03', text: '想放下什么？', note: null }])
  assert.throws(() => parseSeed('{"prompts":[]}'), /非空的 prompts/)
  assert.throws(() => parseSeed('{'), /不是合法 JSON/)
  assert.throws(() => parseSeed('{"prompts":[{"date":"2026-10-03","text":"题目甲甲"},{"date":"2026-10-03","text":"题目乙乙"}]}'), /出现了两次/)
  assert.throws(() => parseSeed(`{"prompts":[{"date":"2026-10-03","text":"${'字'.repeat(MAX_TEXT + 1)}"}]}`), /超长/)
})

test('仓库里的 daily-prompt.seed.json 自身就是合法的：日期递增、不重复、每条 ≤ 120 字', () => {
  const rows = parseSeed(readFileSync(new URL('./daily-prompt.seed.json', import.meta.url), 'utf8'))
  assert.ok(rows.length >= 7, '至少录满一周')
  const dates = rows.map((r) => r.date)
  assert.deepEqual(dates, [...dates].sort(), '按日期升序，便于人肉检查')
  assert.equal(new Set(dates).size, dates.length)
  for (const r of rows) {
    assert.ok(Array.from(r.text).length <= MAX_TEXT, r.date)
    assert.doesNotMatch(r.text, /[\r\n]/, '种子正文必须是单行')
  }
})

/* ---------------- 写库计划 ---------------- */

test('planSet：没有就新建；正文不同只改 text；完全一致 unchanged（幂等）', () => {
  const c = planSet(null, { date: TODAY, text: Q, now: NOW })
  assert.equal(c.action, 'create')
  assert.deepEqual(c.doc, { date: TODAY, text: Q, status: 'ok', createdAt: NOW, updatedAt: NOW })
  assert.equal(planSet(null, { date: TODAY, text: Q, note: '周六', now: NOW }).doc.note, '周六', '备注只在新建时写入')
  const same = planSet({ _id: 'p1', date: TODAY, text: Q, status: 'ok' }, { date: TODAY, text: Q, now: NOW })
  assert.equal(same.action, 'unchanged')
  assert.equal(same.patch, null)
  const up = planSet({ _id: 'p1', date: TODAY, text: '旧题目', status: 'ok', note: '旧' }, { date: TODAY, text: Q, note: '新', now: NOW })
  assert.equal(up.action, 'update')
  assert.deepEqual(up.patch, { text: Q, note: '新', updatedAt: NOW }, '不动 createdAt')
  assert.deepEqual([up.from, up.to], ['旧题目', Q], '预览要打印改前改后')
})

test('planSet：已 close 的日子拒绝悄悄放出来，--reopen 才改回 ok；缺 status 的脏文档也算异常', () => {
  const closed = { _id: 'p1', date: TODAY, text: Q, status: 'closed' }
  const refused = planSet(closed, { date: TODAY, text: '换一道题', now: NOW })
  assert.equal(refused.action, 'refused')
  assert.match(refused.note, /reopen/)
  const reopened = planSet(closed, { date: TODAY, text: '换一道题', now: NOW, reopen: true })
  assert.equal(reopened.action, 'update')
  assert.deepEqual(reopened.patch, { text: '换一道题', status: 'ok', updatedAt: NOW })
  assert.equal(planSet({ _id: 'p1', date: TODAY, text: Q, status: 'draft' }, { date: TODAY, text: Q, now: NOW }).action, 'update', '未知 status 会被纠正成 ok')
})

test('planClose：只翻 status，正文留着；没题目 / 已 closed 都不写', () => {
  assert.deepEqual(planClose(null, { date: TODAY, now: NOW }).action, 'missing')
  const p = planClose({ _id: 'p1', date: TODAY, text: Q, status: 'ok' }, { date: TODAY, now: NOW })
  assert.deepEqual(p.patch, { status: 'closed', updatedAt: NOW })
  assert.equal(p.id, 'p1')
  assert.equal(planClose({ _id: 'p1', date: TODAY, text: Q, status: 'closed' }, { date: TODAY, now: NOW }).action, 'unchanged')
})

test('applySet / applyClose：不加 --apply 一个字节都不写；写了之后再跑同一条 → unchanged（不产生第二条）', async () => {
  const db = createFakeDb({ unique: { daily_prompts: ['date'] }, data: { daily_prompts: [] } })
  const plan = planSet(null, { date: TODAY, text: Q, now: NOW })
  await applySet(db, [plan], { apply: false })
  assert.equal(db.store.daily_prompts.length, 0, '预览不写')
  await applySet(db, [plan], { apply: true })
  assert.equal(db.store.daily_prompts.length, 1)
  assert.equal(db.store.daily_prompts[0].status, 'ok')
  const byDate = await promptsByDate(db, [TODAY])
  const again = planSet(byDate.get(TODAY)[0], { date: TODAY, text: Q, now: NOW + 5000 })
  assert.equal(again.action, 'unchanged', '第二次 set 同一句话：幂等，不会被 uniq_date 撞')
  await applySet(db, [again], { apply: true })
  assert.equal(db.store.daily_prompts.length, 1)
  await assert.rejects(() => db.collection('daily_prompts').add(promptDoc('p-forced', TODAY)), 'uniq_date 在拦同日第二条')
  const closePlan = planClose(byDate.get(TODAY)[0], { date: TODAY, now: NOW + 9000 })
  await applyClose(db, closePlan, { apply: false })
  assert.equal(db.store.daily_prompts[0].status, 'ok', 'close 也是预览优先')
  await applyClose(db, closePlan, { apply: true })
  assert.equal(db.store.daily_prompts[0].status, 'closed')
  assert.equal(db.store.daily_prompts[0].text, Q, '下架不删正文')
})

test('close 之后 todayPrompt 不再返回这道题（云函数与脚本同一口径，验收点）', async () => {
  const db = createFakeDb({
    data: {
      users: [{ _openid: 'oA', adultConfirmedAt: 1, phoneVerified: true }],
      daily_prompts: [promptDoc('p1', TODAY)],
      prompt_answers: [answerDoc('a1', 'p1')],
    },
  })
  const as = () => S.createMain({ actions: practice.actions, logger: silent, createContext: async () => ({ db, identity: { openid: 'oA' }, now: () => NOW, logger: silent }) })
  const before = await as()({ action: 'todayPrompt' })
  assert.equal(before.code, 0)
  assert.deepEqual(before.data.prompt, { id: 'p1', date: TODAY, text: Q, answered: true, myStatus: 'ok', answerCount: 1 })
  await applyClose(db, planClose(db.store.daily_prompts[0], { date: TODAY, now: NOW }), { apply: true })
  const after = await as()({ action: 'todayPrompt' })
  assert.deepEqual(after.data, { prompt: null }, '下架后前端隐藏卡片，不是报错')
  assert.equal(db.store.daily_prompts[0].text, Q, 'close 只改 status：正文留着，日后 --reopen 还能原样放出')
  assert.equal(db.store.prompt_answers.length, 1, 'close 不动任何人的答案')
})

/* ---------------- 只读：list / audit ---------------- */

test('buildList：逐日给出条数 / 状态 / 作答数 / 待复核数，并且只读', async () => {
  const db = createFakeDb({
    data: {
      daily_prompts: [promptDoc('p1', TODAY), promptDoc('p2', '2026-10-04', { status: 'closed' }), promptDoc('p3', '2026-10-05', { text: '换一道题？' })],
      prompt_answers: [answerDoc('a1', 'p1'), answerDoc('a2', 'p1', { status: 'pending' }), answerDoc('a3', 'p3', { status: 'removed' })],
    },
  })
  const before = snapshot(db)
  const r = await buildList(db, { from: TODAY, days: 4, now: NOW })
  assert.equal(JSON.stringify(db.store), before, 'list 不改库')
  assert.deepEqual(r.rows.map((x) => [x.date, x.docs, x.status, x.answers, x.visible, x.pending]), [
    [TODAY, 1, 'ok', 2, 1, 1],
    ['2026-10-04', 1, 'closed', 0, 0, 0],
    ['2026-10-05', 1, 'ok', 1, 0, 1],
    ['2026-10-06', 0, 'none', 0, 0, 0],
  ])
  assert.equal(r.rows[0].today, true)
  assert.equal(r.rows[1].today, false, '只有北京时间今天算 today')
  assert.equal(r.rows[0].text, Q)
  assert.equal(r.rows[2].text, '换一道题？', '取的是 status=ok 的那条')
})

test('buildList / buildAudit：集合还没建（首个部署前）也不报错', async () => {
  const db = createFakeDb({ strictCollections: true })
  assert.deepEqual((await buildList(db, { from: TODAY, days: 2, now: NOW })).rows.map((x) => x.status), ['none', 'none'])
  const a = await buildAudit(db, { from: TODAY, days: 2, now: NOW })
  assert.deepEqual(a.issues, [])
  assert.deepEqual([a.stats.published, a.stats.missing], [0, 2])
})

test('buildAudit：同日多条、非法 status、超长与脏空白、全被隐藏、孤儿答案、缺口起点', async () => {
  const long = '字'.repeat(MAX_TEXT + 5)
  const db = createFakeDb({
    data: {
      daily_prompts: [
        promptDoc('p1', TODAY, { text: long }),
        promptDoc('p1b', TODAY, { status: 'draft' }),
        promptDoc('p2', '2026-10-04', { text: '含\n换行的题目', status: 'closed' }),
        promptDoc('p3', '2026-10-05'),
        promptDoc('p4', '2026-10-07', { status: 'closed' }),
      ],
      prompt_answers: [
        answerDoc('a-hidden', 'p3', { status: 'pending', date: '2026-10-05' }),
        answerDoc('a-orphan', 'p-gone', { date: '2026-10-06' }),
      ],
    },
  })
  const before = snapshot(db)
  const r = await buildAudit(db, { from: TODAY, days: 7, now: NOW })
  assert.equal(JSON.stringify(db.store), before, 'audit 只读')
  const kinds = r.issues.map((i) => `${i.date}:${i.kind}:${i.level}`)
  assert.ok(kinds.includes(`${TODAY}:duplicate:error`), kinds.join(' '))
  assert.ok(kinds.includes(`${TODAY}:status:error`), 'draft 不是允许的状态')
  assert.ok(kinds.includes(`${TODAY}:length:error`), `超长要报：${long.length}`)
  assert.ok(kinds.includes('2026-10-04:whitespace:warn'), '换行只 warn（能显示，只是挤）')
  assert.ok(kinds.includes('2026-10-05:all-hidden:warn'), '有作答但 0 可见')
  assert.ok(kinds.includes('2026-10-07:closed:info'), '全是 closed 只当提示')
  assert.ok(kinds.some((k) => k.endsWith(':orphan:error')), '答案指向不存在的题目')
  assert.match(r.issues.find((i) => i.kind === 'orphan').note, /a-orphan/)
  // 没有 ok 题目的日子都算「今天不出题」：closed-only 的 10-04 与 10-07 也算，只报连续段起点
  assert.deepEqual(r.stats.gaps, ['2026-10-04', '2026-10-06'])
  assert.deepEqual([r.stats.published, r.stats.closedOnly, r.stats.missing, r.stats.answers, r.stats.visible, r.stats.unanswered, r.stats.answered], [2, 2, 3, 1, 0, 1, 1])
})

test('buildAudit：数据干净时一条问题都不报（录完题后跑它就是绿灯）', async () => {
  const rows = parseSeed(readFileSync(new URL('./daily-prompt.seed.json', import.meta.url), 'utf8'))
  const db = createFakeDb({
    data: {
      daily_prompts: rows.map((r, i) => promptDoc(`seed-${i}`, r.date, { text: r.text })),
      prompt_answers: [answerDoc('a1', 'seed-0')],
    },
  })
  const r = await buildAudit(db, { from: rows[0].date, days: rows.length, now: NOW })
  assert.deepEqual(r.issues, [], r.issues.map((i) => i.note).join(' | '))
  assert.deepEqual([r.stats.published, r.stats.missing, r.stats.answered, r.stats.unanswered], [7, 0, 1, 6])
  assert.deepEqual(r.stats.gaps, [])
})
