# 加入机制 v0.2 规划：申请审核 / 邀请码增强 / 圈主前置

> 状态（2026-10-03）：**草案，待评审；未排期、未实现**。里程碑编号建议 **M8（v0.2 公测期）**，可按最终排期调整。
> 依据：2026-10-03 加入机制讨论（分层结论：App 半开放浏览 + 圈子按私密程度使用「邀请 / 申请」混合制）；现状基线为 [`m4-plan.md`](./m4-plan.md)（D1–D14）与 [`docs/api/community.md`](../api/community.md)「圈子与邀请码（M4 契约）」；对应 PRD §5 G2/G3、§10 v0.2 / v0.3。
> 前置依赖：**M4 签核**（[`docs/ops/release-checklist.md`](../ops/release-checklist.md) 第 6–8 步）；申请结果通知依赖 M6 的 N1；审核人力依赖 [`docs/ops/compliance-checklist.md`](../ops/compliance-checklist.md) §4 的值班人。

## 1. 范围与目标

| 项 | 内容 | 理由 |
|---|---|---|
| V2-1 | **申请审核入圈**：`circles.joinMode` + `applyCircle` / `listApplications` / `decideApplication` | 公测放量需要一条不依赖邀请码的入口；内测保持全邀请不动 |
| V2-2 | **邀请码撤销**：`invites.revokedAt` + 运维 `circles.mjs revoke`；云函数动作留到圈主时代 | 误发 / 外传的码现在只能等 7 天过期，撤销是运营兜底 |
| V2-3 | **滥用监控（先监控后拦截）**：同邀请人兑换集中度、同 IP 成功兑换数等 | 防倒卖靠数据阈值与人工处置，不先上自动拦截 |
| V2-4 | **圈主前置**：[`owner-agreement.md`](./owner-agreement.md) 骨架 + 「平台依法审核与抽查」条款 | v0.3 用户自建圈子的前置；平衡 D10（审核员无读圈内内容特权）与平台内容管理义务 |

**明确不做**：全 App 注册门禁（小程序无注册墙，且违背「浏览半开放」定位）；公共广场 / 新手村（与 D6「圈内内容仅成员可见」冲突，扩大安全评估与审核面）；设备指纹级风控（量未到）。

## 2. 决策（默认，可推翻）

| # | 决策 | 理由 |
|---|---|---|
| D-J1 | `joinMode: 'invite' \| 'apply' \| 'owner_only'` 单枚举，默认 `invite`；`apply` 语义 = 开放申请**且**成员邀请码继续有效 | 与产品语言一一对应；申请与邀请并行（分层方案的初衷） |
| D-J2 | v0.2 只给「正念生活」（`lifestyle`）一个圈开 `apply`；「静观练习 / 传统养生」保持邀请 | 审核带宽是硬约束；单圈可试点、可回退 |
| D-J3 | 官方圈申请审核人 = `mod / admin`（并入 `pkg-admin` 队列），不引入圈子级角色 | 不为试点先造一套圈主权限体系（那是 v0.3） |
| D-J4 | 申请要求实名（与 D5 加入门槛一致）；表单全结构化，**不收集**师承 / 门派 / 宗教背景 / 健康信息 | 宗教信仰属 PIPL 敏感个人信息（第 28 条）；与「非互联网宗教信息服务」定位一致 |
| D-J5 | 被拒后冷却 7 天；`pending` 每账号 ≤ 2 个；重复提交幂等（`duplicate: true`，不扣额度） | 防刷；复用 `moderation.report` 的 duplicate 语义 |
| D-J6 | 撤销仅限未使用的码；撤销即退额（与过期退额共用 `refunded` 一次性标记）；已用码不可撤 | 成员去留属 v0.3 议题（D12 现无移除成员能力） |
| D-J7 | 滥用先做「监控指标 + 人工处置」，不自动拦截 IP / 设备 | 内测量小，误伤成本大于收益 |
| D-J8 | 圈主角色与权限推迟到 v0.3，本轮只交付协议骨架与审核权条款 | 没有自建圈子就没有圈主，提前造权限无人使用 |

## 3. 数据与配置（增量）

契约草案全文见 [`docs/api/community.md`](../api/community.md)「加入方式与申请审核（草案 · 未实现）」。摘要：

- `circles.joinMode`（缺省视为 `invite`，存量数据不迁移）。
- `applications` 新集合：`circleId`、`_openid`、`answers { practices, years, topic, willingness }`、`status(pending/approved/rejected)`、`createdAt/updatedAt`、`decidedBy/decidedAt`、`reason`、`note`；唯一索引 `uniq_application (circleId, _openid)`、`idx_apply_queue (status, createdAt)`。
- `invites.revokedAt / revokedBy`（撤销留痕；`revokedBy` 不下发）。
- `_shared/config.js`：`APPLY_RULES = { topicMax: 80, practicesMax: 3, yearsMax: 60, cooldownDays: 7, pendingMaxPerUser: 2, listMax: 50 }`；`DAILY_LIMITS += { applyCircle: 5 }`；前端 `src/constants/community.ts` 同名常量由测试比对（沿用现有做法）。
- 索引由 `scripts/ops/ensure-indexes.mjs` 新增（只增不改）。

## 4. 申请表单（合规修订版）与审核 rubric

**表单字段**（界面文案见 [`wording.md`](./wording.md) §6）：

| 字段 | 类型 | 约束 | 处理 |
|---|---|---|---|
| practices | string[] | 1–3 个，取 `PRACTICES` 预置值 | — |
| years | number \| null | 0–60 | — |
| topic | string | 1–80 字，去首尾空白 | 词库 + `msgSecCheck`；reject → 40001，不落库 |
| willingness | enum | `read` / `discuss` / `write` | — |

**明确不收集**：师承、门派、「修行」经历、宗教归属、健康状况、任何联系方式。理由：可推断宗教信仰的信息属敏感个人信息（PIPL 第 28 条），收集需特定目的 + 充分必要 + 单独同意 + 影响评估；入圈审核构不成必要性，且与产品定位冲突（措辞规范 [`wording.md`](./wording.md) §1、§2）。

**审核 rubric（只看两点）**：① 认真填写——`topic` 与圈子主题相关、非模板化；② 无违规——无引流 / 宗教 / 疗效 / 广告（机审已拦一层，人审复核）。不评价水平与资历；拿不准时倾向通过（内测期圈子质量有邀请制打底）。

**数据保留**：`rejected` 超过 90 天的申请由运维脚本清理 `answers`（v0.2 先做脚本）。

## 5. 任务拆解

| 编号 | 负责 | 任务 | 验收 | 估时 |
|---|---|---|---|---|
| BE-M8-01 | BE | `joinMode` 数据与读取：`circles.joinMode`、`presentCircle` 下发、缺省 `invite` 兼容 | 单测；M4 用例仅补断言、不回归 | 0.5d |
| BE-M8-02 | BE | `applyCircle`：表单校验、机审、频控、幂等（duplicate）、冷却与重投复用 | 单测：重复 / 冷却 / 未实名 / 非 apply 圈 | 1d |
| BE-M8-03 | BE | `listApplications` / `decideApplication`：并发双审、入圈幂等（`memberships` 唯一索引）、`memberCount` 维护、`mod_logs`、通知钩子（N1） | 单测：并发双审一成一败；返回体不含内部字段 | 1d |
| BE-M8-04 | BE | **撤销数据层**：`invites.revokedAt`；兑换拒绝（同一条 40401 文案）；`listInvites` 增 `revoked` 状态；撤销退额（`refunded` 复用、防双退） | 单测：撤销后兑换 / 退额只一次 / 官方码不退 / 已用不可撤 | 0.5d |
| OPS-M8-01 | OPS | `circles.mjs revoke --code` 与 `set-join-mode`（预览 / `--apply` / 单测）；`audit` 增 `revoked` 计数 | 脚本单测（预览不写、幂等） | 0.5d |
| FE-M8-01 | FE | `apply-circle` 页（表单、合规文案、状态 / 冷却 / 拒绝原因回显）；`circle` / `circles` 按 `joinMode` 展示「申请加入」或「输入邀请码」 | 页面测试；mock 云端同规则 | 1d |
| FE-M8-02 | FE | 审核台并入 `pkg-admin`：申请队列 / 详情 / 通过 / 拒绝选原因 | 非 mod/admin 不可见 | 1d |
| FE-M8-03 | FE | `invites` 页 `revoked` 状态展示 | 可并入 FE-M8-01 | 0.5d |
| QA-M8-01 | QA | 用例：越权、幂等、冷却、并发双审、撤销退额、机审拦截；三端真机清单 | 用例入库并执行 | 0.5d |
| PM-M8-01 | PM | `wording.md` §6 与圈主协议走措辞 / 法务审阅；确认审核值班表与 SLA | 审阅记录 | 0.5d |

依赖：M4 签核 → M6（N1）→ BE-M8-01 → 02 → 03 → FE；**V2-2（BE-M8-04 + OPS-M8-01）不依赖 apply，可独立先行**——建议作为 M4 签核后的第一个小切口。

## 6. 测试要点

- 幂等 / 并发：`pending` 重复提交（`duplicate: true`、不扣额度）；冷却期 42901；并发双审一成一 40901；重投覆盖 `answers` 并清空裁定字段。
- 权限：普通用户调审核动作 40301；申请与审核返回值不含 `_openid` / `decidedBy` / `note`；`reason` 以文案化枚举回读。
- 合规：未声明字段 40001；`topic` 命中引流 / 宗教词 40001 不落库；表单与文案过 `wording.md` 检查。
- 撤销：被撤销码兑换 → 与已用 / 过期同一条 40401；撤销退额只一次；官方码撤销不退；已用码撤销 40001；`audit` 计数正确。
- 回归：`joinMode` 缺省 `invite` 时 M4 全量用例零行为变化（快照更新仅新增字段）。

## 7. 指标（v0.2 看板增量）

| 类别 | 指标 | 用途 |
|---|---|---|
| 邀请漏斗 | 签发→兑换转化率、兑换时效、过期未用率、名额使用率 | 供给健康度 |
| 邀请质量 | 按 `invitedBy` 分群的新人留存 / 7 日违规率 | D13 自动增发规则的依据 |
| 申请 | 审核时滞（目标 < 24h）、通过率、拒绝原因分布、申请→首帖转化 | 开量闸门 |
| 滥用 | 同邀请人兑换集中度、同 IP 成功兑换数、被撤销码数 | 阈值与人工处置 |
| 圈子健康 | 周有效回复数；28 天无有效回复（死圈评估） | 合并 / 关闭评估 |

## 8. 门槛与风险

**开 `apply` 的门槛（全部满足才执行 `circles.mjs set-join-mode`）**：① M4 签核完成并发布客户端；② M6 N1 通知可用；③ 内测指标（PRD §11）达标；④ 审核值班表与拒绝原因文案就位。

| 风险 | 缓解 |
|---|---|
| 审核人力不足、时滞 > 24h | 值班表（PM-M8-01）；单圈试点；可随时把 `joinMode` 调回 `invite` |
| 申请表单产生违规内容 | 机审前置；拒绝原因留痕；90 天清理 |
| 撤销被内部误用 | 脚本预览 + 打印旧值；`revokedBy` 留痕；`audit` 输出 |
| 圈主协议法务周期长 | 骨架先行（`owner-agreement.md`）；正式版随 v0.3 提前送审 |
