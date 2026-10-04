# M6 实施计划：每日一题 / 慢话题 / 精华 / 通知

> 范围：PRD §5 T3 / T5 / W3 / N1（`docs/prd/README.md`）、§7.1 与 §7.4 线框中的「每日一题」卡片与「精华」入口。
> 状态（2026-10-04）：**已评审并部分实现**——D9（署名形态）与 N1（通知范围）由用户当日拍板（见 D9、D17）。**2026-10-04 更新**：`practice` / `community` / `moderation` 已按用户授权部署到体验版环境，索引与首周题目也已落地（回滚包与实测见第 7 节末与 [`docs/test/cases/M6.md`](../test/cases/M6.md) §4）；下面各项的完成记录仍是本地验证：BE-M6-00 与 BE-M6-01（每日一题：今日题目 / 作答 / 答案列表）、FE-M6-00 与 FE-M6-01（前端类型与常量、`services/practice.ts`、mock、练习 Tab 卡片 + 作答页）、BE-M6-02（慢话题 `slowUntil` 与精华 `featured`）、OPS-M6-01（`daily-prompt.mjs` 录题 / 巡检 + 首周题目种子）、FE-M6-02（发帖的慢话题开关、冷静期展示、圈内只看精华、`markTopicFeatured` 接线）、BE-M6-03（`notifications` 三类通知 + `listNotifications` / `markNotificationsRead` + 定时触发器）、FE-M6-03（消息页 + 未读角标 + 订阅授权）。QA-M6-01 已完成（2026-10-04，本地）：`docs/test/cases/M6.md` 登记自动化用例 M6-A01…A17 与三端清单 M6-D01…D09，全量门禁绿、本轮变异验证 8/8 被捕获。QA-M6-02 已完成（2026-10-04，本地）：审核队列加「标为精华 / 取消精华」入口（`queue` 目标快照带 `featured`），并补 8 处变异验证。未开工：M4 签核与 M5 真机验收；M6 真机项与订阅送达要等部署窗口，全部记 ⏭ 或受阻。接口见 [`docs/api/practice.md`](../api/practice.md)「每日一题」。
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
| ★ D9 | **可选匿名，默认匿名**：`answerPrompt` 入参 `anon`（缺省即 `true`，显式传 `false` 才实名）；`listAnswers` 每项只给 `authorName` + `anon` / `deleted` / `isSelf`，匿名取 `profiles.anonAlias`、实名取 `nickname`、注销或已解除归属取「已注销用户」 | 用户 2026-10-03 决定（覆盖本计划原稿的「一律不署名」）：练习分享常涉及身心状态，默认匿名最稳，同时保留「我用真名交流」的可能。展示形态沿用社区 `presentAuthor` 的口径，但按最小必要不带头像 / 徽章 / 练习方式 / 年限（与 M4 D10 一致） |
| D10 | 未作答调 `listAnswers` → 40301「作答后即可查看他人的回答」；题目不存在 / 已 `closed` → 40401 | PRD W3 的「作答后可见」要有可区分的失败语义，但不能泄露他人答案的任何内容 |
| D11 | 慢话题 `slowUntil`（T3）：`createTopic` 增加 `slow` 布尔（前端映射为 24h 冷静期），`slowUntil = createdAt + 24h`；`slowUntil` 之前 `createReply` → 40901「这条话题还没开放回复」；已发布的回复不受影响 | PRD 只说「发起人设定开放回复前的冷静期（如 24h）」，取值 24h 固定，先不做自定义时长 |
| D12 | 精华（T5）：`moderation.markFeatured` 仅 `mod` / `admin`，写 `mod_logs`（`kind: 'featured'`）+ 话题 `featured` 布尔；`listTopics` 增 `featured: true` 筛选；**精华不解除圈子成员校验**（圈内精华仍只给成员看） | D6（M4）的可见性规则优先于列表筛选，否则精华列表会变成越权读圈内内容的通道 |
| D13 | 通知（N1）只做三类：`reply`（回复我）、`moderation`（处理结果）、`prompt`（每日一题提醒），全部先落 `notifications`；**站内消息是唯一保证送达的通道** | 订阅消息受模板与授权限制，不能当作可靠通道；与 PRD「通知仅三类、不做营销推送」一致 |
| D14 | 小程序订阅消息：只在用户**主动操作成功后**（作答成功、发帖成功）请求一次订阅授权，且 `subscribeMessage.send` 需配置了模板 ID 才调用；模板 ID 走 `envVariables`（`WX_MP_PROMPT_TEMPLATE_ID` 等），缺键时**跳过外发只留站内**，不抛错 | 避免「未配置即报错」把主流程带崩；部署时 `scripts/ops/function-env.mjs` 会核对环境变量，缺键即清空是已知坑 |
| D15 | 每日一题提醒由定时触发器发：`cloudbaserc.json` 给 `practice` 加 `triggers: [{ type: 'timer', config: '0 0 8 * * * *' }]`（北京时间 08:00），当天没有 `ok` 题目就整批跳过；发送前按 `(uid, type='prompt', refId=promptId)` 去重，保证一题最多提醒一次 | 提醒是低频可延迟动作，用触发器省客户端轮询；去重防止重跑或部署重试造成刷屏 |
| D16 | 未读数与列表：`listNotifications`（分页、按 `createdAt` 倒序）+ `markNotificationsRead`（把给定 id 或全部置 `read`）；`notifications` 集合 `owned: {}`，只有 `_openid` 本人可读写 | `collections.js:107` 的登记已经是这个形状，接口照它写 |
| ★ D17 | **本轮范围**：只做每日一题（BE-M6-00 / 01）；通知 N1 **只做站内**——D13 的站内部分先落，D14 的小程序订阅消息与 `WX_MP_PROMPT_TEMPLATE_ID` 模板 ID 后补；慢话题 / 精华（BE-M6-02）与 FE-M6-* 未开工；本轮不部署任何云函数 | 用户 2026-10-03 决定。M4 签核与 M5 真机仍未闭环，云端环境不宜再加变量；站内消息是唯一保证送达的通道，先把数据面打通 |

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

索引定稿（2026-10-03，BE-M6-00 登记 / OPS-M6-01 核对）：`daily_prompts.uniq_date`（`date` 唯一，防同日两条）与 `prompt_answers.idx_prompt_list`（`promptId` + `status` + `createdAt`，供「其他人的回答」分页）已在 `collections.js` 里；「我今天答过没」由原有的 `idx_prompt_owner` 覆盖（`service.js` 的 `findMyAnswer` 就是按 `promptId` + `_openid` 查）。本稿原先写的 `prompt_answers.idx_owner_time` **不采纳**：M6 没有「按人回溯作答历史」的动作，等真做「我的回答」列表时再加。待办只剩云端 `ensure-indexes.mjs --apply` 建那 1 个新索引（需用户授权）。

## 4. 接口（契约草案，全文见 [`docs/api/practice.md`](../api/practice.md)）

| action | 写 | 说明 |
|---|---|---|
| `todayPrompt` | 否 | 返回今日 `ok` 题目 + 我是否已作答 + `answerCount`；没有题目 → `{ prompt: null }`（不是错误） |
| `answerPrompt` | 是 | 门禁见 D5；`{ promptId, text }` → `{ answer: { id, date, text, status, createdAt } }` |
| `listAnswers` | 否 | `{ promptId, page, size }`；本人未作答 → `40301` 且不返回任何答案内容；他人只返回 `status = 'ok'`，本人条目在 `mine` 单独返回（可为 `pending`）；每项含 `authorName` / `anon`（D9：默认匿名），不含 `_openid` / 头像 / 徽章 / 练习档案 |
| `listNotifications` / `markNotificationsRead` | 否 / 是 | 站内消息列表 + 未读数；只按 `_openid` 过滤 |
| ✅ `community.createTopic` | — | 增 `slow` 入参（D11），返回体带 `slowUntil`（BE-M6-02 已实现） |
| ✅ `community.createReply` | — | `slowUntil` 未到 → 40901（已实现） |
| ✅ `community.listTopics` | — | 增 `featured: true` 筛选；摘要与详情带 `featured` 与 `slowUntil`（已实现） |
| ✅ `moderation.markFeatured` | 是 | `mod` / `admin` 专用；写 `mod_logs`；不改变可见性判定（D12，已实现） |

错误码不新增：沿用 `40001` / `40101` / `40301` / `40302` / `40303` / `40304` / `40401` / `40901` / `42901`。

## 5. 任务拆解（约 6 个工作日，BE / FE 可并行；顺序：契约 → mock → 云函数 → 页面）

| 编号 | 负责 | 任务 | 验收 | 估时 |
|---|---|---|---|---|
| ✅ BE-M6-00 | BE | 已完成（2026-10-03，本地）：`config.js` 加 `PROMPT_RULES`（`textMax 120`、`answer { min: 5, max: 500 }`、`listMax 50`、`defaultAnon true`）并导出；`collections.js` 的 `prompt_answers` 补分页索引 `idx_prompt_list`（`promptId + status + createdAt`）。`daily_prompts` / `prompt_answers`、`idx_prompt_owner` 与「每日一次在应用层判断（不能建含 `_openid` 的唯一索引）」原已在册，故未新增 `idx_owner_time`；`fakeDb`（已支持 `count` / `$ne` / `orderBy`）与 `userHarness` 无需改动 | 现有云函数用例不回归：244/244（含新增 22 例） | 0.5d ✔ |
| ✅ BE-M6-01 | BE | 已完成（本地）：`practice/service.js` 新增 `todayPrompt` / `answerPrompt` / `listAnswers` 并注册进 `actions`；机审复用 `checkText`（scene `comment`）+ `logModeration`，`reject` → `40001` 不落库不扣额度、`review` → 落库 `status: 'pending'`；拦截文案与社区逐字一致。**顺序修正**：`answerPrompt` 的「题目失效 / 已作答」前置判断放在 `guardWrite` 之前（每日额度只有 1 次，先扣额度会让 `40901` 被 `42901` 盖掉），与 `community.redeemInvite` 同序 | 单测 22 例：无题目兜底、只认当日 `ok`、重复 `40901` 不扣额度、同日第二题 `42901`、`40401`、字数与参数校验、四类门禁码、reject / review、未作答 `40301` 零内容、他人 `ok` 过滤、匿名与实名展示、注销形态、分页 | 1d ✔ |
| ✅ BE-M6-02 | BE | 已完成（2026-10-03，本地）：`TOPIC_RULES.slowHours = 24`（前后端同名常量，一致性由 Jest 用例比对）；`createTopic` 增 `slow` 布尔 → 落库 `slowUntil = createdAt + 24h`，`presentTopic` 随摘要与详情下发；`createReply` 在机审与 `g.commit()` 之前判 `slowUntil`，未到 → 40901「这条话题还没开放回复」（作者本人同样受限，不扣额度、不落库）；`listTopics` 增 `featured` 布尔筛选（只 `true` 生效，圈子成员校验不动）；`moderation.markFeatured`（`guardRole` + `topics.featured` + `mod_logs` `kind: 'featured'`，只允许对 `ok` 话题标精华，同值调用 `changed: false`） | 实测：`tests/cloudfunctions/m6-slow-featured.test.js` 17 例全通过（差 1ms 不可回 / 到点可回、旧文档缺字段兜 `null`、`slow` 只接受布尔、已有回复照常读、非成员 40401 优先、`featured` 只含 `ok` 且不越圈、非 mod 40301、二次调用幂等仍留审计）；变异验证 7 处全部被捕获；`npm run test:functions` 261/261、`test:ops` 32/32、Jest 40 suites / 551 tests / 32 snapshots、`tsc --noEmit` 0 错 | 1d ✔ |
| ✅ BE-M6-03 | BE | 已完成（2026-10-03，本地）：通知：`reply` / `moderation` / `prompt` 落 `notifications`（`_shared/notify.js`）+ `listNotifications` / `markNotificationsRead`；`cloudbaserc.json` 加定时触发器；订阅消息按 D14（模板 ID 缺则跳过） | 单测：同 `(uid, type, refId)` 只一条、未读数与分页正确、触发器函数在无题目时不写任何记录、`envVariables` 缺键不抛错 | 1.5d |
| ✅ OPS-M6-01 | OPS | 已完成（2026-10-03，本地）：`scripts/ops/daily-prompt.mjs` 的 `set`（单日 / `--from-file` 批量，幂等 upsert，**只改正文不悄悄放开已 close 的日子**，重开要显式 `--reopen`）、`list`（逐日条数 / 状态 / 作答 / 可见 / 待复核）、`close`（只翻 `status`，正文留着）、`audit`（同日多条、非法 `status`、超长 / 空 / 脏空白、全被隐藏、孤儿答案、连续缺口起点）；`scripts/ops/daily-prompt.seed.json` 首周 7 题；长度与归日复用 `PROMPT_RULES.textMax` / `cnDate()`，不另写一套 | 实测：`scripts/ops/daily-prompt.test.mjs` 15 例全通过（含「预览一个字节都不写」「`--apply` 后再跑同一条 → `unchanged`，不产生第二条」「`close` 之后云函数 `todayPrompt` 返回 `prompt: null`」「集合还没建也不报错」「种子文件自身被 CI 校验」）；`npm run test:ops` 47/47、`test:functions` 261/261、Jest 40 / 551 / 32、`tsc --noEmit` 0 错 | 0.5d ✔ |
| ✅ FE-M6-00 | FE | 已完成（2026-10-03，本地）：`types/models.ts` 加每日一题类型（`DailyPrompt` / `PromptAnswer` / `PromptAnswerItem` / `PromptAnswerPage` 等）；`constants/community.ts` 的 `PROMPT_RULES`（`textMax 120`、`answer { min:5, max:500 }`、`listMax 50`、`defaultAnon true`）；`services/practice.ts` 的 `todayPrompt` / `answerPrompt` / `listAnswers` 与 `guard.ts` 的 `WRITE_ACTIONS.practice`；`cloud.types.ts` 的 `FunctionMap`；`mock/client.ts` 补齐同名 handler（校验顺序、`40901` 先于额度、`anon: input.anon !== false` 均与云函数一致） | 实测：`npx tsc --noEmit` 0 错；「mock 与云函数共用规则由测试比对」= `src/constants/__tests__/community.test.ts` 新增「每日一题规则（M6）」用例，对 `PROMPT_RULES` 整对象 `toEqual`，任一侧漂移即红 | 0.5d ✔ |
| ✅ FE-M6-01 | FE | 已完成（2026-10-03，本地）：`features/practice/prompt.ts`（状态机 `none` / `unanswered` / `answered` / `pending`、字数校验、`answerCounter`、署名文案、`promptError` 码表）、`PromptCard.tsx` 挂进练习 Tab、`pkg-practice/pages/prompt` 作答页（默认匿名可切实名、未作答不请求 `listAnswers`、分页「查看更多」、`pending` 只出现在我那条、列表失败可重试且不打断作答）、`utils/router.ts` 的 `prompt` 路由与参数、`app.config.ts` 分包页、`utils/track.ts` 的 `prompt_answer` | 实测：`src/pkg-practice/__tests__/m6.test.tsx` 12 例（卡片 5 + 作答页 7）与 `src/features/practice/__tests__/prompt.test.ts` 全绿，快照 1 个（未作答态卡片）；全量 Jest 40 suites / 551 tests / 32 snapshots | 1d ✔ |
| ✅ FE-M6-02 | FE | 已完成（2026-10-03，本地）：发起话题页的「慢话题」开关（默认关、开了才带 `slow: true`、随草稿一起保存恢复）；列表卡片与详情页的冷静期展示（未到点只收起回复栏并显示剩余时间，读 / 引用查看 / 举报照常）；圈内话题流「只看精华」筛选（筛选态进 `usePaged` 的 key）；`markTopicFeatured` 服务层接线。契约同步：`models.ts` 的 `TopicSummary.slowUntil` 与 `TopicInput.slow`、`cloud.types.ts` 的 `FunctionMap`（`listTopics` 入参加 `featured`、`moderation.markFeatured`）、`guard.ts` 的 `WRITE_ACTIONS.moderation`、`mock/client.ts`（create 落 `slowUntil` / list 按 `featured` 筛 / createReply 冷静期闸门 / markFeatured handler）与云函数同口径 | 实测：新增 `src/pkg-community/__tests__/m6.test.tsx` 6 例（开关与发布入参、草稿恢复、锁回复栏、到点放开、筛选透传与重新取数、精华空态）；`rules.test.ts` +6 例（`slow` 只在为真时下发、文案与 `TOPIC_RULES.slowHours` 同源、`isReplyLocked` 到点即解锁的边界、剩余时间给准数、40901 透出云端中文、老草稿缺字段不炸）；`topic-card` +1 例；`community-topics` +6 例（含 markFeatured 权限与状态校验、缓存失效、话题流版本、未同意不发请求）；全量 Jest **41 suites / 570 tests / 32 snapshots**、`tsc --noEmit` 0 错、`test:functions` 261/261、`test:ops` 47/47；**变异验证 17 处全部被捕获**（含「到点仍算锁住」「筛选没传下去」「切换不重新取数」「markFeatured 不校验状态」「锁住时整块提示消失」） | 0.5d ✔ |
| ✅ FE-M6-03 | FE | 已完成（2026-10-04，本地）：`features/notify/`——`rules.ts`（三类标签、`formatPostTime` 时间口径、「能不能点开」只看 `type` + `refType` + `refId`、分页合并与就地标已读）、`subscribe.ts`（订阅授权，缺配置即跳过、失败静默）、`badge.ts`（weapp tabBar 角标，best-effort）；`services/practice.ts` 的 `listNotifications` / `notificationsUnread` / `markNotificationsRead` 与 `NOTIFICATIONS_KEY`；`pkg-community/pages/messages`；「我的」入口显示未读数并同步角标；提交回答成功后才请求订阅授权。契约同步：`models.ts` 的 `AppNotification` / `NotificationPage` / `MarkReadResult`、`cloud.types.ts` 两个动作、`guard.ts` 的写动作、`app.config.ts` 分包页、`router.ts` 的 `messages` 路由、`mock/client.ts` 两个 handler（校验顺序、倒序、`unread` 只数自己的、1–100 上限）与「回复别人话题 → 作者收到消息」的联动 | 实测：新增 3 个测试文件 54 例；全量 Jest **44 suites / 628 tests / 33 snapshots**、变异验证 29 处全部被捕获、`tsc --noEmit` 0 错、`test:functions` 287/287、`test:ops` 47/47，改动文件 eslint 只剩 `mock/client.ts` 的 6 条既有债。**三端**按 `TARO_ENV` 分支在 jsdom 下覆盖（weapp 走角标与订阅、h5 / rn 只站内），真机与订阅送达留到 `QA-M6-01` 登记；模板 ID 未到位前「实际送达」一项记受阻、不得标通过 | 1d ✔ |
| ✅ QA-M6-01 | QA | 已完成（2026-10-04，本地）：`docs/test/cases/M6.md` 登记 M6-A01…A17（作答可见性、每日一次与并发、慢话题时间边界、精华权限、通知去重与送达、越权专项、前后端同源、运维巡检）+ M6-D01…D09 三端清单；顺手补三处此前缺的自动化——云函数「同 tick 并发双写」真实代价（M6-A04）、前端连点保护（`loading` / `disabled` 两道）、`audit` 的 `dup_answer` 巡检（D7 承诺的观测口径此前并不存在） | 实测：Jest **44 suites / 629 tests / 33 snapshots**、`test:functions` 288/288、`test:ops` 48/48、`tsc --noEmit` 0 错；变异验证 **8/8 被捕获**（单摘第三道 `busy` 早退不转红，已记为与 UI 层互为冗余）；云端未部署 → 真机 D01–D08 待执行、D09 订阅送达受阻，M6 不签核 | 0.5d ✔ |
| ✅ QA-M6-02 | FE | 已完成（2026-10-04，本地）：审核页（`pkg-admin/pages/queue`）行内加「标为精华 / 取消精华」，只对 `ok` 话题给标、撤销不限状态、复用 `markTopicFeatured`（含缓存失效）、失败只报文案不改本地状态、请求期间按钮禁用；`moderation.queue` 的目标快照多带布尔 `featured`（云端 + mock + `docs/api/moderation.md` + `ModQueueItem` 同步） | 实测：`src/pkg-admin/__tests__/admin.test.tsx` 新增 7 例（按钮显示规则、翻面、失败不假装成功、未同意协议零请求、连点只发一次、取消确认不发请求）、`m6-slow-featured` +1 例；全量 Jest **44 / 636 / 33**、`test:functions` 289/289、`test:ops` 48/48、`tsc` 0 错；变异验证 **8/8 被捕获** | 0.25d ✔ |
| DOC-M6 | PM / BE | 契约定稿、`docs/ops/collections.md` 索引表、`wording.md` 补「每日一题 / 慢话题 / 精华」措辞规范（含题目与提醒文案送审） | 文档与实现一致 | 随各项 |

合计约 6~6.5 个工作日（含并行）。依赖：BE-M6-00 → 01 / 02 / 03；FE-M6-00 可与 BE 并行（先 mock）；OPS-M6-01 在 BE-M6-00 之后；FE-M6-01~03 在 FE-M6-00 之后。

## 6. 测试计划（要点；完整用例编号写进 `docs/test/cases/M6.md`）

- 云函数（`tests/cloudfunctions/m6-prompt.test.js`）：`todayPrompt` 无题目 / `closed` / 只取 `ok`；`answerPrompt` 的 40001（字数与未知字段）、40302 / 40303 / 40304、40901（重复作答）、42901（当日额度）、机审三态；`listAnswers` 未作答 40301、只返回 `ok`、返回体无身份字段。
- 云函数（`m6-slow-featured.test.js`）：`slowUntil` 边界（差 1ms 不可回、到期可回）、已有回复不受影响、非 mod 标记 40301、`markFeatured` 写 `mod_logs` 且二次调用幂等、`listTopics({ featured: true })` 不越圈。
- 云函数（`m6-notify.test.js`）：`(uid, type, refId)` 去重、未读数、分页、触发器入口在无题目时零写入、无模板 ID 时不外发且不抛错。
- 运维：`daily-prompt.mjs` 预览不写 / `--apply` 幂等 upsert / `close` 后 `todayPrompt` 不再返回；`audit` 对同日多条题目与同人同题多条作答（`dup_answer`，warn）给出可读输出。
- 前端：卡片状态机（未作答 / 已作答 / 审核中 / 无题目）、`pending` 与 `ok` 的展示差异、未作答时不请求 `listAnswers`、订阅授权只在主动操作后触发一次、失败静默。
- 变异验证（M3 起的习惯）：去掉「已作答」前置查询、去掉 `slowUntil` 校验、去掉 `listAnswers` 的成员前置（改为不判作答）、去掉通知去重查询——每种都要让对应用例转红，探针后恢复。

- **实现结果（2026-10-03，BE-M6-00 / 01）**：`tests/cloudfunctions/m6-prompt.test.js` 22 例全通过；变异验证 5 处（去掉「已作答」前置 / 默认匿名翻成默认实名 / reject 先扣额度 / 他人答案不按 `ok` 过滤 / 重复判断挪到扣额度之后）各使**恰好 1 例**转红，恢复后复绿。全量复跑：云函数 244/244、运维 32/32、Jest 38 suites / 526 tests / 31 snapshots、`npx tsc --noEmit` 0 错。

- **实现结果（2026-10-03，BE-M6-02）**：慢话题与精华全部落在云端读写的既有链路上，没有新集合、没有新索引、没有定时任务——`slowUntil` 只在 `createTopic` 多存一个字段、在 `createReply` 多一个前置判断（放在机审与计额度之前，被挡下的回复不占额度也不发机审）；精华只在 `topics` 上翻一个布尔，配套 `moderation.markFeatured` 走 `guardRole` 并逐次写 `mod_logs`。`TOPIC_RULES.slowHours` 同时加到 `_shared/config.js` 与 `src/constants/community.ts`，`tests/cloudfunctions/m3.test.js` 里那条 `TOPIC_RULES` 断言与前端 `community.test.ts` 的比对用例一起把两边钉住（只改一侧必红）。刻意保守的地方：冷静期对作者本人同样生效（开放回复是给别人看的，不是给自己续写的通道）、`featured: false` 视为「不过滤」而不是「只看非精华」、给非 `ok` 话题标精华一律 40001 但取消标记任何时候都可以。
- **实现结果（2026-10-03，FE-M6-00 / 01）**：卡片与作答页全程走 mock 云端（`TARO_APP_DATA_SOURCE` 不变），断言打在真实请求上。覆盖：无题目（含门禁未过）不渲染、未作答 / 已作答 / 审核中三态与 CTA 文案、默认匿名提交且首尾空白被裁、切实名后 `anon=false`、未作答时不发 `listAnswers`、他人列表不含 `pending` / `removed`、「查看更多」翻页（21 条 → 第二页取到第 21 条）、`40901`「今天已经作答过了」并回读状态、`42901`「明天再来」、机审拒绝与云函数同一句话且不落库。测试侧两个坑记在这里免得重犯：`useRequest` 有 5 分钟内存缓存，`mockControl.reset()` 不清它，`beforeEach` 必须 `invalidate()`；发布类动作的 `requirePhone` 除 `account.phoneVerified` 外还要求「已读社区公约」（`markRulesRead()`），否则提交会被静默引导走别的分支、连请求都不发。文案：`showToast` 上限 8 字，长句留在页面内联显示（新增 `SUBMITTED_TOAST` / `PENDING_TOAST`，`PENDING_HINT` 等长文案继续用于卡片与列表）。全量复跑：Jest 40 suites / 551 tests / 32 snapshots、云函数 244/244、运维 32/32、`npx tsc --noEmit` 0 错；本轮新增与改动的文件 `npx eslint` 0 问题（`src/services/mock/client.ts` 的 6 条 `import/first`、`CheckinCalendar.tsx` 的数字分隔符、`me.ts` / `cloud.rn.ts` 各 1 条经与 HEAD 版本比对确认是既有债，本轮不动）。**仍仅本地，未部署**。

- **实现结果（2026-10-03，OPS-M6-01）**：录题脚本只做「读—算计划—打印—（`--apply` 才）写」，所以每一句都会先被打印出来复核，误操作的回滚成本就是一次 `close`。与云函数共用 `PROMPT_RULES.textMax` 与 `cnDate()`，题目取法也与 `todayPrompt` 一致（`date` + `status: 'ok'` + `limit 1`，**不排序**）——`audit` 因此专门把「同一天多条」列为 `error`：`uniq_date` 本该拦住，一旦有就说明索引缺失或被绕过，此时前端会随机看到两条中的一条。`set` 的两条硬规矩：正文-only（`status` 只在 `--reopen` 时才改），批量整批校验通过才写（种子文件里日期重复直接拒绝，不产生半批写入）。索引侧只做了一件小事：把 `prompt_answers.idx_prompt_list` 补进 `docs/ops/collections.md` 的索引表（BE-M6-00 已登记在 `collections.js`，文档漏了一行），并把本计划原先设想的 `idx_owner_time` 标记为不采纳。**未执行任何云端 `--apply`，未部署。**

- **实现结果（2026-10-03，FE-M6-02）**：这一轮的铁律是「前端只做减法，不做决定」——前端只传 `slow: true` / `featured: true` 两个开关，
  `slowUntil` 由云端算、到点与否由云端判（`createReply` 仍会 40901），`isReplyLocked` 只用来少发一次注定被拒的请求并把话讲清楚，
  所以「前端时钟漂移」不会变成绕过冷静期的通道。三个刻意的取舍：① 锁的是**回复栏**而不是整页（读、引用查看、举报都照常，被锁的人不该连内容都看不到）；
  ② 提示给准数（「2 小时 1 分后开放回复」）而不是「稍后再试」，`slowReplyHint` 与卡片标共用 `TOPIC_RULES.slowHours`，改规则不会两边漂；
  ③ 只在开启时带键（`slow` / `featured` 都是如此），与云函数「`=== true` 才生效」的读法严格对齐，避免 `false` 被下游当成第三种状态。
  `markTopicFeatured` 只做到服务层（写动作门禁 + `invalidate(topicKey)` + 话题流版本 +1），**审核页的按钮留到下一轮**：它得跟 `decide` 同屏才有用，那是 pkg-admin 的改动。
  前端也补了 mock 的同款行为（发帖落 `slowUntil`、列表按 `featured` 筛、回复冷静期闸门、markFeatured 的角色与状态校验），否则「真机过、mock 红」迟早出现。

- **实现结果（2026-10-03，BE-M6-03）**：通知这一轮把「送达」和「打扰」分开处理——**送达**靠 `notify()` 的唯一收口：三类
  （`reply` / `moderation` / `prompt`）都从这一个函数写，接收人为空就不写（作者注销是常态而不是异常）；**不打扰**靠新增的
  `dedupe` 开关：只对 `(uid, type, refId)` 齐全、且重复发出去确实没意义的类型打开（每日一题），`moderation` 沿用默认不去重，
  免得「二次处理同一目标」的通知被吞掉。三个刻意的取舍：① `createReply` 的通知在 `g.commit()` 之后发，回复本身已经站住了，
  通知只是附加品——它失败不该让发帖人看到「回复失败」；② 每日提醒做成**定时触发器 + 纯函数模块**（`_shared/reminder.js`），
  不暴露成 action，宁可接受「定时事件不是可信来源」，所以那个入口不收业务参数、不回数据、且天然幂等；③ 外发（订阅消息）
  一行代码都不写，「模板 ID 缺键不抛错」是靠**没有读环境的代码**保证的，而不是靠判空——这一点在 `m6-notify.test.js` 里
  用源码断言钉住（`reminder.js` 不得出现 `process.env` / `WX_MP_` / `subscribeMessage`）。
  `tests/cloudfunctions/m6-notify.test.js` 26 例全通过（云函数全量 287/287）；变异验证 **23/23 被捕获**，含本轮点名的
  「去掉通知去重查询」、以及「去重条件去掉 `_openid`」（否则 A 的已提醒会吞掉 B 的）、「`read: false` 去掉」破坏幂等、
  「列表去掉 `_openid` 过滤」的越权、`users` 翻页 `break` 提前（只发前 100 人）、`isTimerEvent` 不判 `action`、
  以及 `index.js` 的接线被摘掉。触发器配置与 `timeout` 提升也进了用例（`cloudbaserc.json` 断言只有 `practice` 挂了
  一个 `timer` 且没有 `envVariables`）。**未做**：订阅消息外发（D17）、`notifications` 的推送优先级/合并（PRD 未要求）、
  复核通过后补发回复通知（明确不做，见上）。

- **实现结果（2026-10-04，FE-M6-03）**：消息页只在既有链路上加东西——`useRequest` 的缓存键、`guard.ts` 的写动作、
  `mock/client.ts` 的同名 handler，没有新增错误码、没有轮询定时器：未读数由 `listNotifications` 的 `unread` 带回，
  「我的」入口用 `notificationsUnread()`（内部就是 `NOTIFICATIONS_ENTRY_SIZE = 1` 的一页一条）换同一个数字，所以红点不多打一次云端。三个刻意的取舍：
  ① 前端**只按 `type` + `refType` + `refId` 决定能不能点开**，绝不解析 `text`——云端改文案不会把跳转改坏，
  `moderation` 与缺 `refId` 的老数据一律不挂点击而不是跳到一个错的页面；② 标已读失败**不本地假装已读**
  （下次照常亮，宁可多提醒一次也不把消息吞掉），但失败也不挡住进话题；③ 订阅授权只在主动操作（提交回答）成功后请求，
  缺模板 ID / 非小程序端 / API 不存在就整个跳过，用户在弹窗里拒绝也不给任何提示（D14：不拿授权就不发外发，站内照常）。
  没用 `usePaged`：它以 `_id` 去重且不提供「就地改一条」的入口，而这里条目主键是云端的 `id`、点开后要立刻翻成已读——
  于是分页合并与就地标记落在 `mergeNotifications` / `markLocalRead`，去重语义与 `usePaged` 保持一致并由用例钉住。
  mock 也补齐了联动（回别人话题 → 作者收到 `reply` 通知、自己回自己不发），否则「真机有消息、mock 空页」迟早对不上。
  两个测试侧的坑记在这里免得重犯：`test/setup.js` 把 `TARO_ENV` 默认成 `weapp`，要测「非小程序端不碰 tabBar」必须显式切成 `h5`；
  `process.env.X = undefined` 会被 Node 写成字符串 `'undefined'`，所以还原环境用 `= prev` 而不是 `delete`。
  实测：`notify.test.ts`（规则 / 订阅 / 角标）、`practice-notifications.test.ts`（服务层门禁、分页、上限、越权、mock 联动）、
  `m6-messages.test.tsx`（两个页面 + 快照，1 个）共 54 例；变异验证 29 处全部被捕获（含「空选中被升格成全部已读」「未读数把别人的算进来」「订阅失败往上抛」「角标越界不截断」「时间口径不共用」）；全量复跑 Jest 44 suites / 628 tests / 33 snapshots、
  `npx tsc --noEmit` 0 错、`test:functions` 287/287、`test:ops` 47/47。**仍仅本地，未部署。**

## 7. 上线与回滚

1. 合并前逐项运行并记录：`yarn test:functions`、`yarn test:ops`、`yarn test --runInBand --silent`、`yarn typecheck`；新文件按仓库风格 `npx eslint`；三端结果记入 `docs/test/cases/M6.md`。
2. `node scripts/sync-shared.mjs`；`node scripts/ops/ensure-indexes.mjs` 预览 → 经用户授权后 `--apply`（M6 只多 1 个索引：`prompt_answers.idx_prompt_list`）。
3. `tcb fn deploy practice community moderation --force`（**部署前用 `scripts/ops/function-env.mjs` 核对 `envVariables` 都有值**：部署会整体覆盖线上环境变量，缺键即清空）；`cloudbaserc.json` 的 `triggers` 变更后重新部署 `practice` 使触发器生效。
4. 录入首周题目：`node scripts/ops/daily-prompt.mjs set --from-file scripts/ops/daily-prompt.seed.json` 预览 → 确认后加 `--apply`；临时撤当天用 `close --date … --apply`；录完 `audit` 应只输出「没问题 ✓」。提醒外发在模板 ID 到位前保持「只站内」。
5. 冒烟：`invoke-fn.mjs` 调 `practice` 的 `todayPrompt` / `listNotifications`；**不在生产写测试数据**（如需作答测试，用 `test_` 前缀题目并在事后 `close`）。
6. 回滚：`practice` / `community` / `moderation` 回到上一提交重新部署；`daily_prompts` / `prompt_answers` / `notifications` 的数据无需回滚（不被旧代码读取）；触发器回滚要一并删掉 `triggers` 再部署，否则旧函数会被定时唤起。

**2026-10-04 部署实测（体验版）**：`tcb fn deploy <f> --force` 三函数成功，且 `cloudbaserc.json` 的 `triggers` 会被 deploy 自动创建（不必再 `tcb fn trigger create`）；`ensure-indexes.mjs --apply` 复核 28 条索引齐、`conflicts 0`；`daily-prompt.mjs set --apply` 写 7 条、二次运行全 `unchanged`。回滚方式：部署前用 `tcb fn code download <f>` 存下的 `../deploy-backup-20261004/code_<f>`，用 `tcb fn code update <f>` 还原（`tcb fn list-function-versions` 显示线上没有发布过版本号，不能靠流量切换回滚）。触发器时区仍待控制台核对；`tcb` 全局登录可能指向别的账号（本次就先撞了一次 `env not found`）。

## 8. 风险与未决

| 风险 / 未决 | 处置 |
|---|---|
| ~~★「作答是否署名」未定~~ **已定**（2026-10-03：可选匿名、默认匿名，见 D9） | 若日后要展示更多身份信息（头像 / 徽章 / 练习年限），须同步隐私政策与 `wording.md`，并补「他人可否反查练习者身份」的越权用例 |
| ★ 订阅消息模板 ID 未申请 | 阻塞 FE-M6-03 的真实送达验收（`QA-M6-01` 的「订阅消息实际送达」项在模板到位前记为受阻，不得标为通过） |
| ★ 题目文案与提醒文案需法务 / 措辞审阅 | 走 `wording.md` §1 / §2 流程；未通过前不 `--apply` 写题 |
| 并发双写导致同日多条答案（D7） | **观测已落地**（2026-10-04，QA-M6-01）：`daily-prompt.mjs audit` 的 `dup_answer`（warn）+ 云函数 M6-A04 与前端连点用例各钉一条；若内测真实出现，再评估把 `prompt_answers` 的注销语义从 `detach` 改成删除并补唯一索引 |
| 提醒定时触发器成本与时区 | 每日一次、08:00 北京时间（控制台时区待部署时核对）；无题目即早退；触发器重跑由 `(uid, type, refId)` 去重兜住。**已按此实现**；另记一笔：定时事件不是安全边界，靠「不收业务参数 + 不回数据 + 幂等」兜，真隔离要等平台侧「仅平台调用」配置 |
| 精华列表变成越权通道 | D12 明确不解除成员校验，并在用例里专测（`listTopics({ featured: true })` 对非成员不返回圈内内容） |
| M4 / M5 真机未闭合就推进 M6 部署 | 本计划第 7 节第 3 步之前必须完成 M4 签核与 M5 真机验收；否则只在本地与隔离 Dev 环境验证 |
| 用户可见文案「精选」（前端 `FEATURED_BADGE`）与「精华」（云端提示 / 本文档）用词不一 | FE-M6-02 先沿用前端既有文案不动快照；待 `wording.md` 定稿后一次性统一（TopicCard 徽标、圈内筛选、`markFeatured` 的 40001 提示、`docs/api/*.md`），连带更新快照 |
| `tcb` CLI 登录账号与项目环境不匹配（2026-10-04 实测） | 现象：`tcb fn list` 报 `[DescribeEnvInfo] env not found in list`，该账号 `env list` 只有另一个环境，同区域加 `-e <envId>` 也绕不过。处置：函数部署前先 `tcb logout && tcb login` 到创建 `TARO_APP_CLOUD_ENV_ID` 那个账号，或改在控制台 / 开发者工具上传；`scripts/ops/*`（集合、索引、录题、函数环境变量）走 `.env` 的 SecretId/Key，不受影响。函数未上线前，`ensure-indexes --apply` 与 `daily-prompt.mjs --apply` 一律按待授权处理 |
| ~~精华只能由云端动作标记，审核页还没有入口~~ **已落地**（2026-10-04，QA-M6-02） | 审核页行内按钮（`ok` 才可标、撤销不限状态、失败不假装成功）；`queue` 目标快照带 `featured` 供前端判断，用例见 `docs/test/cases/M6.md` 的 M6-A18 |
