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

## 每日一题（M6 契约 · 草案，未实现）

> 决策与理由见 [`docs/prd/m6-plan.md`](../prd/m6-plan.md)；本节是实现前的契约草案，**未定稿**。三个动作都挂在 `practice` 云函数（`service.js` 头注释已预留）。

### todayPrompt

- 入参：无
- 返回：`{ prompt: { id, date, text, answered, answerCount } | null }`；`date` 是北京时间当日（`cnDate`），只取 `status: 'ok'` 的题目；当天没有题目返回 `null`，不是错误。
- 权限：登录 + 已确认 18+ 即可；不要求入圈，也不要求手机号。
- 错误：`40101` 未登录；`40303` 未确认 18+；`40304` 封禁。

### answerPrompt

- 入参：`{ promptId, text }`；`text` 去首尾空白后 5–500 字（`PROMPT_RULES.answer`），未知字段 `40001`。
- 门禁：登录 → 未封禁 → 18+ → 已实名 → 未禁言 → 当日额度 `DAILY_LIMITS.answerPrompt = 1`；机审 `reject` → `40001`，不落库也不扣额度。
- 行为：同一题每人一条，应用层先查后写（`collections.js:95` 已注明不能建含 `_openid` 的唯一索引）；机审 `review` → 落库 `status: 'pending'`；`pass` → `ok`。
- 返回：`{ answer: { id, date, text, status, createdAt } }`。
- 错误：`40001`；`40101`；`40302` 未实名；`40303`；`40304`；`40401` 题目不存在或已 `closed`；`40901`「今天已经作答过了」；`42901` 当日额度已用完。

### listAnswers

- 入参：`{ promptId, page?, size? }`；`size` 默认 20、上限 `PROMPT_RULES.listMax = 50`。
- 前置：调用方必须已作答该题，否则 `40301`「作答后即可查看他人的回答」，且**不返回任何答案内容**。
- 返回：`{ promptId, list, page, size, hasMore }`；`list` 按 `createdAt` 升序，每项 `{ id, date, text, status, createdAt, mine }`；他人答案只含 `status: 'ok'`，本人自己的 `pending` 也返回。
- 隐私：不下发 `_openid`、昵称、头像、徽章等任何作者标识（m6-plan D9，答案不署名）。

### 同里程碑的其他接口

- `community.createTopic`：增可选 `slow: true` → 落库 `slowUntil = createdAt + 24h`；话题摘要与详情返回 `slowUntil`。
- `community.createReply`：`slowUntil` 未到 → `40901`「这条话题还没开放回复」；已发布的回复不受影响。
- `community.listTopics`：增 `featured: true` 筛选；圈内精华仍只对成员可见。
- `moderation.markFeatured`：`{ topicId, featured }` → `{ ok: true, featured, changed }`，仅 `mod` / `admin`，写 `mod_logs`（`kind: 'featured'`）。
- `practice.listNotifications` / `markNotificationsRead`：站内消息分页与已读；`listNotifications` 返回 `unread`。
