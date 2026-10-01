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

## 3. 索引（控制台手动创建：云开发平台 → 数据库 → 集合 → 索引管理）

| 集合 | 索引 | 类型 | 何时需要 |
|---|---|---|---|
| users | `_openid` | 唯一 | 已有 |
| account_links | `accountId` | 普通 | 已有 |
| profiles | `_openid` | 唯一 | M1 |
| profiles | `anonAlias` | 唯一 | M1 |
| memberships | `circleId` + `_openid` | 唯一 | M4 |
| invites | `code` | 唯一 | M4 |
| topics | `circleId` + `status` + `createdAt`(desc) | 普通 | M3 |
| topics | `_openid` + `createdAt`(desc) | 普通 | M3 |
| replies | `topicId` + `createdAt` | 普通 | M3 |
| reports | `targetId` + `_openid` | 唯一 | M2 |
| reports | `state` + `createdAt` | 普通 | M2 |
| checkins | `_openid` + `dayKey` | 唯一 | M5 |
| daily_prompts | `date` | 唯一 | M6 |
| prompt_answers | `promptId` + `_openid` | 唯一 | M6 |
| notifications | `_openid` + `read` + `createdAt`(desc) | 普通 | M6 |
| rate_limits | `expireAt` | TTL（0 秒） | M0 |
