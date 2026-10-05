import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { auditCircles, findCircle, formatCode, grantMember, issueCodes, loadSeed, migrateTopics, parseArgs, recountCircles, seedCircles, validateSeed } from './circles.mjs'
const require = createRequire(import.meta.url)
const S = require('../../cloudfunctions/_shared')
const community = require('../../cloudfunctions/community/service')
const { scanText, verdictOf } = require('../../cloudfunctions/_shared/wordlist.js')
const { createFakeDb } = require('../../tests/cloudfunctions/fakeDb.js')
const { CIRCLE_UNIQUE, circleDoc, memberDoc, inviteDoc } = require('../../tests/cloudfunctions/circleFixtures.js')
const DAY = 24 * 3600 * 1000
const NOW = Date.UTC(2026, 9, 1, 4, 0, 0)
const silent = { info () {}, error () {} }

test('circles parseArgs：命令必填；grant 要 --circle 且账号三选一；issue 要 --count（1–100）与合法有效期；migrate-topics 要 --to；未知参数报错', () => {
  assert.throws(() => parseArgs([]), /用法/)
  assert.throws(() => parseArgs(['nope']), /用法/)
  assert.deepEqual(parseArgs(['seed']), { cmd: 'seed', circle: null, account: null, phone: null, latest: false, count: null, ttlDays: 7, to: null, apply: false })
  assert.equal(parseArgs(['seed', '--apply']).apply, true)
  assert.equal(parseArgs(['audit']).cmd, 'audit')
  assert.equal(parseArgs(['recount', '--apply']).apply, true)
  const g = parseArgs(['grant', '--circle', 'mindful', '--account', 'oA'])
  assert.deepEqual([g.circle, g.account, g.apply], ['mindful', 'oA', false])
  assert.equal(parseArgs(['grant', '--circle', 'mindful', '--latest', '--apply']).latest, true)
  assert.equal(parseArgs(['grant', '--circle', 'mindful', '--phone', '13800138000']).phone, '13800138000')
  assert.throws(() => parseArgs(['grant', '--account', 'oA']), /--circle/)
  assert.throws(() => parseArgs(['grant', '--circle', 'mindful']), /之一/)
  assert.throws(() => parseArgs(['grant', '--circle', 'mindful', '--account', 'oA', '--latest']), /之一/)
  assert.throws(() => parseArgs(['grant', '--circle', 'mindful', '--phone', '123']), /11 位/)
  const i = parseArgs(['issue', '--circle', 'mindful', '--count', '5', '--ttl-days', '14'])
  assert.deepEqual([i.count, i.ttlDays], [5, 14])
  assert.equal(parseArgs(['issue', '--circle', 'mindful', '--count', '5']).ttlDays, 7)
  assert.throws(() => parseArgs(['issue', '--count', '5']), /--circle/)
  assert.throws(() => parseArgs(['issue', '--circle', 'mindful']), /--count/)
  assert.throws(() => parseArgs(['issue', '--circle', 'mindful', '--count', '0']), /--count/)
  assert.throws(() => parseArgs(['issue', '--circle', 'mindful', '--count', '101']), /--count/)
  assert.throws(() => parseArgs(['issue', '--circle', 'mindful', '--count', 'x']), /正整数/)
  assert.throws(() => parseArgs(['issue', '--circle', 'mindful', '--count', '1', '--ttl-days', '31']), /--ttl-days/)
  assert.throws(() => parseArgs(['issue', '--circle', 'mindful', '--count', '1', '--ttl-days', '0']), /--ttl-days/)
  assert.equal(parseArgs(['migrate-topics', '--to', 'mindful']).to, 'mindful')
  assert.throws(() => parseArgs(['migrate-topics']), /--to/)
  assert.throws(() => parseArgs(['seed', '--nope']), /未知参数/)
})

test('circles.seed.json：3 个官方圈子，字段合法；名称 / 简介 / 公约过站内词库且不含宗教名称（wording.md §1、§2）', () => {
  const list = loadSeed()
  assert.deepEqual(list.map((c) => c.slug), ['mindful', 'tradition', 'lifestyle'])
  assert.deepEqual(list.map((c) => c.name), ['静观练习', '传统养生', '正念生活'])
  for (const c of list) {
    assert.equal(c.rules.length, 3)
    for (const t of [c.name, c.desc, ...c.rules]) {
      assert.equal(verdictOf(scanText(t)), 'pass', `词库未通过：${t}`)
      assert.ok(!/佛|禅|道教|道家|基督|伊斯兰|法轮|耶稣/.test(t), `含宗教名称：${t}`)
    }
  }
})

test('validateSeed：slug 格式 / 重复、名称简介公约长度与条数、cover、sort 都要校验', () => {
  const ok = { slug: 'mindful', name: '静观练习', desc: '简介', cover: 'circle:mindful', sort: 1, rules: ['一条公约'] }
  assert.equal(validateSeed([ok]).length, 1)
  assert.throws(() => validateSeed([]), /没有圈子/)
  assert.throws(() => validateSeed([{ ...ok, slug: 'Mindful' }]), /slug/)
  assert.throws(() => validateSeed([ok, ok]), /重复/)
  assert.throws(() => validateSeed([{ ...ok, name: '' }]), /name/)
  assert.throws(() => validateSeed([{ ...ok, name: '一二三四五六七八九十一二三' }]), /name/)
  assert.throws(() => validateSeed([{ ...ok, desc: '字'.repeat(61) }]), /desc/)
  assert.equal(validateSeed([{ ...ok, desc: '字'.repeat(60) }]).length, 1)
  assert.throws(() => validateSeed([{ ...ok, rules: Array(6).fill('公约') }]), /最多 5 条/)
  assert.throws(() => validateSeed([{ ...ok, rules: ['字'.repeat(61)] }]), /每条公约/)
  assert.throws(() => validateSeed([{ ...ok, rules: [' '] }]), /每条公约/)
  assert.throws(() => validateSeed([{ ...ok, cover: 'circle:other' }]), /cover/)
  assert.equal(validateSeed([{ ...ok, cover: null }]).length, 1)
  assert.throws(() => validateSeed([{ ...ok, sort: 1.5 }]), /sort/)
})

test('seed：预览不写；--apply 建 3 个（成员数 / 话题数 0、open）；再跑一遍无变化；改名只更新有差异的字段，不动计数与状态', async () => {
  const db = createFakeDb({ unique: CIRCLE_UNIQUE })
  const seed = loadSeed()
  const preview = await seedCircles(db, seed, { apply: false, now: NOW })
  assert.deepEqual(preview.map((p) => [p.slug, p.action]), [['mindful', 'create'], ['tradition', 'create'], ['lifestyle', 'create']])
  assert.equal((db.store.circles || []).length, 0)
  await seedCircles(db, seed, { apply: true, now: NOW })
  assert.equal(db.store.circles.length, 3)
  const m = db.store.circles.find((c) => c.slug === 'mindful')
  assert.deepEqual([m.status, m.memberCount, m.topicCount, m.createdAt, m.cover, m.sort], ['open', 0, 0, NOW, 'circle:mindful', 1])
  assert.deepEqual(m.rules, seed[0].rules)
  assert.deepEqual((await seedCircles(db, seed, { apply: true, now: NOW + 1 })).map((p) => p.action), ['same', 'same', 'same'])
  assert.equal(m.updatedAt, undefined, '无变化不写')
  // 运行期状态：计数与关闭状态由别的流程维护，种子不能覆盖
  m.memberCount = 7
  m.topicCount = 9
  const t = db.store.circles.find((c) => c.slug === 'tradition')
  t.status = 'closed'
  const renamed = seed.map((c) => (c.slug === 'mindful' ? { ...c, name: '静观与练习', rules: [...c.rules, '新增一条'] } : c))
  const plan = await seedCircles(db, renamed, { apply: true, now: NOW + 2 })
  assert.deepEqual(plan.map((p) => [p.slug, p.action]), [['mindful', 'update'], ['tradition', 'same'], ['lifestyle', 'same']])
  assert.deepEqual(plan[0].fields, ['name', 'rules'])
  assert.deepEqual([m.name, m.rules.length, m.memberCount, m.topicCount, m.updatedAt], ['静观与练习', 4, 7, 9, NOW + 2])
  assert.equal(t.status, 'closed')
  assert.equal(db.store.circles.length, 3, '按 slug upsert，不重复建')
})

test('grant：预览不写；--apply 写成员关系（invitedBy = null）并 memberCount +1；重复执行不重复计数；账号 / 圈子不存在、圈子已关闭报错', async () => {
  const db = createFakeDb({ unique: CIRCLE_UNIQUE, data: { users: [{ _openid: 'acct-a' }], circles: [circleDoc({ slug: 'mindful', memberCount: 1 }), circleDoc({ slug: 'old', status: 'closed' })] } })
  const at = { circle: 'mindful', accountId: 'acct-a' }
  assert.deepEqual(await grantMember(db, at, { apply: false, now: NOW }), { status: 'joined', circle: 'mindful' })
  assert.equal((db.store.memberships || []).length, 0)
  await grantMember(db, at, { apply: true, now: NOW })
  assert.deepEqual(db.store.memberships, [{ _id: db.store.memberships[0]._id, circleId: 'circle-mindful', _openid: 'acct-a', joinedAt: NOW, invitedBy: null, inviteCode: null, role: 'member' }])
  assert.equal(db.store.circles[0].memberCount, 2)
  assert.deepEqual(await grantMember(db, at, { apply: true, now: NOW }), { status: 'already', circle: 'mindful' })
  assert.equal(db.store.circles[0].memberCount, 2)
  assert.equal(db.store.memberships.length, 1)
  await assert.rejects(grantMember(db, { circle: 'mindful', accountId: 'nobody' }, { apply: true }), /账号不存在/)
  await assert.rejects(grantMember(db, { circle: 'nope', accountId: 'acct-a' }, { apply: true }), /不存在/)
  await assert.rejects(grantMember(db, { circle: 'old', accountId: 'acct-a' }, { apply: true }), /已关闭/)
})

test('issue：预览不生成；--apply 签发官方码（无归属、不占名额、7 天）；码可直接被 community.redeemInvite 兑换入圈（脚本与云函数联调）', async () => {
  const db = createFakeDb({
    unique: { profiles: ['_openid', 'anonAlias'], ...CIRCLE_UNIQUE },
    data: { users: [{ _openid: 'acct-new', adultConfirmedAt: 1, phoneVerified: true }], circles: [circleDoc({ slug: 'mindful', memberCount: 0 })] },
  })
  const preview = await issueCodes(db, { circle: 'mindful', count: 2, ttlDays: 7 }, { apply: false, now: NOW })
  assert.deepEqual(preview, { circle: 'mindful', count: 2, codes: [] })
  assert.equal((db.store.invites || []).length, 0)
  // 第一个码撞码一次后重试
  const seq = [...Array(8).fill(0), ...Array(8).fill(0), ...Array(8).fill(0.999)]
  let n = 0
  const r = await issueCodes(db, { circle: 'mindful', count: 2, ttlDays: 14 }, { apply: true, now: NOW, random: () => seq[n++] })
  assert.deepEqual(r.codes, ['00000000', 'ZZZZZZZZ'])
  assert.equal(formatCode(r.codes[1]), 'ZZZZ-ZZZZ')
  for (const i of db.store.invites) {
    assert.deepEqual([i._openid, i.official, i.usedBy, i.refunded, i.createdAt, i.expiresAt, i.circleId], [null, true, null, false, NOW, NOW + 14 * DAY, 'circle-mindful'])
  }
  assert.equal(db.store.users[0].inviteQuota, undefined, '官方码不占任何名额')
  // 联调：新用户用官方码入圈
  const as = S.createMain({ actions: community.actions, logger: silent, createContext: async () => ({ db, identity: { openid: 'acct-new' }, now: () => NOW + 1000, logger: silent }) })
  const joined = await as({ action: 'redeemInvite', code: 'zzzz-zzzz' })
  assert.equal(joined.code, 0)
  assert.equal(db.store.memberships[0].invitedBy, null)
  assert.equal(db.store.circles[0].memberCount, 1)
  // 不存在 / 已关闭
  await assert.rejects(issueCodes(db, { circle: 'nope', count: 1, ttlDays: 7 }, { apply: true }), /不存在/)
})

test('issue：随机源一直撞码时不会死循环', async () => {
  const db = createFakeDb({ unique: CIRCLE_UNIQUE, data: { circles: [circleDoc({ slug: 'mindful' })] } })
  await assert.rejects(issueCodes(db, { circle: 'mindful', count: 2, ttlDays: 7 }, { apply: true, now: NOW, random: () => 0 }), /撞码/)
  assert.equal(db.store.invites.length, 1)
})

test('audit：旧话题 / 旧回复（circleId 为空或缺失）、各圈子计数偏差、名额异常、邀请码概况；只读', async () => {
  const t = (id, circleId, status = 'ok') => ({ _id: id, circleId, status })
  const noField = { _id: 'legacy-missing', status: 'ok' }
  const db = createFakeDb({
    data: {
      circles: [circleDoc({ slug: 'mindful', sort: 1, memberCount: 3, topicCount: 2 }), circleDoc({ slug: 'tradition', sort: 2, memberCount: 1, topicCount: 0 })],
      memberships: [memberDoc('circle-mindful', 'a'), memberDoc('circle-mindful', 'b'), memberDoc('circle-tradition', 'a')],
      topics: [t('t1', 'circle-mindful'), t('t2', 'circle-mindful'), t('t3', 'circle-mindful', 'removed'), t('legacy-null', null), noField],
      replies: [{ _id: 'r1', circleId: null }, { _id: 'r2', circleId: 'circle-mindful' }],
      users: [{ _openid: 'acct-ok-0001', inviteQuota: 2 }, { _openid: 'acct-bad-neg-001', inviteQuota: -1 }, { _openid: 'acct-bad-frac-01', inviteQuota: 1.5 }, { _openid: 'acct-none' }],
      invites: [
        inviteDoc('ACTIVE01', 'circle-mindful', 'a', { now: NOW }),
        inviteDoc('OFFICE01', 'circle-mindful', null, { now: NOW }),
        inviteDoc('USED0001', 'circle-mindful', 'a', { now: NOW, usedBy: 'b' }),
        inviteDoc('EXPRED01', 'circle-mindful', 'a', { now: NOW - 10 * DAY }),
      ],
    },
  })
  const before = JSON.stringify(db.store)
  const r = await auditCircles(db, { now: NOW + 1 })
  assert.deepEqual(r.legacy, { topics: 2, replies: 1 })
  assert.deepEqual(r.circles.map((c) => [c.slug, c.memberCount, c.members, c.topicCount, c.topics, c.drift]), [['mindful', 3, 2, 2, 2, true], ['tradition', 1, 1, 0, 0, false]])
  assert.deepEqual(r.quotaAnomalies.map((q) => q.value).sort(), [-1, 1.5])
  assert.ok(r.quotaAnomalies.every((q) => q.account.includes('…') || q.account.length <= 10), '账号只显示首尾')
  assert.deepEqual(r.invites, { active: 2, used: 1, expired: 1, officialActive: 1 })
  assert.equal(JSON.stringify(db.store), before, 'audit 不写库')
  // 空库（集合都不存在）也不报错
  const empty = await auditCircles(createFakeDb({ strictCollections: true }), { now: NOW })
  assert.deepEqual([empty.legacy.topics, empty.circles.length, empty.invites.active], [0, 0, 0])
})

test('recount：按明细重算 memberCount / topicCount（只数 status = ok 的话题）；预览不写；幂等', async () => {
  const db = createFakeDb({
    data: {
      circles: [circleDoc({ slug: 'mindful', memberCount: 9, topicCount: 9 }), circleDoc({ slug: 'tradition', memberCount: 1, topicCount: 1 })],
      memberships: [memberDoc('circle-mindful', 'a'), memberDoc('circle-mindful', 'b'), memberDoc('circle-tradition', 'a')],
      topics: [{ _id: 't1', circleId: 'circle-mindful', status: 'ok' }, { _id: 't2', circleId: 'circle-mindful', status: 'pending' }, { _id: 't3', circleId: 'circle-tradition', status: 'ok' }],
    },
  })
  const preview = await recountCircles(db, { apply: false })
  assert.deepEqual(preview.map((c) => [c.slug, c.memberCount, c.topicCount, c.changed]), [['mindful', [9, 2], [9, 1], true], ['tradition', [1, 1], [1, 1], false]])
  assert.equal(db.store.circles[0].memberCount, 9)
  await recountCircles(db, { apply: true })
  assert.deepEqual(db.store.circles.map((c) => [c.memberCount, c.topicCount]), [[2, 1], [1, 1]])
  assert.ok((await recountCircles(db, { apply: true })).every((c) => !c.changed))
})

test('migrate-topics：预览只报数量；--apply 把无圈子的话题与回复归到指定圈子，不动已有圈子的；之后成员能读到；幂等', async () => {
  const db = createFakeDb({
    unique: { profiles: ['_openid', 'anonAlias'], ...CIRCLE_UNIQUE },
    data: {
      circles: [circleDoc({ slug: 'mindful' }), circleDoc({ slug: 'tradition' })],
      memberships: [memberDoc('circle-mindful', 'acct-a')],
      users: [{ _openid: 'acct-a', adultConfirmedAt: 1, phoneVerified: true }],
      topics: [
        { _id: 'old1', _openid: 'x', circleId: null, title: '旧话题一', body: '正文', status: 'ok', createdAt: 1, anon: false, replyCount: 0 },
        { _id: 'old2', _openid: 'x', title: '旧话题二', body: '正文', status: 'ok', createdAt: 2, anon: false, replyCount: 0 },
        { _id: 'keep', _openid: 'x', circleId: 'circle-tradition', title: '别的圈子', body: '正文', status: 'ok', createdAt: 3, anon: false, replyCount: 0 },
      ],
      replies: [{ _id: 'r1', topicId: 'old1', circleId: null, status: 'ok' }, { _id: 'r2', topicId: 'keep', circleId: 'circle-tradition', status: 'ok' }],
    },
  })
  const as = S.createMain({ actions: community.actions, logger: silent, createContext: async () => ({ db, identity: { openid: 'acct-a' }, now: () => NOW, logger: silent }) })
  assert.equal((await as({ action: 'listTopics' })).data.total, 0, '迁移前旧话题不可见')
  assert.deepEqual(await migrateTopics(db, { to: 'mindful' }, { apply: false }), { to: 'mindful', topics: 2, replies: 1 })
  assert.equal(db.store.topics[0].circleId, null)
  await migrateTopics(db, { to: 'mindful' }, { apply: true })
  assert.deepEqual(db.store.topics.map((t) => t.circleId), ['circle-mindful', 'circle-mindful', 'circle-tradition'])
  assert.deepEqual(db.store.replies.map((r) => r.circleId), ['circle-mindful', 'circle-tradition'])
  assert.deepEqual((await as({ action: 'listTopics' })).data.list.map((t) => t.title).sort(), ['旧话题一', '旧话题二'])
  assert.deepEqual(await migrateTopics(db, { to: 'mindful' }, { apply: true }), { to: 'mindful', topics: 0, replies: 0 })
  await assert.rejects(migrateTopics(db, { to: 'nope' }, { apply: true }), /不存在/)
  assert.equal((await findCircle(db, 'mindful'))._id, 'circle-mindful')
})
