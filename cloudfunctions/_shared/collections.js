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
 */

const PRIVATE = Object.freeze({ read: false, write: false })

/** @type {ReadonlyArray<{ name: string, desc: string, owned?: { key?: string, single?: boolean, keep?: 'primary'|'newer'|'sum', sumFields?: string[], onDelete?: 'remove'|'detach' } }>} */
const COLLECTIONS = Object.freeze([
  // 账号层（account.js 自己管理，不登记 owned）
  { name: 'users', desc: '用户（实名、18+、角色、处罚、邀请名额）' },
  { name: 'account_links', desc: '身份别名 → accountId' },
  { name: 'account_merges', desc: '账号合并审计' },

  // 练习档案
  { name: 'profiles', desc: '练习档案（昵称、练习方式、匿名代号）', owned: { single: true, keep: 'primary' } },

  // 圈子与话题
  { name: 'circles', desc: '官方圈子' },
  { name: 'memberships', desc: '圈子成员关系', owned: { key: 'circleId', keep: 'primary' } },
  { name: 'invites', desc: '邀请码', owned: {} },
  { name: 'topics', desc: '话题', owned: { onDelete: 'detach' } },
  { name: 'replies', desc: '回复', owned: { onDelete: 'detach' } },

  // 内容安全
  { name: 'reports', desc: '举报（_openid = 举报人）', owned: { onDelete: 'detach' } },
  { name: 'mod_logs', desc: '机审 / 人工处理日志（保留 6 个月，备监管查询）' },

  // 练习工具
  { name: 'checkins', desc: '练习打卡（dayKey = 日期:练习方式）', owned: { key: 'dayKey', keep: 'sum', sumFields: ['minutes'] } },
  { name: 'daily_prompts', desc: '每日一题' },
  { name: 'prompt_answers', desc: '每日一题作答', owned: { key: 'promptId', keep: 'primary', onDelete: 'detach' } },

  // 通知与频控
  { name: 'notifications', desc: '站内消息', owned: {} },
  { name: 'rate_limits', desc: '频控计数（_id = accountId:action:日期）' },
])

const COLLECTION_NAMES = COLLECTIONS.map((c) => c.name)

/** 数据库安全规则：客户端一律不可直读直写 */
function collectionRules() {
  return Object.fromEntries(COLLECTIONS.map((c) => [c.name, PRIVATE]))
}

/** owned.js 的登记项 */
function ownedDefs() {
  return COLLECTIONS.filter((c) => c.owned).map((c) => ({ name: c.name, ...c.owned }))
}

module.exports = { COLLECTIONS, COLLECTION_NAMES, collectionRules, ownedDefs, PRIVATE_RULE: PRIVATE }
