import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReport, extractJson, formatReport, parseCycle } from './usage.ts'
import { exportAll, verifyBackup, planRestore, restore, compareRestore, memoryStore, DRILL_SUFFIX } from './backup.ts'

const CLI = `✔ Authorization login successful!
ℹ Current billing cycle: 2026-09-26 ~ 2026-10-26
{"data":{"Usages":[{"CreditsValue":2.86,"EnvId":"env-1","MetricUsageDetail":[
 {"ResourceType":"FLEXDB","MetricName":"ReadRequests","Unit":"次","Value":2260,"CreditsValue":2.26,"ValueDetailList":[{"CalcTime":"2026-09-27 00:00:00","CreditsValue":2},{"CalcTime":"2026-09-28 00:00:00","CreditsValue":0.26}]},
 {"ResourceType":"CDN","MetricName":"Flux","Unit":"GB","Value":0.1,"CreditsValue":0.6,"ValueDetailList":[{"CalcTime":"2026-09-28 00:00:00","CreditsValue":0.6}]},
 {"ResourceType":"FLEXDB","MetricName":"Capacity","Unit":"MB","Value":0,"CreditsValue":0}]}]}}`

const NOW = Date.parse('2026-09-28T12:00:00+08:00')

test('usage：解析 CLI 输出、排序、按天合计、推算', () => {
  const r = buildReport(extractJson(CLI), { cycle: parseCycle(CLI), now: NOW })
  assert.equal(r.envId, 'env-1')
  assert.equal(r.used, 2.86)
  assert.deepEqual(r.rows.map(x => x.metric), ['ReadRequests', 'Flux', 'Capacity'])
  assert.deepEqual(r.daily, [{ date: '2026-09-27', credits: 2 }, { date: '2026-09-28', credits: 0.86 }])
  assert.deepEqual(r.cycle, { start: '2026-09-26', end: '2026-10-26', elapsedDays: 3, totalDays: 30 })
  assert.equal(r.projected, 28.6)
  assert.equal(r.level, 'ok')
  assert.match(formatReport(r), /资源点 2\.86 \/ 40000/)
})

test('usage：70% 预警、90% 严重、推算超额也预警', () => {
  const j = (v: number) => ({ data: { Usages: [{ CreditsValue: v, MetricUsageDetail: [] }] } })
  assert.equal(buildReport(j(28000)).level, 'warn')
  assert.equal(buildReport(j(36000)).level, 'critical')
  assert.equal(buildReport(j(27999)).level, 'ok')
  // 第 3 天已用 5000 → 推算 50000 > 额度
  assert.equal(buildReport(j(5000), { cycle: { start: '2026-09-26', end: '2026-10-26' }, now: NOW }).level, 'warn')
  assert.match(formatReport(buildReport(j(28000))), /预警/)
  assert.throws(() => extractJson('no json'))
})

const seed = () => ({
  users: [{ _id: 'a1', title: '原值', status: 'draft', tags: ['x'] }, { _id: 'a2', title: '其他', status: 'online' }],
  account_links: Array.from({ length: 2500 }, (_, i) => ({ _id: `e${i}`, index: i }))
})

test('backup：全量导出分页、manifest、校验；缺失集合记 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bk-'))
  const store = memoryStore(seed())
  const { dir: out, manifest } = await exportAll(store, { dir, envId: 'env-1', now: NOW })
  assert.equal(manifest.collections.account_links, 2500)
  assert.equal(manifest.collections.account_merges, 0)
  assert.equal(verifyBackup(out).ok, true)
  writeFileSync(join(out, 'users.json'), JSON.stringify([{ _id: 'a1' }, { _id: 'a1' }, { title: 'x' }]))
  const bad = verifyBackup(out)
  assert.equal(bad.ok, false)
  assert.equal(bad.problems.length, 3)
})

test('backup 演练：还原到 _restore_drill 新集合并逐条比对；正式集合须 --overwrite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bk-'))
  const store = memoryStore(seed())
  const { dir: out } = await exportAll(store, { dir, envId: 'env-1', now: NOW })
  const plan = await planRestore(store, { dir: out, collection: 'users' })
  assert.deepEqual(plan, { collection: 'users', target: `users${DRILL_SUFFIX}`, docs: 2, createTarget: true, isLive: false })
  await restore(store, plan, { dir: out, backupDir: dir, envId: 'env-1' })
  assert.equal((await compareRestore(store, out, 'users', plan.target)).ok, true)
  // 演练目标已有数据：拒绝
  await assert.rejects(planRestore(store, { dir: out, collection: 'users' }), /已有数据/)
  // 正式集合：不带 overwrite 拒绝
  await assert.rejects(planRestore(store, { dir: out, collection: 'users', to: 'users' }), /overwrite/)
  await assert.rejects(planRestore(store, { dir: out, collection: 'nope' }), /未知集合/)
})

test('backup：覆盖正式集合前先导出当前数据，恢复被误改的文档', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bk-'))
  const store = memoryStore(seed())
  const { dir: out } = await exportAll(store, { dir, envId: 'env-1', now: NOW })
  await store.set('users', { _id: 'a1', title: '误改', status: 'online' })
  const plan = await planRestore(store, { dir: out, collection: 'users', to: 'users', overwrite: true })
  const r = await restore(store, plan, { dir: out, backupDir: dir, envId: 'env-1', now: NOW + 1000 })
  assert.ok(r.preBackup)
  assert.equal(JSON.parse(readFileSync(join(r.preBackup!, 'users.json'), 'utf8'))[0].title, '误改')
  assert.equal(store.data.get('users')!.get('a1')!.title, '原值')
  const cmp = await compareRestore(store, out, 'users', 'users')
  assert.equal(cmp.ok, true)
})
