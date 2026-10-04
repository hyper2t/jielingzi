# practice 云函数（打卡 / 每日一题）

> 通用约定见 [README.md](./README.md)。除 `ping` 外均需登录（安全规则 `auth != null`）。打卡是本人可见的私人练习记录：仍要求账号未封禁、已确认 18+，但不要求绑定手机号，也不受社区禁言影响。集合客户端不可直读，所有查询经云函数并按 `_openid` 限定本人。

## ping

健康检查，免身份，不读写数据库。

- 入参：无
- 返回：`{ fn: 'practice', at: <毫秒时间戳> }`

## checkin（BE-M5-01）

- 入参：`{ sessionId, date, practice, minutes }`
  - `sessionId`：8–80 位 `[A-Za-z0-9_-]` 幂等键；计时器每次练习生成一个新值，网络重试必须复用原值。
  - `date`：用户设备本地日期 `YYYY-MM-DD`，必须是有效公历日期；跨零点练习以计时结束时间所属日期记账。
  - `practice`：`meditation`、`mindfulness`、`vipassana`、`taichi`、`zhanzhuang`、`qigong`、`yoga`、`breathing`、`calligraphy`、`tea`、`reading`、`other` 之一。
  - `minutes`：1–180 的整数。
- 行为：按 `_openid + dayKey(date:practice)` 聚合分钟数；同一日 / 练习方式下重复提交同一 `sessionId` 不重复累加。
- 返回：`{ checkin: { date, practice, minutes, duplicate } }`；`minutes` 是该日该练习方式的累计值。
- 错误：参数不合法 `40001`；未登录 `40101`；未确认 18+ `40303`；账号封禁 `40304`。不要求手机号；禁言账号仍可记录私人练习。
- 服务端只保存幂等键及累计值，不回传 `_openid` / 内部 `_id`。

## listCheckins（BE-M5-01）

- 入参：`{ month }`，格式 `YYYY-MM`（年份 2000–2100）。
- 返回：`{ month, list, totalMinutes }`；`list` 按日期升序，每项为 `{ date, minutes, practices }`，其中 `practices` 是各练习方式的分钟数映射。
- 权限：只按当前调用方 `_openid` 查询；无其他用户查询参数。
- 错误：参数不合法 `40001`；未登录 `40101`；未确认 18+ `40303`；账号封禁 `40304`。

## 每日一题（M6 契约 · 云函数与前端均已实现（本地，未部署））

> 决策与理由见 [`docs/prd/m6-plan.md`](../prd/m6-plan.md)。本节三个动作已按定稿契约实现于 `cloudfunctions/practice/service.js`（2026-10-03：本地 22 例单测通过；同日前端接线完成——`src/services/practice.ts` 三个方法 + `src/services/mock/client.ts` 同名 handler + 练习 Tab 的 `PromptCard` 与 `pkg-practice/pages/prompt` 作答页，页面测试 12 例 + 快照 1 个，前后端规则同源由 `community.test.ts` 比对。**均只在本地，未部署**）；「同里程碑的其他接口」一节里的慢话题 / 精华也已实现（本地），只有审核页的标记入口待接。

### todayPrompt

- 入参：无
- 返回：`{ prompt: { id, date, text, answered, myStatus, answerCount } | null }`；`date` 是北京时间当日（`cnDate`），只取 `status: 'ok'` 的题目；当天没有题目返回 `null`，不是错误。`myStatus` 是本人那条的状态（未作答为 `null`），`answerCount` 为他人可见答案数（近似值，与圈子成员数同口径）。
- 权限：登录 + 已确认 18+ 即可；不要求入圈，也不要求手机号。
- 错误：`40101` 未登录；`40303` 未确认 18+；`40304` 封禁。

### answerPrompt

- 入参：`{ promptId, text, anon? }`；`text` 去首尾空白后 5–500 字（`PROMPT_RULES.answer`）；`anon` 缺省即匿名（`PROMPT_RULES.defaultAnon = true`，显式 `false` 才实名，见 m6-plan D9）；未知字段 `40001`。
- 门禁：登录 → 未封禁 → 18+ → 已实名 → 未禁言 → 当日额度 `DAILY_LIMITS.answerPrompt = 1`；机审 `reject` → `40001`，不落库也不扣额度。
- 行为：同一题每人一条，应用层先查后写（`collections.js:95` 已注明不能建含 `_openid` 的唯一索引）；机审 `review` → 落库 `status: 'pending'`；`pass` → `ok`。
- 返回：`{ answer: { id, date, text, anon, status, createdAt } }`（不回传 `_openid`）。**顺序**：题目失效（`40401`）与重复作答（`40901`）的判断在 `guardWrite` 之前——每日额度只有 1 次，先扣额度会让重复提交的真实原因被 `42901` 盖掉。
- 错误：`40001`；`40101`；`40302` 未实名；`40303`；`40304`；`40401` 题目不存在或已 `closed`；`40901`「今天已经作答过了」；`42901` 当日额度已用完。

### listAnswers

- 入参：`{ promptId, page?, size? }`；`size` 默认 20、上限 `PROMPT_RULES.listMax = 50`。
- 前置：调用方必须已作答该题，否则 `40301`「作答后即可查看他人的回答」，且**不返回任何答案内容**。
- 返回：`{ promptId, date, page, size, hasMore, list, mine }`；`list` 按 `createdAt` 升序、只含他人 `status: 'ok'`，每项 `{ id, date, text, status, createdAt, authorName, anon, isSelf, deleted }`；本人那条在 `mine` 单独返回（可能是 `pending`）。
- 隐私（D9）：默认匿名。`authorName` 匿名时取 `profiles.anonAlias`、实名时取 `nickname`，注销或已解除归属（`_openid` 为 `null` 或 `authorDeleted`）固定「已注销用户」；不下发 `_openid` / 头像 / 徽章 / 练习方式 / 年限 / 手机号。

### 同里程碑的其他接口（慢话题 / 精华：云函数与前端均已实现（本地，未部署））

- `community.createTopic`：增可选 `slow: true` → 落库 `slowUntil = createdAt + 24h`；话题摘要与详情返回 `slowUntil`。
- `community.createReply`：`slowUntil` 未到 → `40901`「这条话题还没开放回复」；已发布的回复不受影响。
- `community.listTopics`：增 `featured: true` 筛选；圈内精华仍只对成员可见。
- `moderation.markFeatured`：`{ topicId, featured }` → `{ ok: true, featured, changed }`，仅 `mod` / `admin`，写 `mod_logs`（`kind: 'featured'`）。**已实现**，详见 [`docs/api/moderation.md`](moderation.md)。
- 站内消息（`practice.listNotifications` / `markNotificationsRead`）与每日提醒触发器：见下一节，BE-M6-03（云端）与 FE-M6-03（前端）均已实现。

## 站内消息与每日提醒（BE-M6-03 + FE-M6-03 · 云函数与前端均已实现（本地，未部署））

> 决策与理由见 [`docs/prd/m6-plan.md`](../prd/m6-plan.md) D13 / D15 / D16 / D17。集合 `notifications` 在安全规则里是私有的
> （`{ read: false, write: false }`），客户端只能经这两个动作读写；没有新增错误码。

### listNotifications

- 入参：`{ page?, size? }`；`size` 默认 20、上限 50，未知字段 `40001`。
- 返回：`{ page, size, hasMore, unread, list }`；`list` 按 `createdAt` 倒序，每项
  `{ id, type, refType, refId, text, read, createdAt }`，不含 `_openid`。`unread` 是本人未读条数（前端红点）。
- 可见范围：查询条件恒为 `_openid = 当前账号`，所以只能看到写给自己的那一份；一条消息都没有时返回空列表
  （`notifications` 集合还不存在也不报错）。
- 门禁：登录 + 18+ + 未封禁（与 `todayPrompt` 同口径：`guardWrite(ctx, 'listNotifications', { requirePhone: false, allowMuted: true, limit: 0 })`），
  禁言只限制发言、不影响收消息；`limit: 0` 表示不占当日额度。
- 错误：`40001`；`40101`；`40303`；`40304`。

### markNotificationsRead

- 入参：`{ ids: string[] }`（去重后 1–100 条）**或** `{ all: true }`；两者都不给 → `40001`（不「顺手全标」）。
- 返回：`{ updated, unread }`。更新条件带 `_openid`，所以传别人的 id 只会命中 0 条——不报错、也不暴露那条消息是否存在；
  已读过的再标一次 `updated: 0`（幂等）。
- 门禁同上（也是写动作，但同样 `limit: 0` 不占额度）。
- 前端接线（FE-M6-03）：`services/practice.ts` 的 `listNotifications(page?, size?)` / `notificationsUnread()` /
  `markNotificationsRead(ids?)`；列表缓存键 `NOTIFICATIONS_KEY`（写成功后 `invalidate`）；`guard.ts` 把
  `markNotificationsRead` 计进 `practice` 的写动作（未同意 / 未确认 18+ / 封禁禁言时前端就地引导，**一个请求都不发**，
  读动作也只在门禁过了之后才发）。「我的」入口用 `notificationsUnread()`（内部就是 `listNotifications(1, NOTIFICATIONS_ENTRY_SIZE)`）只为拿 `unread`，
  不多发一次计数请求；门禁未过时直接返回空页。
- 前端的 `markNotificationsRead(ids?)`：不传 → `{ all: true }`；传空数组 → 原样发出、由云端 `40001` 挡下——
  「空选中」不等于「全部已读」，前端不改调用方的语义。标记失败不本地假装已读（下次照常是未读），但也不挡住跳转。
- 页面：`pkg-community/pages/messages`（标签 / 时间 / 可点判定在 `features/notify/rules.ts`，时间口径共用
  `utils/format.ts` 的 `formatPostTime`；只有 `type` 与 `refType` 对得上且 `refId` 在的条目才挂点击，
  `moderation` 与缺引用的老数据一律不可点；「全部标为已读」放导航栏右侧且只在有未读时出现）。
  weapp 下「我的」还会把未读数同步成 tabBar 角标（`features/notify/badge.ts`，超过 99 显示 `99+`；
  非 weapp 端、没有该 API、被 reject 都静默返回 false）。
- 订阅消息授权（D14 / D17）只在「提交回答成功」之后请求（`pkg-practice/pages/prompt`），
  模板 ID 取自 `TARO_APP_WX_MP_PROMPT_TEMPLATE_ID`：非 weapp、缺该键、或 Taro 上没有
  `requestSubscribeMessage` → 直接跳过；调用报错或用户在弹窗里拒绝 → 静默，不弹提示、不影响本次提交结果。

### 谁会往 `notifications` 里写

| 来源 | `type` | `refType` / `refId` | 说明 |
|---|---|---|---|
| `community.createReply` | `reply` | `topic` / 话题 id | 只发话题作者；给自己回复不发；机审判为 `pending` 的回复不发（复核通过后也不补发）；正文是固定说明「你的话题收到了新回复」，不含回复原文 |
| `moderation.decide` | `moderation` | 内容类型 / 目标 id | 被处理作者 + 各举报人；`notify()` 默认不去重，同一目标二次处理仍会再通知一次 |
| 定时触发器（下一节） | `prompt` | `daily_prompt` / 题目 id | 按 `(uid, type, refId)` 去重：一道题对同一人最多提醒一次 |

### 每日一题提醒（定时触发器）

- 配置：`cloudbaserc.json` → `functions[]` 里 `practice` 的
  `triggers: [{ name: 'dailyPromptReminder', type: 'timer', config: '0 0 8 * * * *' }]`（七段 cron，秒在最前）。
  **一个函数只支持挂一个触发器**；`triggers` 变更后要重新部署 `practice` 才生效，必要时 `tcb fn trigger create practice`；
  控制台「触发器」页标注的时区要先核对（配置按北京时间 08:00 写，若控制台是 UTC 需换算）。
- 入口：`cloudfunctions/practice/index.js` 认出「`event.Type === 'timer'` 且不带 `action`」的事件后**不进 action 分发**，
  直接跑 `_shared/reminder.js` 的 `runPromptReminder`；其余调用照旧走 `createMain`。
- 行为：取 `cnDate(now)` 当日 `status: 'ok'` 的题目，给每个「已确认年满 18 周岁且不在封禁期」的账号写一条
  `type: 'prompt'` 通知（`refType: 'daily_prompt'`、`refId = promptId`、正文固定）。
- 兜底与代价：当日没有可用题目 → 整批跳过、零写入；`(uid, 'prompt', promptId)` 去重 → 触发器重跑不会重复打扰；
  `users` 按 `_id` 翻页扫描，每页 100、上限 2000，超限在日志里记 `truncated` 而不静默丢账号；`practice` 的
  `timeout` 因此从 10s 提到 60s。去重靠「先查后写」而不是唯一索引：`refId` 允许为 `null`，唯一索引会把多条 `null` 判成重复。
- 安全边界要说清楚：定时事件本身不是可信来源（`{ Type: 'timer' }` 构造得出来，虽然 App 侧封装永远带 `action`），
  所以这个入口不收业务参数、不返回业务数据，最坏结果只是「今天的提醒提前发一次」，并被去重挡住不会发第二遍。
  真要隔离得靠平台侧「仅平台调用」的函数配置，本轮不做（与 `mediacheck` 同法时再一并处理）。
- 失败不外抛：`createTimerEntry` 捕获异常、只记 `[promptReminder]` 日志并返回 `'success'`，避免平台按调用失败重试反复唤起
  （提醒可延迟，明晚还会再跑）。
- **不外发订阅消息**：`_shared/reminder.js` 不读任何环境变量，`practice` 在 `cloudbaserc.json` 里也没有 `envVariables`，
  所以「模板 ID 缺键」这条链路没有对应代码，不会抛错；订阅消息按 D17 后补。
- **2026-10-04 补记（底层件已就位，尚未接线）**：`_shared/wxmp.js` 新增 `mp.subscribeMessageSend`（`POST /cgi-bin/message/subscribe/send`，`data` 每项自动包成 `{ value }`、非字符串转字符串、`page` / `miniprogram_state` 为空则不带），errcode 分类为 `sent` / `no-quota`（43101 = 没订阅、已取消或额度用完，属正常结果不重试）/ `bad-template`（40037、47003 = 模板或参数问题）/ `failed`，只有传输层失败才外抛；`tests/cloudfunctions/m6-subscribe-send.test.js` 覆盖 6 例。但 `runPromptReminder` **仍不调用它**：额度记录与模板字段映射未定（见 `docs/prd/m6-plan.md` 的 D09b 前提），`practice` 也仍无 `envVariables`。
