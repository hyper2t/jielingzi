'use strict'
/**
 * moderation 云函数（BE-M2-03 / BE-M2-04，PRD S2–S4）：举报 → 达阈值自动折叠 → 审核队列 → 处理（删除 / 恢复 / 驳回 / 禁言 / 封禁）→ 站内通知。
 * 契约见 docs/api/moderation.md。ctx：{ identity, db, now, logger }
 * - 举报不要求实名、禁言中也可举报（guardWrite: requirePhone=false, allowMuted=true），需 18+，每日 30 次
 * - 同一人对同一目标只计一次（reports 唯一索引 targetId + _openid）；不能举报自己的内容
 * - 举报「用户」时不暴露任何 uid：传他发布的内容（contentType + targetId），服务端解析作者，记在 report.targetUid（不下发）
 * - queue / decide 仅 mod / admin（guardRole）；decide 的处理方式参数叫 decision（action 是路由字段）；mod 不能处罚 mod / admin（只有 admin 可以）
 * - 处罚写 users.mutedUntil / bannedUntil，guardWrite 立即生效；通知作者与举报人（不含原文）；全部写 mod_logs
 * - 精华（BE-M6-02，D12）：markFeatured 只改 topics.featured 并写 mod_logs（kind: featured），不动 status——
 *   可见性一律由 M4 的圈子成员校验决定，精华列表不会成为越权读圈内内容的通道
 */
const {
  validate, badParam, notFound, forbidden, guardWrite, guardRole, isDuplicateKeyError, isCollectionMissingError,
  withCollection, logModeration, notify, REPORT_REASONS, REPORT_FOLD_THRESHOLD, PUNISH_DAYS, pageSchema,
  settleMedia, MEDIA_COLLECTION, PENDING_STALE_MS, MEDIA_PURPOSES,
} = require('./_shared')

const REPORTS = 'reports'
const DAY = 24 * 3600 * 1000
const PERMANENT_MS = 100 * 365 * DAY
const TARGET_TYPES = ['topic', 'reply', 'user']
const CONTENT_TYPES = ['topic', 'reply']
const CONTENT_COLLECTION = { topic: 'topics', reply: 'replies' }
const REASON_IDS = REPORT_REASONS.map((r) => r.id)
const ACTIONS = ['dismiss', 'remove', 'restore', 'mute', 'ban']
const QUEUE_SCAN_LIMIT = 300
/** 精华（D12）：mod / admin 手工标记，只写审计日志，不通知（通知归 BE-M6-03） */
const FEATURED_LOG_KIND = 'featured'

/** 不要求身份的动作（入口据此不因副作用建号） */
const IDENTITY_FREE_ACTIONS = ['ping']

const idRule = { type: 'id' }

/** 内容文档（集合还没建 / 不存在 → null） */
async function findContent(db, contentType, id) {
  try {
    const res = await db.collection(CONTENT_COLLECTION[contentType]).doc(id).get()
    return (res && res.data && res.data[0]) || null
  } catch (e) {
    if (isCollectionMissingError(e)) return null
    throw e
  }
}

async function findUser(db, uid) {
  const res = await db.collection('users').where({ _openid: uid }).limit(1).get()
  return (res && res.data && res.data[0]) || null
}

async function listReports(db, where, limit = QUEUE_SCAN_LIMIT) {
  try {
    const res = await db.collection(REPORTS).where(where).orderBy('createdAt', 'desc').limit(limit).get()
    return (res && res.data) || []
  } catch (e) {
    if (isCollectionMissingError(e)) return []
    throw e
  }
}

/** report 的目标解析：内容本身，或「用户」= 他发布的这条内容的作者 */
function contentTypeOf(input) {
  if (input.targetType === 'user') {
    if (!input.contentType) throw badParam('举报用户时需提供 contentType（他发布的话题 / 回复）')
    return input.contentType
  }
  if (input.contentType && input.contentType !== input.targetType) throw badParam('contentType 与 targetType 不一致')
  return input.targetType
}

const excerpt = (doc) => {
  const s = String((doc && (doc.title || doc.body)) || '')
  const chars = Array.from(s)
  return chars.length > 60 ? `${chars.slice(0, 60).join('')}…` : s
}

/** 举报人是否是内容所在圈子的成员（circleId 为空的旧内容对任何人不可见） */
async function isCircleMember(db, accountId, circleId) {
  if (!accountId || typeof circleId !== 'string' || !circleId) return false
  try {
    const res = await db.collection('memberships').where({ circleId, _openid: accountId }).limit(1).get()
    return !!(res && res.data && res.data.length)
  } catch (e) {
    if (isCollectionMissingError(e)) return false
    throw e
  }
}
// ---------- 举报 ----------

async function report(params, ctx) {
  const input = validate(params, {
    targetType: { type: 'enum', values: TARGET_TYPES },
    targetId: idRule,
    contentType: { type: 'enum', values: CONTENT_TYPES, optional: true },
    reason: { type: 'enum', values: REASON_IDS },
    note: { type: 'string', maxLen: 200, optional: true },
  })
  const contentType = contentTypeOf(input)
  const g = await guardWrite(ctx, 'report', { requirePhone: false, allowMuted: true })
  const content = await findContent(ctx.db, contentType, input.targetId)
  if (!content) throw notFound('内容不存在或已删除')
  // 圈内内容只有圈子成员能举报（与读取一致：不是成员 / 旧话题一律当作不存在）
  if (!(await isCircleMember(ctx.db, g.accountId, content.circleId))) throw notFound('内容不存在或已删除')
  if (content._openid && content._openid === g.accountId) throw badParam('不能举报自己发布的内容')
  const now = ctx.now()

  const mine = await listReports(ctx.db, { targetType: input.targetType, targetId: input.targetId, _openid: g.accountId }, 1)
  if (mine.length) return { ok: true, duplicate: true, folded: content.status === 'folded' }
  const doc = {
    _openid: g.accountId,
    targetType: input.targetType,
    targetId: input.targetId,
    contentType,
    reason: input.reason,
    note: (input.note || '').trim(),
    state: 'open',
    createdAt: now,
  }
  if (input.targetType === 'user') doc.targetUid = content._openid || null
  try {
    await withCollection(ctx.db, REPORTS, () => ctx.db.collection(REPORTS).add(doc))
  } catch (e) {
    if (isDuplicateKeyError(e)) return { ok: true, duplicate: true, folded: content.status === 'folded' }
    throw e
  }
  await g.commit()

  // 达阈值自动折叠（只折叠内容；举报用户只进队列）
  let folded = content.status === 'folded'
  if (input.targetType !== 'user' && (content.status || 'ok') === 'ok') {
    const open = await listReports(ctx.db, { targetType: input.targetType, targetId: input.targetId, state: 'open' })
    const reporters = new Set(open.map((r) => r._openid))
    if (reporters.size >= REPORT_FOLD_THRESHOLD) {
      await ctx.db.collection(CONTENT_COLLECTION[contentType]).doc(input.targetId).update({ status: 'folded', foldedAt: now })
      await logModeration(ctx.db, { kind: 'machine', action: 'fold', targetType: input.targetType, targetId: input.targetId, contentType, actor: 'system', subject: content._openid || null, note: `举报达到 ${REPORT_FOLD_THRESHOLD} 人` }, now)
      folded = true
    }
  }
  return { ok: true, duplicate: false, folded }
}

// ---------- 审核队列 ----------

async function queue(params, ctx) {
  const input = validate(params, { state: { type: 'enum', values: ['open', 'resolved'], default: 'open' }, ...pageSchema(50) })
  await guardRole(ctx)
  const rows = await listReports(ctx.db, { state: input.state })
  const groups = new Map()
  for (const r of rows) {
    const key = `${r.targetType}:${r.targetId}`
    const g = groups.get(key) || { targetType: r.targetType, targetId: r.targetId, contentType: r.contentType, count: 0, reporters: new Set(), reasons: {}, latestAt: 0, notes: [] }
    if (!g.reporters.has(r._openid)) {
      g.reporters.add(r._openid)
      g.count++
      g.reasons[r.reason] = (g.reasons[r.reason] || 0) + 1
      if (r.note && g.notes.length < 3) g.notes.push(r.note)
    }
    g.latestAt = Math.max(g.latestAt, r.createdAt || 0)
    groups.set(key, g)
  }
  const all = [...groups.values()].sort((a, b) => b.count - a.count || b.latestAt - a.latestAt)
  const start = (input.page - 1) * input.size
  const list = []
  for (const g of all.slice(start, start + input.size)) {
    const content = await findContent(ctx.db, g.contentType, g.targetId)
    list.push({
      targetType: g.targetType,
      targetId: g.targetId,
      contentType: g.contentType,
      count: g.count,
      reasons: g.reasons,
      notes: g.notes,
      latestAt: g.latestAt,
      // 内容快照：状态与摘要；不含任何作者标识
      target: content ? { status: content.status || 'ok', excerpt: excerpt(content), anon: content.anon === true, authorDeleted: content.authorDeleted === true } : null,
    })
  }
  return { list, total: all.length, page: input.page, size: input.size, hasMore: start + input.size < all.length }
}

// ---------- 处理 ----------

const MESSAGES = {
  remove: (t) => `你发布的${t}因违反社区公约已被删除。`,
  mute: (days, until) => `你的账号因违反社区公约被禁言 ${days} 天（至 ${until}），期间不能发布内容。`,
  ban: (days, until) => (days ? `你的账号因违反社区公约被封禁 ${days} 天（至 ${until}）。` : '你的账号因严重违反社区公约已被永久封禁。'),
  reporter: '你举报的内容已处理，感谢你守护社区。',
}
const cnDay = (ms) => new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10)
const TYPE_TEXT = { topic: '话题', reply: '回复' }

async function decide(params, ctx) {
  const input = validate(params, {
    targetType: { type: 'enum', values: TARGET_TYPES },
    targetId: idRule,
    contentType: { type: 'enum', values: CONTENT_TYPES, optional: true },
    // 不能叫 action：入参与路由字段 event.action 同名会被覆盖
    decision: { type: 'enum', values: ACTIONS },
    days: { type: 'int', min: 1, max: PUNISH_DAYS.ban.max, optional: true },
    note: { type: 'string', maxLen: 200, optional: true },
  })
  const { user: mod, accountId: actor } = await guardRole(ctx)
  const contentType = contentTypeOf(input)
  const now = ctx.now()
  const content = await findContent(ctx.db, contentType, input.targetId)
  const open = await listReports(ctx.db, { targetType: input.targetType, targetId: input.targetId, state: 'open' })
  if (!content && !open.length) throw notFound('举报目标不存在')

  let status = content ? content.status || 'ok' : null
  let subject = null
  const col = CONTENT_COLLECTION[contentType]
  if (input.decision === 'remove' || input.decision === 'restore' || input.decision === 'dismiss') {
    if (input.targetType === 'user' && input.decision !== 'dismiss') throw badParam('举报用户只能驳回、禁言或封禁')
    if (!content && input.decision !== 'dismiss') throw notFound('内容不存在或已删除')
    // 作者自己删除的内容不能被审核员恢复（尊重作者意愿）
    if (input.decision === 'restore' && content && content.removedBy === 'author') throw badParam('作者已自行删除该内容，不能恢复')
    if (input.decision === 'remove') status = 'removed'
    // pending（机审待复核，见 _shared/moderation.js enqueueReview）：restore / dismiss 都是放行
    else if (content && (input.decision === 'restore' || status === 'folded' || status === 'pending')) status = 'ok'
    if (content && input.targetType !== 'user' && status !== (content.status || 'ok')) {
      const patch = { status, handledAt: now }
      if (status === 'removed') patch.removedAt = now
      await ctx.db.collection(col).doc(input.targetId).update(patch)
    }
    if (input.decision === 'remove') subject = content._openid || null
  } else {
    // 禁言 / 封禁：对象是内容作者（举报用户时为解析出的 targetUid）
    const days = input.days
    if (input.decision === 'mute' && (!days || days > PUNISH_DAYS.mute.max)) throw badParam(`禁言天数需为 ${PUNISH_DAYS.mute.min}–${PUNISH_DAYS.mute.max}`)
    subject = (input.targetType === 'user' && (open.find((r) => r.targetUid) || {}).targetUid) || (content && content._openid) || null
    if (!subject) throw badParam('作者已注销，无法处罚')
    const target = await findUser(ctx.db, subject)
    if (!target) throw notFound('用户不存在')
    if (['mod', 'admin'].includes(target.role) && mod.role !== 'admin') throw forbidden('只有管理员可以处罚审核员 / 管理员')
    const field = input.decision === 'mute' ? 'mutedUntil' : 'bannedUntil'
    const until = days ? now + days * DAY : now + PERMANENT_MS
    const current = typeof target[field] === 'number' ? target[field] : 0
    if (until > current) await ctx.db.collection('users').doc(target._id).update({ [field]: until })
  }

  // 关闭该目标的全部待处理举报
  const result = input.decision
  if (open.length) {
    await ctx.db.collection(REPORTS).where({ targetType: input.targetType, targetId: input.targetId, state: 'open' })
      .update({ state: 'resolved', result, handledBy: actor, handledAt: now })
  }
  await logModeration(ctx.db, { kind: 'manual', action: result, targetType: input.targetType, targetId: input.targetId, contentType, actor, subject, days: input.days || null, note: input.note || null }, now)

  // 站内通知（BE-M2-04）：被处理的作者 + 举报人；不含原文
  if (subject && result !== 'dismiss' && result !== 'restore') {
    const until = input.days ? now + input.days * DAY : null
    const text = result === 'remove' ? MESSAGES.remove(TYPE_TEXT[contentType]) : result === 'mute' ? MESSAGES.mute(input.days, cnDay(until)) : MESSAGES.ban(input.days, until ? cnDay(until) : '')
    await notify(ctx.db, { uid: subject, type: 'moderation', refType: contentType, refId: input.targetId, text, now })
    for (const uid of new Set(open.map((r) => r._openid))) {
      await notify(ctx.db, { uid, type: 'moderation', refType: 'report', refId: input.targetId, text: MESSAGES.reporter, now })
    }
  }
  return { ok: true, resolved: open.length, status }
}

// ---------- 图片人工复核（BE-M2-02） ----------

async function listMedia(db, status) {
  try {
    const res = await db.collection(MEDIA_COLLECTION).where({ status }).orderBy('createdAt', 'asc').limit(QUEUE_SCAN_LIMIT).get()
    return (res && res.data) || []
  } catch (e) {
    if (isCollectionMissingError(e)) return []
    throw e
  }
}

/** 待人工复核的图片：status=review（App 用户 / 机审要求复核 / 微信接口失败），以及等回调超过 30 分钟的 pending */
async function mediaQueue(params, ctx) {
  const input = validate(params, pageSchema(50))
  await guardRole(ctx)
  const now = ctx.now()
  const rows = [...await listMedia(ctx.db, 'review'), ...(await listMedia(ctx.db, 'pending')).filter((m) => now - (m.createdAt || 0) > PENDING_STALE_MS)]
  const start = (input.page - 1) * input.size
  const list = []
  for (const m of rows.slice(start, start + input.size)) {
    list.push({
      mediaId: m._id,
      purpose: m.purpose,
      purposeLabel: (MEDIA_PURPOSES[m.purpose] && MEDIA_PURPOSES[m.purpose].label) || m.purpose,
      status: m.status,
      provider: m.provider,
      label: m.label,
      createdAt: m.createdAt,
      // 预览用临时链接（1 小时）；不含上传者标识
      url: ctx.storage ? await ctx.storage.tempUrl(m.fileID) : null,
    })
  }
  return { list, total: rows.length, page: input.page, size: input.size, hasMore: start + input.size < rows.length }
}

async function decideMedia(params, ctx) {
  const input = validate(params, { mediaId: { type: 'id' }, decision: { type: 'enum', values: ['pass', 'reject'] }, note: { type: 'string', maxLen: 200, optional: true } })
  const { accountId: actor } = await guardRole(ctx)
  let media = null
  try {
    const res = await ctx.db.collection(MEDIA_COLLECTION).doc(input.mediaId).get()
    media = (res && res.data && res.data[0]) || null
  } catch (e) {
    if (!isCollectionMissingError(e)) throw e
  }
  if (!media) throw notFound('图片记录不存在')
  const r = await settleMedia(ctx, media, { verdict: input.decision, label: input.note || null, actor })
  return { ok: true, status: r.status, changed: r.changed }
}

// ---------- 精华标记（BE-M6-02） ----------

/**
 * moderation.markFeatured：标 / 取消精华。只翻 topics.featured，不改 status（D12：精华不解除可见性判定）。
 * 只允许对 status = ok 的话题标精华（下架、折叠、待复核的内容不该被推到列表前面）；取消则任何时候都允许，
 * 便于撤销误标。二次调用是同值：数据不变、changed = false，但仍然留一条 mod_logs（人工操作逐次留痕）。
 */
async function markFeatured(params, ctx) {
  const input = validate(params, {
    topicId: idRule,
    featured: { type: 'boolean' },
    note: { type: 'string', maxLen: 200, optional: true },
  })
  const { accountId: actor } = await guardRole(ctx)
  const topic = await findContent(ctx.db, 'topic', input.topicId)
  if (!topic) throw notFound('话题不存在或已删除')
  const on = input.featured
  if (on && topic.status !== 'ok') throw badParam('只有正常显示的话题能标为精华')
  const changed = (topic.featured === true) !== on
  const now = ctx.now()
  if (changed) await ctx.db.collection(CONTENT_COLLECTION.topic).doc(input.topicId).update({ featured: on })
  await logModeration(ctx.db, {
    kind: FEATURED_LOG_KIND, action: on ? 'feature' : 'unfeature',
    targetType: 'topic', targetId: input.topicId, contentType: 'topic',
    actor, subject: topic._openid || null, note: input.note || null,
  }, now)
  return { ok: true, featured: on, changed }
}

const actions = {
  /** 健康检查：部署 / 安全规则验证用，不读写数据库 */
  async ping(_params, ctx) {
    return { fn: 'moderation', at: ctx.now() }
  },
  report,
  queue,
  decide,
  mediaQueue,
  decideMedia,
  markFeatured,
  // 图片机审回调不在这里：消息推送推给独立的 mediacheck 云函数（客户端无权调用），见 cloudfunctions/mediacheck
}

module.exports = { actions, IDENTITY_FREE_ACTIONS }
