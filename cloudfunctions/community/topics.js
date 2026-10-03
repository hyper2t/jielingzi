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
 * - 慢话题与精华（M6）：`slow: true` → 落库 `slowUntil = createdAt + TOPIC_RULES.slowHours`，到点前 `createReply` 一律 40901（作者也一样），
 *   已有回复与读取不受影响；`featured` 只由 moderation.markFeatured 改，不影响 `status`，所以精华列表不会越过圈子成员校验（D12）。
 * - 圈子（M4，BE-M4-03）：话题必须属于一个圈子，**只有圈子成员能读写**（审核员也没有读圈内内容的特权）。
 *   不是成员 / 圈子已关闭 / circleId 为空的旧话题：读详情、读回复、写回复一律 40401（与「不存在」一致，防遍历 ID）；
 *   话题流（listTopics）不传圈子 = 聚合我所有圈子，传了却不是成员 40301。deleteMine 不要求成员。
 *   circles.topicCount 是展示用近似值（发布 +1、作者删除 −1，运维脚本 recount 校正）。
 */
const {
  badParam, conflict, notFound, forbidden, validate, pageSchema, guardWrite, checkText,
  logModeration, enqueueReview, withCollection, isCollectionMissingError, TEXT_RULES, TOPIC_RULES,
} = require('./_shared')
const { ensureProfile, textLength, cleanLine, INVISIBLE_RE } = require('./profile')
const { findById, findRows, countRows, requireReader } = require('./common')
const { myOpenCircles, circleAccess } = require('./circles')

const TOPICS = 'topics'
const REPLIES = 'replies'
const CIRCLES = 'circles'
const PROFILES = 'profiles'
const DELETED_NAME = '已注销用户'
const IN_CHUNK = 100
const REJECT_MSG = '内容不符合社区公约，请修改后再发布'
/** 慢话题（D11）：冷静期内回复时的话术（40901） */
const SLOW_REPLY_MSG = '这条话题还没开放回复'
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
  rejectUnknown(src, ['title', 'body', 'anon', 'tags', 'circleId', 'slow'])
  const { circleId, slow } = validate(
    { circleId: src.circleId, slow: src.slow },
    { circleId: { type: 'id', optional: true }, slow: { type: 'boolean', optional: true } },
  )
  const title = cleanLine('title', '标题', src.title === undefined ? '' : src.title, TEXT_RULES.topicTitle)
  const body = cleanBody('正文', src.body === undefined ? '' : src.body, TEXT_RULES.topicBody)
  return { title, body: body.text, tags: cleanTags(src.tags), anon: asAnon(src.anon), circleId: circleId || null, slow: slow === true }
}

function parseReply(params) {
  const src = asObject(params)
  rejectUnknown(src, ['topicId', 'body', 'anon', 'quoteId'])
  const { topicId, quoteId } = validate({ topicId: src.topicId, quoteId: src.quoteId }, { topicId: { type: 'id' }, quoteId: { type: 'id', optional: true } })
  const body = cleanBody('回复', src.body === undefined ? '' : src.body, TEXT_RULES.reply)
  return { topicId, quoteId: quoteId || null, body: body.text, short: body.count < TEXT_RULES.shortReply, anon: asAnon(src.anon) }
}

// ---------- 读取与脱敏 ----------

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

/** 话题所属圈子的展示对象（只给 id 与名称）；circles 为 Map<circleId, circleDoc> */
function circleView(id, circles) {
  const c = id && circles ? circles.get(id) : null
  return c ? { id: c._id, name: typeof c.name === 'string' ? c.name : '' } : null
}
function presentTopic(doc, profiles, me, { full = false, circles = null } = {}) {
  const folded = doc.status === 'folded'
  const out = {
    id: doc._id,
    title: doc.title,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    anon: doc.anon === true,
    circle: circleView(doc.circleId, circles),
    author: presentAuthor(doc, profiles, me),
    replyCount: Math.max(0, doc.replyCount || 0),
    createdAt: doc.createdAt,
    lastReplyAt: doc.lastReplyAt || doc.createdAt,
    featured: doc.featured === true,
    // 慢话题：到点前 createReply 会被拒；null = 没有冷静期（含 M6 之前的旧数据）
    slowUntil: typeof doc.slowUntil === 'number' ? doc.slowUntil : null,
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

/** 圈子话题数（展示用近似值）：失败不影响主流程 */
async function bumpTopicCount(ctx, circleId, delta) {
  try {
    const _ = ctx.db.command
    // 减少时带 ≥ 1 条件：近似值不会被减成负数
    if (delta < 0) await ctx.db.collection(CIRCLES).where({ _id: circleId, topicCount: _.gte(1) }).update({ topicCount: _.inc(delta) })
    else await ctx.db.collection(CIRCLES).doc(circleId).update({ topicCount: _.inc(delta) })
  } catch (e) {
    if (ctx.logger && ctx.logger.error) ctx.logger.error('更新圈子话题数失败', circleId, e)
  }
}

// ---------- 话题 ----------

/** community.createTopic（BE-M3-01 / 03） */
async function createTopic(params, ctx) {
  const input = parseTopic(params)
  const g = await guardWrite(ctx, 'createTopic')
  // 圈子：指定的必须是我加入的开放圈子；没指定时，恰好加入 1 个就默认归到它，多个要选，没有则要先入圈
  const mine = await myOpenCircles(ctx.db, g.accountId)
  let circle = null
  if (input.circleId) circle = mine.get(input.circleId) || null
  else if (mine.size === 1) circle = [...mine.values()][0]
  else if (mine.size > 1) throw badParam('请选择圈子')
  if (!circle) throw forbidden('加入圈子后才能发帖')
  const now = ctx.now()
  const status = await screen(ctx, g, { scene: 'forum', texts: [input.title, input.body, ...input.tags], now })
  const { doc: profile } = await ensureProfile(ctx, g.accountId, now)
  // 慢话题（D11）：只记「什么时候开放回复」，是否到点在读侧按 ctx.now() 判，不做定时任务、不额外存标记字段
  const slowUntil = input.slow ? now + TOPIC_RULES.slowHours * 3600 * 1000 : null
  const topic = await insert(ctx, TOPICS, {
    _openid: g.accountId, circleId: circle._id, anon: input.anon, title: input.title, body: input.body, tags: input.tags, images: [],
    status, featured: false, slowUntil, replyCount: 0, reportCount: 0, createdAt: now, lastReplyAt: now,
  })
  if (status === 'pending') await enqueueReview(ctx.db, { contentType: 'topic', targetId: topic._id, now })
  else await bumpTopicCount(ctx, circle._id, 1)
  await g.commit()
  return { topic: presentTopic(topic, new Map([[g.accountId, profile]]), g.accountId, { full: true, circles: mine }), status, remaining: g.remaining }
}

/** community.listTopics：话题流（status = ok，新的在前）；列表只给摘要 */
async function listTopics(params, ctx) {
  const src = asObject(params)
  const input = validate(src, { ...pageSchema(50), circleId: { type: 'id', optional: true }, featured: { type: 'boolean', optional: true } })
  const me = await requireReader(ctx)
  const mine = await myOpenCircles(ctx.db, me)
  const empty = { list: [], total: 0, page: input.page, size: input.size, hasMore: false }
  let where
  if (input.circleId) {
    if (!mine.has(input.circleId)) throw forbidden('加入圈子后才能查看')
    where = { status: 'ok', circleId: input.circleId }
  } else {
    if (!mine.size) return empty
    where = { status: 'ok', circleId: ctx.db.command.in([...mine.keys()]) }
  }
  // 精华筛选（D12）：只加一个 where 条件，可见性仍由上面的圈子成员决定；featured=false 视为「不过滤」
  if (input.featured === true) where.featured = true
  const total = await countRows(ctx.db.collection(TOPICS).where(where))
  const start = (input.page - 1) * input.size
  const rows = total > start ? await findRows(ctx.db.collection(TOPICS).where(where).orderBy('createdAt', 'desc').skip(start).limit(input.size)) : []
  const profiles = await readProfiles(ctx.db, rows.map((t) => t._openid))
  return { list: rows.map((t) => presentTopic(t, profiles, me, { circles: mine })), total, page: input.page, size: input.size, hasMore: start + rows.length < total }
}

/** community.getTopic：详情（含正文）；回复另用 listReplies */
async function getTopic(params, ctx) {
  const { id } = validate(params, { id: { type: 'id' } })
  const me = await requireReader(ctx)
  const topic = await findById(ctx.db, TOPICS, id)
  if (!topic || !canView(topic, me)) throw notFound('话题不存在或已删除')
  const circle = await circleAccess(ctx.db, me, topic.circleId)
  if (!circle) throw notFound('话题不存在或已删除')
  const profiles = await readProfiles(ctx.db, [topic._openid])
  return { topic: presentTopic(topic, profiles, me, { full: true, circles: new Map([[circle._id, circle]]) }) }
}

// ---------- 回复 ----------

/** community.createReply（BE-M3-02 / 03）：< 30 字标记 short；可引用同一话题里的一条正常回复 */
async function createReply(params, ctx) {
  const input = parseReply(params)
  const g = await guardWrite(ctx, 'createReply')
  const topic = await findById(ctx.db, TOPICS, input.topicId)
  if (!topic || topic.status !== 'ok' || !(await circleAccess(ctx.db, g.accountId, topic.circleId))) throw notFound('话题不存在或暂时不能回复')
  let quoted = null
  if (input.quoteId) {
    quoted = await findById(ctx.db, REPLIES, input.quoteId)
    if (!quoted || quoted.topicId !== input.topicId || quoted.status !== 'ok') throw badParam('引用的回复不存在或已被处理')
  }
  const now = ctx.now()
  // 冷静期（D11）：放在机审与 g.commit() 之前——被拒的回复不占当日额度，也不消耗机审调用
  if (typeof topic.slowUntil === 'number' && now < topic.slowUntil) throw conflict(SLOW_REPLY_MSG)
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
  if (!topic || !canView(topic, me) || !(await circleAccess(ctx.db, me, topic.circleId))) throw notFound('话题不存在或已删除')
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
  if (input.type === 'topic' && doc.status === 'ok' && doc.circleId) await bumpTopicCount(ctx, doc.circleId, -1)
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
