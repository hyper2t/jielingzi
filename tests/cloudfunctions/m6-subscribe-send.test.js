'use strict'
/**
 * mp.subscribeMessageSend（D14 订阅通道的底层件）：只测「请求形状 + errcode 分类」。
 * 额度记录与扣减不在这里——那要先定字段与事务，见 docs/prd/m6-plan.md §8 的 D09b 前提。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMpClient } = require('../../cloudfunctions/_shared/wxmp')

const ENV = { WX_MP_APP_ID: 'wx-app-id', WX_MP_APP_SECRET: 'mp-secret' }

function harness ({ send, token } = {}) {
  const calls = []
  let sent = 0
  const sendImpl = send || (() => ({ errcode: 0, errmsg: 'ok' }))
  const tokenImpl = token || ((body) => ({ access_token: body.force_refresh ? 'tok2' : 'tok1', expires_in: 7200 }))
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body)
    if (url.includes('/cgi-bin/stable_token')) {
      calls.push({ kind: 'token', url, body })
      return { json: async () => tokenImpl(body) }
    }
    sent += 1
    calls.push({ kind: 'send', url, body, n: sent })
    return { json: async () => sendImpl(sent) }
  }
  return { client: createMpClient(ENV, { fetchImpl }), calls }
}

test('未配置小程序凭证 → createMpClient 返回 null，订阅发送自然不存在', () => {
  assert.equal(createMpClient({}, { fetchImpl: async () => ({ json: async () => ({}) }) }), null)
})

test('发送成功：先取 token 再打 subscribe/send，touser 去空格、data 值统一转字符串', async () => {
  const { client, calls } = harness()
  const out = await client.subscribeMessageSend({
    toUser: '  ope-1  ',
    templateId: ' tpl-1 ',
    page: 'pkg-practice/pages/prompt/index',
    data: { thing1: '今天的每日一题', number2: 3, thing3: null, thing4: undefined },
  })
  assert.deepEqual(out, { outcome: 'sent', errcode: 0 })
  assert.deepEqual(calls.map((c) => c.kind), ['token', 'send'])
  assert.match(calls[1].url, /\/cgi-bin\/message\/subscribe\/send\?access_token=tok1$/)
  assert.deepEqual(calls[1].body, {
    touser: 'ope-1',
    template_id: 'tpl-1',
    lang: 'zh_CN',
    page: 'pkg-practice/pages/prompt/index',
    miniprogram_state: 'formal',
    data: { thing1: { value: '今天的每日一题' }, number2: { value: '3' }, thing3: { value: '' }, thing4: { value: '' } },
  })
})

test('page / miniprogramState 为空时不带这两个字段', async () => {
  const { client, calls } = harness()
  await client.subscribeMessageSend({ toUser: 'ope-1', templateId: 'tpl-1', data: { thing1: 'x' }, miniprogramState: '' })
  assert.equal('page' in calls[1].body, false)
  assert.equal('miniprogram_state' in calls[1].body, false)
})

test('errcode 分类：43101 是没额度（正常结果），40037 / 47003 是模板或参数问题，其它算失败', async () => {
  const cases = [[43101, 'no-quota'], [40037, 'bad-template'], [47003, 'bad-template'], [45009, 'failed'], [-1, 'failed']]
  for (const [errcode, outcome] of cases) {
    const { client } = harness({ send: () => ({ errcode, errmsg: 'x'.repeat(200) }) })
    const out = await client.subscribeMessageSend({ toUser: 'o', templateId: 't', data: {} })
    assert.equal(out.outcome, outcome, `errcode ${errcode} 应归为 ${outcome}`)
    if (outcome === 'sent' || outcome === 'no-quota') assert.equal(out.errmsg, undefined)
    else assert.ok(out.errmsg.length <= 64, 'errmsg 要截断，别把微信原文整条灌进日志')
  }
})

test('token 失效自动强刷并重试一次，只算一次成功发送', async () => {
  const { client, calls } = harness({ send: (n) => (n === 1 ? { errcode: 40001, errmsg: 'invalid credential' } : { errcode: 0 }) })
  const out = await client.subscribeMessageSend({ toUser: 'o', templateId: 't', data: {} })
  assert.deepEqual(out, { outcome: 'sent', errcode: 0 })
  assert.deepEqual(calls.map((c) => `${c.kind}${c.body && c.body.force_refresh ? ':force' : ''}`), ['token', 'send', 'token:force', 'send'])
})

test('缺收件人或模板 ID → 参数错，且一个请求都不发', async () => {
  const { client, calls } = harness()
  await assert.rejects(() => client.subscribeMessageSend({ templateId: 't', data: {} }), /订阅消息缺少收件人或模板 ID/)
  await assert.rejects(() => client.subscribeMessageSend({ toUser: 'o', data: {} }), /订阅消息缺少收件人或模板 ID/)
  assert.equal(calls.length, 0)
})
