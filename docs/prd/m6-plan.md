# M6 实施计划：每日一题 / 慢话题 / 精华 / 通知

> 范围：PRD §5 T3 / T5 / W3 / N1（`docs/prd/README.md`）、§7.1 与 §7.4 线框中的「每日一题」卡片与「精华」入口。
> 状态（2026-10-03）：**计划与接口契约草案，未评审、未排期、未实现**。接口草案写在 [`docs/api/practice.md`](../api/practice.md)「每日一题（M6 契约 · 草案）」。
> 前置：M4 签核（[`docs/ops/release-checklist.md`](../ops/release-checklist.md) 第 7~8 步）与 M5 真机验收（[`docs/test/cases/M5.md`](../test/cases/M5.md)）先闭合；M6 不得先于它们部署到共享环境。
> 下游：`docs/prd/join-plan.md` 的申请结果通知（V2-1）依赖本里程碑的 N1。

## 1. 开工前盘点（2026-10-03 实读）

| 项 | 现状 | 位置 |
|---|---|---|
| 集合登记 | `daily_prompts`（`uniq_date` 唯一）、`prompt_answers`（`owned: { key: 'promptId', keep: 'primary', onDelete: 'detach' }` + `idx_prompt_owner`）、`notifications`（`idx_owner_read_time`）**均已登记且云端索引已存在**（27 个索引齐全、0 冲突） | `cloudfunctions/_shared/collections.js:94-107`、`node scripts/ops/ensure-indexes.mjs` 预览 |
| 每日额度 | `DAILY_LIMITS.answerPrompt = 1` 已在配置里，但没有任何 action 使用它 | `cloudfunctions/_shared/config.js:7-16` |
| 「每日一次」的唯一性 | 登记处已注明「每日一次在应用层判断（注销会解除归属，不能建含 `_openid` 的唯一索引）」→ 不能靠索引兜底 | `cloudfunctions/_shared/collections.js:95` |
| 云函数归属 | `practice` 函数头注释已预留「M6 每日一题后续补齐」；`IDENTITY_FREE_ACTIONS = ['ping']` | `cloudfunctions/practice/service.js:3,13` |
| 站内通知 | `_shared/notify.js` 提供 `notify(db, { uid, type, refType, refId, text, now })` 与 `NOTIFY_TYPES`，M5 前已就位但无人调用 | `cloudfunctions/_shared/notify.js:13,21` |
| 定时触发器 | `cloudbaserc.json` 的 `functions[]` **没有任何 `triggers` 字段**；N1 的「每日一题提醒」需要新增 | `cloudbaserc.json:1-40` |
| 机审链路 | `community/topics.js` 的 `screen()` 已封装「`checkText` → reject 抛 40001 不落库不扣额度 / review 落 `status = pending` / pass 落 `ok`」，M6 直接复用同一约定 | `cloudfunctions/community/topics.js:181-190` |
| 运营脚本范式 | `circles.mjs`（默认预览、`--apply` 才写）+ `circles.seed.json` + `circles.test.mjs`，共用 `scripts/lib/ops-db.mjs`；M6 的题目录入脚本照此新增 | `scripts/ops/`、`scripts/lib/ops-db.mjs` |
| 待确认的外部依赖 | 小程序订阅消息模板 ID 需在微信公众平台后台申请并通过；无模板 ID 时不得调用 `subscribeMessage.send` | PRD N1、`docs/ops/compliance-checklist.md` |

## 2. 决策（默认值；标 ★ 的需产品 / 法务确认后才实现）

| # | 决策 | 理由 |
|---|---|---|
| D1 | 每日一题的三个动作（`todayPrompt` / `answerPrompt` / `listAnswers`）落在 **`practice` 云函数**，不新建函数 | `practice` 已是「练习工具」域且 `daily_prompts` / `prompt_answers` 都在它的数据范围内；少一个函数少一次部署与环境变量维护 |
| D2 | 题目由 **运营脚本** 写入，后台界面无录入入口：`scripts/ops/daily-prompt.mjs set --date <YYYY-MM-DD> --text <题干> [--apply]`，另有 `list` / `close` | 数量极小（每天一条），做成后台表单的成本远高于脚本；沿用 `circles.mjs` 的预览 / `--apply` 与幂等 upsert 惯例 |
| D3 | 题干长度 ≤ 120 字，落在 `PROMPT_RULES = { textMax: 120, answer: { min: 5, max: 500 }, listMax: 50 }`；答案 5–500 字 | 与 PRD T1 / T2 的量级一致（题干短于话题标题上限 40 太多会写不下，120 够一句话且不喧哗）；前端同名常量放 `src/constants/community.ts`，由测试比对（沿用 M3–M5 做法） |
| D4 | 题目**不属于任何圈子**，对所有已确认 18+ 的用户可见可答；不要求入圈、不要求手机号之外的额外门槛 | PRD 把 W3 挂在练习 Tab（§7.4）而非圈子内；「作答后可见他人回答」本身就是门槛 |
| D5 | `answerPrompt` 门禁 = 登录 + 未封禁 + 已确认 18+ + 已实名 + 未禁言 + 当日额度 1（`DAILY_LIMITS.answerPrompt`） | 答案对其他用户可见，属公开内容：与 `createTopic` / `createReply` 同一档（后台实名是红线） |
| D6 | 「每人每题只能一条」**在应用层判断**：写前查 `prompt_answers` 是否已有本人该题答案，有则 40901「今天已经作答过了」 | 登记处已排除含 `_openid` 的唯一索引（注销 `detach` 会留记录）；配合 D5 的当日额度，正常路径唯一 |
| D7 | 并发双写的后果可接受：同账号同日两条答案时，`listAnswers` 以 `createdAt` 最早的一条作为「我的作答」，多余一条由运维 `daily-prompt.mjs audit` 报出（不自动删） | 不引入事务（CloudBase `runTransaction` 在现有代码里没用过）；把偏差变成可观测数据比假装没有更稳 |
| D8 | 答案走机审：`reject` → 40001 不落库不扣额度；`review` → 落库 `status = 'pending'`，本人可见「审核中」但不进他人列表；`pass` → `ok` | 与 `community/topics.js` 的 `screen()` 完全一致，前端与审核台无需新增状态机 |
| ★ D9 | **答案不署名**：`listAnswers` 只返回内容 + 时间，不下发 `nickname` / `avatar` / 徽章，也不提供匿名开关 | 练习分享常涉及身心状态，与 M4 D10「最小必要」和 `wording.md` §1 的去身份化取向一致；若要署名，需产品明确并补隐私说明后再开 |
| D10 | 未作答调 `listAnswers` → 40301「作答后即可查看他人的回答」；题目不存在 / 已 `closed` → 40401 | PRD W3 的「作答后可见」要有可区分的失败语义，但不能泄露他人答案的任何内容 |
| D11 | 慢话题 `slowUntil`（T3）：`createTopic` 增加 `slow` 布尔（前端映射为 24h 冷静期），`slowUntil = createdAt + 24h`；`slowUntil` 之前 `createReply` → 40901「这条话题还没开放回复」；已发布的回复不受影响 | PRD 只说「发起人设定开放回复前的冷静期（如 24h）」，取值 24h 固定，先不做自定义时长 |
| D12 | 精华（T5）：`moderation.markFeatured` 仅 `mod` / `admin`，写 `mod_logs`（`kind: 'featured'`）+ 话题 `featured` 布尔；`listTopics` 增 `featured: true` 筛选；**精华不解除圈子成员校验**（圈内精华仍只给成员看） | D6（M4）的可见性规则优先于列表筛选，否则精华列表会变成越权读圈内内容的通道 |
| D13 | 通知（N1）只做三类：`reply`（回复我）、`moderation`（处理结果）、`prompt`（每日一题提醒），全部先落 `notifications`；**站内消息是唯一保证送达的通道** | 订阅消息受模板与授权限制，不能当作可靠通道；与 PRD「通知仅三类、不做营销推送」一致 |
| D14 | 小程序订阅消息：只在用户**主动操作成功后**（作答成功、发帖成功）请求一次订阅授权，且 `subscribeMessage.send` 需配置了模板 ID 才调用；模板 ID 走 `envVariables`（`WX_MP_PROMPT_TEMPLATE_ID` 等），缺键时**跳过外发只留站内**，不抛错 | 避免「未配置即报错」把主流程带崩；部署时 `scripts/ops/function-env.mjs` 会核对环境变量，缺键即清空是已知坑 |
| D15 | 每日一题提醒由定时触发器发：`cloudbaserc.json` 给 `practice` 加 `triggers: [{ type: 'timer', config: '0 0 8 * * * *' }]`（北京时间 08:00），当天没有 `ok` 题目就整批跳过；发送前按 `(uid, type='prompt', refId=promptId)` 去重，保证一题最多提醒一次 | 提醒是低频可延迟动作，用触发器省客户端轮询；去重防止重跑或部署重试造成刷屏 |
| D16 | 未读数与列表：`listNotifications`（分页、按 `createdAt` 倒序）+ `markNotificationsRead`（把给定 id 或全部置 `read`）；`notifications` 集合 `owned: {}`，只有 `_openid` 本人可读写 | `collections.js:107` 的登记已经是这个形状，接口照它写 |

## 3. 数据模型（增量）

**`daily_prompts`**（运营脚本 upsert，`uniq_date` 已存在）

| 字段 | 说明 |
|---|---|
| `date` | `YYYY-MM-DD`，北京时间日期；唯一（`uniq_date`） |
| `text` | 题干，1–120 字，去首尾空白 |
| `status` | `ok` / `closed`（`closed`：不再展示、不可作答；已有答案保留） |
| `createdAt` / `updatedAt` | 毫秒 |

**`prompt_answers`**（客户端只经云函数写）

| 字段 | 说明 |
|---|---|
| `promptId` | 关联 `daily_prompts._id`；账号合并按它归主（登记已有） |
| `_openid` | 作答人；**永不下发** |
| `date` | 冗余题目日期，便于「今日」查询与审计 |
| `text` | 5–500 字 |
| `status` | `ok` / `pending`（机审 review 结果）；`reject` 不落库 |
| `createdAt` | 毫秒 |

**`notifications`**：`_openid`、`type`（`reply` / `moderation` / `prompt`）、`refType`、`refId`、`text`（≤ 60 字，不含营销话术）、`read`（布尔）、`createdAt`。

新增索引（`collections.js` 声明、`ensure-indexes.mjs --apply` 只新增）：`prompt_answers` 加 `idx_owner_time`：`_openid` + `createdAt`（倒序），供「我今天答过没」与「我的作答」读取；不建唯一索引（D6 理由）。

## 4. 接口（契约草案，全文见 [`docs/api/practice.md`](../api/practice.md)）

| action | 写 | 说明 |
|---|---|---|
| `todayPrompt` | 否 | 返回今日 `ok` 题目 + 我是否已作答 + `answerCount`；没有题目 → `{ prompt: null }`（不是错误） |
| `answerPrompt` | 是 | 门禁见 D5；`{ promptId, text }` → `{ answer: { id, date, text, status, createdAt } }` |
| `listAnswers` | 否 | `{ promptId, page, size }`；未作答 → 40301；只返回 `status = 'ok'` 的他人答案 + 我的（含 `pending`）；**不含任何身份字段**（D9） |
| `listNotifications` / `markNotificationsRead` | 否 / 是 | 站内消息列表 + 未读数；只按 `_openid` 过滤 |
| `community.createTopic` | — | 增 `slow` 入参（D11），返回体带 `slowUntil` |
| `community.createReply` | — | `slowUntil` 未到 → 40901 |
| `community.listTopics` | — | 增 `featured: true` 筛选；摘要与详情带 `featured` |
| `moderation.markFeatured` | 是 | `mod` / `admin` 专用；写 `mod_logs`；不改变可见性判定（D12） |

错误码不新增：沿用 `40001` / `40101` / `40301` / `40302` / `40303` / `40304` / `40401` / `40901` / `42901`。

## 5. 任务拆解（约 6 个工作日，BE / FE 可并行；顺序：契约 → mock → 云函数 → 页面）

| 编号 | 负责 | 任务 | 验收 | 估时 |
|---|---|---|---|---|
| BE-M6-00 | BE | 前置：`config.js` 加 `PROMPT_RULES`；`collections.js` 加 `prompt_answers.idx_owner_time`；`fakeDb` 若缺能力先补；`userHarness` 加 `seedPrompt` / `seedAnswer` | 现有云函数用例（222 例）不回归 | 0.5d |
| BE-M6-01 | BE | `daily_prompts` 读取与 `todayPrompt` / `answerPrompt` / `listAnswers`；机审走 `screen()` 同约定 | 单测：无题目返回 null、未 18+ / 未实名 / 禁言 / 封禁各错误码、当日重复 40901、额度用尽 42901、reject 不落库不扣额度、review 落 pending、未作答读列表 40301、返回体无 `_openid` 且无昵称 | 1d |
| BE-M6-02 | BE | 慢话题 `slowUntil`（`createTopic` / `createReply`）与 `featured`（`moderation.markFeatured` + `listTopics` 筛选 + `mod_logs`） | 单测：冷静期内回复 40901、到期可回；非 mod 标记精华 40301；精华不解除成员校验；`featured` 列表只含 `ok` | 1d |
| BE-M6-03 | BE | 通知：`reply` / `moderation` / `prompt` 落 `notifications`（`_shared/notify.js`）+ `listNotifications` / `markNotificationsRead`；`cloudbaserc.json` 加定时触发器；订阅消息按 D14（模板 ID 缺则跳过） | 单测：同 `(uid, type, refId)` 只一条、未读数与分页正确、触发器函数在无题目时不写任何记录、`envVariables` 缺键不抛错 | 1.5d |
| OPS-M6-01 | OPS | `scripts/ops/daily-prompt.mjs`（`set` / `list` / `close` / `audit`）+ `daily-prompt.seed.json`；`ensure-indexes.mjs --apply` 建 1 个新索引 | 脚本单测：参数解析、预览不写、重复执行幂等、`audit` 报出同日多条与未作答统计 | 0.5d |
| FE-M6-00 | FE | 类型与 `constants/community.ts`（`PROMPT_RULES`）、`services/practice.ts` 三个方法 + `guard.ts` 的 `WRITE_ACTIONS`、mock 云端补齐、`cloud.types.ts` 的 `FunctionMap` | `tsc --noEmit` 无错；mock 与云函数共用规则由测试比对 | 0.5d |
| FE-M6-01 | FE | 练习 Tab 的「每日一题」卡片与作答页；作答后展示他人回答（分页 + `pending` 提示） | 页面测试 + 快照 1 个 | 1d |
| FE-M6-02 | FE | 发起话题的「慢话题」开关与详情页冷静期展示；「精华」入口与列表 | 组件测试 | 0.5d |
| FE-M6-03 | FE | 消息页 + 未读角标；订阅授权只在主动操作成功后请求；`Taro.requestSubscribeMessage` 失败静默 | 三端走通并留证 | 1d |
| QA-M6-01 | QA | `docs/test/cases/M6.md`：作答可见性、每日一次与并发、慢话题时间边界、精华权限、通知去重与送达、越权专项 | 自动化 + 变异验证通过；三端清单登记 | 0.5d |
| DOC-M6 | PM / BE | 契约定稿、`docs/ops/collections.md` 索引表、`wording.md` 补「每日一题 / 慢话题 / 精华」措辞规范（含题目与提醒文案送审） | 文档与实现一致 | 随各项 |

合计约 6~6.5 个工作日（含并行）。依赖：BE-M6-00 → 01 / 02 / 03；FE-M6-00 可与 BE 并行（先 mock）；OPS-M6-01 在 BE-M6-00 之后；FE-M6-01~03 在 FE-M6-00 之后。

## 6. 测试计划（要点；完整用例编号写进 `docs/test/cases/M6.md`）

- 云函数（`tests/cloudfunctions/m6-prompt.test.js`）：`todayPrompt` 无题目 / `closed` / 只取 `ok`；`answerPrompt` 的 40001（字数与未知字段）、40302 / 40303 / 40304、40901（重复作答）、42901（当日额度）、机审三态；`listAnswers` 未作答 40301、只返回 `ok`、返回体无身份字段。
- 云函数（`m6-slow-featured.test.js`）：`slowUntil` 边界（差 1ms 不可回、到期可回）、已有回复不受影响、非 mod 标记 40301、`markFeatured` 写 `mod_logs` 且二次调用幂等、`listTopics({ featured: true })` 不越圈。
- 云函数（`m6-notify.test.js`）：`(uid, type, refId)` 去重、未读数、分页、触发器入口在无题目时零写入、无模板 ID 时不外发且不抛错。
- 运维：`daily-prompt.mjs` 预览不写 / `--apply` 幂等 upsert / `close` 后 `todayPrompt` 不再返回；`audit` 对同日多条给出可读输出。
- 前端：卡片状态机（未作答 / 已作答 / 审核中 / 无题目）、`pending` 与 `ok` 的展示差异、未作答时不请求 `listAnswers`、订阅授权只在主动操作后触发一次、失败静默。
- 变异验证（M3 起的习惯）：去掉「已作答」前置查询、去掉 `slowUntil` 校验、去掉 `listAnswers` 的成员前置（改为不判作答）、去掉通知去重查询——每种都要让对应用例转红，探针后恢复。

## 7. 上线与回滚

1. 合并前逐项运行并记录：`yarn test:functions`、`yarn test:ops`、`yarn test --runInBand --silent`、`yarn typecheck`；新文件按仓库风格 `npx eslint`；三端结果记入 `docs/test/cases/M6.md`。
2. `node scripts/sync-shared.mjs`；`ensure-indexes.mjs`（预览 → `--apply`，只新增 `prompt_answers.idx_owner_time`）。
3. `tcb fn deploy practice community moderation --force`（**部署前用 `scripts/ops/function-env.mjs` 核对 `envVariables` 都有值**：部署会整体覆盖线上环境变量，缺键即清空）；`cloudbaserc.json` 的 `triggers` 变更后重新部署 `practice` 使触发器生效。
4. 录入首周题目：`daily-prompt.mjs set --date … --text …` 预览确认 → `--apply`；提醒外发在模板 ID 到位前保持「只站内」。
5. 冒烟：`invoke-fn.mjs` 调 `practice` 的 `todayPrompt` / `listNotifications`；**不在生产写测试数据**（如需作答测试，用 `test_` 前缀题目并在事后 `close`）。
6. 回滚：`practice` / `community` / `moderation` 回到上一提交重新部署；`daily_prompts` / `prompt_answers` / `notifications` 的数据无需回滚（不被旧代码读取）；触发器回滚要一并删掉 `triggers` 再部署，否则旧函数会被定时唤起。

## 8. 风险与未决

| 风险 / 未决 | 处置 |
|---|---|
| ★「作答是否署名」未定（D9 取了不署名的保守值） | 需产品确认；若改为署名，要同步隐私政策说明与 `wording.md`，并补「他人可否反查练习者身份」的越权用例 |
| ★ 订阅消息模板 ID 未申请 | 阻塞 FE-M6-03 的真实送达验收（`QA-M6-01` 的「订阅消息实际送达」项在模板到位前记为受阻，不得标为通过） |
| ★ 题目文案与提醒文案需法务 / 措辞审阅 | 走 `wording.md` §1 / §2 流程；未通过前不 `--apply` 写题 |
| 并发双写导致同日多条答案（D7） | `daily-prompt.mjs audit` 观测；若内测真实出现，再评估把 `prompt_answers` 的注销语义从 `detach` 改成删除并补唯一索引 |
| 提醒定时触发器成本与时区 | 每日一次、08:00 北京时间；无题目即早退；触发器重跑由 `(uid, type, refId)` 去重兜住 |
| 精华列表变成越权通道 | D12 明确不解除成员校验，并在用例里专测（`listTopics({ featured: true })` 对非成员不返回圈内内容） |
| M4 / M5 真机未闭合就推进 M6 部署 | 本计划第 7 节第 3 步之前必须完成 M4 签核与 M5 真机验收；否则只在本地与隔离 Dev 环境验证 |
