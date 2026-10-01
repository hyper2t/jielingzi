'use strict'
/**
 * 集合登记表（OPS-M0-02）：结灵子所有 CloudBase 集合的唯一清单。读这里的有：
 *   - scripts/ops/ensure-collections.mjs   建集合
 *   - scripts/ops/security-rules.mjs       下发数据库安全规则（全部 { read:false, write:false }：所有读写走云函数）
 *   - scripts/ops/backup.ts                备份范围
 *   - ./owned.js                           账号合并 / 注销的业务集合（owned 字段）
 * 字段模型见 docs/prd/README.md §8。归属字段统一为 `_openid`（承载 accountId，见 account.js）。
 *
 * owned（可选，"属于某个用户"的集合）：
 *   key      合并去重键（字段名）；single=true 表示每个账号只有一条（如 profiles）
 *   keep     冲突时保留：'primary'（默认）| 'newer'（updatedAt 较新）| 'sum'（累加 sumFields 后保留主账号那条）
 *   onDelete 注销时：'remove'（默认，删除）| 'detach'（保留内容、解除归属，作者显示为"已注销用户"——用户协议须说明）
 *
 * indexes（scripts/ops/ensure-indexes.mjs 据此建索引；docs/ops/collections.md §3 是它的说明）：
 *   { name, keys: [[字段, 1 | -1], ...], unique? }
 *   注意：onDelete = 'detach' 的集合不能建包含 _openid 的唯一索引——注销会把 _openid 置 null，
 *   第二个注销的人就会撞唯一索引而失败（collections 测试会拦）。这类去重放在应用层做。
 */

const PRIVATE = Object.freeze({ read: false, write: false })

/** @type {ReadonlyArray<{ name: string, desc: string, owned?: { key?: string, single?: boolean, keep?: 'primary'|'newer'|'sum', sumFields?: string[], onDelete?: 'remove'|'detach' }, indexes?: Array<{ name: string, keys: Array<[string, 1 | -1]>, unique?: boolean }> }>} */
const COLLECTIONS = Object.freeze([
  // 账号层（account.js 自己管理，不登记 owned）
  { name: 'users', desc: '用户（实名、18+、角色、处罚、邀请名额）', indexes: [{ name: 'uniq_openid', keys: [['_openid', 1]], unique: true }] },
  { name: 'account_links', desc: '身份别名 → accountId', indexes: [{ name: 'idx_accountId', keys: [['accountId', 1]] }] },
  { name: 'account_merges', desc: '账号合并审计' },

  // 练习档案
  {
    name: 'profiles',
    desc: '练习档案（昵称、练习方式、匿名代号）',
    owned: { single: true, keep: 'primary' },
    indexes: [{ name: 'uniq_openid', keys: [['_openid', 1]], unique: true }, { name: 'uniq_anonAlias', keys: [['anonAlias', 1]], unique: true }],
  },

  // 圈子与话题
  // slug：稳定标识，种子脚本按它 upsert（改名不改 slug）
  { name: 'circles', desc: '官方圈子', indexes: [{ name: 'uniq_slug', keys: [['slug', 1]], unique: true }] },
  {
    name: 'memberships',
    desc: '圈子成员关系',
    owned: { key: 'circleId', keep: 'primary' },
    indexes: [
      { name: 'uniq_circle_member', keys: [['circleId', 1], ['_openid', 1]], unique: true },
      // 「我的圈子」：按成员查（唯一索引以 circleId 打头，不能用于按成员查）
      { name: 'idx_member', keys: [['_openid', 1], ['joinedAt', 1]] },
    ],
  },
  {
    name: 'invites',
    desc: '邀请码',
    owned: {},
    indexes: [
      { name: 'uniq_code', keys: [['code', 1]], unique: true },
      // 「我的邀请码」与过期退名额扫描
      { name: 'idx_owner_time', keys: [['_openid', 1], ['createdAt', -1]] },
    ],
  },
  {
    name: 'topics',
    desc: '话题',
    owned: { onDelete: 'detach' },
    indexes: [
      { name: 'idx_circle_status_time', keys: [['circleId', 1], ['status', 1], ['createdAt', -1]] },
      // M3 首页话题流（不分圈子）：status = ok，按时间倒序
      { name: 'idx_status_time', keys: [['status', 1], ['createdAt', -1]] },
      { name: 'idx_author_time', keys: [['_openid', 1], ['createdAt', -1]] },
    ],
  },
  { name: 'replies', desc: '回复', owned: { onDelete: 'detach' }, indexes: [{ name: 'idx_topic_time', keys: [['topicId', 1], ['createdAt', 1]] }] },

  // 内容安全
  {
    name: 'reports',
    desc: '举报（_openid = 举报人）',
    owned: { onDelete: 'detach' },
    // 去重在应用层（同一人同一目标只计一次；计数按不同举报人去重），这里不建唯一索引（见头注释）
    indexes: [
      { name: 'idx_reporter_target', keys: [['targetType', 1], ['targetId', 1], ['_openid', 1]] },
      { name: 'idx_target_state', keys: [['targetType', 1], ['targetId', 1], ['state', 1]] },
      { name: 'idx_state_time', keys: [['state', 1], ['createdAt', -1]] },
    ],
  },
  {
    name: 'mod_logs',
    desc: '机审 / 人工处理日志（保留 6 个月，备监管查询）',
    indexes: [{ name: 'idx_expireAt', keys: [['expireAt', 1]] }, { name: 'idx_subject_time', keys: [['subject', 1], ['createdAt', -1]] }],
  },

  // 练习工具
  { name: 'checkins', desc: '练习打卡（dayKey = 日期:练习方式）', owned: { key: 'dayKey', keep: 'sum', sumFields: ['minutes'] }, indexes: [{ name: 'uniq_owner_day', keys: [['_openid', 1], ['dayKey', 1]], unique: true }] },
  { name: 'daily_prompts', desc: '每日一题', indexes: [{ name: 'uniq_date', keys: [['date', 1]], unique: true }] },
  // 每日一次在应用层判断（注销会解除归属，不能建含 _openid 的唯一索引）
  { name: 'prompt_answers', desc: '每日一题作答', owned: { key: 'promptId', keep: 'primary', onDelete: 'detach' }, indexes: [{ name: 'idx_prompt_owner', keys: [['promptId', 1], ['_openid', 1]] }] },

  // 用户上传图片的机审记录（BE-M2-02）；注销时记录删除，文件由 user.deleteAccount 一并删除
  {
    name: 'media',
    desc: '用户上传图片的机审记录（头像等）',
    owned: {},
    indexes: [{ name: 'idx_traceId', keys: [['traceId', 1]] }, { name: 'idx_status_time', keys: [['status', 1], ['createdAt', -1]] }, { name: 'idx_owner_time', keys: [['_openid', 1], ['createdAt', -1]] }],
  },

  // 通知与频控
  { name: 'notifications', desc: '站内消息', owned: {}, indexes: [{ name: 'idx_owner_read_time', keys: [['_openid', 1], ['read', 1], ['createdAt', -1]] }] },
  { name: 'rate_limits', desc: '频控计数（_id = accountId:action:日期）', indexes: [{ name: 'idx_expireAt', keys: [['expireAt', 1]] }] },
])

const COLLECTION_NAMES = COLLECTIONS.map((c) => c.name)

/** 数据库安全规则：客户端一律不可直读直写 */
function collectionRules() {
  return Object.fromEntries(COLLECTIONS.map((c) => [c.name, PRIVATE]))
}

/** ensure-indexes 的登记项：[{ collection, name, keys, unique }] */
function indexDefs() {
  return COLLECTIONS.flatMap((c) => (c.indexes || []).map((i) => ({ collection: c.name, unique: false, ...i })))
}

/** owned.js 的登记项 */
function ownedDefs() {
  return COLLECTIONS.filter((c) => c.owned).map((c) => ({ name: c.name, ...c.owned }))
}

module.exports = { COLLECTIONS, COLLECTION_NAMES, collectionRules, ownedDefs, indexDefs, PRIVATE_RULE: PRIVATE }
