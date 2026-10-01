'use strict'
/**
 * 用户上传图片的机审（BE-M2-02，PRD S1「图片异步机审」）：media 集合记录每张图的审核状态。
 *   const m = await startImageCheck(ctx, { fileID, purpose: 'avatar', accountId })   // 上传后登记并发起机审
 *   await handleMediaCheckEvent(ctx, event)                                         // 消息推送回调（mediacheck 云函数）
 *   await settleMedia(ctx, media, { verdict, label, actor })                         // 回调 / 人工复核的统一落地
 * - fileID 必须属于本环境、位于 uploads/<purpose>/ 下；读文件头校验类型（JPG / PNG / WebP / GIF）与大小（≤ 2MB），不合规立即删除
 * - 小程序用户：mediaCheckAsync v2（需 openid）→ status=pending 等回调；App 用户（无 openid）/ 微信接口失败 → status=review 进人工复核
 * - pass → 按用途生效（头像：profiles.avatar = fileID，旧的自定义头像文件删除）；reject → 删除文件（违规图自动下架）+ 站内通知 + mod_logs
 * - 结论幂等：已 pass / reject 的记录不再变化
 * ctx：{ db, now, envId, storage: { tempUrl, probe, deleteFiles }, mp?, identity?, appId?, logger? }
 */
const { badParam } = require('./errors')
const { withCollection, isCollectionMissingError } = require('./db')
const { notify } = require('./notify')
const { logModeration } = require('./moderation')

const MEDIA_COLLECTION = 'media'
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const IMAGE_TYPE_RE = /^image\/(jpeg|jpg|png|webp|gif)$/i
/** 等回调超过这个时间还没结论的，进人工复核队列 */
const PENDING_STALE_MS = 30 * 60 * 1000
/** 用途：机审场景（msgSecCheck / mediaCheckAsync scene：资料 1）与生效方式 */
const PURPOSES = Object.freeze({ avatar: { scene: 1, label: '头像' } })

const first = (res) => (res && res.data && res.data[0]) || null

/** fileID 形如 cloud://<envId>.<bucket>/<path> */
function checkFileID(fileID, envId, purpose) {
  const m = typeof fileID === 'string' && fileID.length <= 512 ? /^cloud:\/\/([^./]+)\.([^/]+)\/(.+)$/.exec(fileID) : null
  if (!m || !envId || m[1] !== envId) throw badParam('图片不属于本应用，请重新上传')
  if (!m[3].startsWith(`uploads/${purpose}/`) || m[3].includes('..')) throw badParam('图片路径不正确，请重新上传')
  return fileID
}

async function safeDelete(ctx, fileIDs) {
  const list = (fileIDs || []).filter((f) => typeof f === 'string' && f.startsWith('cloud://'))
  if (!list.length || !ctx.storage) return
  try {
    await ctx.storage.deleteFiles(list)
  } catch (e) {
    ;(ctx.logger || console).error('[media] 删除文件失败', e && e.message)
  }
}

/**
 * 上传后登记并发起机审。返回 media 文档（含 _id、status）。
 * @param {{ fileID: string, purpose: keyof typeof PURPOSES, accountId: string }} input
 */
async function startImageCheck(ctx, { fileID, purpose, accountId }) {
  const def = PURPOSES[purpose]
  if (!def) throw new Error(`startImageCheck: 未知用途 ${purpose}`)
  checkFileID(fileID, ctx.envId, purpose)
  const url = await ctx.storage.tempUrl(fileID)
  if (!url) throw badParam('图片不存在或已过期，请重新上传')
  const meta = await ctx.storage.probe(url)
  if (!meta || !IMAGE_TYPE_RE.test(meta.type || '')) {
    await safeDelete(ctx, [fileID])
    throw badParam('只支持 JPG / PNG / WebP / GIF 图片')
  }
  if (!(meta.size > 0) || meta.size > MAX_IMAGE_BYTES) {
    await safeDelete(ctx, [fileID])
    throw badParam('图片不能超过 2MB')
  }
  const now = ctx.now()
  const doc = { _openid: accountId, fileID, purpose, status: 'pending', provider: 'wx', traceId: null, label: null, size: meta.size, createdAt: now, checkedAt: null }
  const openid = ctx.identity && ctx.identity.raw && ctx.identity.raw.openId
  if (openid && ctx.mp && typeof ctx.mp.mediaCheckAsync === 'function') {
    try {
      doc.traceId = (await ctx.mp.mediaCheckAsync(url, { scene: def.scene, openid })).traceId
    } catch (e) {
      Object.assign(doc, { status: 'review', provider: 'manual', label: 'mediacheck_error' })
    }
  } else {
    // App 用户没有小程序 openid（或未配置小程序凭证）：进人工复核，宁可慢不可乱
    Object.assign(doc, { status: 'review', provider: 'manual' })
  }
  const res = await withCollection(ctx.db, MEDIA_COLLECTION, () => ctx.db.collection(MEDIA_COLLECTION).add(doc))
  return { ...doc, _id: res && (res.id || res._id) }
}

async function findProfile(db, uid) {
  return first(await db.collection('profiles').where({ _openid: uid }).limit(1).get())
}

/** 各用途在通过 / 驳回时怎么生效 */
const EFFECTS = {
  avatar: {
    async pass(ctx, media, now) {
      const p = await findProfile(ctx.db, media._openid)
      if (!p || p.avatarPending !== media.fileID) return { applied: false }
      const old = typeof p.avatar === 'string' && p.avatar.startsWith('cloud://') && p.avatar !== media.fileID ? p.avatar : null
      await ctx.db.collection('profiles').doc(p._id).update({ avatar: media.fileID, avatarPending: null, updatedAt: now })
      if (old) await safeDelete(ctx, [old])
      return { applied: true }
    },
    async reject(ctx, media, now) {
      const p = await findProfile(ctx.db, media._openid)
      if (!p) return
      const patch = {}
      if (p.avatarPending === media.fileID) patch.avatarPending = null
      if (p.avatar === media.fileID) patch.avatar = null
      if (Object.keys(patch).length) await ctx.db.collection('profiles').doc(p._id).update({ ...patch, updatedAt: now })
    },
  },
}

/**
 * 回调 / 人工复核的统一落地。verdict：pass | reject | review；actor：'system'（机审）或审核员 accountId。
 * @returns {Promise<{ changed: boolean, status: string, applied?: boolean }>}
 */
async function settleMedia(ctx, media, { verdict, label = null, actor = 'system' }) {
  if (media.status === 'pass' || media.status === 'reject') return { changed: false, status: media.status }
  const now = ctx.now()
  const col = ctx.db.collection(MEDIA_COLLECTION)
  if (verdict === 'review') {
    await col.doc(media._id).update({ status: 'review', label, checkedAt: now })
    await logModeration(ctx.db, { kind: 'machine', scene: media.purpose, verdict: 'review', labels: label != null ? [label] : [], actor, subject: media._openid, targetType: 'media', targetId: media._id }, now)
    return { changed: true, status: 'review' }
  }
  const status = verdict === 'pass' ? 'pass' : 'reject'
  await col.doc(media._id).update({ status, label, checkedAt: now, checkedBy: actor })
  const effect = EFFECTS[media.purpose]
  let applied = false
  if (status === 'pass') {
    applied = effect ? (await effect.pass(ctx, media, now)).applied : false
    // 已被更新的上传替代（用户又传了一张）：这张不再使用，删掉
    if (!applied) await safeDelete(ctx, [media.fileID])
  } else {
    if (effect) await effect.reject(ctx, media, now)
    await safeDelete(ctx, [media.fileID])
    const what = (PURPOSES[media.purpose] && PURPOSES[media.purpose].label) || '图片'
    await notify(ctx.db, { uid: media._openid, type: 'moderation', refType: 'media', refId: media._id, text: `你上传的${what}未通过审核，已被移除。`, now })
  }
  await logModeration(ctx.db, {
    kind: actor === 'system' ? 'machine' : 'manual', scene: media.purpose, action: status === 'pass' ? 'media_pass' : 'media_reject', verdict: status === 'pass' ? 'pass' : 'reject',
    labels: label != null ? [label] : [], actor, subject: media._openid, targetType: 'media', targetId: media._id,
  }, now)
  return { changed: true, status, applied }
}

/**
 * 「消息推送」事件 wxa_media_check（推到 mediacheck 云函数）。只认本小程序 appid、已登记的 trace_id；其余忽略。
 * v2：result.suggest = pass | review | risky；兼容 v1：isrisky = 0 / 1。
 */
async function handleMediaCheckEvent(ctx, event) {
  if (!event || event.MsgType !== 'event' || event.Event !== 'wxa_media_check') return { handled: false, reason: 'not wxa_media_check' }
  if (ctx.appId && event.appid && event.appid !== ctx.appId) return { handled: false, reason: 'appid mismatch' }
  const traceId = event.trace_id
  if (typeof traceId !== 'string' || !traceId) return { handled: false, reason: 'no trace_id' }
  let media = null
  try {
    media = first(await ctx.db.collection(MEDIA_COLLECTION).where({ traceId }).limit(1).get())
  } catch (e) {
    if (!isCollectionMissingError(e)) throw e
  }
  if (!media) return { handled: false, reason: 'unknown trace_id' }
  const r = event.result || {}
  let verdict = r.suggest === 'pass' ? 'pass' : r.suggest === 'risky' ? 'reject' : 'review'
  if (!r.suggest && (event.isrisky === 0 || event.isrisky === 1)) verdict = event.isrisky ? 'reject' : 'pass'
  const res = await settleMedia(ctx, media, { verdict, label: r.label != null ? r.label : null, actor: 'system' })
  return { handled: true, verdict, ...res }
}

/**
 * node-sdk 的存储能力适配（入口 wiring 用；单测注入替身）。
 * probe：先 HEAD，失败再 GET Range: bytes=0-0 读响应头，得到 { type, size }
 */
function createStorage(app, fetchImpl = globalThis.fetch) {
  return {
    async tempUrl(fileID) {
      const res = await app.getTempFileURL({ fileList: [{ fileID, maxAge: 3600 }] })
      const f = res && res.fileList && res.fileList[0]
      return f && (f.code === 'SUCCESS' || !f.code) && f.tempFileURL ? f.tempFileURL : null
    },
    async probe(url) {
      try {
        let res = await fetchImpl(url, { method: 'HEAD' })
        let size = Number(res.headers.get('content-length') || 0)
        if (!res.ok) {
          res = await fetchImpl(url, { method: 'GET', headers: { Range: 'bytes=0-0' } })
          if (!res.ok && res.status !== 206) return null
          const range = /\/(\d+)$/.exec(res.headers.get('content-range') || '')
          size = range ? Number(range[1]) : Number(res.headers.get('content-length') || 0)
        }
        return { type: (res.headers.get('content-type') || '').split(';')[0].trim(), size }
      } catch (e) {
        return null
      }
    },
    async deleteFiles(fileIDs) {
      if (fileIDs && fileIDs.length) await app.deleteFile({ fileList: fileIDs })
    },
  }
}

module.exports = {
  startImageCheck, settleMedia, handleMediaCheckEvent, createStorage, checkFileID,
  MEDIA_COLLECTION, MAX_IMAGE_BYTES, PENDING_STALE_MS, MEDIA_PURPOSES: PURPOSES,
}
