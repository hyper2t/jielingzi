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

## 后续（M6）

`todayPrompt`、`answerPrompt`、`listAnswers` 尚未实现。
