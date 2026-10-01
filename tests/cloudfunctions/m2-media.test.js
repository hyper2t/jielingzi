'use strict'
/**
 * BE-M2-02 图片异步机审 + 自定义头像：community.setAvatar 登记并发起 mediaCheckAsync → mediacheck 回调（消息推送）生效 / 下架；
 * App 用户与接口失败走人工复核（moderation.mediaQueue / decideMedia）；注销删除上传的文件。用例索引见 docs/test/cases/M2.md。
 */
const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const S = require('../../cloudfunctions/_shared')
const community = require('../../cloudfunctions/community/service')
const moderation = require('../../cloudfunctions/moderation/service')
const userService = require('../../cloudfunctions/user/service')
const { createUserRepo } = require('../../cloudfunctions/user/repo.nosql')
const { createFakeDb } = require('./fakeDb')

beforeEach(() => S.restoreOwnedCollections())

const NOW = Date.UTC(2026, 9, 1, 4, 0, 0)
const MIN = 60 * 1000
const ENV = 'env-test'
const silent = { info() {}, error() {} }
const file = (name) => `cloud://${ENV}.bucket-1/uploads/avatar/202610/${name}`

/** 存储替身：files 记录存在的文件及其类型 / 大小；deleted 记录被删的 */
function fakeStorage(files = {}) {
  const store = { ...files }
  const deleted = []
  return {
    store,
    deleted,
    async tempUrl(fileID) { return store[fileID] ? `https://tmp.example/${encodeURIComponent(fileID)}` : null },
    async probe(url) { const id = decodeURIComponent(url.replace('https://tmp.example/', '')); return store[id] || null },
    async deleteFiles(list) { for (const f of list) { deleted.push(f); delete store[f] } },
  }
}
function fakeMp({ fail = false } = {}) {
  const calls = []
  let n = 0
  return { calls, async mediaCheckAsync(url, opts) { calls.push({ url, ...opts }); if (fail) throw S.upstream('x'); return { traceId: `tr-${++n}` } } }
}
const JPG = (size = 50 * 1024) => ({ type: 'image/jpeg', size })

function world({ users = [{ _openid: 'U', adultConfirmedAt: 1 }], files = {}, profiles = [] } = {}) {
  return createFakeDb({ unique: { profiles: ['_openid', 'anonAlias'] }, data: { users: [...users, { _openid: 'Mod', adultConfirmedAt: 1, role: 'mod' }], profiles } })
}
function communityAs(db, { uid = 'U', openId = 'oU', storage, mp, now = NOW } = {}) {
  let t = now
  return S.createMain({ actions: community.actions, logger: silent, createContext: async () => ({ db, identity: { openid: uid, raw: openId ? { openId } : {} }, now: () => ++t, envId: ENV, storage, mp, logger: silent }) })
}
function modAs(db, { uid = 'Mod', storage, now = NOW } = {}) {
  let t = now
  return S.createMain({ actions: moderation.actions, logger: silent, createContext: async () => ({ db, identity: { openid: uid }, now: () => ++t, storage, logger: silent }) })
}
const cbCtx = (db, storage, now = NOW + 5 * MIN) => ({ db, now: () => now, storage, appId: 'wxapp', logger: silent })
const event = (traceId, suggest, extra = {}) => ({ MsgType: 'event', Event: 'wxa_media_check', appid: 'wxapp', trace_id: traceId, version: 2, result: { suggest, label: suggest === 'pass' ? 100 : 20002 }, ...extra })

test('checkFileID：必须是本环境、uploads/<用途>/ 下的文件，不能带 ..', () => {
  assert.equal(S.checkFileID(file('a.jpg'), ENV, 'avatar'), file('a.jpg'))
  for (const bad of ['cloud://other-env.bucket/uploads/avatar/a.jpg', `cloud://${ENV}.bucket/topics/a.jpg`, `cloud://${ENV}.bucket/uploads/avatar/../x.jpg`, 'https://x/a.jpg', 123]) {
    assert.throws(() => S.checkFileID(bad, ENV, 'avatar'), (e) => e.code === 40001, String(bad))
  }
})

test('setAvatar（小程序）：登记 media、发起 mediaCheckAsync（scene 1、openid、临时链接）；审核前只记 avatarPending；扣上传额度', async () => {
  const storage = fakeStorage({ [file('a.jpg')]: JPG() })
  const mp = fakeMp()
  const db = world({ profiles: [{ _openid: 'U', nickname: '林然', anonAlias: '竹影', avatar: 'preset:leaf' }] })
  const r = await communityAs(db, { storage, mp })({ action: 'setAvatar', fileID: file('a.jpg') })
  assert.equal(r.code, 0, r.msg)
  assert.equal(r.data.status, 'pending')
  assert.deepEqual([r.data.profile.avatar, r.data.profile.avatarPending], ['preset:leaf', file('a.jpg')])
  assert.deepEqual(mp.calls.map((c) => [c.scene, c.openid, c.url.startsWith('https://tmp.example/')]), [[1, 'oU', true]])
  const m = db.store.media[0]
  assert.deepEqual([m._openid, m.fileID, m.purpose, m.status, m.provider, m.traceId, m.size], ['U', file('a.jpg'), 'avatar', 'pending', 'wx', 'tr-1', 50 * 1024])
  assert.equal(db.store.rate_limits[0]._id.split(':')[1], 'uploadImage')
  assert.equal(db.store.profiles[0].avatar, 'preset:leaf', '审核前不对他人展示')
})

test('setAvatar 校验：非图片 / 超过 2MB 立即删除文件并 40001；文件不存在 / 别的环境 40001；需 18+；未登录 40101', async () => {
  const storage = fakeStorage({ [file('t.txt')]: { type: 'text/plain', size: 10 }, [file('big.jpg')]: JPG(3 * 1024 * 1024) })
  const db = world({ users: [{ _openid: 'U', adultConfirmedAt: 1 }, { _openid: 'Kid' }] })
  const me = communityAs(db, { storage, mp: fakeMp() })
  assert.equal((await me({ action: 'setAvatar', fileID: file('t.txt') })).code, 40001)
  assert.equal((await me({ action: 'setAvatar', fileID: file('big.jpg') })).code, 40001)
  assert.deepEqual(storage.deleted, [file('t.txt'), file('big.jpg')])
  assert.equal((await me({ action: 'setAvatar', fileID: file('nope.jpg') })).code, 40001)
  assert.equal((await me({ action: 'setAvatar', fileID: 'cloud://other.bucket/uploads/avatar/x.jpg' })).code, 40001)
  assert.equal((await me({ action: 'setAvatar' })).code, 40001)
  assert.equal((await communityAs(db, { uid: 'Kid', storage })({ action: 'setAvatar', fileID: file('t.txt') })).code, 40303)
  assert.equal((await communityAs(db, { uid: null, storage })({ action: 'setAvatar', fileID: file('t.txt') })).code, 40101)
  assert.equal((db.store.media || []).length, 0)
})

test('App 用户（无小程序 openid）或微信接口失败：进人工复核（status=review、provider=manual），不调 / 调失败不阻断', async () => {
  const storage = fakeStorage({ [file('app.jpg')]: JPG(), [file('err.jpg')]: JPG() })
  const mp = fakeMp()
  const db = world()
  const app = await communityAs(db, { openId: null, storage, mp })({ action: 'setAvatar', fileID: file('app.jpg') })
  assert.equal(app.data.status, 'review')
  assert.equal(mp.calls.length, 0)
  const err = await communityAs(db, { storage, mp: fakeMp({ fail: true }) })({ action: 'setAvatar', fileID: file('err.jpg') })
  assert.equal(err.data.status, 'review')
  assert.deepEqual(db.store.media.map((m) => [m.status, m.provider, m.label]), [['review', 'manual', null], ['review', 'manual', 'mediacheck_error']])
  // 第二次上传作废第一张待审的（删文件）
  assert.deepEqual(storage.deleted, [file('app.jpg')])
  assert.equal(db.store.profiles[0].avatarPending, file('err.jpg'))
})

test('回调 pass：头像生效、旧的自定义头像文件删除、写 mod_logs；重复推送幂等', async () => {
  const old = file('old.jpg')
  const storage = fakeStorage({ [file('a.jpg')]: JPG(), [old]: JPG() })
  const db = world({ profiles: [{ _openid: 'U', anonAlias: '竹影', avatar: old }] })
  await communityAs(db, { storage, mp: fakeMp() })({ action: 'setAvatar', fileID: file('a.jpg') })
  const r = await S.handleMediaCheckEvent(cbCtx(db, storage), event('tr-1', 'pass'))
  assert.deepEqual([r.handled, r.verdict, r.status, r.applied], [true, 'pass', 'pass', true])
  assert.deepEqual([db.store.profiles[0].avatar, db.store.profiles[0].avatarPending], [file('a.jpg'), null])
  assert.deepEqual(storage.deleted, [old])
  assert.ok(db.store.mod_logs.some((l) => l.action === 'media_pass' && l.actor === 'system' && l.targetType === 'media'))
  assert.equal((await S.handleMediaCheckEvent(cbCtx(db, storage), event('tr-1', 'risky'))).changed, false, '已有结论不再变化')
  assert.equal(db.store.profiles[0].avatar, file('a.jpg'))
})

test('回调 risky：违规图自动下架（删文件）、清掉待审头像、站内通知（不含文件地址）、mod_logs；review：进人工队列', async () => {
  const storage = fakeStorage({ [file('bad.jpg')]: JPG(), [file('hmm.jpg')]: JPG() })
  const db = world({ users: [{ _openid: 'U', adultConfirmedAt: 1 }, { _openid: 'V', adultConfirmedAt: 1 }] })
  const mp = fakeMp()
  await communityAs(db, { storage, mp })({ action: 'setAvatar', fileID: file('bad.jpg') })
  const r = await S.handleMediaCheckEvent(cbCtx(db, storage), event('tr-1', 'risky'))
  assert.deepEqual([r.verdict, r.status], ['reject', 'reject'])
  assert.deepEqual(storage.deleted, [file('bad.jpg')])
  assert.equal(db.store.profiles[0].avatarPending, null)
  const n = db.store.notifications[0]
  assert.deepEqual([n._openid, n.type, n.refType], ['U', 'moderation', 'media'])
  assert.ok(!n.text.includes('cloud://') && /未通过审核/.test(n.text))
  assert.ok(db.store.mod_logs.some((l) => l.action === 'media_reject' && l.labels[0] === 20002))
  // review
  await communityAs(db, { uid: 'V', openId: 'oV', storage, mp })({ action: 'setAvatar', fileID: file('hmm.jpg') })
  const rv = await S.handleMediaCheckEvent(cbCtx(db, storage), event(db.store.media[1].traceId, 'review'))
  assert.equal(rv.status, 'review')
  const q = await modAs(db, { storage })({ action: 'mediaQueue' })
  assert.deepEqual(q.data.list.map((i) => [i.status, i.purposeLabel]), [['review', '头像']])
})

test('伪造 / 无关事件一律忽略：别的 appid、未登记的 trace_id、非 wxa_media_check、缺 trace_id', async () => {
  const storage = fakeStorage({ [file('a.jpg')]: JPG() })
  const db = world()
  await communityAs(db, { storage, mp: fakeMp() })({ action: 'setAvatar', fileID: file('a.jpg') })
  const before = JSON.stringify(db.store)
  const ctx = cbCtx(db, storage)
  assert.equal((await S.handleMediaCheckEvent(ctx, event('tr-1', 'pass', { appid: 'wxOTHER' }))).reason, 'appid mismatch')
  assert.equal((await S.handleMediaCheckEvent(ctx, event('tr-404', 'pass'))).reason, 'unknown trace_id')
  assert.equal((await S.handleMediaCheckEvent(ctx, { action: 'queue' })).handled, false)
  assert.equal((await S.handleMediaCheckEvent(ctx, { MsgType: 'event', Event: 'wxa_media_check', appid: 'wxapp' })).reason, 'no trace_id')
  assert.equal(JSON.stringify(db.store), before)
  // v1 兼容：isrisky
  assert.equal((await S.handleMediaCheckEvent(ctx, { MsgType: 'event', Event: 'wxa_media_check', trace_id: 'tr-1', isrisky: 0 })).verdict, 'pass')
})

test('被新上传替代的图片：结论 pass 也不生效，文件删掉；改选预置头像会作废待审的上传', async () => {
  const storage = fakeStorage({ [file('a.jpg')]: JPG(), [file('b.jpg')]: JPG(), [file('c.jpg')]: JPG() })
  const db = world()
  const me = communityAs(db, { storage, mp: fakeMp() })
  await me({ action: 'setAvatar', fileID: file('a.jpg') })
  await me({ action: 'setAvatar', fileID: file('b.jpg') })
  const r = await S.handleMediaCheckEvent(cbCtx(db, storage), event('tr-1', 'pass'))
  assert.deepEqual([r.status, r.applied], ['pass', false])
  assert.equal(db.store.profiles[0].avatarPending, file('b.jpg'))
  await me({ action: 'setAvatar', fileID: file('c.jpg') })
  const p = await me({ action: 'updateProfile', avatar: 'preset:moon' })
  assert.deepEqual([p.data.profile.avatar, p.data.profile.avatarPending], ['preset:moon', null])
  assert.ok(storage.deleted.includes(file('c.jpg')))
})

test('人工复核：仅 mod / admin；队列含 review 与等回调超过 30 分钟的 pending（不含新的 pending）、预览链接、无上传者标识；通过 / 驳回', async () => {
  const storage = fakeStorage({ [file('x.jpg')]: JPG(), [file('y.jpg')]: JPG(), [file('z.jpg')]: JPG() })
  const db = world({ users: [{ _openid: 'U', adultConfirmedAt: 1 }, { _openid: 'V', adultConfirmedAt: 1 }, { _openid: 'W', adultConfirmedAt: 1 }] })
  await communityAs(db, { openId: null, storage })({ action: 'setAvatar', fileID: file('x.jpg') })
  await communityAs(db, { uid: 'V', openId: 'oV', storage, mp: fakeMp(), now: NOW - 40 * MIN })({ action: 'setAvatar', fileID: file('y.jpg') })
  await communityAs(db, { uid: 'W', openId: 'oW', storage, mp: fakeMp() })({ action: 'setAvatar', fileID: file('z.jpg') })
  assert.equal((await modAs(db, { uid: 'U', storage })({ action: 'mediaQueue' })).code, 40301)
  const q = await modAs(db, { storage })({ action: 'mediaQueue' })
  assert.deepEqual(q.data.list.map((i) => i.status), ['review', 'pending'])
  assert.ok(q.data.list.every((i) => i.url && i.url.startsWith('https://tmp.example/')))
  assert.ok(!JSON.stringify(q.data).includes('"U"') && !JSON.stringify(q.data).includes('_openid'))
  const [x, y] = q.data.list
  assert.equal((await modAs(db, { storage })({ action: 'decideMedia', mediaId: x.mediaId, decision: 'pass' })).data.status, 'pass')
  assert.equal(db.store.profiles.find((p) => p._openid === 'U').avatar, file('x.jpg'))
  assert.equal((await modAs(db, { storage })({ action: 'decideMedia', mediaId: y.mediaId, decision: 'reject', note: '二维码' })).data.status, 'reject')
  assert.ok(storage.deleted.includes(file('y.jpg')))
  assert.ok(db.store.mod_logs.some((l) => l.kind === 'manual' && l.action === 'media_reject' && l.actor === 'Mod'))
  assert.equal((await modAs(db, { storage })({ action: 'decideMedia', mediaId: 'nope', decision: 'pass' })).code, 40401)
  assert.equal((await modAs(db, { uid: 'U', storage })({ action: 'decideMedia', mediaId: x.mediaId, decision: 'reject' })).code, 40301)
})

test('注销：删除用户上传过的全部图片文件与 media 记录', async () => {
  const storage = fakeStorage({ [file('a.jpg')]: JPG(), [file('b.jpg')]: JPG() })
  const db = world()
  const me = communityAs(db, { storage, mp: fakeMp() })
  await me({ action: 'setAvatar', fileID: file('a.jpg') })
  await S.handleMediaCheckEvent(cbCtx(db, storage), event('tr-1', 'pass'))
  await me({ action: 'setAvatar', fileID: file('b.jpg') })
  const main = S.createMain({
    actions: userService.actions,
    logger: silent,
    createContext: async () => ({ identity: { openid: 'U', raw: {} }, accountRepo: S.createAccountRepo(db), repo: createUserRepo(db), now: () => NOW, logger: silent, storage }),
  })
  const d = await main({ action: 'deleteAccount', confirm: 'DELETE' })
  assert.equal(d.code, 0)
  assert.deepEqual(storage.deleted.slice(-2).sort(), [file('a.jpg'), file('b.jpg')].sort())
  assert.equal(d.data.removed.media, 2)
  assert.deepEqual(db.store.media, [])
})

test('mediacheck 云函数入口：处理推送并返回 success；用 WX_MP_APP_ID 校验 appid', async () => {
  const storage = fakeStorage({ [file('a.jpg')]: JPG() })
  const db = world()
  await communityAs(db, { storage, mp: fakeMp() })({ action: 'setAvatar', fileID: file('a.jpg') })
  const fakeSdk = {
    SYMBOL_CURRENT_ENV: Symbol('current'),
    init: () => ({
      database: () => db,
      getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map((f) => ({ fileID: f.fileID, tempFileURL: 'https://tmp', code: 'SUCCESS' })) }),
      deleteFile: async ({ fileList }) => { storage.deleted.push(...fileList); return { fileList } },
    }),
  }
  const origLoad = Module._load
  const origLog = console.log
  Module._load = function (request, ...rest) {
    if (request === '@cloudbase/node-sdk') return fakeSdk
    return origLoad.call(this, request, ...rest)
  }
  process.env.WX_MP_APP_ID = 'wxapp'
  console.log = () => {}
  try {
    const { main } = require('../../cloudfunctions/mediacheck/index.js')
    assert.equal(await main(event('tr-1', 'risky', { appid: 'wxOTHER' })), 'success')
    assert.equal(db.store.media[0].status, 'pending', '别的 appid 被忽略')
    assert.equal(await main(event('tr-1', 'risky')), 'success')
    assert.equal(db.store.media[0].status, 'reject')
    assert.ok(storage.deleted.includes(file('a.jpg')))
  } finally {
    Module._load = origLoad
    console.log = origLog
    delete process.env.WX_MP_APP_ID
  }
})
