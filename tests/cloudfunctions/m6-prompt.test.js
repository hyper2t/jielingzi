'use strict'
/**
 * BE-M6-01：每日一题的今日题目、作答与答案列表（规则见 docs/prd/m6-plan.md D6–D13）。
 * 覆盖：无题目兜底、一人一题一次与额度顺序、字数与参数校验、四类门禁、机审 reject / review、
 * 「已作答才可见他人答案」的可见性与分页、匿名与注销形态、以及与社区一致的拦截文案。
 * 用例编号见 docs/test/cases/M6.md（M6-A01 … M6-A05；并发双写的已知代价记在 M6-A04，其前端一半由 src/pkg-practice 的连点用例钉住）。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const S = require('../../cloudfunctions/_shared')
const practice = require('../../cloudfunctions/practice/service')
const { RATE_COLLECTION } = require('../../cloudfunctions/_shared/guard')
const { PROMPT_RULES } = require('../../cloudfunctions/_shared/config')
const { createFakeDb } = require('./fakeDb')

const NOW = Date.UTC(2026, 9, 3, 4, 0, 0)
const TODAY = '2026-10-03'
const A = 'acct-prompt-a'
const B = 'acct-prompt-b'
const C = 'acct-prompt-c'
const silent = { info() {}, error() {} }

const TEXT = '本周你想放下的一件小事是什么？'
const ANSWER = '想把睡前刷手机的时间换成十分钟静坐'
const REJECT_MSG = '内容不符合社区公约，请修改后再发布'

const promptDoc = (extra = {}) => ({
  _id: 'prompt-1', date: TODAY, text: TEXT, status: 'ok', createdAt: NOW - 3600 * 1000, ...extra
})
const answerDoc = (id, who, extra = {}) => ({
  _id: id, promptId: 'prompt-1', date: TODAY, _openid: who, text: ANSWER, anon: true, status: 'ok', createdAt: NOW + 1000, ...extra
})

function world (opts = {}) {
  const users = opts.users || [A, B, C].map((id) => ({ _openid: id, adultConfirmedAt: 1, phoneVerified: true }))
  return createFakeDb({
    data: {
      users,
      profiles: opts.profiles || [
        { _openid: A, nickname: '甲的昵称', anonAlias: '甲的花名' },
        { _openid: B, nickname: '乙的昵称', anonAlias: '乙的花名' },
        { _openid: C, nickname: '丙的昵称', anonAlias: '丙的花名' }
      ],
      daily_prompts: 'prompts' in opts ? opts.prompts : [promptDoc()],
      prompt_answers: 'answers' in opts ? opts.answers : []
    }
  })
}

function as (db, accountId = A, moderation) {
  let now = NOW
  return S.createMain({
    actions: practice.actions,
    logger: silent,
    createContext: async () => ({ db, identity: { openid: accountId }, now: () => ++now, logger: silent, moderation })
  })
}

const call = (db, action, p = {}, who = A, moderation) => as(db, who, moderation)({ action, ...p })
const answerText = (extra = {}) => ({ promptId: 'prompt-1', text: ANSWER, ...extra })
/** 当日额度已用次数（rate_limits 的 _id 形如 `<accountId>:<action>:<YYYY-MM-DD>`） */
function used (db, accountId, action) {
  return (db.store[RATE_COLLECTION] || [])
    .filter((r) => r._id === `${accountId}:${action}:${TODAY}`)
    .reduce((sum, r) => sum + (Number(r.count) || 0), 0)
}
const moderationOf = (verdict) => ({ checkText: async () => ({ verdict, hits: [{ category: 'diversion', word: '加群' }], labels: [20002] }) })

/* ---------------- todayPrompt ---------------- */

test('todayPrompt：当日无已发布题目时返回 prompt=null（前端隐藏入口，不算错误）', async () => {
  const db = world({ prompts: [] })
  const res = await call(db, 'todayPrompt')
  assert.equal(res.code, 0)
  assert.deepEqual(res.data, { prompt: null })
  assert.equal(used(db, A, 'todayPrompt'), 0, '读动作不扣额度')
})

test('todayPrompt：只认当日 status=ok 的题目（跨日与 closed 都不出现在今日入口）', async () => {
  const yesterday = world({ prompts: [promptDoc({ date: '2026-10-02' })] })
  assert.deepEqual((await call(yesterday, 'todayPrompt')).data, { prompt: null })
  const closed = world({ prompts: [promptDoc({ status: 'closed' })] })
  assert.deepEqual((await call(closed, 'todayPrompt')).data, { prompt: null })
})

test('todayPrompt：返回题目正文与本人作答状态、他人可见答案数', async () => {
  const db = world({
    answers: [
      answerDoc('a-mine', A),
      answerDoc('a-b', B),
      answerDoc('a-c', C, { status: 'pending' })
    ]
  })
  const res = await call(db, 'todayPrompt')
  assert.equal(res.code, 0)
  assert.deepEqual(res.data.prompt, {
    id: 'prompt-1', date: TODAY, text: TEXT, answered: true, myStatus: 'ok', answerCount: 2
  })
})

test('todayPrompt：多传参数按 40001 拒绝（尽早暴露前端拼错的字段）', async () => {
  const res = await call(world(), 'todayPrompt', { foo: 1 })
  assert.equal(res.code, 40001)
})

/* ---------------- answerPrompt ---------------- */

test('answerPrompt：写入答案（默认匿名）；返回体不回传 _openid', async () => {
  const db = world()
  const res = await call(db, 'answerPrompt', answerText())
  assert.equal(res.code, 0)
  assert.equal(res.data.answer.date, TODAY)
  assert.equal(res.data.answer.text, ANSWER)
  assert.equal(res.data.answer.anon, true, 'PROMPT_RULES.defaultAnon：未显式选择时按匿名处理')
  assert.equal(res.data.answer.status, 'ok')
  assert.equal('_openid' in res.data.answer, false)
  const row = db.store.prompt_answers[0]
  assert.equal(row._openid, A)
  assert.equal(row.promptId, 'prompt-1')
  assert.equal(used(db, A, 'answerPrompt'), 1, '成功后才计一次额度')
})

test('answerPrompt：显式传 anon=false 才走实名；答案首尾空白被裁掉', async () => {
  const db = world()
  await call(db, 'answerPrompt', answerText({ anon: false, text: `  ${ANSWER}  ` }))
  assert.equal(db.store.prompt_answers[0].anon, false)
  assert.equal(db.store.prompt_answers[0].text, ANSWER)
})

test('answerPrompt：同一题重复作答 40901，且不落库、不扣额度', async () => {
  const db = world()
  assert.equal((await call(db, 'answerPrompt', answerText())).code, 0)
  const again = await call(db, 'answerPrompt', answerText({ text: '换一个说法再交一次作业看看' }))
  assert.equal(again.code, 40901)
  assert.equal(again.msg, '今天已经作答过了')
  assert.equal(db.store.prompt_answers.length, 1)
  assert.equal(used(db, A, 'answerPrompt'), 1)
})

test('answerPrompt：同日第二题由每日额度拦住（42901）', async () => {
  const db = world({ prompts: [promptDoc(), promptDoc({ _id: 'prompt-2', date: '2026-10-02' })] })
  assert.equal((await call(db, 'answerPrompt', answerText())).code, 0)
  const second = await call(db, 'answerPrompt', answerText({ promptId: 'prompt-2' }))
  assert.equal(second.code, 42901)
  assert.match(second.msg, /今日额度已用完/)
  assert.equal(db.store.prompt_answers.length, 1)
})

test('answerPrompt：真并发同时提交会双写（D7 明确接受的代价），展示只认最早那条', async () => {
  const db = world()
  const main = as(db)
  const [r1, r2] = await Promise.all([
    main({ action: 'answerPrompt', promptId: 'prompt-1', text: ANSWER }),
    main({ action: 'answerPrompt', promptId: 'prompt-1', text: '同一分钟里又交了一次' })
  ])
  assert.equal(r1.code, 0)
  assert.equal(r2.code, 0)
  // 「每人每题一条」是应用层先查后写（D6：不能建含 _openid 的唯一索引），同 tick 双发挡不住。
  // 这里钉的是**已接受的后果**：两条都落库、额度各扣一次，多余那条由 ops 的 dup_answer 巡检发现。
  assert.equal(db.store.prompt_answers.length, 2)
  assert.equal(used(db, A, 'answerPrompt'), 2, '每日额度只有 1，并发是本动作唯一的漏口')
  const mine = (await call(db, 'listAnswers', { promptId: 'prompt-1' }, A)).data.mine
  assert.equal(mine.text, ANSWER, '本人看到的是最早那条（findMyAnswer 按 createdAt 升序取 1）')
  assert.equal((await call(db, 'listAnswers', { promptId: 'prompt-1' }, B)).code, 40301, '没作答的人一条都看不到')
  assert.equal((await call(db, 'answerPrompt', answerText(), B)).code, 0)
  const seen = (await call(db, 'listAnswers', { promptId: 'prompt-1' }, B)).data
  assert.deepEqual(seen.list.map((r) => r.text), ['想把睡前刷手机的时间换成十分钟静坐', '同一分钟里又交了一次'],
    '他人列表里会看到同账号的两条——重复条目外露的位置就在这里，今后要按作者去重就改这一处')
})

test('answerPrompt：题目不存在或已下架 → 40401', async () => {
  const missing = await call(world({ prompts: [] }), 'answerPrompt', answerText())
  assert.equal(missing.code, 40401)
  const closed = await call(world({ prompts: [promptDoc({ status: 'closed' })] }), 'answerPrompt', answerText())
  assert.equal(closed.code, 40401)
})

test('answerPrompt：字数按 PROMPT_RULES.answer（去空白后 5–500）', async () => {
  const { min, max } = PROMPT_RULES.answer
  const short = await call(world(), 'answerPrompt', answerText({ text: '短短短短' }))
  assert.equal(short.code, 40001)
  assert.match(short.msg, new RegExp(`${min}–${max}`))
  const edge = await call(world(), 'answerPrompt', answerText({ text: '字'.repeat(min) }))
  assert.equal(edge.code, 0, `恰好 ${min} 字应通过`)
  const long = await call(world(), 'answerPrompt', answerText({ text: '字'.repeat(max + 1) }))
  assert.equal(long.code, 40001)
})

test('answerPrompt：参数校验（缺 promptId / anon 非布尔 / 未知字段）与身份要求', async () => {
  const noId = await call(world(), 'answerPrompt', { text: ANSWER })
  assert.equal(noId.code, 40001)
  const badAnon = await call(world(), 'answerPrompt', answerText({ anon: 'true' }))
  assert.equal(badAnon.code, 40001)
  const unknown = await call(world(), 'answerPrompt', answerText({ extra: 1 }))
  assert.equal(unknown.code, 40001)
  const noId2 = await call(world(), 'answerPrompt', answerText({ text: 123 }))
  assert.equal(noId2.code, 40001)
})

test('answerPrompt：门禁顺序——未登录 40101、未成年 40303、未绑手机 40302、封禁 40304、禁言 40305', async () => {
  const anon = { _openid: A, adultConfirmedAt: 1, phoneVerified: true }
  assert.equal((await call(world({ users: [] }), 'answerPrompt', answerText())).code, 40101, '无 users 记录 → 未登录')
  const kid = await call(world({ users: [{ _openid: A }] }), 'answerPrompt', answerText())
  assert.equal(kid.code, 40303)
  const noPhone = await call(world({ users: [{ _openid: A, adultConfirmedAt: 1 }] }), 'answerPrompt', answerText())
  assert.equal(noPhone.code, 40302)
  const banned = await call(world({ users: [{ ...anon, bannedUntil: NOW + 1000 }] }), 'answerPrompt', answerText())
  assert.equal(banned.code, 40304)
  const muted = await call(world({ users: [{ ...anon, mutedUntil: NOW + 1000 }] }), 'answerPrompt', answerText())
  assert.equal(muted.code, 40305)
  const today = await call(world({ users: [{ ...anon, mutedUntil: NOW - 1000 }] }), 'answerPrompt', answerText())
  assert.equal(today.code, 0, '禁言到期后照常放行')
})

test('answerPrompt：机审 reject → 40001，文案与社区一致，不落库不扣额度但留审核日志', async () => {
  const db = world()
  const res = await call(db, 'answerPrompt', answerText(), A, moderationOf('reject'))
  assert.equal(res.code, 40001)
  assert.equal(res.msg, REJECT_MSG)
  assert.equal(db.store.prompt_answers.length, 0)
  assert.equal(used(db, A, 'answerPrompt'), 0)
  const logs = db.store.mod_logs || []
  assert.equal(logs.length, 1)
  assert.equal(logs[0].verdict, 'reject')
  assert.equal(logs[0].targetType, 'prompt_answer')
  assert.equal(logs[0].scene, 'comment')
})

test('answerPrompt：机审 review → 落库但 status=pending（只在本人「今日题目」里可见，不计入他人可见数）', async () => {
  const db = world()
  const res = await call(db, 'answerPrompt', answerText(), A, moderationOf('review'))
  assert.equal(res.code, 0)
  assert.equal(res.data.answer.status, 'pending')
  assert.equal(db.store.prompt_answers[0].status, 'pending')
  assert.equal((await call(db, 'todayPrompt')).data.prompt.myStatus, 'pending')
  assert.equal((await call(db, 'todayPrompt', {}, B)).data.prompt.answerCount, 0)
})

/* ---------------- listAnswers ---------------- */

test('listAnswers：本人未作答 → 40301，且不返回任何他人答案内容', async () => {
  const db = world({ answers: [answerDoc('a-b', B)] })
  const res = await call(db, 'listAnswers', { promptId: 'prompt-1' })
  assert.equal(res.code, 40301)
  assert.equal(res.msg, '作答后即可查看他人的回答')
  assert.equal(res.data, null, '被拦住时不得带出答案文本')
  assert.equal(JSON.stringify(res).includes(ANSWER), false)
})

test('listAnswers：已作答后可见他人 ok 答案；他人 pending / removed 不可见；本人那条单独返回', async () => {
  const db = world({
    answers: [
      answerDoc('a-mine', A, { status: 'pending', text: '我的那条还在复核里' }),
      answerDoc('a-b', B),
      answerDoc('a-c', C, { status: 'removed' }),
      answerDoc('a-d', 'acct-prompt-d', { status: 'pending' })
    ]
  })
  const res = await call(db, 'listAnswers', { promptId: 'prompt-1' })
  assert.equal(res.code, 0)
  assert.equal(res.data.promptId, 'prompt-1')
  assert.equal(res.data.date, TODAY)
  assert.deepEqual(res.data.list.map((r) => r.id), ['a-b'])
  assert.equal(res.data.list[0].authorName, '乙的花名', '匿名答案只给花名')
  assert.equal(res.data.list[0].anon, true)
  assert.equal(res.data.list[0].isSelf, false)
  assert.equal(res.data.mine.status, 'pending')
  assert.equal(res.data.mine.isSelf, true)
  assert.equal(used(db, A, 'listAnswers'), 0, '读动作不扣额度')
})

test('listAnswers：只返回展示所需字段（无头像 / 徽章 / 练习档案 / 手机号），实名条目给昵称', async () => {
  const db = world({
    answers: [answerDoc('a-mine', A, { anon: false }), answerDoc('a-b', B, { anon: false })]
  })
  const res = await call(db, 'listAnswers', { promptId: 'prompt-1' })
  const item = res.data.list[0]
  assert.equal(item.authorName, '乙的昵称')
  assert.equal(item.anon, false)
  for (const key of ['avatar', 'badges', 'practices', 'years', '_openid', 'phone', 'promptId']) {
    assert.equal(key in item, false, `不应返回 ${key}`)
  }
})

test('listAnswers：注销后解除归属的答案展示为「已注销用户」', async () => {
  const db = world({
    answers: [answerDoc('a-mine', A), answerDoc('a-gone', 'acct-gone', { _openid: null, authorDeleted: true })]
  })
  const res = await call(db, 'listAnswers', { promptId: 'prompt-1' })
  assert.equal(res.data.list.length, 1)
  assert.equal(res.data.list[0].authorName, '已注销用户')
  assert.equal(res.data.list[0].deleted, true)
})

test('listAnswers：分页与 hasMore；size 超上限或 page 非正整数 → 40001', async () => {
  const db = world({
    answers: [
      answerDoc('a-mine', A),
      answerDoc('a-b', B, { createdAt: 1 }),
      answerDoc('a-c', C, { createdAt: 2 }),
      answerDoc('a-d', 'acct-prompt-d', { createdAt: 3 })
    ]
  })
  const p1 = await call(db, 'listAnswers', { promptId: 'prompt-1', page: 1, size: 2 })
  assert.deepEqual(p1.data.list.map((r) => r.id), ['a-b', 'a-c'])
  assert.equal(p1.data.hasMore, true)
  const p2 = await call(db, 'listAnswers', { promptId: 'prompt-1', page: 2, size: 2 })
  assert.deepEqual(p2.data.list.map((r) => r.id), ['a-d'])
  assert.equal(p2.data.hasMore, false)
  assert.equal((await call(db, 'listAnswers', { promptId: 'prompt-1', size: PROMPT_RULES.listMax + 1 })).code, 40001)
  assert.equal((await call(db, 'listAnswers', { promptId: 'prompt-1', page: 0 })).code, 40001)
  assert.equal((await call(db, 'listAnswers', { promptId: 'prompt-1', nope: 1 })).code, 40001)
})

test('listAnswers：题目不存在 40401（先查题目，再判「已作答」）', async () => {
  const res = await call(world({ prompts: [] }), 'listAnswers', { promptId: 'nope' })
  assert.equal(res.code, 40401)
})

/* ---------------- 配置与文案一致性 ---------------- */

test('每日一题与社区的机审拦截文案一字不差（两处常量各自锁死）', () => {
  const topics = fs.readFileSync(path.join(__dirname, '../../cloudfunctions/community/topics.js'), 'utf8')
  assert.match(topics, new RegExp(`const REJECT_MSG = '${REJECT_MSG}'`))
  const service = fs.readFileSync(path.join(__dirname, '../../cloudfunctions/practice/service.js'), 'utf8')
  assert.match(service, new RegExp(`const REJECT_MSG = '${REJECT_MSG}'`))
})

test('PROMPT_RULES 的形状：默认匿名、答案字数与分页上限（前端同名常量由此对齐）', () => {
  assert.equal(PROMPT_RULES.defaultAnon, true)
  assert.deepEqual(PROMPT_RULES.answer, { min: 5, max: 500 })
  assert.equal(PROMPT_RULES.listMax, 50)
  assert.ok(PROMPT_RULES.textMax >= 20 && PROMPT_RULES.textMax <= 200)
})
