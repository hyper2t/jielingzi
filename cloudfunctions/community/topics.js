'use strict'
/**
 * 深度话题与回复（BE-M3-01 ~ 04，PRD T1 / T2 / T4 / §8.3）。契约见 docs/api/community.md。
 *
 * - topics / replies 的作者字段是 `_openid`（= accountId，与其他 owned 集合一致；PRD 里叫 authorUid）。
 *   注销时 detach：_openid = null、authorDeleted = true，展示为「已注销用户」。
 * - 匿名脱敏（BE-M3-04）：任何返回值都不含 `_openid` / `authorUid` / `_id` 以外的内部字段，作者只给
 *   `author: { name, avatar, badges, isSelf }`；匿名时 name = anonAlias、avatar = null（默认头像）、badges = []。
 * - 写入链路：guardWrite（登录 → 未封禁 → 18+ → 实名 → 未禁言 → 当日额度：话题 2 / 回复 20，见 _shared/config.js DAILY_LIMITS）
 *   → 机审 checkText（reject：40001 不落库不扣额度；review：落库 status = pending 且进人工复核；pass：ok）→ 落库 → commit 计额度。
 * - 读：要求已确认 18+（PRD C5）；话题流只含 status = ok；pending 仅作者本人可见；folded 保留位置但不下发正文。
 * - 字数规则：标题单行、码点计；正文 / 回复的「有效字数」不含空白（防空格凑字数），与前端 src/features/topic/rules.ts 一致。
 * - 圈子（M4）：circleId 先恒为 null；传 circleId 暂时 40001。M4 接入成员校验后放开。
 */
const {
  badParam, notFound, unauthorized, AppError, CODES, validate, pageSchema, requireOpenid, guardWrite, checkText,
  logModeration, enqueueReview, withCollection, isCollectionMissingError, TEXT_RULES, TOPIC_RULES,
} = require('./_shared')
const { ensureProfile, textLength, cleanLine, INVISIBLE_RE } = require('./profile')

const TOPICS = 'topics'
const REPLIES = 'replies'
const PROFILES = 'profiles'
const DELETED_NAME = '已注销用户'
const IN_CHUNK = 100
const REJECT_MSG = '内容不符合社区公约，请修改后再发布'
/** 下发给前端的话题 / 回复里不允许出现的内部字段（测试据此断言） */
const INTERNAL_FIELDS = Object.freeze(['_openid', 'authorUid', 'openid', 'accountId', 'targetUid', 'reportCount', 'removedBy'])

// ---------- 文本清洗 ----------

const clip = (s, n) => {
  const chars = Array.from(String(s || '').replace(/\s+/g, ' ').trim())
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : chars.join('')
}

/** 多行正文：统一换行、去行尾空白、折叠 3 个以上连续换行；返回清洗后的文本与有效字数（不含空白） */
function cleanBody(label, value, { min = 0, max }) {
  if (typeof value !== 'string') throw badParam(`${label}格式错误`)
  if (INVISIBLE_RE.test(value.replace(/[\t\r\n]/g, ' '))) throw badParam(`${label}含有不支持的字符`)
  const text = value.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  const count = textLength(text.replace(/\s/g, ''))
  if (count < min) throw badParam(`${label}至少 ${min} 个字`)
  if (textLength(text) > max) throw badParam(`${label}最多 ${max} 个字`)
  return { text, count }
}

function cleanTags(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw badParam('标签格式错误')
  const out = []
  for (const raw of value) {
    const v = cleanLine('tag', '标签', typeof raw === 'string' ? raw.replace(/^#+/, '') : raw, TOPIC_RULES.tag)
    if (!out.includes(v)) out.push(v)
  }
  if (out.length > TOPIC_RULES.tagsMax) throw badParam(`标签最多 ${TOPIC_RULES.tagsMax} 个`)
  return out
}

function rejectUnknown(src, allowed) {
  const unknown = Object.keys(src).filter((k) => !allowed.includes(k))
  if (unknown.length) throw badParam(`不支持的参数：${unknown.join(',')}`)
}
const asObject = (p) => (p && typeof p === 'object' && !Array.isArray(p) ? p : {})
function asAnon(v) {
  if (v === undefined || v === null) return false
  if (typeof v !== 'boolean') throw badParam('匿名参数格式错误')
  return v
}

function parseTopic(params) {
  const src = asObject(params)
  rejectUnknown(src, ['title', 'body', 'anon', 'tags', 'circleId'])
  if (src.circleId !== undefined && src.circleId !== null) throw badParam('圈子话题暂未开放')
  const title = cleanLine('title', '标题', src.title === undefined ? '' : src.title, TEXT_RULES.topicTitle)
  const body = cleanBody('正文', src.body === undefined ? '' : src.body, TEXT_RULES.topicBody)
  return { title, body: body.text, tags: cleanTags(src.tags), anon: asAnon(src.anon) }
}

function parseReply(params) {
  const src = asObject(params)
  rejectUnknown(src, ['topicId', 'body', 'anon', 'quoteId'])
  const { topicId, quoteId } = validate({ topicId: src.topicId, quoteId: src.quoteId }, { topicId: { type: 'id' }, quoteId: { type: 'id', optional: true } })
  const body = cleanBody('回复', src.body === undefined ? '' : src.body, TEXT_RULES.reply)
  return { topicId, quoteId: quoteId || null, body: body.text, short: body.count < TEXT_RULES.shortReply, anon: asAnon(src.anon) }
}

// ---------- 读取与脱敏 ----------

async function findById(db, collection, id) {
  try {
    const res = await db.collection(collection).doc(id).get()
    return (res && res.data && res.data[0]) || null
  } catch (e) {
    if (isCollectionMissingError(e)) return null
    throw e
  }
}

async function findRows(query) {
  try {
    const res = await query.get()
    return (res && res.data) || []
  } catch (e) {
    if (isCollectionMissingError(e)) return []
    throw e
  }
}

async function countRows(query) {
  try {
    const res = await query.count()
    return (res && res.total) || 0
  } catch (e) {
    if (isCollectionMissingError(e)) return 0
    throw e
  }
}

/** 读内容要求已确认 18+（PRD C5）；返回当前账号 id */
async function requireReader(ctx) {
  const me = requireOpenid(ctx.identity)
  const rows = await findRows(ctx.db.collection('users').where({ _openid: me }).limit(1))
  if (!rows[0]) throw unauthorized('未获取到用户信息，请重新登录')
  if (typeof rows[0].adultConfirmedAt !== 'number') throw new AppError(CODES.ADULT_REQUIRED)
  return me
}

async function readProfiles(db, uids) {
  const ids = [...new Set(uids.filter((u) => typeof u === 'string' && u))]
  const map = new Map()
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const rows = await findRows(db.collection(PROFILES).where({ _openid: db.command.in(ids.slice(i, i + IN_CHUNK)) }).limit(IN_CHUNK))
    for (const p of rows) map.set(p._openid, p)
  }
  return map
}

/**
 * 作者展示对象（与前端 AuthorView / AuthorBadge 对齐）：已注销 / 匿名 / 实名三种形态。
 * 匿名与已注销时不给头像、徽章、练习方式、年限（避免被反推）；`anon` / `deleted` 让前端不必靠名字猜形态。
 */
function presentAuthor(doc, profiles, me) {
  const base = { avatar: null, badges: [], practices: [], years: null }
  if (doc.authorDeleted === true || !doc._openid) return { name: DELETED_NAME, ...base, isSelf: false, anon: false, deleted: true }
  const isSelf = doc._openid === me
  const p = profiles.get(doc._openid) || {}
  if (doc.anon === true) return { name: p.anonAlias || '匿名用户', ...base, isSelf, anon: true, deleted: false }
  return {
    name: p.nickname || p.anonAlias || '练习者',
    avatar: typeof p.avatar === 'string' ? p.avatar : null,
    badges: Array.isArray(p.badges) ? p.badges : [],
    practices: Array.isArray(p.practices) ? p.practices : [],
    years: typeof p.years === 'number' ? p.years : null,
    isSelf,
    anon: false,
    deleted: false,
  }
}

/** 话题对当前用户是否可见（ok / folded 所有人；pending 仅作者；removed 等不可见） */
const canView = (topic, me) => topic.status === 'ok' || topic.status === 'folded' || (topic.status === 'pending' && !!me && topic._openid === me)

function presentTopic(doc, profiles, me, { full = false } = {}) {
  const folded = doc.status === 'folded'
  const out = {
    id: doc._id,
    title: doc.title,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    anon: doc.anon === true,
    author: presentAuthor(doc, profiles, me),
    replyCount: Math.max(0, doc.replyCount || 0),
    createdAt: doc.createdAt,
    lastReplyAt: doc.lastReplyAt || doc.createdAt,
    featured: doc.featured === true,
    images: [],
    folded,
    pending: doc.status === 'pending',
  }
  if (full) out.body = folded ? null : doc.body
  else out.excerpt = folded ? '' : clip(doc.body, TOPIC_RULES.excerptLen)
  return out
}

function presentReply(doc, profiles, me, quote) {
  const folded = doc.status === 'folded'
  return {
    id: doc._id,
    topicId: doc.topicId,
    body: folded ? null : doc.body,
    short: doc.short === true,
    anon: doc.anon === true,
    author: presentAuthor(doc, profiles, me),
    quote: quote || null,
    createdAt: doc.createdAt,
    folded,
    pending: doc.status === 'pending',
  }
}

/** 引用展开：只展开正常（ok）的回复；被折叠 / 删除 / 待审的只告知「不可用」，不泄露内容。anon：被引用的是匿名回复（前端显示「匿名·代号」） */
function presentQuote(quoteId, q, profiles, me) {
  if (!q || q.status !== 'ok') return { id: quoteId, unavailable: true, authorName: null, anon: false, excerpt: null }
  const a = presentAuthor(q, profiles, me)
  return { id: quoteId, unavailable: false, authorName: a.name, anon: a.anon, excerpt: clip(q.body, 60) }
}

// ---------- 机审与落库的公共部分 ----------

async function screen(ctx, g, { scene, texts, now }) {
  const r = await checkText(ctx, { scene, texts })
  if (r.verdict !== 'pass') {
    await logModeration(ctx.db, { kind: 'machine', scene, verdict: r.verdict, categories: [...new Set(r.hits.map((h) => h.category))], labels: r.labels, actor: 'system', subject: g.accountId }, now)
  }
  if (r.verdict === 'reject') throw badParam(REJECT_MSG)
  return r.verdict === 'review' ? 'pending' : 'ok'
}

async function insert(ctx, collection, doc) {
  const res = await withCollection(ctx.db, collection, () => ctx.db.collection(collection).add(doc))
  return { ...doc, _id: res && (res.id || res._id) }
}

// ---------- 话题 ----------

/** community.createTopic（BE-M3-01 / 03） */
async function createTopic(params, ctx) {
  const input = parseTopic(params)
  const g = await guardWrite(ctx, 'createTopic')
  const now = ctx.now()
  const status = await screen(ctx, g, { scene: 'forum', texts: [input.title, input.body, ...input.tags], now })
  const { doc: profile } = await ensureProfile(ctx, g.accountId, now)
  const topic = await insert(ctx, TOPICS, {
    _openid: g.accountId, circleId: null, anon: input.anon, title: input.title, body: input.body, tags: input.tags, images: [],
    status, featured: false, replyCount: 0, reportCount: 0, createdAt: now, lastReplyAt: now,
  })
  if (status === 'pending') await enqueueReview(ctx.db, { contentType: 'topic', targetId: topic._id, now })
  await g.commit()
  return { topic: presentTopic(topic, new Map([[g.accountId, profile]]), g.accountId, { full: true }), status, remaining: g.remaining }
}

/** community.listTopics：话题流（status = ok，新的在前）；列表只给摘要 */
async function listTopics(params, ctx) {
  const src = asObject(params)
  const input = validate(src, { ...pageSchema(50), circleId: { type: 'id', optional: true } })
  if (input.circleId) throw badParam('圈子话题暂未开放')
  const me = await requireReader(ctx)
  const where = { status: 'ok' }
  const total = await countRows(ctx.db.collection(TOPICS).where(where))
  const start = (input.page - 1) * input.size
  const rows = total > start ? await findRows(ctx.db.collection(TOPICS).where(where).orderBy('createdAt', 'desc').skip(start).limit(input.size)) : []
  const profiles = await readProfiles(ctx.db, rows.map((t) => t._openid))
  return { list: rows.map((t) => presentTopic(t, profiles, me)), total, page: input.page, size: input.size, hasMore: start + rows.length < total }
}

/** community.getTopic：详情（含正文）；回复另用 listReplies */
async function getTopic(params, ctx) {
  const { id } = validate(params, { id: { type: 'id' } })
  const me = await requireReader(ctx)
  const topic = await findById(ctx.db, TOPICS, id)
  if (!topic || !canView(topic, me)) throw notFound('话题不存在或已删除')
  const profiles = await readProfiles(ctx.db, [topic._openid])
  return { topic: presentTopic(topic, profiles, me, { full: true }) }
}

// ---------- 回复 ----------

/** community.createReply（BE-M3-02 / 03）：< 30 字标记 short；可引用同一话题里的一条正常回复 */
async function createReply(params, ctx) {
  const input = parseReply(params)
  const g = await guardWrite(ctx, 'createReply')
  const topic = await findById(ctx.db, TOPICS, input.topicId)
  if (!topic || topic.status !== 'ok') throw notFound('话题不存在或暂时不能回复')
  let quoted = null
  if (input.quoteId) {
    quoted = await findById(ctx.db, REPLIES, input.quoteId)
    if (!quoted || quoted.topicId !== input.topicId || quoted.status !== 'ok') throw badParam('引用的回复不存在或已被处理')
  }
  const now = ctx.now()
  const status = await screen(ctx, g, { scene: 'comment', texts: [input.body], now })
  const { doc: profile } = await ensureProfile(ctx, g.accountId, now)
  const reply = await insert(ctx, REPLIES, {
    _openid: g.accountId, topicId: input.topicId, circleId: topic.circleId || null, anon: input.anon, body: input.body, short: input.short,
    quoteId: input.quoteId, status, reportCount: 0, createdAt: now,
  })
  if (status === 'pending') await enqueueReview(ctx.db, { contentType: 'reply', targetId: reply._id, now })
  else await ctx.db.collection(TOPICS).doc(topic._id).update({ replyCount: ctx.db.command.inc(1), lastReplyAt: now })
  await g.commit()
  const profiles = await readProfiles(ctx.db, [quoted && quoted._openid])
  profiles.set(g.accountId, profile)
  return { reply: presentReply(reply, profiles, g.accountId, quoted ? presentQuote(input.quoteId, quoted, profiles, g.accountId) : null), status, remaining: g.remaining }
}

/** community.listReplies：按时间正序；ok / folded 所有人可见，pending 仅作者本人 */
async function listReplies(params, ctx) {
  const input = validate(params, { topicId: { type: 'id' }, page: pageSchema(50).page, size: { type: 'int', min: 1, max: 50, default: 30 } })
  const me = await requireReader(ctx)
  const topic = await findById(ctx.db, TOPICS, input.topicId)
  if (!topic || !canView(topic, me)) throw notFound('话题不存在或已删除')
  const where = { topicId: input.topicId, status: ctx.db.command.in(['ok', 'folded', 'pending']) }
  const total = await countRows(ctx.db.collection(REPLIES).where(where))
  const start = (input.page - 1) * input.size
  const rows = total > start ? await findRows(ctx.db.collection(REPLIES).where(where).orderBy('createdAt', 'asc').skip(start).limit(input.size)) : []
  const visible = rows.filter((r) => r.status !== 'pending' || r._openid === me)
  // 引用展开：一次批量取回
  const quoteIds = [...new Set(visible.map((r) => r.quoteId).filter(Boolean))]
  const quotes = new Map()
  for (let i = 0; i < quoteIds.length; i += IN_CHUNK) {
    for (const q of await findRows(ctx.db.collection(REPLIES).where({ _id: ctx.db.command.in(quoteIds.slice(i, i + IN_CHUNK)) }).limit(IN_CHUNK))) quotes.set(q._id, q)
  }
  const profiles = await readProfiles(ctx.db, [...visible.map((r) => r._openid), ...[...quotes.values()].map((q) => q._openid)])
  const list = visible.map((r) => presentReply(r, profiles, me, r.quoteId ? presentQuote(r.quoteId, quotes.get(r.quoteId), profiles, me) : null))
  return { list, total, page: input.page, size: input.size, hasMore: start + rows.length < total }
}

// ---------- 删除自己的内容 ----------

/**
 * community.deleteMine（BE-M3-03）：作者删除自己的话题 / 回复 = 软删除（status = removed、removedBy = author，审核员不能恢复）。
 * 不是作者一律 40401（不暴露内容是否存在）；已删除的重复删除幂等。禁言期间也可以删除；不占额度。
 */
async function deleteMine(params, ctx) {
  const input = validate(params, { type: { type: 'enum', values: ['topic', 'reply'] }, id: { type: 'id' } })
  const g = await guardWrite(ctx, 'deleteMine', { requirePhone: false, allowMuted: true })
  const collection = input.type === 'topic' ? TOPICS : REPLIES
  const doc = await findById(ctx.db, collection, input.id)
  if (!doc || !doc._openid || doc._openid !== g.accountId) throw notFound('内容不存在或已删除')
  if (doc.status === 'removed') return { ok: true, changed: false }
  const now = ctx.now()
  await ctx.db.collection(collection).doc(input.id).update({ status: 'removed', removedBy: 'author', removedAt: now })
  if (input.type === 'reply' && doc.status === 'ok') await ctx.db.collection(TOPICS).doc(doc.topicId).update({ replyCount: ctx.db.command.inc(-1) })
  // 未处理的「机审待复核」随之关闭，避免审核员再看到已删除的内容
  if (doc.status === 'pending') {
    try {
      await ctx.db.collection('reports').where({ targetType: input.type, targetId: input.id, state: 'open', system: true }).update({ state: 'resolved', result: 'author_deleted', handledAt: now })
    } catch (e) {
      if (!isCollectionMissingError(e)) throw e
    }
  }
  return { ok: true, changed: true }
}

// parseTopic / parseReply：入参校验与清洗，导出供前后端一致性测试使用（tests/fixtures/topic-validation.json）
module.exports = { createTopic, listTopics, getTopic, createReply, listReplies, deleteMine, INTERNAL_FIELDS, parseTopic, parseReply }
