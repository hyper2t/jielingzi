'use strict'
/**
 * BE-M6-04（D09b）：订阅消息额度记账的接线 + 定时提醒里的外发分支。
 * 只测注入的 mp 客户端与模板 ID 的各种组合，不碰真实微信接口；guardWrite 那条链由 m6-prompt 的
 * 入口用例覆盖，这里用 runPromptReminder / 动作存在性 / 规则常量三层把接线钉住。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const practice = require('../../cloudfunctions/practice/service')
const { runPromptReminder, SUBSCRIBE_PAGE, SUBSCRIBE_THING } = require('../../cloudfunctions/_shared/reminder')
const { PROMPT_RULES, cnDate } = require('../../cloudfunctions/_shared/config')
const { createFakeDb } = require('./fakeDb')

const NOW = Date.UTC(2026, 9, 3, 4, 0, 0)
const DAY = 24 * 3600 * 1000
const TODAY = cnDate(NOW)
const silent = { info() {}, error() {} }
const UID = 'acct-sub-1'
const OTHER = 'acct-sub-2'
const adult = () => NOW - 30 * DAY
const userRow = (id, over) => Object.assign({ _id: id, _openid: id, adultConfirmedAt: adult() }, over || {})
const promptRow = () => ({ _id: 'p-sub-1', date: TODAY, status: 'ok', text: '今天站桩二十分钟' })

function world (users, prompts) {
  const db = createFakeDb({ data: { users, daily_prompts: prompts, notifications: [], mod_logs: [] } })
  return { db, users, prompts }
}
function mpOf (outcome) {
  const calls = []
  let n = 0
  return {
    calls,
    async subscribeMessageSend (input) {
      calls.push(input)
      const o = typeof outcome === 'function' ? outcome(n++) : outcome
      return { outcome: o, errcode: o === 'sent' ? 0 : 43101 }
    },
  }
}
async function quotaOf (db, uid) {
  const res = await db.collection('users').where({ _openid: uid }).limit(1).get()
  const doc = res.data[0] || {}
  return { quota: doc.promptSubscribeQuota, mpOpenid: doc.mpOpenid, at: doc.promptSubscribeAt }
}

test('接线：额度上限来自 PROMPT_RULES，动作已挂进 practice.actions', () => {
  assert.equal(PROMPT_RULES.subscribeQuotaMax, 10)
  assert.equal(typeof practice.actions.recordPromptSubscription, 'function')
})

test('env 读取只在入口：reminder 模块仍然一行 process.env 都不读，index.js 读两处', () => {
  const root = path.resolve(__dirname, '../..')
  const reminder = fs.readFileSync(path.join(root, 'cloudfunctions/_shared/reminder.js'), 'utf8')
  const index = fs.readFileSync(path.join(root, 'cloudfunctions/practice/index.js'), 'utf8')
  assert.equal((reminder.match(/process\.env/g) || []).length, 0, 'reminder.js 不该读环境变量')
  assert.ok((index.match(/process\.env/g) || []).length >= 2, 'index.js 要读 mp 凭证与模板 ID')
})

test('非小程序端调用：直接拒，且一次数据库都不碰（同时钉住 forbidden / badParam 的引用）', async () => {
  const db = { collection () { throw new Error('这条路径不该碰数据库') } }
  const ctx = { db, identity: { openid: UID }, now: () => NOW, logger: silent }
  await assert.rejects(() => practice.actions.recordPromptSubscription({ granted: true }, ctx), /不是小程序/)
  await assert.rejects(() => practice.actions.recordPromptSubscription({}, ctx), /granted/)
  await assert.rejects(() => practice.actions.recordPromptSubscription({ granted: 'yes' }, ctx), /granted/)
})

test('未注入 mp / 模板 ID → 订阅段返回 null，站内提醒照常', async () => {
  const { db, users } = world([userRow(UID)], [promptRow()])
  const out = await runPromptReminder({ db, now: () => NOW, logger: silent })
  assert.equal(out.sent, 1, '站内消息照写')
  assert.equal(out.subscribe, null, '通道未启用时整段返回 null')
  assert.equal(out.sent, 1, '站内消息照写')
})

test('注入了 mp 但没有模板 ID → 同样只走站内，且一个订阅请求都不发', async () => {
  const { db } = world([userRow(UID, { mpOpenid: 'mp-1', promptSubscribeQuota: 2 })], [promptRow()])
  const mp = mpOf('sent')
  const out = await runPromptReminder({ db, now: () => NOW, logger: silent, mp, promptTemplateId: '   ' })
  assert.equal(out.subscribe, null)
  assert.equal(mp.calls.length, 0)
})

test('有 openid 与额度 → 发一条并扣减；请求形状带 page 与 thing1 / date2', async () => {
  const { db } = world([userRow(UID, { mpOpenid: 'mp-1', promptSubscribeQuota: 2 })], [promptRow()])
  const mp = mpOf('sent')
  const out = await runPromptReminder({ db, now: () => NOW, logger: silent, mp, promptTemplateId: ' tpl-1 ' })
  assert.deepEqual(
    { attempted: out.subscribe.attempted, sent: out.subscribe.sent, noQuota: out.subscribe.noQuota, failed: out.subscribe.failed },
    { attempted: 1, sent: 1, noQuota: 0, failed: 0 })
  assert.equal(mp.calls.length, 1)
  assert.equal(mp.calls[0].toUser, 'mp-1')
  assert.equal(mp.calls[0].templateId, 'tpl-1')
  assert.equal(mp.calls[0].page, SUBSCRIBE_PAGE)
  assert.deepEqual(mp.calls[0].data, { thing1: SUBSCRIBE_THING, date2: TODAY })
  assert.deepEqual(await quotaOf(db, UID), { quota: 1, mpOpenid: 'mp-1', at: NOW })
})

test('额度为 0 或没有 mpOpenid → 跳过，不发也不报错', async () => {
  const { db } = world([
    userRow(UID, { mpOpenid: 'mp-1', promptSubscribeQuota: 0 }),
    userRow(OTHER, { promptSubscribeQuota: 3 }),
  ], [promptRow()])
  const mp = mpOf('sent')
  const out = await runPromptReminder({ db, now: () => NOW, logger: silent, mp, promptTemplateId: 'tpl-1' })
  assert.equal(out.subscribe.attempted, 0)
  assert.equal(out.subscribe.skipped, 2)
  assert.equal(out.sent, 2, '两条站内消息照常')
  assert.equal(mp.calls.length, 0)
})

test('微信回 43101（no-quota）→ 本地额度清零，下轮不再尝试', async () => {
  const { db } = world([userRow(UID, { mpOpenid: 'mp-1', promptSubscribeQuota: 4 })], [promptRow()])
  const out = await runPromptReminder({ db, now: () => NOW, logger: silent, mp: mpOf('no-quota'), promptTemplateId: 'tpl-1' })
  assert.equal(out.subscribe.noQuota, 1)
  assert.equal(out.subscribe.sent, 0)
  assert.equal((await quotaOf(db, UID)).quota, 0)
})

test('模板失配（bad-template）→ 记一次失败并早停，后面的账号不再撞同样的错', async () => {
  const { db } = world([
    userRow(UID, { mpOpenid: 'mp-1', promptSubscribeQuota: 1 }),
    userRow(OTHER, { mpOpenid: 'mp-2', promptSubscribeQuota: 1 }),
  ], [promptRow()])
  const mp = mpOf('bad-template')
  const out = await runPromptReminder({ db, now: () => NOW, logger: silent, mp, promptTemplateId: 'tpl-1' })
  assert.equal(mp.calls.length, 1, '只试一个')
  assert.equal(out.subscribe.reason, 'bad-template')
  assert.equal(out.subscribe.failed, 1)
  assert.equal((await quotaOf(db, UID)).quota, 1, '失败不扣额度')
})

test('当日没有可用题目 → 整批零写入，订阅段也不参与', async () => {
  const { db } = world([userRow(UID, { mpOpenid: 'mp-1', promptSubscribeQuota: 5 })], [])
  const mp = mpOf('sent')
  const out = await runPromptReminder({ db, now: () => NOW, logger: silent, mp, promptTemplateId: 'tpl-1' })
  assert.equal(out.promptId, null)
  assert.equal(out.sent, 0)
  assert.equal(out.subscribe, null)
  assert.equal(mp.calls.length, 0)
})
