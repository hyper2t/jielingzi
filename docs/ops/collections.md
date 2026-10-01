# 数据库集合与索引（OPS-M0-02）

> 清单的唯一来源：`cloudfunctions/_shared/collections.js`。建集合、安全规则、备份、账号合并 / 注销都读它，**新增集合只改那里**，再更新本文的索引表。
> 字段模型：`docs/prd/README.md` §8。归属字段统一为 `_openid`（承载 accountId）。

## 1. 初始化（新环境 / 新增集合后）

```bash
node scripts/ops/ensure-collections.mjs --check   # 只检查
node scripts/ops/ensure-collections.mjs           # 创建缺失的集合（幂等）
node scripts/ops/security-rules.mjs               # 查看当前规则
node scripts/ops/security-rules.mjs --apply       # 下发：全部集合 {read:false, write:false}；user/community/moderation/practice 需登录
```

## 2. 集合、归属策略与安全规则

| 集合 | 用途 | 合并（同一人两个账号） | 注销 | 客户端规则 |
|---|---|---|---|---|
| users | 用户（实名 `phoneVerified` / `phoneHash`（只存哈希）、18+ `adultConfirmedAt`、协议版本、角色、处罚、邀请名额） | account.js 处理（实名 / 18+ 补齐，处罚取较晚，角色取较高） | 删除 | 私有 |
| account_links | 身份别名（含 M1 的 `phone:<hash>`） | 重定向 | 删除 | 私有 |
| account_merges | 合并审计 | — | 保留 | 私有 |
| profiles | 练习档案 | 每账号一条，保留主账号 | 删除 | 私有 |
| circles | 官方圈子 | — | — | 私有 |
| memberships | 圈子成员 | 按 circleId 去重 | 删除 | 私有 |
| invites | 邀请码 | 改归属 | 删除 | 私有 |
| topics | 话题 | 改归属 | **保留，解除归属**（显示"已注销用户"） | 私有 |
| replies | 回复 | 改归属 | **保留，解除归属** | 私有 |
| reports | 举报（_openid = 举报人） | 改归属 | **保留，解除归属** | 私有 |
| mod_logs | 机审 / 人工处理日志（≥ 6 个月） | — | 保留 | 私有 |
| checkins | 打卡 | 按 dayKey 累加 minutes | 删除 | 私有 |
| daily_prompts | 每日一题 | — | — | 私有 |
| prompt_answers | 每日一题作答 | 按 promptId 去重 | **保留，解除归属** | 私有 |
| notifications | 站内消息 | 改归属 | 删除 | 私有 |
| rate_limits | 频控计数（_id = accountId:action:日期，expireAt 2 天） | — | 过期自动清理 | 私有 |

"私有" = `{ read: false, write: false }`：客户端 SDK 不能直读直写，所有读写经云函数。

## 3. 索引（`node scripts/ops/ensure-indexes.mjs [--apply]`）

清单的唯一来源：`cloudfunctions/_shared/collections.js` 每个集合的 `indexes`（下表由它生成）。脚本按「字段 + 方向」比对已有索引，只创建缺失的，不删除任何索引；唯一性不一致的只报告。

| 集合 | 索引名 | 字段 | 类型 |
|---|---|---|---|
| users | `uniq_openid` | `_openid` | 唯一 |
| account_links | `idx_accountId` | `accountId` | 普通 |
| profiles | `uniq_openid` | `_openid` | 唯一 |
| profiles | `uniq_anonAlias` | `anonAlias` | 唯一 |
| memberships | `uniq_circle_member` | `circleId` + `_openid` | 唯一 |
| invites | `uniq_code` | `code` | 唯一 |
| topics | `idx_circle_status_time` | `circleId` + `status` + `createdAt`(desc) | 普通 |
| topics | `idx_author_time` | `_openid` + `createdAt`(desc) | 普通 |
| replies | `idx_topic_time` | `topicId` + `createdAt` | 普通 |
| reports | `idx_reporter_target` | `targetType` + `targetId` + `_openid` | 普通 |
| reports | `idx_target_state` | `targetType` + `targetId` + `state` | 普通 |
| reports | `idx_state_time` | `state` + `createdAt`(desc) | 普通 |
| mod_logs | `idx_expireAt` | `expireAt` | 普通 |
| mod_logs | `idx_subject_time` | `subject` + `createdAt`(desc) | 普通 |
| checkins | `uniq_owner_day` | `_openid` + `dayKey` | 唯一 |
| daily_prompts | `uniq_date` | `date` | 唯一 |
| prompt_answers | `idx_prompt_owner` | `promptId` + `_openid` | 普通 |
| notifications | `idx_owner_read_time` | `_openid` + `read` + `createdAt`(desc) | 普通 |
| rate_limits | `idx_expireAt` | `expireAt` | 普通 |

说明：
- **注销会解除归属的集合（topics / replies / reports / prompt_answers，`onDelete: 'detach'`）不能建包含 `_openid` 的唯一索引**：注销把 `_openid` 置 null，第二个注销的人会撞索引而失败。这些集合的去重在应用层（举报：同人同目标只计一次、计数按不同举报人去重；每日一题：作答前查询）。`scripts/ops/ensure-indexes.test.mjs` 会拦这类配置。
- **过期清理（TTL）**：平台 OpenAPI 只支持普通 / 唯一 / 稀疏索引，不支持 TTL。`rate_limits` / `mod_logs` 的 `expireAt` 上建的是普通索引；需要自动过期请在控制台确认是否提供 TTL 选项，否则后续加定时清理（数据量很小：频控每人每动作每天一条，日志保留 6 个月）。
- 唯一索引只能在集合里没有重复数据时创建；新环境先跑 `ensure-collections.mjs` 再跑本脚本。
