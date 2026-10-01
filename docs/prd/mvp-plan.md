# 结灵子 MVP 任务规划（前端 / 后端 / 测试）

> 依据：`docs/prd/README.md`（需求编号 A/P/S/T/G/W/N）。主体：**企业账号**上线小程序 + RN App。
> 角色对应 `.claude/agents/`：frontend-engineer（FE）、backend-engineer（BE）、qa-engineer（QA）、devops-engineer（OPS）、product-manager（PM）。

## 0. 协作约定

1. **契约先行**：每个里程碑先由 BE 在 `docs/api/<模块>.md` 写好接口契约 → FE 按契约在 `src/services/mock/` 做 mock 并开发 → BE 实现云函数 → 切 `TARO_APP_DATA_SOURCE=cloud` 联调。
2. **云函数划分**：`user`（已有，扩展）、`community`（话题/回复/圈子/邀请）、`moderation`（机审/举报/处罚/管理）、`practice`（打卡/每日一题）。公共逻辑放 `_shared`，`scripts/sync-shared.mjs` 同步。
3. **统一写入链路**（所有 UGC 写接口必须经过）：登录 → 实名（`phoneVerified`）→ 18+ 已确认 → 未封禁 → 频控 → 机审 → 落库。在 `_shared/guard` 实现一次，各函数复用。
4. **完成定义（DoD）**：tsc 通过；jest / `node --test` 新增用例通过；三端（weapp / rn / h5 mock）可跑；API 文档已更新；QA 用例已登记到 `docs/test/`。
5. **任务编号**：`FE-Mx-nn` / `BE-Mx-nn` / `QA-Mx-nn`，提交信息与 PR 标题带编号。

## 1. 里程碑总览

| 里程碑 | 内容 | 需求 | 预估 | 依赖 |
|---|---|---|---|---|
| M0 | 准备：资质、环境、集合与安全规则骨架、措辞词库 | — | 0.5 周 | — |
| M1 | 账号补强 + 练习档案 | A2 A3 P1 P2 | 1.5 周 | M0 |
| M2 | 内容安全底座 + 社区公约 | S1–S4 | 1.5 周 | M1 |
| M3 | 深度话题 | T1 T2 T4 | 1.5 周 | M2 |
| M4 | 官方圈子 + 邀请码 | G1 G2 G3 | 1 周 | M3 |
| M5 | 冥想计时 + 打卡 | W1 W2 | 1 周 | M1（可与 M3/M4 并行） |
| M6 | 每日一题 / 慢话题 / 精华 / 通知 | W3 T3 T5 N1 | 1.5 周 | M3 M4 |
| M7 | 回归、提审、内测发布 | — | 1 周 | 全部 |

总计约 **9~10 周**（FE / BE / QA 各 1 人并行；M5 可插空提前）。

---

## M0 · 准备（0.5 周）

> **进度（2026-10-01 复核）**：代码与文档已完成，自动化全绿，三端构建通过（`docs/test/cases/M0.md` M0-13）。Windows 实机复核修复 3 处：RN 打包脚本 spawn `npx.cmd` 报 EINVAL；运维脚本把 cloudbaserc 的 envId 模板原文当环境 ID；moderation 云函数误用 App 的微信凭证（应为小程序凭证）。2026-10-01 已部署 user / community / moderation，并执行 M0-12（下发安全规则、建 16 个集合）。待办（非代码，需人工）：OPS-M0-01 资质申请（需企业材料）、控制台建索引（`docs/ops/collections.md` §3）、M0-11 真机视觉走查。
> 产出：`cloudfunctions/_shared/{collections,config,guard}.js`、`cloudfunctions/{community,moderation,practice}/`、`docs/ops/{compliance-checklist,collections}.md`、`docs/prd/{wording,community-rules}.md`、`docs/test/`、练习 Tab 与两个新分包、品牌色令牌（竹青）与新标志。

| 编号 | 负责 | 任务 | 验收 |
|---|---|---|---|
| OPS-M0-01 | OPS | 企业主体小程序：类目选"社交"相关类目，准备所需资质/安全评估材料；App 软著与隐私合规清单 | 类目审核通过或材料清单齐备 |
| OPS-M0-02 | OPS | CloudBase 新建集合：profiles / circles / memberships / invites / topics / replies / reports / checkins / daily_prompts / prompt_answers；安全规则默认"仅云函数写" | `scripts/ops` 安全规则测试覆盖新集合 |
| BE-M0-01 | BE | 新建云函数骨架 `community` / `moderation` / `practice`，注册到 `cloudbaserc.json`，接入 `sync-shared` | 三个函数 `ping` 可调用，测试通过 |
| BE-M0-02 | BE | `_shared/guard`：写入链路（登录/实名/18+/封禁/频控），频控用集合计数（按 uid+日期） | 单测覆盖每一个拒绝分支 |
| PM-M0-01 | PM | 措辞词库（禁用词 → 替换建议）、练习方式预置列表、社区公约初稿、官方圈子名称 | 文件入库：`docs/prd/wording.md`、`docs/prd/community-rules.md` |
| FE-M0-01 | FE | Tab 结构调整为 首页 / 练习 / 我的；新增分包 `pkg-community`、`pkg-practice` 空页面；Tab 图标占位 | 三端可切换 Tab，快照测试更新 |
| QA-M0-01 | QA | 建 `docs/test/` 用例模板与 MVP 测试计划；准备内测账号（小程序 3 个、App 3 个，含未实名 / 未成年声明拒绝） | 测试计划评审通过 |

## M1 · 账号补强 + 练习档案（1.5 周）

> **进度（2026-10-01）**：代码、文档、自动化已完成（tsc 0 错；jest 26 套件 / 334 例；云函数 86 例；运维 10 例；三端构建通过），用例见 `docs/test/cases/M1.md`。
> 产出：`user.bindPhoneWeapp / confirmAdult`、`login / whoami` 账号状态、`linkPhoneSession` 登记号码（`_shared/{phone,wxmp,moderation}.js`、`account.js linkPhone`）；`community.getProfile / updateProfile`（`community/{profile,alias}.js`）；
> 前端 18+ 确认页、发布门禁 `features/auth/gates.ts`（`requirePhone` / `ensureAdult`）、小程序手机号弹层 `PhoneSheet`、档案卡与编辑档案页、`AuthorBadge` / `Avatar`、12 款预置头像。
> **范围调整**：FE-M1-03 头像先提供预置头像，**自定义上传随 BE-M2-02 图片机审一起上线**（未经机审的图片不展示，PRD §3 / §9）。
> 待办（需人工 / 授权）：配置 `WX_MP_APP_ID` / `WX_MP_APP_SECRET` / `PHONE_HASH_SECRET` 并部署 user / community；小程序隐私保护指引声明「手机号」；建 `profiles` 唯一索引；QA-M1-01 三端真机执行（M1-19）。

| 编号 | 负责 | 任务 | 验收 |
|---|---|---|---|
| BE-M1-01 | BE | `user.bindPhoneWeapp`：小程序手机号快速验证（`getPhoneNumber` code → 换手机号），写 `phoneVerified`，手机号哈希存储；与 App 手机号账号冲突时走已有合并逻辑 | 单测：成功 / code 失效 / 已被他人绑定 |
| BE-M1-02 | BE | App 端：已有手机号登录即视为实名；微信/Apple 登录账号补绑手机号复用 `linkPhoneSession` | 单测通过 |
| BE-M1-03 | BE | `user.confirmAdult`（记录 `adultConfirmedAt`、协议版本）；`whoami` 返回 `phoneVerified / adult / role / bannedUntil` | 单测通过，`docs/api/user.md` 更新 |
| BE-M1-04 | BE | `community.getProfile / updateProfile`：字段校验（昵称 2–16 字、介绍 ≤ 80 字、practices 只能取预置值）；昵称与介绍过机审（M2 前先留钩子）；生成唯一 `anonAlias` | 单测 + `docs/api/profile.md` |
| BE-M1-05 | BE | 注销 / 合并时处理 profiles（注销删除，合并按主账号保留）——登记到 `_shared` owned 集合登记表 | 注销/合并单测覆盖 profiles |
| FE-M1-01 | FE | 首次进入流程：同意书（已有）+ 18+ 确认页；不同意则只能浏览公开内容 | 三端走通；拒绝路径可回退 |
| FE-M1-02 | FE | 实名拦截 `requirePhone()`：发布类动作前检查，小程序弹手机号授权按钮，App 跳手机号绑定 | 未实名用户点"发起话题"被拦截 |
| FE-M1-03 | FE | 档案页 + 编辑档案页（头像上传、练习方式多选、年限、目标、介绍）；"我的"展示档案卡 | 表单校验与后端一致；快照测试 |
| FE-M1-04 | FE | 身份展示组件 `<AuthorBadge anon>`：实名昵称 / 匿名代号两种形态，供 M3 复用 | 组件测试 |
| QA-M1-01 | QA | 用例：首次进入、18+ 拒绝、手机号绑定（成功/失败/冲突合并）、档案编辑校验、注销后档案消失 | 用例入库，三端执行通过 |

## M2 · 内容安全底座（1.5 周）

> **进度（2026-10-01，首批）**：BE-M2-01（词库 + msgSecCheck，档案已接入）、BE-M2-03（举报 / 自动折叠 / 队列 / 处理）、BE-M2-04（站内通知）、BE-M2-05（`scripts/ops/set-role.mjs`）、
> FE-M2-01（`ReportSheet`）、FE-M2-02（`pkg-admin/pages/queue`，入口仅 mod / admin）、FE-M2-03（首次发布前阅读公约）、QA-M2-01（样本集 37 + 20，命中率 100%、误杀 0）已完成，用例见 `docs/test/cases/M2.md`，契约见 `docs/api/moderation.md`。
> 2026-10-01 已部署（含小程序凭证与手机号哈希密钥）、建好 19 个索引、设置第一个管理员。BE-M2-02 图片异步机审 + 自定义头像上传（小程序 / H5）代码完成（`_shared/media.js`、`cloudfunctions/mediacheck`、`community.setAvatar`、`moderation.mediaQueue / decideMedia`）。2026-10-01 已上线（规则、media 集合与索引、4 个函数，客户端调 mediacheck 实测被拒）。待办：微信侧配置消息推送（wxa_media_check → mediacheck）+ 云存储读权限「所有用户可读」；App 端存储上传（含 App 端头像选图，与话题配图一起放进 M3 之后的「原生选图」任务）；三端真机执行。

| 编号 | 负责 | 任务 | 验收 |
|---|---|---|---|
| BE-M2-01 | BE | `_shared/moderation`：文本 `msgSecCheck`（v2，带 openid/scene）+ 自建词库（措辞禁用词、疗效承诺、站外引流：微信号/二维码/手机号正则）；结论 pass / review / reject | 单测：各类命中样例 |
| BE-M2-02 | BE | 图片 `mediaCheckAsync` 异步回调（消息推送）→ 更新内容状态；App 端上传图片同样走此流程（由云函数代调） | 回调处理单测；违规图自动下架 |
| BE-M2-03 | BE | `moderation.report`：举报（同一人对同一目标只计一次），达到阈值（默认 3）自动 `folded`；`moderation.queue / decide`（仅 mod/admin）：删除、恢复、禁言 N 天、封禁 | 单测：权限、阈值、处罚生效于 guard |
| BE-M2-04 | BE | 处罚与处理结果写站内消息 `notifications` 集合（N1 前置） | 单测 |
| BE-M2-05 | BE | 管理员白名单：`users.role` 由脚本设置（`scripts/ops/set-role.mjs`），不提供前端入口 | 脚本测试 |
| FE-M2-01 | FE | 举报入口组件（原因单选 + 补充说明），话题/回复/用户卡片通用 | 组件测试 |
| FE-M2-02 | FE | 简易审核页 `pkg-admin`（仅 role=mod/admin 可见入口）：待审队列、详情、处理按钮 | 普通用户访问被拒 |
| FE-M2-03 | FE | 社区公约页（协议页复用），首次发布前强制阅读一次 | 三端走通 |
| QA-M2-01 | QA | 违规样本集（宗教措辞、疗效、引流、辱骂、色情图）→ 自动化跑机审命中率；举报阈值与处罚链路；禁言用户发布被拒 | 样本集入库，命中率报告 |

## M3 · 深度话题（1.5 周）

> **进度（2026-10-01，纯文字版，已部署）**：BE-M3-01～04（`cloudfunctions/community/topics.js` + `service.js` 6 个 action：`createTopic / listTopics / getTopic / createReply / listReplies / deleteMine`；限额在 `_shared/config`；匿名脱敏）、FE-M3-01～03（首页话题流 + `TopicCard`、`pkg-community/pages/topic-new`、`pkg-community/pages/topic`、`Toggle`）、QA-M3-01 自动化部分已完成，用例见 `docs/test/cases/M3.md`，契约见 `docs/api/community.md`。审核页对机审待复核的内容显示「通过」（放行）。
> **范围决策**：先做纯文字版；话题配图（PRD / 本计划均未含，新增范围）与 App 头像上传暂缓，**统一挂在「原生选图」任务上**（新增原生选图组件、重新打包一次；话题配图复用 `media.js` 图片审核流程，App 上传走人工复核）。`TopicSummary.images` 暂为 `[]`。
> 2026-10-01 已部署 community / moderation，`topics` 建好索引（status + createdAt）。待办：三端真机执行与匿名抓包留存；M4 接入圈子可见性。

| 编号 | 负责 | 任务 | 验收 |
|---|---|---|---|
| BE-M3-01 | BE | `community.createTopic`（标题 5–40 字、正文 ≥ 50 字、匿名开关、标签）/ `listTopics`（分页、按圈子、仅成员可见 M4 接入）/ `getTopic` | 单测 + `docs/api/community.md` |
| BE-M3-02 | BE | `community.createReply`（≥ 1 字，< 30 字标记 `short`）/ `listReplies`（引用展开） | 单测 |
| BE-M3-03 | BE | 每日上限 T4（话题 2 / 回复 20，配置在 `_shared/config`）；删除自己的内容 | 单测：第 3 条话题被拒 |
| BE-M3-04 | BE | 匿名脱敏：返回给前端的对象剔除 `authorUid`，只给 `author: {alias|nickname, avatar, isSelf}` | 单测断言字段不存在 |
| FE-M3-01 | FE | 首页话题流（下拉刷新、分页）、话题卡片 | 快照测试 |
| FE-M3-02 | FE | 发起话题页：长文编辑、字数提示、匿名切换、草稿本地保存 | 字数不足无法提交 |
| FE-M3-03 | FE | 话题详情：正文、回复列表（短回复折叠"展开 N 条简短回复"）、引用回复、举报 | 组件测试 |
| QA-M3-01 | QA | 用例：发帖/回复边界、上限、匿名不泄露（抓包检查返回体）、删除、机审拦截提示 | 三端通过，抓包记录 |

## M4 · 官方圈子 + 邀请码（1 周）

> **状态（2026-10-01）**：计划已完善；**BE-M4-00、BE-M4-01、BE-M4-02 已完成**（配置、索引登记、`fakeDb` 条件操作符、夹具；`listCircles / getCircle`；云函数 205 例、jest 470 例全绿，未部署），其余任务未开工。完整的决策、数据模型差异、成员校验矩阵、并发 / 幂等设计、运维脚本、测试与上线 / 回滚方案见 [`m4-plan.md`](./m4-plan.md)；接口契约草案见 `docs/api/community.md`「圈子与邀请码（M4，草案）」。
> **关键决策（默认，可推翻）**：3 个官方圈子（`wording.md` §5）；邀请码绑定圈子、一次性、7 天、初始名额 3、过期未用退名额；圈内内容仅成员可见（非成员详情 40401）；首页聚合我的圈子；发帖缺省圈子在「只加入 1 个圈子」时自动归属（兼容 M3 客户端）；审核员无额外读圈内内容的特权；第一批成员靠运维脚本签发官方码 / 直接加入。
> **待产品确认**：圈子名称与公约、第一批成员入圈方式、M3 期间旧话题处理（见 `m4-plan.md` §2.2）。

| 编号 | 负责 | 任务 | 验收 |
|---|---|---|---|
| BE-M4-00 | BE | 前置：`INVITE_RULES` / `CIRCLE_RULES` / `redeemInvite` 日限；3 个新索引；`fakeDb` 支持 `$gte / $gt / $lt / $exists / $ne`；测试夹具 `seedCircle / seedMember / seedInvite` | M3 的 165 例不回归 |
| BE-M4-01 | BE | `community.listCircles / getCircle`（含 `joined`、公约；非成员可见简介） | 单测 |
| OPS-M4-01 | OPS | 圈子种子数据脚本与运维工具：`scripts/ops/circles.mjs`（seed / grant / issue / audit / migrate-topics / recount）、`invite-quota.mjs`（--report / --add）、`circles.seed.json` | 脚本单测（预览不写、幂等）；云端 `audit` |
| BE-M4-02 | BE | 邀请码：`createInvite`（成员才能签发、名额懒初始化 + 原子扣减、7 天有效）、`listInvites`（状态、过期退名额）、`redeemInvite`（一次性、写 memberships、已是成员不消耗码、日限含失败尝试） | 单测：过期 / 已用 / 名额不足 / 并发抢最后名额 / 并发重复兑换 / 退名额只退一次 |
| BE-M4-03 | BE | 话题读写加成员校验（`listTopics` 聚合我的圈子；`getTopic / listReplies / createReply` 非成员 40401；`createTopic` 缺省圈子规则；`moderation.report` 成员校验）；名额增发规则（每月按有效回复数）先做手动脚本（`invite-quota.mjs`，见 OPS-M4-01） | 非成员读圈内话题被拒；M3 用例补成员种子后全绿 |
| FE-M4-00 | FE | 类型 / 常量 / 邀请码规范化（共享 fixture）/ 服务层 / mock 云端（`reset()` 默认 1 个圈子 + 默认账号是成员）/ `app.config` / `router` | `tsc` 无错；规则单测 |
| FE-M4-01 | FE | 圈子列表 `circles` / 详情 `circle`、输入邀请码入圈 `join-circle`（支持 `?code=` 预填）、我的邀请码 `invites`（分享卡片：小程序 `onShareAppMessage`，App 复制文本）、「我的」入口 | 三端走通；页面测试 |
| FE-M4-02 | FE | 首页话题流按"我的圈子"聚合（`FilterChips` 切换）；未入圈用户看到引导页；发起话题选圈子；卡片 / 详情显示圈子名 | 快照测试 |
| QA-M4-01 | QA | 用例：邀请全链路、越权读取、名额边界、注销后成员关系清理（`docs/test/cases/M4.md`，用例清单见 `m4-plan.md` §10） | 自动化全绿 + 真机清单入库 |

## M5 · 冥想计时 + 打卡（1 周，可并行）

| 编号 | 负责 | 任务 | 验收 |
|---|---|---|---|
| BE-M5-01 | BE | `practice.checkin`（每日按练习方式累加分钟，幂等）/ `listCheckins`（按月） | 单测 |
| FE-M5-01 | FE | 计时器：预设时长、开始/结束提示音、后台/锁屏恢复（RN 用时间戳计算，不依赖定时器） | 切后台 5 分钟再回来时间正确 |
| FE-M5-02 | FE | 结束后一键打卡；打卡日历热力图（仅本人可见）；未登录时本地暂存，登录后补传（starter 已有的登录后钩子） | 组件测试 |
| QA-M5-01 | QA | 用例：计时准确性、来电/锁屏打断、跨零点打卡、离线补传 | 真机通过（iOS / Android / 小程序） |

## M6 · 每日一题 / 慢话题 / 精华 / 通知（1.5 周）

| 编号 | 负责 | 任务 | 验收 |
|---|---|---|---|
| BE-M6-01 | BE | 每日一题：`daily_prompts` 运营脚本录入；`answerPrompt`（每日一次）/ `listAnswers`（作答后才可读） | 单测 |
| BE-M6-02 | BE | 慢话题：`slowUntil` 前拒绝回复；精华 `featured` 标记（mod）+ `listFeatured` | 单测 |
| BE-M6-03 | BE | 通知：回复我 / 处理结果 / 每日一题提醒；小程序订阅消息（定时触发器），App 站内消息列表 + 未读数 | 单测；触发器配置入 `cloudbaserc.json` |
| FE-M6-01 | FE | 练习 Tab 内"每日一题"卡片与作答页；作答后展示他人回答 | 快照测试 |
| FE-M6-02 | FE | 发起话题增加"慢话题"选项与倒计时展示；精华列表入口 | 组件测试 |
| FE-M6-03 | FE | 消息页 + 未读角标；小程序订阅授权在用户主动操作时请求（发帖/作答后） | 三端走通 |
| QA-M6-01 | QA | 用例：作答可见性、慢话题时间边界、订阅消息实际送达、通知不含营销内容 | 通过 |

## M7 · 回归与发布（1 周）

| 编号 | 负责 | 任务 | 验收 |
|---|---|---|---|
| QA-M7-01 | QA | 全量回归（三端）、匿名泄露专项、越权专项、弱网与离线、性能（话题流首屏 < 1.5s） | 回归报告，无 P0/P1 遗留 |
| QA-M7-02 | QA | 合规走查：全站措辞扫描（脚本扫 `src/` 与种子数据）、协议/公约/隐私政策与 SDK 清单一致 | 走查清单签字 |
| OPS-M7-01 | OPS | 小程序提审（类目、隐私保护指引、用户协议）；App 内测分发（TestFlight / 安卓内测渠道）；CloudBase 备份与告警 | 内测版本可安装 |
| PM-M7-01 | PM | 内测招募 50–100 人、邀请码发放、反馈问卷与指标看板（PRD §8） | 内测启动 |

---

## 2. 并行排期示意（周）

```
周次   1    2    3    4    5    6    7    8    9    10
M0    ██
M1     ████████
M2              ████████
M3                       ████████
M4                                ████
M5              ████ (FE 空档/BE 空档插入)
M6                                    ████████
M7                                             █████
QA     计划 ──── 每个里程碑结束 2 天内完成用例执行 ──── 回归
```

## 3. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 社交类目资质审核周期长 | 小程序无法按期上线 | M0 立即启动；App 内测先行，小程序可用体验版内测 |
| 机审误杀正常练习讨论 | 用户体验差 | 结论 review 进人工而非直接拒绝；QA 维护误杀样本集持续调词库 |
| 内测人少、内容冷启动 | 指标失真 | PM 准备 30 个种子话题；运营每日一题保底 |
| 审核人力不足 | 违规内容滞留 | 举报阈值自动折叠兜底；设定值班表与 24h SLA |
| `msgSecCheck` 仅限小程序 openid | App 用户无 openid | App 内容改用服务端无 openid 场景调用或接入腾讯云内容安全（BE-M2-01 技术预研 0.5 天） |
