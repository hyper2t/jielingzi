'use strict'
/**
 * M2 内容安全底座：BE-M2-01 机审（词库 + msgSecCheck）、QA-M2-01 样本集命中率、BE-M2-03 举报 / 折叠 / 队列 / 处理、
 * BE-M2-04 站内通知、处罚生效于 guardWrite、mod_logs 留痕、档案机审。用例索引见 docs/test/cases/M2.md。
 */
const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const S = require('../../cloudfunctions/_shared')
const moderation = require('../../cloudfunctions/moderation/service')
const community = require('../../cloudfunctions/community/service')
const { createFakeDb } = require('./fakeDb')
const SAMPLES = require('./fixtures/moderation-samples.json')

beforeEach(() => S.restoreOwnedCollections())

const DAY = 24 * 3600 * 1000
const NOW = Date.UTC(2026, 9, 1, 4, 0, 0)
const silent = { info() {}, error() {} }
const ADULT = { adultConfirmedAt: 1 }

function world() {
  return createFakeDb({
    unique: { reports: [['targetId', '_openid']], profiles: ['_openid', 'anonAlias'] },
    data: {
      users: [
        { _id: 'uA', _openid: 'A', ...ADULT, phoneVerified: true },
        { _id: 'uR1', _openid: 'R1', ...ADULT },
        { _id: 'uR2', _openid: 'R2', ...ADULT },
        { _id: 'uR3', _openid: 'R3', ...ADULT, mutedUntil: NOW + DAY },
        { _id: 'uKid', _openid: 'Kid' },
        { _id: 'uBan', _openid: 'Ban', ...ADULT, bannedUntil: NOW + DAY },
        { _id: 'uMod', _openid: 'Mod', ...ADULT, role: 'mod' },
        { _id: 'uAdm', _openid: 'Adm', ...ADULT, role: 'admin' },
      ],
      topics: [
        { _id: 't1', _openid: 'A', title: '如何面对练习中的枯燥期', body: '坚持站桩第三年……', status: 'ok' },
        { _id: 't2', _openid: 'Mod', title: '审核员发的帖', body: '……', status: 'ok' },
        { _id: 't3', _openid: null, authorDeleted: true, title: '已注销用户的帖', body: '……', status: 'ok' },
      ],
      replies: [{ _id: 'r1', _openid: 'A', topicId: 't1', body: '我也遇到过', status: 'ok' }],
    },
  })
}
function as(db, accountId, now = NOW) {
  let t = now
  return S.createMain({ actions: moderation.actions, logger: silent, createContext: async () => ({ db, identity: { openid: accountId }, now: () => ++t, logger: silent }) })
}
const codeOf = async (p) => {
  try {
    await p
    return 0
  } catch (e) {
    return e.code
  }
}

// ---------- BE-M2-01 词库 ----------

test('词库：各分类命中样例；拆字 / 全角 / 分隔符规避也能识别；结论取更严', () => {
  const v = (t) => S.verdictOf(S.scanText(t))
  assert.equal(v('想皈依的朋友找我'), 'review')
  assert.equal(v('劝你停药'), 'reject')
  assert.equal(v('医生让我慢慢停药'), 'review', '只出现「停药」不直接拒绝，进人工')
  assert.equal(v('我开天眼了'), 'review')
  assert.equal(v('随喜转账'), 'review')
  assert.equal(v('你个傻逼'), 'review')
  assert.equal(v('加我微信 abc12345'), 'reject')
  assert.equal(v('微 信 号：ｑｗｅｒｔｙ１２３'), 'reject', '全角 + 空格拆字')
  assert.equal(v('电话 139-1234-5678'), 'reject')
  assert.equal(v('见 https://example.com'), 'review')
  assert.equal(v('今天站桩二十分钟'), 'pass')
  assert.deepEqual(S.scanText('劝你停药 加我微信 abc12345').map((h) => h.category).sort(), ['diversion', 'medical', 'medical'])
  assert.equal(S.stricter('review', 'pass'), 'review')
  assert.equal(S.stricter('review', 'reject'), 'reject')
})

test('QA-M2-01 样本集：违规样本命中率 100%（reject 样本必须拒绝），正常样本 0 误杀', () => {
  const report = { total: 0, hit: 0, miss: [], fp: [] }
  for (const s of SAMPLES.violations) {
    report.total++
    const verdict = S.verdictOf(S.scanText(s.text))
    const ok = s.expect === 'reject' ? verdict === 'reject' : verdict !== 'pass'
    if (ok) report.hit++
    else report.miss.push(`${s.category}: ${s.text} → ${verdict}`)
  }
  for (const t of SAMPLES.normal) {
    const verdict = S.verdictOf(S.scanText(t))
    if (verdict !== 'pass') report.fp.push(`${t} → ${verdict} ${JSON.stringify(S.scanText(t))}`)
  }
  const rate = report.hit / report.total
  console.log(`[QA-M2-01] 违规样本 ${report.total} 条，命中 ${report.hit}（${(rate * 100).toFixed(1)}%）；正常样本 ${SAMPLES.normal.length} 条，误杀 ${report.fp.length}`)
  assert.deepEqual(report.miss, [])
  assert.deepEqual(report.fp, [])
  assert.ok(report.total >= 30 && SAMPLES.normal.length >= 20)
})

test('checkText：msgSecCheck 结论叠加（risky→reject、review→review）；无 openid 只用词库；接口失败进人工；长文分段', async () => {
  const calls = []
  const mp = (map) => ({ async msgSecCheck(content, opts) { calls.push({ len: Array.from(content).length, ...opts }); const r = map(content); if (r instanceof Error) throw r; return r } })
  const weapp = (m) => ({ mp: m, identity: { raw: { openId: 'oMini' } } })
  assert.equal((await S.checkText(weapp(mp(() => ({ suggest: 'risky', label: 20002 }))), { scene: 'forum', texts: ['正常文字'] })).verdict, 'reject')
  const rv = await S.checkText(weapp(mp(() => ({ suggest: 'review', label: 21000 }))), { scene: 'comment', texts: ['正常文字'] })
  assert.deepEqual([rv.verdict, rv.labels], ['review', [21000]])
  assert.deepEqual(calls.slice(0, 2).map((c) => [c.scene, c.openid]), [[3, 'oMini'], [2, 'oMini']])
  assert.equal((await S.checkText(weapp(mp(() => ({ suggest: 'pass', label: 100 }))), { scene: 'profile', texts: ['正常文字'] })).verdict, 'pass')
  // 词库已 reject：不再调微信
  const before = calls.length
  assert.equal((await S.checkText(weapp(mp(() => ({ suggest: 'pass' }))), { scene: 'forum', texts: ['加我微信 abc12345'] })).verdict, 'reject')
  assert.equal(calls.length, before)
  // App 用户（无 openid）：只用词库
  assert.equal((await S.checkText({ mp: mp(() => ({ suggest: 'risky' })), identity: { raw: {} } }, { scene: 'forum', texts: ['正常文字'] })).verdict, 'pass')
  // 微信接口失败：不阻断，但进人工
  const err = await S.checkText(weapp(mp(() => S.upstream('x'))), { scene: 'forum', texts: ['正常文字'] })
  assert.deepEqual([err.verdict, err.labels], ['review', ['msgsec_error']])
  // 超过 2500 字分段
  calls.length = 0
  await S.checkText(weapp(mp(() => ({ suggest: 'pass', label: 100 }))), { scene: 'forum', texts: ['静'.repeat(3000)] })
  assert.deepEqual(calls.map((c) => c.len), [2500, 500])
})

test('createMpClient.msgSecCheck：v2 入参（content / version 2 / scene / openid）；未知 suggest 按 review；errcode → 50201', async () => {
  const bodies = []
  const fetchImpl = async (url, init) => {
    const u = new URL(url)
    const body = JSON.parse(init.body)
    if (u.pathname === '/cgi-bin/stable_token') return { json: async () => ({ access_token: 'tk', expires_in: 7200 }) }
    bodies.push(body)
    if (body.content === 'boom') return { json: async () => ({ errcode: 44004, errmsg: 'empty' }) }
    if (body.content === 'odd') return { json: async () => ({ errcode: 0, result: { suggest: 'weird' } }) }
    return { json: async () => ({ errcode: 0, result: { suggest: 'risky', label: 20001 }, trace_id: 'tr1' }) }
  }
  const mp = S.createMpClient({ WX_MP_APP_ID: 'wx', WX_MP_APP_SECRET: 's' }, { fetchImpl })
  assert.deepEqual(await mp.msgSecCheck('文本', { scene: 3, openid: 'o1' }), { suggest: 'risky', label: 20001, traceId: 'tr1' })
  assert.deepEqual(bodies[0], { content: '文本', version: 2, scene: 3, openid: 'o1' })
  assert.equal((await mp.msgSecCheck('odd', { scene: 2, openid: 'o1' })).suggest, 'review')
  await assert.rejects(mp.msgSecCheck('boom', { scene: 2, openid: 'o1' }), (e) => e.code === 50201)
})

test('档案机审：介绍里留微信号 → 40001 且不写档案；疑似违规 → 保存但写 mod_logs 待复核', async () => {
  const db = world()
  const me = S.createMain({ actions: community.actions, logger: silent, createContext: async () => ({ db, identity: { openid: 'R1', raw: {} }, now: () => NOW, logger: silent }) })
  const r = await me({ action: 'updateProfile', bio: '想交流的加我微信 abc12345' })
  assert.equal(r.code, 40001)
  assert.match(r.msg, /社区公约/)
  assert.equal((db.store.profiles || []).length, 0)
  const ok = await me({ action: 'updateProfile', bio: '站桩治愈了我的焦虑' })
  assert.equal(ok.code, 0)
  const logs = db.store.mod_logs.map((l) => [l.kind, l.scene, l.verdict, l.categories.join(), l.subject])
  assert.deepEqual(logs, [['machine', 'profile', 'reject', 'diversion', 'R1'], ['machine', 'profile', 'review', 'medical', 'R1']])
  assert.ok(db.store.mod_logs.every((l) => new Date(l.expireAt).getTime() > NOW + 180 * DAY && !JSON.stringify(l).includes('abc12345')), '保留约 6 个月、日志不含原文')
})

// ---------- BE-M2-03 举报 ----------

test('report：需 18+、不要求实名、禁言中也可举报、封禁不可；不能举报自己；目标不存在 40401；参数校验', async () => {
  const db = world()
  const r1 = await as(db, 'R1')({ action: 'report', targetType: 'topic', targetId: 't1', reason: 'medical', note: '说能治病' })
  assert.deepEqual(r1, { code: 0, data: { ok: true, duplicate: false, folded: false }, msg: 'ok' })
  assert.equal((await as(db, 'R3')({ action: 'report', targetType: 'topic', targetId: 't1', reason: 'spam' })).code, 0, '禁言中也能举报')
  assert.equal((await as(db, 'Kid')({ action: 'report', targetType: 'topic', targetId: 't1', reason: 'spam' })).code, 40303)
  assert.equal((await as(db, 'Ban')({ action: 'report', targetType: 'topic', targetId: 't1', reason: 'spam' })).code, 40304)
  assert.equal((await as(db, null)({ action: 'report', targetType: 'topic', targetId: 't1', reason: 'spam' })).code, 40101)
  assert.equal((await as(db, 'A')({ action: 'report', targetType: 'topic', targetId: 't1', reason: 'spam' })).code, 40001, '不能举报自己')
  assert.equal((await as(db, 'R1')({ action: 'report', targetType: 'reply', targetId: 'nope', reason: 'spam' })).code, 40401)
  assert.equal((await as(db, 'R1')({ action: 'report', targetType: 'topic', targetId: 't1', reason: 'bad-reason' })).code, 40001)
  assert.equal((await as(db, 'R1')({ action: 'report', targetType: 'topic', targetId: 't1', reason: 'spam', note: 'x'.repeat(201) })).code, 40001)
  assert.equal((await as(db, 'R1')({ action: 'report', targetType: 'user', targetId: 't1', reason: 'abuse' })).code, 40001, '举报用户需 contentType')
  assert.equal(db.store.reports[0].note, '说能治病')
})

test('report：同一人对同一目标只计一次（不扣额度）；3 个不同的人举报后自动折叠并留痕；举报用户只进队列、不折叠、不暴露 uid', async () => {
  const db = world()
  const rep = (who, extra = {}) => as(db, who)({ action: 'report', targetType: 'topic', targetId: 't1', reason: 'medical', ...extra })
  await rep('R1')
  assert.deepEqual((await rep('R1')).data, { ok: true, duplicate: true, folded: false })
  assert.equal(db.store.reports.length, 1)
  assert.equal(db.store.rate_limits.find((x) => x._id.startsWith('R1:report')).count, 1, '重复举报不扣额度')
  assert.equal((await rep('R2')).data.folded, false)
  assert.equal((await rep('R3')).data.folded, true)
  assert.equal(db.store.topics.find((t) => t._id === 't1').status, 'folded')
  assert.ok(db.store.mod_logs.some((l) => l.action === 'fold' && l.targetId === 't1' && l.actor === 'system'))
  // 举报用户：服务端解析作者记在 targetUid，内容不折叠
  const u = await as(db, 'R1')({ action: 'report', targetType: 'user', targetId: 'r1', contentType: 'reply', reason: 'abuse' })
  assert.deepEqual(u.data, { ok: true, duplicate: false, folded: false })
  const ur = db.store.reports.find((r) => r.targetType === 'user')
  assert.deepEqual([ur.targetUid, ur.contentType], ['A', 'reply'])
  assert.equal(db.store.replies[0].status, 'ok')
})

test('report：每日 30 次额度（S.DAILY_LIMITS.report）', async () => {
  const topics = Array.from({ length: S.DAILY_LIMITS.report + 1 }, (_, i) => ({ _id: `x${i}`, _openid: 'A', title: 't', body: 'b', status: 'ok' }))
  const db = createFakeDb({ unique: { reports: [['targetId', '_openid']] }, data: { users: [{ _openid: 'R1', ...ADULT }], topics } })
  const me = as(db, 'R1')
  for (let i = 0; i < S.DAILY_LIMITS.report; i++) assert.equal((await me({ action: 'report', targetType: 'topic', targetId: `x${i}`, reason: 'spam' })).code, 0)
  assert.equal((await me({ action: 'report', targetType: 'topic', targetId: `x${S.DAILY_LIMITS.report}`, reason: 'spam' })).code, 42901)
})

// ---------- 审核队列 / 处理 ----------

test('queue：仅 mod / admin；按目标聚合（人数、原因分布、补充说明）、按人数排序；不含任何作者 / 举报人标识', async () => {
  const db = world()
  for (const who of ['R1', 'R2']) await as(db, who)({ action: 'report', targetType: 'topic', targetId: 't1', reason: who === 'R1' ? 'medical' : 'spam', note: `${who} 的说明` })
  await as(db, 'R1')({ action: 'report', targetType: 'reply', targetId: 'r1', reason: 'abuse' })
  assert.equal((await as(db, 'R1')({ action: 'queue' })).code, 40301)
  assert.equal((await as(db, null)({ action: 'queue' })).code, 40101)
  const q = await as(db, 'Mod')({ action: 'queue' })
  assert.equal(q.code, 0)
  assert.deepEqual(q.data.list.map((i) => [i.targetType, i.targetId, i.count]), [['topic', 't1', 2], ['reply', 'r1', 1]])
  assert.deepEqual(q.data.list[0].reasons, { medical: 1, spam: 1 })
  assert.deepEqual(q.data.list[0].notes.sort(), ['R1 的说明', 'R2 的说明'])
  assert.deepEqual(q.data.list[0].target, { status: 'ok', excerpt: '如何面对练习中的枯燥期', anon: false, authorDeleted: false })
  const json = JSON.stringify(q.data)
  for (const id of ['"A"', '"R1"', '"R2"', '_openid', 'targetUid']) assert.ok(!json.includes(id), `不应包含 ${id}`)
  assert.equal((await as(db, 'Adm')({ action: 'queue', page: 2, size: 1 })).data.list[0].targetId, 'r1')
})

test('decide remove：内容删除、举报关闭、通知作者与举报人（不含原文）、写 mod_logs；dismiss 恢复折叠内容；restore', async () => {
  const db = world()
  for (const who of ['R1', 'R2', 'R3']) await as(db, who)({ action: 'report', targetType: 'topic', targetId: 't1', reason: 'medical' })
  assert.equal(db.store.topics[0].status, 'folded')
  const d = await as(db, 'Mod')({ action: 'decide', targetType: 'topic', targetId: 't1', decision: 'remove', note: '疗效承诺' })
  assert.deepEqual(d.data, { ok: true, resolved: 3, status: 'removed' })
  assert.equal(db.store.topics[0].status, 'removed')
  assert.ok(db.store.reports.every((r) => r.state === 'resolved' && r.result === 'remove' && r.handledBy === 'Mod'))
  const notes = db.store.notifications.map((n) => [n._openid, n.type, n.refType, n.read])
  assert.deepEqual(notes.sort(), [['A', 'moderation', 'topic', false], ['R1', 'moderation', 'report', false], ['R2', 'moderation', 'report', false], ['R3', 'moderation', 'report', false]])
  assert.ok(db.store.notifications.every((n) => !n.text.includes('枯燥期')), '通知不含原文')
  assert.ok(db.store.mod_logs.some((l) => l.kind === 'manual' && l.action === 'remove' && l.actor === 'Mod' && l.subject === 'A' && l.note === '疗效承诺'))
  // 驳回：折叠内容恢复为 ok，不通知
  await as(db, 'R1')({ action: 'report', targetType: 'reply', targetId: 'r1', reason: 'spam' })
  await db.collection('replies').doc('r1').update({ status: 'folded' })
  const n0 = db.store.notifications.length
  assert.deepEqual((await as(db, 'Mod')({ action: 'decide', targetType: 'reply', targetId: 'r1', decision: 'dismiss' })).data, { ok: true, resolved: 1, status: 'ok' })
  assert.equal(db.store.replies[0].status, 'ok')
  assert.equal(db.store.notifications.length, n0)
  // 恢复已删除内容
  assert.equal((await as(db, 'Mod')({ action: 'decide', targetType: 'topic', targetId: 't1', decision: 'restore' })).data.status, 'ok')
  assert.equal((await as(db, 'R1')({ action: 'decide', targetType: 'topic', targetId: 't1', decision: 'remove' })).code, 40301)
  assert.equal((await as(db, 'Mod')({ action: 'decide', targetType: 'topic', targetId: 'zzz', decision: 'remove' })).code, 40401)
})

test('decide mute / ban：处罚立即生效于 guardWrite（40305 / 40304）；禁言 1–30 天；mod 不能处罚审核员，admin 可以；作者已注销不能处罚', async () => {
  const db = world()
  await as(db, 'R1')({ action: 'report', targetType: 'user', targetId: 't1', contentType: 'topic', reason: 'abuse' })
  assert.equal((await as(db, 'Mod')({ action: 'decide', targetType: 'user', targetId: 't1', contentType: 'topic', decision: 'mute', days: 31 })).code, 40001)
  assert.equal((await as(db, 'Mod')({ action: 'decide', targetType: 'user', targetId: 't1', contentType: 'topic', decision: 'mute' })).code, 40001)
  assert.equal((await as(db, 'Mod')({ action: 'decide', targetType: 'user', targetId: 't1', contentType: 'topic', decision: 'remove' })).code, 40001, '举报用户不能删除内容')
  const m = await as(db, 'Mod')({ action: 'decide', targetType: 'user', targetId: 't1', contentType: 'topic', decision: 'mute', days: 7 })
  assert.equal(m.code, 0)
  const a = db.store.users.find((u) => u._openid === 'A')
  assert.ok(a.mutedUntil > NOW + 6 * DAY && a.mutedUntil < NOW + 8 * DAY)
  const gctx = { db, identity: { openid: 'A' }, now: () => NOW + 1000 }
  assert.equal(await codeOf(S.guardWrite(gctx, 'createTopic')), 40305)
  assert.ok(db.store.notifications.some((n) => n._openid === 'A' && /禁言 7 天/.test(n.text)))
  // 永久封禁（不传天数）
  assert.equal((await as(db, 'Mod')({ action: 'decide', targetType: 'topic', targetId: 't1', decision: 'ban' })).code, 0)
  assert.equal(await codeOf(S.guardWrite(gctx, 'createTopic')), 40304)
  assert.ok(db.store.notifications.some((n) => n._openid === 'A' && /永久封禁/.test(n.text)))
  // 处罚取较晚：短期禁言不会缩短已有的更长处罚
  const before = db.store.users.find((u) => u._openid === 'A').bannedUntil
  await as(db, 'Mod')({ action: 'decide', targetType: 'topic', targetId: 't1', decision: 'ban', days: 1 })
  assert.equal(db.store.users.find((u) => u._openid === 'A').bannedUntil, before)
  // mod 不能处罚审核员；admin 可以
  assert.equal((await as(db, 'Mod')({ action: 'decide', targetType: 'topic', targetId: 't2', decision: 'mute', days: 3 })).code, 40301)
  assert.equal((await as(db, 'Adm')({ action: 'decide', targetType: 'topic', targetId: 't2', decision: 'mute', days: 3 })).code, 0)
  assert.equal((await as(db, 'Mod')({ action: 'decide', targetType: 'topic', targetId: 't3', decision: 'mute', days: 3 })).code, 40001, '作者已注销')
})

test('notify：未知 type 报错；没有接收人不写；cloudbaserc：community 注入小程序凭证（msgSecCheck）', async () => {
  const db = createFakeDb()
  await assert.rejects(S.notify(db, { uid: 'A', type: 'ad', text: 'x', now: 1 }), /未知 type/)
  assert.equal(await S.notify(db, { uid: null, type: 'moderation', text: 'x', now: 1 }), false)
  assert.equal(await S.notify(db, { uid: 'A', type: 'reply', text: 'x', now: 1 }), true)
  assert.deepEqual(db.store.notifications.map((n) => [n._openid, n.type, n.read]), [['A', 'reply', false]])
  const rc = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../cloudbaserc.json'), 'utf8'))
  assert.deepEqual(Object.keys(rc.functions.find((f) => f.name === 'community').envVariables).sort(), ['WX_MP_APP_ID', 'WX_MP_APP_SECRET'])
  assert.deepEqual(S.REPORT_REASONS.map((r) => r.id).length, new Set(S.REPORT_REASONS.map((r) => r.id)).size)
})
